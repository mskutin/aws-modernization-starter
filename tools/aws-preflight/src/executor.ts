/**
 * The exec boundary: the ONLY module of this package that starts processes (test/static.test.ts
 * enforces it). It runs the AWS CLI v2 with `execFile` (never a shell), with an environment built
 * from scratch, and only for probe ids from the static allowlist: the argv is rebuilt here from
 * the frozen definition plus validated placeholder values and checked once more immediately
 * before the process is started, against the independent boundary list (boundary.ts). Discovery
 * probes are refused until the identity gate has unlocked them.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  assertArgvSafe,
  boundArgs,
  BoundaryViolation,
  renderArgs,
  REQUIRED_GLOBAL_ARGS,
  type PlaceholderValues,
  type ProbeDef,
} from './policy.ts';
import { probesFor, VERIFIED_CLI_NIXPKGS_REV, VERIFIED_CLI_VERSION } from './probes.ts';
import { DEFAULT_WORKLOAD_REGION, type Region } from './types.ts';
import { PATTERNS } from './validate.ts';

export interface ProcessRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxBuffer: number;
  readonly signal?: AbortSignal | undefined;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The wall-clock timeout fired and the child was killed with SIGKILL. */
  readonly timedOut: boolean;
  /** The run was interrupted (SIGINT/SIGTERM) and the child was killed. */
  readonly aborted: boolean;
  readonly outputTooLarge: boolean;
  /** The process could not be started (e.g. ENOENT, EACCES). */
  readonly spawnError?: string | undefined;
  readonly pid?: number | undefined;
  readonly durationMs: number;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

/** Responses larger than this are refused (the child is killed). */
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** After a kill, stop waiting for pipes a grandchild might still hold open. */
const PIPE_DRAIN_MS = 2_000;

/** Runs one process with execFile (no shell), closed stdin and a SIGKILL wall-clock timeout. */
export const execFileRunner: ProcessRunner = (request) =>
  new Promise((done) => {
    const started = Date.now();
    let timedOut = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const child = execFile(
      request.file,
      [...request.args],
      {
        env: { ...request.env },
        cwd: request.cwd,
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: request.maxBuffer,
        killSignal: 'SIGKILL',
        signal: request.signal,
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        if (drainTimer) clearTimeout(drainTimer);
        const code = (error as NodeJS.ErrnoException | null)?.code;
        done({
          exitCode: child.exitCode,
          signal: child.signalCode,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut,
          aborted: request.signal?.aborted ?? false,
          outputTooLarge: code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          spawnError: child.pid === undefined && typeof code === 'string' ? code : undefined,
          pid: child.pid,
          durationMs: Date.now() - started,
        });
      },
    );
    // The AWS CLI must never wait for input (prompts, auto-prompt, device flows).
    child.stdin?.end();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, PIPE_DRAIN_MS);
      drainTimer.unref();
    }, request.timeoutMs);
  });

// ── Child environment ────────────────────────────────────────────────────────────────────────

/** Parent variables passed through by NAME (values are never recorded). */
export const ENV_PASS_THROUGH: readonly string[] = [
  'HOME',
  'PATH',
  'LANG',
  'TZ',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'AWS_CA_BUNDLE',
];
const LOCALE_RE = /^LC_[A-Z]+$/;

/**
 * Fixed child variables. AWS_CLI_ERROR_FORMAT pins the error text the classifier parses;
 * AWS_IGNORE_CONFIGURED_ENDPOINT_URLS makes the CLI ignore endpoint_url settings (besides
 * the configuration refusal in awsconfig.ts); PYTHONNOUSERSITE keeps Python from loading
 * `~/.local/.../site-packages` (the Nix wrapper sets it too).
 */
export const ENV_FIXED: Readonly<Record<string, string>> = {
  AWS_PAGER: '',
  AWS_CLI_AUTO_PROMPT: 'off',
  AWS_RETRY_MODE: 'standard',
  AWS_MAX_ATTEMPTS: '3',
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_CLI_ERROR_FORMAT: 'legacy',
  AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
  PYTHONNOUSERSITE: '1',
};

