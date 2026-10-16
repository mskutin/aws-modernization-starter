#!/usr/bin/env node
/**
 * starter-aws-preflight — read-only AWS sandbox discovery (see README.md).
 *
 *   plan     [--format markdown|json|iam-policy] [--write]       no credentials, no AWS calls
 *   identity --profile <p> --expected-account <12 digits> --expected-role-pattern <glob> [...]
 *   discover --profile <p> --expected-account <12 digits> --expected-role-pattern <glob> [...]
 *   identity|discover --execution-profile personal-sandbox --owner-authorization "<text>" [...]
 *
 * Exit codes: 0 ok, 1 error, 2 refused (no AWS call), 3 account mismatch, 4 principal rejected,
 * 5 privilege check failed, 6 credentials expired/invalid, 7 organization check failed,
 * 8 leak scanner blocked the output, 130 interrupted.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkAwsCliConfig, fallbackIdentityProblems } from './awsconfig.ts';
import { recordOf, runCall, type RunContext } from './calls.ts';
import { runDiscovery } from './discover.ts';
import {
  buildEvidence,
  formatJson,
  maskLocalPath,
  writeEvidence,
  type IdentityEvidence,
  type ProbeRecord,
} from './evidence.ts';
import { createExecutor, ENV_FIXED, resolveAwsCli, type ProcessRunner } from './executor.ts';
import { parsePrincipal, runIdentityGate } from './gate.ts';
import { gitHeadCommit } from './gitinfo.ts';
import { leakRulesIn, type LeakSecrets } from './leak.ts';
import {
  iamPolicy,
  POLICY_PATH,
  README_PATH,
  renderPlanJson,
  renderPlanMarkdown,
  renderPolicyFile,
  renderReadme,
} from './plan.ts';
import {
  CDK_DEFAULT_QUALIFIER,
  DEFAULT_DB_ENGINE_VERSION,
  DEFAULT_QUALIFIER,
  VERIFIED_CLI_NIXPKGS_REV,
  VERIFIED_CLI_VERSION,
} from './probes.ts';
import { gitDirty, toolSourceSha256 } from './provenance.ts';
import { openRawStore, type RawStore } from './rawstore.ts';
import {
  cdkSettingsFiles,
  isExecutionProfile,
  ownerAuthorizationProblem,
  readExpectedAccountFile,
  sandboxEnvProblems,
} from './sandbox.ts';
import { preGateConsoleMask, type Sanitizer } from './sanitize.ts';
import { workloadRegionProblem } from './region.ts';
import { DEFAULT_WORKLOAD_REGION, EXIT, GLOBAL_REGION, isRecord, type Json } from './types.ts';
import { compileRolePattern, isValid, maskAccount, operatorTextProblem } from './validate.ts';

const TOOL_DIR = fileURLToPath(new URL('..', import.meta.url));
const TOOL_VERSION = (() => {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(TOOL_DIR, 'package.json'), 'utf8'));
    return isRecord(pkg) && typeof pkg['version'] === 'string' ? pkg['version'] : 'unknown';
  } catch {
    return 'unknown';
  }
})();
export const DEFAULT_CALL_TIMEOUT_SECONDS = 150;
export const MAX_KMS_KEYS = 10;
const THROTTLE_BACKOFF_MS = 5_000;

export const USAGE = `starter-aws-preflight <command> [options]

Commands
  plan       Print the call plan (no credentials, no AWS calls).
               --format markdown|json|iam-policy   (default markdown)
               --write   regenerate the README probe table and iam/discovery-readonly-policy.json
  identity   Identity gate only (sts, own-role privilege check, organization).
  discover   Identity gate, then every discovery probe, strictly sequentially.

Required for identity/discover
  --profile <name>                 native IAM Identity Center profile in ~/.aws/config
  --expected-account <12 digits>   the sandbox account; anything else stops the run (exit 3)
  --expected-role-pattern <glob>   e.g. 'AWSReservedSSO_<PermissionSet>_*' (exit 4 on mismatch)

Options
  --region <region>                workload region, given once (default ${DEFAULT_WORKLOAD_REGION}); any
                                   region of the aws partition. ${GLOBAL_REGION} is added for global
                                   endpoints. plan: the region the plan and IAM policy are for
  --aws-cli <path>                 AWS CLI ${VERIFIED_CLI_VERSION} (default: first 'aws' on PATH)
  --raw-dir <dir>                  private raw output base (default ~/.local/state/starter-aws-preflight)
  --evidence-out <file>            sanitized evidence (default reports/aws-preflight/, gitignored)
  --qualifier <q>                  CDK bootstrap qualifier (default ${DEFAULT_QUALIFIER}; hnb659fds is always probed)
  --vpc-id <vpc-...>               filter VPC-scoped probes to one VPC
  --kms-key <alias/...>            describe this key alias (repeatable, max ${MAX_KMS_KEYS})
  --boundary-policy-arn <arn>      describe this permissions boundary policy
  --db-engine-version <x.y>        PostgreSQL version to check (default ${DEFAULT_DB_ENGINE_VERSION})
  --attest-read-only "<text>"      HUMAN-written statement (permission set + who checked it) for an
                                   identity that is read-only but unverifiable or data-capable
  --accept-write-capable "<text>"  HUMAN-written decision (who, when, why) to run with a write-capable
                                   identity; never accepted for administrator-equivalent identities
  --call-timeout <seconds>         wall-clock limit per call, the child is killed (default ${DEFAULT_CALL_TIMEOUT_SECONDS})

Execution profile
  --execution-profile <p>          strict (default): unchanged; an administrator-equivalent identity
                                   stops the run (exit 5, no override).
                                   personal-sandbox: a dedicated sandbox account only. Accepts any
                                   identity, administrator-equivalent included, on the owner's
                                   statement; discovery stays read-only (same allowlist). Refuses
                                   --profile default, static keys, AWS_DEFAULT_PROFILE and a different
                                   AWS_PROFILE / AWS_REGION / AWS_DEFAULT_REGION in the environment.
  --owner-authorization "<text>"   personal-sandbox, required: HUMAN-written statement of the account
                                   owner (who, when, why, the permission set, this sandbox only)
  --expected-account-file <file>   personal-sandbox: private file (0600) holding the 12-digit account,
                                   instead of --expected-account

AWS CLI pin: nix shell github:NixOS/nixpkgs/${VERIFIED_CLI_NIXPKGS_REV}#awscli2
Never runs when CI or GITLAB_CI is set. Exit codes: see README.md.`;

const OPTIONS = {
  profile: { type: 'string' },
  'expected-account': { type: 'string' },
  'expected-role-pattern': { type: 'string' },
  region: { type: 'string', multiple: true },
  'aws-cli': { type: 'string' },
  'raw-dir': { type: 'string' },
  'evidence-out': { type: 'string' },
  qualifier: { type: 'string' },
  'vpc-id': { type: 'string' },
  'kms-key': { type: 'string', multiple: true },
  'boundary-policy-arn': { type: 'string' },
  'db-engine-version': { type: 'string' },
  'attest-read-only': { type: 'string' },
  'accept-write-capable': { type: 'string' },
  'call-timeout': { type: 'string' },
  'execution-profile': { type: 'string' },
  'expected-account-file': { type: 'string' },
  'owner-authorization': { type: 'string' },
  format: { type: 'string' },
  write: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

export interface Deps {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /** Process runner used by the executor (tests inject a fake AWS CLI here). */
  readonly runner?: ProcessRunner;
  readonly now?: () => Date;
  readonly randomHex?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly throttleBackoffMs?: number;
  readonly signal?: AbortSignal;
  readonly repoRoot?: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function findRepoRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// ── Console ──────────────────────────────────────────────────────────────────────────

