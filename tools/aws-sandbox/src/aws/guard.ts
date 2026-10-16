/**
 * Account guard: every AWS call this tool makes
 * is preceded by a verified `guard-cli.js check --execution-profile personal-sandbox ...` that is
 * at most `maxAgeMs` old. A refusal (non-zero exit, unparsable output, or a record that does not
 * match the request) stops the run before the next AWS call. The guard does the STS call; this
 * tool never calls STS itself.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { maskString } from '../mask.js';
import { execFileRunner, type ProcessRunner } from './executor.js';

export const EXECUTION_PROFILE = 'personal-sandbox';
export const DEFAULT_GUARD_CLI = fileURLToPath(
  new URL('../../../aws-preflight/dist/guard-cli.js', import.meta.url),
);
/**
 * A guard verification older than this is repeated before the next AWS call. 0 (the default):
 * every AWS call is preceded by its own guard check. A larger value is an operator
 * opt-in (`--guard-max-age-seconds`), recorded in the report as a deviation.
 */
export const GUARD_MAX_AGE_MS = 0;
const LABEL_RE = /^[A-Za-z0-9 ._:/()+=,@#-]{1,200}$/;

export interface GuardConfig {
  /** Path to `guard-cli.js` (run with this Node). */
  readonly guardCli: string;
  readonly profile: string;
  readonly expectedAccountFile: string;
  readonly region: string;
  readonly logFile?: string | undefined;
  readonly nodePath?: string;
}

/** The guard's one-line JSON record, already masked by the guard. */
export interface GuardRecord {
  readonly time: string;
  readonly label: string;
  readonly account: string;
  readonly principalArn: string;
  readonly principalType: string;
  readonly region: string;
  readonly executionProfile: typeof EXECUTION_PROFILE;
}

export type GuardResult =
  | { readonly ok: true; readonly record: GuardRecord }
  | { readonly ok: false; readonly exitCode: number | null; readonly reason: string };

export class GuardRefused extends Error {
  override name = 'GuardRefused';
  constructor(
    readonly exitCode: number | null,
    readonly reason: string,
  ) {
    super(`account guard refused: ${reason}`);
  }
}

export function guardArgv(config: GuardConfig, label: string): string[] {
  return [
    config.guardCli,
    'check',
    '--execution-profile',
    EXECUTION_PROFILE,
    '--profile',
    config.profile,
    '--expected-account-file',
    config.expectedAccountFile,
    '--region',
    config.region,
    '--label',
    label,
    ...(config.logFile ? ['--log', config.logFile] : []),
  ];
}

/** Validates the guard's stdout record against the request. */
export function parseGuardRecord(
  stdout: string,
  expected: { label: string; region: string },
): GuardRecord | { error: string } {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop();
  if (!line) return { error: 'the guard printed no verification record' };
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { error: 'the guard record is not JSON' };
  }
  const r = (raw ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : undefined);
  const record = {
    time: s('time'),
    label: s('label'),
    account: s('account'),
    principalArn: s('principalArn'),
    principalType: s('principalType'),
    region: s('region'),
    executionProfile: s('executionProfile'),
  };
  const missing = Object.entries(record)
    .filter(([, v]) => v === undefined)
    .map(([k]) => k);
  if (missing.length > 0) return { error: `the guard record lacks ${missing.join(', ')}` };
  if (record.executionProfile !== EXECUTION_PROFILE) {
    return {
      error: `the guard verified execution profile ${record.executionProfile}, not ${EXECUTION_PROFILE}`,
    };
  }
  if (record.region !== expected.region) {
    return { error: `the guard verified region ${record.region}, not ${expected.region}` };
  }
  if (record.label !== expected.label)
    return { error: 'the guard record is for a different label' };
  if (!/^\*{8}\d{4}$/.test(record.account ?? '')) {
    return { error: 'the guard record does not carry a masked account (********NNNN)' };
  }
  return {
    time: record.time as string,
    label: record.label as string,
    account: record.account as string,
    principalArn: maskString(record.principalArn as string),
    principalType: record.principalType as string,
    region: record.region as string,
    executionProfile: EXECUTION_PROFILE,
  };
}

export async function runGuard(
  config: GuardConfig,
  label: string,
  options: { runner?: ProcessRunner; parentEnv: NodeJS.ProcessEnv; cwd: string },
): Promise<GuardResult> {
  if (!LABEL_RE.test(label)) return { ok: false, exitCode: null, reason: 'invalid guard label' };
  if (!existsSync(config.guardCli)) {
    return {
      ok: false,
      exitCode: null,
      reason: `guard CLI not found at ${config.guardCli} (build tools/aws-preflight first); refusing to call AWS`,
    };
  }
  const runner = options.runner ?? execFileRunner;
  // The guard gets the operator's REAL environment, so that its own refusals (static keys,
  // AWS_CONFIG_FILE, AWS_REGION, another profile, CI, ...) see what the operator's shell has.
  const env = Object.fromEntries(
    Object.entries(options.parentEnv).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const result = await runner({
    file: config.nodePath ?? process.execPath,
    args: guardArgv(config, label),
    env,
    cwd: options.cwd,
    timeoutMs: 120_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.exitCode !== 0 || result.timedOut || result.spawnError) {
    const why =
      result.stderr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? (result.timedOut ? 'timed out' : 'no reason given');
    return {
      ok: false,
      exitCode: result.exitCode,
      reason: `exit ${result.exitCode ?? 'none'}: ${maskString(why).slice(0, 300)}`,
    };
  }
  const parsed = parseGuardRecord(result.stdout, { label, region: config.region });
  if ('error' in parsed) return { ok: false, exitCode: 0, reason: parsed.error };
  return { ok: true, record: parsed };
}

/** Keeps the latest verification and repeats it when it is older than `maxAgeMs`. */
export class GuardSession {
  readonly checks: GuardRecord[] = [];
  private lastOkAt: number | undefined;

  constructor(
    private readonly config: GuardConfig,
    private readonly options: {
      runner?: ProcessRunner;
      parentEnv: NodeJS.ProcessEnv;
      cwd: string;
      clock?: () => number;
      maxAgeMs?: number;
    },
  ) {}

  /** The freshness window in seconds (0 = a guard check before every AWS call). */
  get maxAgeSeconds(): number {
    return (this.options.maxAgeMs ?? GUARD_MAX_AGE_MS) / 1000;
  }

  /** Throws GuardRefused unless a verification at most maxAgeMs old exists (or succeeds now). */
  async ensure(label: string): Promise<GuardRecord> {
    const clock = this.options.clock ?? Date.now;
    const maxAge = this.options.maxAgeMs ?? GUARD_MAX_AGE_MS;
    const last = this.checks[this.checks.length - 1];
    if (last && this.lastOkAt !== undefined && maxAge > 0 && clock() - this.lastOkAt <= maxAge) {
      return last;
    }
    const result = await runGuard(this.config, label, this.options);
    if (!result.ok) throw new GuardRefused(result.exitCode, result.reason);
    this.checks.push(result.record);
    this.lastOkAt = clock();
    return result.record;
  }
}