/** Builds the child environment from scratch: pass-through allowlist + fixed values only. */
export function buildChildEnv(parent: NodeJS.ProcessEnv): {
  env: Record<string, string>;
  passedThrough: string[];
} {
  const env: Record<string, string> = {};
  const passedThrough: string[] = [];
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (ENV_PASS_THROUGH.includes(name) || LOCALE_RE.test(name)) {
      env[name] = value;
      passedThrough.push(name);
    }
  }
  Object.assign(env, ENV_FIXED);
  for (const name of Object.keys(env)) {
    if (name.startsWith('AWS_') && !(name in ENV_FIXED) && name !== 'AWS_CA_BUNDLE') {
      throw new BoundaryViolation(`unexpected ${name} in the AWS CLI environment`);
    }
  }
  return { env, passedThrough: passedThrough.sort() };
}

// ── AWS CLI resolution ───────────────────────────────────────────────────────────────────────

export interface AwsCli {
  /** Where it was found (`--aws-cli` or the PATH entry). */
  readonly path: string;
  /** Resolved path; this is what is executed. */
  readonly realpath: string;
  /** SHA-256 of the executed file. */
  readonly sha256: string;
  readonly version: string;
}

/** Pin hint printed when the CLI is not VERIFIED_CLI_VERSION. */
export const CLI_PIN_COMMAND = `nix shell github:NixOS/nixpkgs/${VERIFIED_CLI_NIXPKGS_REV}#awscli2`;

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const writableByOthers = (path: string): boolean => {
  try {
    return (statSync(path).mode & 0o022) !== 0;
  } catch {
    return true;
  }
};

/**
 * Finds the AWS CLI (`--aws-cli` or the first `aws` on an absolute PATH entry), refuses it when the
 * file, its directory or the directory it was found in is writable by group or others, records its
 * real path and SHA-256, and runs `aws --version` (local; no AWS request): v1 is refused, and so is
 * any v2 release other than VERIFIED_CLI_VERSION (the allowlist and the configuration checks were
 * verified against that release). Must only be called after the configuration check (awsconfig.ts):
 * even `aws --version` loads plugins from `~/.aws/config`.
 */
export async function resolveAwsCli(options: {
  explicitPath?: string | undefined;
  parentEnv: NodeJS.ProcessEnv;
  cwd: string;
  runner?: ProcessRunner | undefined;
}): Promise<AwsCli | { error: string }> {
  let path: string | undefined;
  if (options.explicitPath !== undefined) {
    const p = isAbsolute(options.explicitPath)
      ? options.explicitPath
      : resolve(options.cwd, options.explicitPath);
    if (!isExecutableFile(p)) return { error: `--aws-cli ${p} is not an executable file` };
    path = p;
  } else {
    for (const dir of (options.parentEnv['PATH'] ?? '').split(delimiter)) {
      // Relative PATH entries (".", "") are never searched.
      if (!dir || !isAbsolute(dir)) continue;
      const candidate = join(dir, 'aws');
      if (isExecutableFile(candidate)) {
        path = candidate;
        break;
      }
    }
    if (!path) return { error: 'the AWS CLI was not found on PATH (install v2 or pass --aws-cli)' };
  }
  let real: string;
  let sha256: string;
  try {
    real = realpathSync(path);
    if (!isExecutableFile(real)) return { error: `${real} is not an executable file` };
    sha256 = createHash('sha256').update(readFileSync(real)).digest('hex');
  } catch {
    return { error: `could not read the AWS CLI at ${path}` };
  }
  for (const [what, p] of [
    ['the AWS CLI file', real],
    ['the directory of the AWS CLI', dirname(real)],
    ['the directory the AWS CLI was found in', dirname(path)],
  ] as const) {
    if (writableByOthers(p)) {
      return { error: `${what} (${p}) is writable by group or others; use ${CLI_PIN_COMMAND}` };
    }
  }
  const { env } = buildChildEnv(options.parentEnv);
  const runner = options.runner ?? execFileRunner;
  const r = await runner({
    file: real,
    args: ['--version'],
    env,
    cwd: options.cwd,
    timeoutMs: 30_000,
    maxBuffer: 1024 * 1024,
  });
  // AWS CLI v1 printed its version on stderr; v2 prints `aws-cli/2.x.y Python/...` on stdout.
  const m = /\baws-cli\/(\d+)\.(\d+)\.(\d+)/.exec(`${r.stdout}\n${r.stderr}`);
  if (r.timedOut || r.spawnError !== undefined || !m) {
    return { error: `could not determine the AWS CLI version of ${path}` };
  }
  const version = `${m[1]}.${m[2]}.${m[3]}`;
  if (m[1] !== '2') return { error: `AWS CLI ${version} is not supported: AWS CLI v2 is required` };
  if (version !== VERIFIED_CLI_VERSION) {
    return {
      error: `AWS CLI ${version} is not the verified release ${VERIFIED_CLI_VERSION}; run with ${CLI_PIN_COMMAND} -c ...`,
    };
  }
  return { path, realpath: real, sha256, version };
}