/** Tool-computed digests (git commit, SHA-256) are shielded from the 12-digit rules. */
const DIGEST_TOKEN = /(?<![0-9A-Za-z])(?:[0-9a-f]{64}|[0-9a-f]{40})(?![0-9A-Za-z])/g;

export interface ConsoleFilter {
  /** Masks and leak-scans one line (local paths and call ids: no domain masking). */
  filter(line: string, options?: { localPath?: boolean }): string;
  /** After the identity gate: the run's sanitizer, the raw account and session name. */
  useSanitizer(s: Sanitizer, account: string): void;
}

/**
 * Every console line of identity/discover passes here: before the gate, 12-digit numbers,
 * separated account IDs and e-mail addresses are masked; after it, the run's sanitizer applies.
 * A line that still hits a leak rule is replaced, never printed.
 */
export function createConsoleFilter(): ConsoleFilter {
  let sanitizer: Sanitizer | undefined;
  let secrets: LeakSecrets = {};
  return {
    filter(line, options = {}) {
      const digests: string[] = [];
      const shielded = line.replace(DIGEST_TOKEN, (d) => `<digest-${digests.push(d) - 1}>`);
      const masked = sanitizer
        ? sanitizer.console(shielded, { domains: !options.localPath })
        : preGateConsoleMask(shielded);
      const hits = leakRulesIn(masked, secrets);
      if (hits.length > 0) return `[line suppressed by the leak scanner: ${hits.join(', ')}]`;
      return masked.replace(/<digest-(\d+)>/g, (_, i: string) => digests[Number(i)] ?? '');
    },
    useSanitizer(s, account) {
      sanitizer = s;
      secrets = { account, sessionName: s.sessionName };
    },
  };
}

export async function run(argv: readonly string[], deps: Deps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? env['INIT_CWD'] ?? process.cwd();
  const rawOut = deps.stdout ?? ((line: string) => console.log(line));
  const rawErr = deps.stderr ?? ((line: string) => console.error(line));

  let parsed: ReturnType<typeof parse>;
  try {
    // pnpm forwards a literal `--` (`pnpm run plan -- --format json`); tolerate it.
    parsed = parse(argv[0] === '--' ? argv.slice(1) : [...argv]);
  } catch (e) {
    rawErr(preGateConsoleMask(`REFUSED — ${message(e)}`));
    rawErr(USAGE);
    return EXIT.REFUSED;
  }
  const { values: v, positionals } = parsed;
  if (v.help) {
    rawOut(USAGE);
    return EXIT.OK;
  }
  const command = positionals[0];
  if (
    positionals.length !== 1 ||
    (command !== 'plan' && command !== 'identity' && command !== 'discover')
  ) {
    rawErr(USAGE);
    return EXIT.REFUSED;
  }
  // Plan output is generated from the static allowlist only (no operator or AWS data).
  if (command === 'plan') return runPlan(v, rawOut, rawErr);
  const consoleFilter = createConsoleFilter();
  const out: Print = (line, options) => rawOut(consoleFilter.filter(line, options));
  const err: Print = (line, options) => rawErr(consoleFilter.filter(line, options));
  try {
    return await runLive(command, v, { ...deps, env, cwd, out, err, consoleFilter });
  } catch (e) {
    err(`ERROR — ${message(e)}`);
    return EXIT.ERROR;
  }
}

const parse = (args: string[]) =>
  parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
type Values = ReturnType<typeof parse>['values'];

async function runPlan(
  v: Values,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  const format = v.format ?? 'markdown';
  const regions = v.region ?? [DEFAULT_WORKLOAD_REGION];
  const workload = regions.length === 1 ? regions[0] : undefined;
  const regionIssue =
    workload === undefined ? 'given more than once' : workloadRegionProblem(workload);
  if (regionIssue !== undefined || workload === undefined) {
    err(`REFUSED — --region must be one aws-partition region (${regionIssue ?? 'missing'})`);
    return EXIT.REFUSED;
  }
  if (v.write && workload !== DEFAULT_WORKLOAD_REGION) {
    err(
      `REFUSED — --write regenerates the committed plan of the default region ${DEFAULT_WORKLOAD_REGION}; print the plan for ${workload} with --format instead`,
    );
    return EXIT.REFUSED;
  }
  if (v.write) {
    writeFileSync(README_PATH, await renderReadme());
    writeFileSync(POLICY_PATH, await renderPolicyFile());
    out(`wrote ${README_PATH}\nwrote ${POLICY_PATH}`);
    return EXIT.OK;
  }
  if (format === 'markdown') out(renderPlanMarkdown(workload));
  else if (format === 'json') out(JSON.stringify(renderPlanJson(workload), null, 2));
  else if (format === 'iam-policy') out((await formatJson(iamPolicy(workload))).trimEnd());
  else {
    err('REFUSED — --format must be markdown, json or iam-policy');
    return EXIT.REFUSED;
  }
  return EXIT.OK;
}