// ── Probe execution ──────────────────────────────────────────────────────────────────────────

export interface CallRequest {
  readonly probeId: string;
  readonly region: Region;
  readonly values: PlaceholderValues;
}

export interface CallResult {
  readonly def: ProbeDef;
  readonly argv: readonly string[];
  readonly result: ProcessResult;
}

export interface Executor {
  readonly cli: AwsCli;
  /** The run's workload region: calls go to it or to the global-endpoint region only. */
  readonly workloadRegion: string;
  /** Names of the parent variables passed to the AWS CLI (values never recorded). */
  readonly passedThroughEnv: readonly string[];
  /** Called by the identity gate once it has passed; `discovery` probes are refused before. */
  unlockDiscovery(): void;
  call(request: CallRequest): Promise<CallResult>;
}

/** The complete AWS CLI argv (without the executable) for one allowlisted probe call. */
export function buildArgv(def: ProbeDef, request: Omit<CallRequest, 'probeId'>, profile: string) {
  const filter =
    def.vpcFilter && request.values.vpcId !== undefined
      ? renderArgs(def.vpcFilter, request.values)
      : [];
  return [
    def.service,
    def.operation,
    ...renderArgs(def.args, request.values),
    ...filter,
    ...boundArgs(def.bound),
    '--profile',
    profile,
    '--region',
    request.region,
    ...REQUIRED_GLOBAL_ARGS,
  ];
}

export function createExecutor(options: {
  cli: AwsCli;
  profile: string;
  parentEnv: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
  runner?: ProcessRunner | undefined;
  signal?: AbortSignal | undefined;
  /** Default DEFAULT_WORKLOAD_REGION; validated (an invalid region has no catalogue). */
  workloadRegion?: string | undefined;
}): Executor {
  if (!PATTERNS.profile.test(options.profile)) throw new BoundaryViolation('invalid profile name');
  const workloadRegion = options.workloadRegion ?? DEFAULT_WORKLOAD_REGION;
  let catalogue: ReturnType<typeof probesFor>;
  try {
    catalogue = probesFor(workloadRegion);
  } catch {
    throw new BoundaryViolation(`workload region ${workloadRegion.slice(0, 40)} is not allowed`);
  }
  const { env, passedThrough } = buildChildEnv(options.parentEnv);
  const runner = options.runner ?? execFileRunner;
  let discoveryUnlocked = false;
  return {
    cli: options.cli,
    workloadRegion,
    passedThroughEnv: passedThrough,
    unlockDiscovery() {
      discoveryUnlocked = true;
    },
    async call(request) {
      const def = catalogue.byId.get(request.probeId);
      if (!def) {
        throw new BoundaryViolation(`refusing to run "${request.probeId}": not in the allowlist`);
      }
      if (def.phase === 'discovery' && !discoveryUnlocked) {
        throw new BoundaryViolation(
          `refusing to run ${def.id}: discovery is locked until the identity gate has passed`,
        );
      }
      const argv = buildArgv(def, request, options.profile);
      // Independent of the registry: the boundary list, option allowlist and fixed globals.
      assertArgvSafe(argv, def, request.region, workloadRegion);
      const result = await runner({
        file: options.cli.realpath,
        args: argv,
        env,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        signal: options.signal,
      });
      return { def, argv, result };
    },
  };
}