type Print = (line: string, options?: { localPath?: boolean }) => void;

interface LiveDeps extends Deps {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly out: Print;
  readonly err: Print;
  readonly consoleFilter: ConsoleFilter;
}

async function runLive(
  command: 'identity' | 'discover',
  v: Values,
  deps: LiveDeps,
): Promise<number> {
  const { env, cwd, out, err } = deps;
  // ── 1. Never in a pipeline ─────────────────────────────────────────────────────────────────
  if (env['CI'] !== undefined || env['GITLAB_CI'] !== undefined) {
    err('REFUSED — CI or GITLAB_CI is set: live AWS discovery never runs in a pipeline.');
    return EXIT.REFUSED;
  }
  // ── 2. Arguments ───────────────────────────────────────────────────────────────────────────
  const problems: string[] = [];
  const executionProfileText = v['execution-profile'] ?? 'strict';
  const executionProfile = isExecutionProfile(executionProfileText)
    ? executionProfileText
    : undefined;
  if (!executionProfile) problems.push('--execution-profile must be strict or personal-sandbox');
  /** personal-sandbox (sandbox.ts); every strict check below is unchanged. */
  const personal = executionProfile === 'personal-sandbox';
  const profile = v.profile;
  if (!isValid('profile', profile)) {
    problems.push('--profile is required (letters, digits, _ . + -; max 64; no leading -)');
  } else if (personal && profile === 'default') {
    problems.push(
      '--profile default is refused in personal-sandbox: select the sandbox profile explicitly',
    );
  }
  let expected = v['expected-account'];
  const expectedFile = v['expected-account-file'];
  if (!personal) {
    if (!isValid('account', expected))
      problems.push('--expected-account is required (exactly 12 digits)');
  } else if (expected !== undefined && expectedFile !== undefined) {
    problems.push('give --expected-account or --expected-account-file, not both');
  } else if (expectedFile !== undefined) {
    const read = readExpectedAccountFile(resolve(cwd, expectedFile));
    if ('error' in read) problems.push(`--expected-account-file: ${read.error}`);
    else expected = read.account;
  } else if (!isValid('account', expected)) {
    problems.push('--expected-account (exactly 12 digits) or --expected-account-file is required');
  }
  const patternText = v['expected-role-pattern'];
  let rolePattern: RegExp | undefined;
  if (patternText === undefined) {
    problems.push("--expected-role-pattern is required (e.g. 'AWSReservedSSO_<PermissionSet>_*')");
  } else {
    const compiled = compileRolePattern(patternText);
    if (compiled instanceof RegExp) rolePattern = compiled;
    else problems.push(`--expected-role-pattern: ${compiled.error}`);
  }
  const regions = v.region ?? [DEFAULT_WORKLOAD_REGION];
  const workloadRegion = regions.length === 1 ? regions[0] : undefined;
  const regionIssue =
    workloadRegion === undefined ? 'given more than once' : workloadRegionProblem(workloadRegion);
  if (regionIssue !== undefined) {
    problems.push(
      `--region must be one aws-partition region, given once (${regionIssue}; ${GLOBAL_REGION} is used automatically, for global endpoints only)`,
    );
  }
  const qualifier = v.qualifier ?? DEFAULT_QUALIFIER;
  if (!isValid('qualifier', qualifier)) problems.push('--qualifier must match ^[a-z0-9]{1,10}$');
  const vpcId = v['vpc-id'];
  if (vpcId !== undefined && !isValid('vpcId', vpcId))
    problems.push('--vpc-id must match ^vpc-[0-9a-f]{8,17}$');
  const kmsKeyRefs = [...new Set(v['kms-key'] ?? [])];
  if (kmsKeyRefs.length > MAX_KMS_KEYS) problems.push(`at most ${MAX_KMS_KEYS} --kms-key values`);
  for (const k of kmsKeyRefs) {
    if (!isValid('kmsKeyRef', k))
      problems.push(`--kms-key ${k} must match ^alias/[A-Za-z0-9/_-]{1,250}$`);
  }
  const boundary = v['boundary-policy-arn'];
  if (boundary !== undefined) {
    if (!isValid('boundaryPolicyArn', boundary)) {
      problems.push(
        '--boundary-policy-arn must be an IAM policy ARN (arn:aws:iam::<account>:policy/...)',
      );
    } else {
      const owner = boundary.split(':')[4];
      if (owner !== 'aws' && owner !== expected) {
        problems.push(
          '--boundary-policy-arn must belong to --expected-account (or be AWS managed)',
        );
      }
    }
  }
  const dbEngineVersion = v['db-engine-version'] ?? DEFAULT_DB_ENGINE_VERSION;
  if (!isValid('dbEngineVersion', dbEngineVersion))
    problems.push('--db-engine-version must match ^\\d+\\.\\d+$');
  const attestation = v['attest-read-only'];
  if (attestation !== undefined) {
    const problem = operatorTextProblem(attestation);
    if (problem) problems.push(`--attest-read-only ${problem}`);
  }
  const acceptance = v['accept-write-capable'];
  if (acceptance !== undefined) {
    const problem = operatorTextProblem(acceptance);
    if (problem) problems.push(`--accept-write-capable ${problem}`);
  }
  if (attestation !== undefined && acceptance !== undefined) {
    problems.push(
      '--attest-read-only and --accept-write-capable are mutually exclusive (one human statement per run)',
    );
  }
  const timeoutText = v['call-timeout'];
  const timeoutSeconds =
    timeoutText === undefined
      ? DEFAULT_CALL_TIMEOUT_SECONDS
      : /^\d{1,3}$/.test(timeoutText)
        ? Number(timeoutText)
        : Number.NaN;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
    problems.push('--call-timeout must be an integer between 1 and 600 seconds');
  }
  if (v.format !== undefined || v.write !== undefined)
    problems.push('--format and --write only apply to plan');
  const ownerAuthorization = v['owner-authorization'];
  if (personal) {
    if (ownerAuthorization === undefined) {
      problems.push(
        '--owner-authorization "<who, when, why>" is required in personal-sandbox (written by the account owner in person, never generated by a tool)',
      );
    } else {
      const problem = ownerAuthorizationProblem(ownerAuthorization);
      if (problem) problems.push(`--owner-authorization ${problem}`);
    }
    if (attestation !== undefined || acceptance !== undefined) {
      problems.push(
        '--attest-read-only and --accept-write-capable belong to the strict profile; personal-sandbox uses --owner-authorization',
      );
    }
    if (isValid('profile', profile)) {
      for (const p of sandboxEnvProblems(env, {
        profile,
        region: workloadRegion ?? DEFAULT_WORKLOAD_REGION,
      })) {
        problems.push(p.message);
      }
    }
  } else if (executionProfile === 'strict') {
    if (ownerAuthorization !== undefined || expectedFile !== undefined) {
      problems.push(
        '--owner-authorization and --expected-account-file only apply to --execution-profile personal-sandbox',
      );
    }
  }
  const home = env['HOME'];
  if (!home || !isAbsolute(home)) {
    problems.push('HOME must be an absolute path (the AWS CLI configuration is $HOME/.aws)');
  }
  if (
    problems.length > 0 ||
    !profile ||
    !expected ||
    !rolePattern ||
    !patternText ||
    !home ||
    workloadRegion === undefined
  ) {
    for (const p of problems) err(`REFUSED — ${p}`);
    return EXIT.REFUSED;
  }
  const profileLabel = /\d/.test(profile) ? '<profile>' : profile;
  /** Home directory -> `~` in messages that may name local paths. */
  const tilde = (text: string) => (home === '/' ? text : text.split(home).join('~'));

  // ── 3. AWS CLI configuration (offline, before ANY aws process) ──────────────────────
  const config = checkAwsCliConfig({
    home,
    profile,
    expectedAccount: expected,
    rolePattern: patternText,
  });
  if (!config.ok) {
    for (const p of config.problems) err(`REFUSED — ${p}`);
    err(
      'REFUSED — the AWS CLI loads $HOME/.aws; only the minimal IAM Identity Center profile shape is accepted (README "Trust assumptions"). Nothing was run.',
    );
    return EXIT.REFUSED;
  }
  if (personal) {
    // personal-sandbox: no other identity a command could fall back to.
    const fallback = fallbackIdentityProblems({
      home,
      cdkSettings: cdkSettingsFiles(home, cwd, deps.repoRoot ?? findRepoRoot(TOOL_DIR)),
    });
    if (fallback.length > 0) {
      for (const p of fallback) err(`REFUSED — ${p}`);
      err(
        'REFUSED — personal-sandbox allows no default profile, no ~/.aws/credentials and no CDK "profile" setting. Nothing was run.',
      );
      return EXIT.REFUSED;
    }
  }

  // ── 4. Run id, private raw directory, evidence path ────────────────────────────────────────
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const hex = (deps.randomHex ?? (() => randomBytes(3).toString('hex')))();
  const runId = `${startedAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}-${hex}`;
  const rawBase =
    v['raw-dir'] !== undefined
      ? resolve(cwd, v['raw-dir'])
      : join(home, '.local', 'state', 'starter-aws-preflight');
  const repoRoot = deps.repoRoot ?? findRepoRoot(TOOL_DIR) ?? cwd;
  // Default: the gitignored reports/ directory, never tracked docs (commit evidence deliberately).
  const evidencePath =
    v['evidence-out'] !== undefined
      ? resolve(cwd, v['evidence-out'])
      : join(
          repoRoot,
          'reports',
          'aws-preflight',
          `${command === 'discover' ? 'discovery' : 'identity'}-${runId}.json`,
        );
  if (existsSync(evidencePath)) {
    err(`REFUSED — ${maskLocalPath(evidencePath, home)} already exists`, { localPath: true });
    return EXIT.REFUSED;
  }

  let raw: RawStore;
  try {
    raw = openRawStore(rawBase, runId);
  } catch (e) {
    err(`REFUSED — raw output: ${tilde(message(e))}`, { localPath: true });
    return EXIT.REFUSED;
  }
  // ── 5. AWS CLI (local `aws --version`; no AWS request) ─────────────────────────────────────
  const cli = await resolveAwsCli({
    explicitPath: v['aws-cli'],
    parentEnv: env,
    cwd,
    runner: deps.runner,
  });
  if ('error' in cli) {
    err(`REFUSED — ${tilde(cli.error)}`, { localPath: true });
    return EXIT.REFUSED;
  }
  const executor = createExecutor({
    cli,
    profile,
    parentEnv: env,
    cwd: raw.dir,
    timeoutMs: timeoutSeconds * 1000,
    runner: deps.runner,
    signal: deps.signal,
    workloadRegion,
  });
  // ── 6. Provenance of the code that runs ────────────────────────────────────────────
  const gitCommit = gitHeadCommit(TOOL_DIR) ?? 'unknown';
  const sourceSha256 = toolSourceSha256(TOOL_DIR);
  const dirty = gitDirty(TOOL_DIR);
  const awsCliProvenance = {
    version: cli.version,
    verifiedAgainst: VERIFIED_CLI_VERSION,
    path: maskLocalPath(cli.path, home),
    realpath: maskLocalPath(cli.realpath, home),
    sha256: cli.sha256,
  };
  raw.write('run', {
    runId,
    command,
    startedAt: startedAt.toISOString(),
    tool: { version: TOOL_VERSION, gitCommit, sourceSha256, gitDirty: dirty },
    awsCli: { path: cli.path, realpath: cli.realpath, sha256: cli.sha256, version: cli.version },
    profile,
    expectedAccount: expected,
    awsConfig: { profileKeys: config.profileKeys, ssoSessionKeys: config.ssoSessionKeys },
    inputs: { qualifier, vpcId, kmsKeyRefs, boundary, dbEngineVersion, timeoutSeconds },
    attestation: attestation ?? null,
    acceptance: acceptance ?? null,
    childEnvPassedThroughNames: executor.passedThroughEnv,
    ...(personal ? { executionProfile, ownerAuthorization: ownerAuthorization ?? null } : {}),
  });

  out(`starter-aws-preflight ${command} — run ${runId}`);
  if (personal) {
    out(
      '  execution profile personal-sandbox: a dedicated sandbox account only; any identity is accepted on the owner authorization; discovery stays read-only (same allowlist)',
    );
  }
  out(
    `  profile ${profileLabel} (IAM Identity Center; keys ${config.profileKeys.join(', ')}), expected account ${maskAccount(expected)}, workload region ${workloadRegion} (global endpoints: ${GLOBAL_REGION})`,
  );
  out(`  AWS CLI ${cli.version} at ${awsCliProvenance.realpath} (sha256 ${cli.sha256})`, {
    localPath: true,
  });
  out(
    `  tool ${TOOL_VERSION}, commit ${gitCommit}, sources sha256 ${sourceSha256}, ${dirty.dirty === false ? 'clean' : `dirty: ${String(dirty.dirty)} (${dirty.reason ?? ''})`}`,
    { localPath: true },
  );
  if (dirty.dirty !== false) {
    out('  note: the tool sources are not a clean checkout; the evidence records this.');
  }
  out(`  raw output (private, never commit): ${maskLocalPath(raw.dir, home)}`, { localPath: true });

  const ctx: RunContext = {
    executor,
    raw,
    profile,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    throttleBackoffMs: deps.throttleBackoffMs ?? THROTTLE_BACKOFF_MS,
    signal: deps.signal,
  };

  // ── 7. Identity gate ───────────────────────────────────────────────────────────────────────
  out('identity gate');
  const gate = await runIdentityGate(ctx, {
    expectedAccount: expected,
    rolePattern,
    rolePatternText: patternText,
    attestation,
    acceptance,
    executionProfile,
    ownerAuthorization,
    profileLabel,
    log: (line) => out(line),
  });
  if (!gate.ok) {
    err(gate.message);
    return gate.exit;
  }
  const s = gate.sanitizer;
  deps.consoleFilter.useSanitizer(s, gate.account);
  const records: ProbeRecord[] = [...gate.records];
  let identity: IdentityEvidence = gate.identity;
  let complete = true;
  let incompleteReason: string | undefined;
  let exit: number = EXIT.OK;
  out(
    `  gate: organization ${identity.organization.status.toUpperCase()}, read-only assessment ${identity.readOnlyAssessment} (computed ${identity.computedLevel})`,
  );

  // ── 8. Discovery ───────────────────────────────────────────────────────────────────────────
  if (command === 'discover') {
    out('discovery (strictly sequential)');
    const d = await runDiscovery(
      ctx,
      s,
      gate.account,
      { qualifier, vpcId, kmsKeyRefs, boundaryPolicyArn: boundary, dbEngineVersion },
      // Status lines name static call ids (`a.org.parents@us-east-1`): no domain masking.
      (line) => out(line, { localPath: true }),
    );
    records.push(...d.records);
    if (d.stopped) {
      complete = false;
      if (d.stopped.reason === 'credentials') {
        incompleteReason = `credentials expired or invalid during discovery (${d.stopped.code})`;
        exit = EXIT.CREDENTIALS;
        err(
          `CREDENTIALS — the AWS session expired during discovery (${d.stopped.code}). Run: aws sso login --profile ${profileLabel}`,
        );
      } else {
        incompleteReason = 'interrupted';
        exit = EXIT.INTERRUPTED;
        err('INTERRUPTED — writing partial evidence marked incomplete');
      }
    } else {
      // The profile must still resolve to the same account AND principal.
      const recheck = await runCall(
        ctx,
        `identity.caller-recheck@${workloadRegion}`,
        { probeId: 'identity.caller-recheck', region: workloadRegion, values: {} },
        { persistRaw: false },
      );
      const c = recheck.classified;
      const acct = c.kind === 'ok' && isRecord(c.data) ? c.data['Account'] : undefined;
      const arn = c.kind === 'ok' && isRecord(c.data) ? c.data['Arn'] : undefined;
      if (c.kind === 'ok' && acct !== gate.account) {
        err(
          `ACCOUNT MISMATCH — STOP. After discovery the profile resolves to ${typeof acct === 'string' ? maskAccount(acct) : 'an unknown account'}; no evidence written.`,
        );
        return EXIT.ACCOUNT_MISMATCH;
      }
      if (c.kind === 'ok' && arn !== gate.callerArn) {
        const later = typeof arn === 'string' ? parsePrincipal(arn, gate.account) : undefined;
        const what =
          later?.type !== 'assumed-role'
            ? 'a principal that is not the checked assumed role'
            : later.roleName === gate.roleName
              ? 'the same role with a different session name'
              : `role ${later.roleName} instead of ${gate.roleName}`;
        err(
          `PRINCIPAL CHANGED — STOP. After discovery the profile resolves to ${what}; no evidence written.`,
        );
        return EXIT.PRINCIPAL_REJECTED;
      }
      recheck.persist();
      records.push(recordOf(recheck, s));
      if (c.kind === 'ok') {
        identity = { ...identity, recheck: { status: 'same-principal' } };
      } else {
        const code = c.code;
        identity = { ...identity, recheck: { status: 'failed', errorCode: code } };
        complete = false;
        incompleteReason = `identity re-check failed (${code})`;
        exit =
          c.kind === 'credentials'
            ? EXIT.CREDENTIALS
            : c.kind === 'interrupted'
              ? EXIT.INTERRUPTED
              : EXIT.ERROR;
        err(`STOP — ${incompleteReason}; evidence marked incomplete`);
      }
    }
  }

  // ── 9. Sanitized evidence (leak-scanned) ───────────────────────────────────────────────────
  const inputs: { [key: string]: Json } = {
    qualifiers: [...new Set([qualifier, CDK_DEFAULT_QUALIFIER])],
    vpcFilter: vpcId ? s.text(vpcId) : null,
    kmsKeyRefs: kmsKeyRefs.map((k) => s.name('kms-alias', k)),
    boundaryPolicyArn: boundary ? s.arn(boundary) : null,
    dbEngineVersion,
    callTimeoutSeconds: timeoutSeconds,
    attestationGiven: attestation !== undefined,
    acceptanceGiven: acceptance !== undefined,
    awsConfig: {
      profileKeys: [...config.profileKeys],
      ssoSessionKeys: [...config.ssoSessionKeys],
    },
    ...(personal
      ? {
          ownerAuthorizationGiven: ownerAuthorization !== undefined,
          expectedAccountSource: expectedFile !== undefined ? 'file' : 'argument',
        }
      : {}),
  };
  const evidence = buildEvidence({
    command,
    executionProfile,
    complete,
    incompleteReason,
    tool: {
      name: '@starter/tool-aws-preflight',
      version: TOOL_VERSION,
      gitCommit,
      sourceSha256,
      gitDirty: dirty.dirty,
      ...(dirty.reason ? { gitDirtyReason: dirty.reason } : {}),
    },
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    awsCli: awsCliProvenance,
    regions: { workload: workloadRegion, global: GLOBAL_REGION },
    childEnvironment: { passedThroughNames: executor.passedThroughEnv, fixed: ENV_FIXED },
    inputs,
    identity,
    probes: records,
  });
  const written = await writeEvidence(evidencePath, evidence, {
    account: gate.account,
    sessionName: s.sessionName,
  });
  if (!written.written) {
    err(
      `LEAK SCANNER — refusing to write the evidence: ${written.findings.map((f) => `${f.rule} at ${f.path}`).join(', ')}`,
    );
    return EXIT.LEAK_BLOCKED;
  }
  const summary = evidence.summary.byStatus;
  out(
    `summary: ${evidence.summary.calls} records — ok ${summary.ok}, access-denied ${summary['access-denied']}, not-found ${summary['not-found']}, error ${summary.error}, timeout ${summary.timeout}, skipped ${summary.skipped}${complete ? '' : ' (INCOMPLETE)'}`,
  );
  out(
    `gate: ${personal ? 'executionProfile personal-sandbox, ' : ''}organization ${evidence.gate.organization}, readOnlyAssessment ${evidence.gate.readOnlyAssessment}, computedLevel ${evidence.gate.computedLevel}, principal re-check ${evidence.gate.principalRecheck}`,
  );
  out(`evidence (sanitized): ${relative(cwd, written.path) || written.path}`, { localPath: true });
  out('after the run: aws sso logout (deletes the cached SSO token and role credentials)');
  return exit;
}

if (import.meta.main) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  run(process.argv.slice(2), { signal: controller.signal }).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(preGateConsoleMask(`ERROR — ${message(e)}`));
      process.exitCode = EXIT.ERROR;
    },
  );
}
