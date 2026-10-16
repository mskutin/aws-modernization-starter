/**
 * The exec boundary: the only place this package starts the AWS CLI. It runs `aws` with
 * `execFile` (never a shell), with an environment built from scratch (no AWS credentials or
 * profile variables pass through), only for operations in the read-only allowlist, and checks the
 * complete argv once more against the denylists immediately before the process starts.
 * Raw responses stay in memory: callers project them field by field; nothing here logs stdout.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_REGION } from '@starter/tool-finops';
import { maskString } from '../mask.js';
import { sandboxRegions } from '../model/prices.js';
import {
  DENIED_FLAGS,
  isDenied,
  OPERATION_RE,
  OPERATIONS_BY_KEY,
  RESERVED_FLAGS,
  VALUE_RESTRICTED,
  type OperationDef,
} from './allowlist.js';

export interface ProcessRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxBuffer: number;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputTooLarge?: boolean;
  /** The process could not be started (ENOENT, EACCES, ...). */
  readonly spawnError?: string | undefined;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Runs one process with execFile (no shell), closed stdin and a SIGKILL wall-clock timeout. */
export const execFileRunner: ProcessRunner = (request) =>
  new Promise((done) => {
    let timedOut = false;
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
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        const code = (error as NodeJS.ErrnoException | null)?.code;
        done({
          exitCode: child.exitCode,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut,
          outputTooLarge: code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          spawnError: child.pid === undefined && typeof code === 'string' ? code : undefined,
        });
      },
    );
    // The AWS CLI must never wait for input (prompts, auto-prompt, device flows).
    child.stdin?.end();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, request.timeoutMs);
  });

// ── Child environment ────────────────────────────────────────────────────────────────────────

/** Parent variables passed through by NAME (never AWS credentials, profiles or config paths). */
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

export const ENV_FIXED: Readonly<Record<string, string>> = {
  AWS_PAGER: '',
  AWS_CLI_AUTO_PROMPT: 'off',
  AWS_RETRY_MODE: 'standard',
  AWS_MAX_ATTEMPTS: '5',
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_CLI_ERROR_FORMAT: 'legacy',
  AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
  PYTHONNOUSERSITE: '1',
};

/** The child environment, built from scratch. */
export function buildChildEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (ENV_PASS_THROUGH.includes(name) || LOCALE_RE.test(name)) env[name] = value;
  }
  return { ...env, ...ENV_FIXED };
}

/** Static credentials (same list as the guard: tools/aws-preflight/src/sandbox.ts). */
export const STATIC_KEY_VARS: readonly string[] = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
];

/**
 * Variables that select another profile, credential source, configuration, endpoint or model
 * (same list as the guard's REDIRECT_VARS, plus AWS_ENDPOINT_URL*).
 */
export const REDIRECT_VARS: readonly string[] = [
  'AWS_DEFAULT_PROFILE',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_DATA_PATH',
  'PYTHONPATH',
];

/**
 * Problems of the operator environment (empty = acceptable), mirroring the guard's
 * sandboxEnvProblems and CI refusal: a variable counts when it is SET (even empty). The guard
 * itself also receives the real environment and refuses on its own. Values are never printed, and
 * the secret-key / session-token variables are not named literally (console leak scanner).
 */
export function parentEnvProblems(
  parent: NodeJS.ProcessEnv,
  profile: string,
  region = DEFAULT_REGION,
): string[] {
  const problems: string[] = [];
  const isSet = (name: string) => parent[name] !== undefined;
  const keys = STATIC_KEY_VARS.filter(isSet);
  if (keys.length > 0) {
    problems.push(
      `static credentials in the environment (${keys.length} variable(s)); unset them, the sandbox uses the IAM Identity Center profile only`,
    );
  }
  const redirects = [
    ...REDIRECT_VARS.filter(isSet),
    ...Object.keys(parent)
      .filter((n) => /^AWS_ENDPOINT_URL(?:_[A-Z0-9_]+)?$/.test(n))
      .sort(),
  ];
  if (redirects.length > 0) {
    problems.push(
      `the environment selects another profile, credential source, configuration, endpoint or model (${redirects.join(', ')}); unset them`,
    );
  }
  if (isSet('AWS_PROFILE') && parent['AWS_PROFILE'] !== profile) {
    problems.push('AWS_PROFILE is set to a different profile than --profile');
  }
  for (const name of ['AWS_REGION', 'AWS_DEFAULT_REGION']) {
    if (isSet(name) && parent[name] !== region) {
      problems.push(`${name} is set to a different region than --region`);
    }
  }
  if (isSet('CI') || isSet('GITLAB_CI')) {
    problems.push(
      'CI/GITLAB_CI is set: AWS reads are operator-run only (CI runs the offline tests)',
    );
  }
  return problems;
}

// ── AWS CLI resolution ───────────────────────────────────────────────────────────────────────

export interface AwsCliInfo {
  readonly path: string;
  readonly realpath: string;
  readonly sha256: string;
}

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

/** `--aws-cli` or the first `aws` on an absolute PATH entry; refuses group/world-writable files. */
export function resolveAwsCli(options: {
  explicitPath?: string | undefined;
  parentEnv: NodeJS.ProcessEnv;
  cwd: string;
}): AwsCliInfo | { error: string } {
  let path: string | undefined;
  if (options.explicitPath !== undefined) {
    const p = isAbsolute(options.explicitPath)
      ? options.explicitPath
      : resolve(options.cwd, options.explicitPath);
    if (!isExecutableFile(p)) return { error: `--aws-cli ${p} is not an executable file` };
    path = p;
  } else {
    for (const dir of (options.parentEnv['PATH'] ?? '').split(delimiter)) {
      if (!dir || !isAbsolute(dir)) continue;
      const candidate = join(dir, 'aws');
      if (isExecutableFile(candidate)) {
        path = candidate;
        break;
      }
    }
    if (!path) return { error: 'the AWS CLI was not found on PATH (install v2 or pass --aws-cli)' };
  }
  try {
    const real = realpathSync(path);
    for (const p of [real, dirname(real)]) {
      if (writableByOthers(p)) return { error: `${p} is writable by group or others` };
    }
    const sha256 = createHash('sha256').update(readFileSync(real)).digest('hex');
    return { path, realpath: real, sha256 };
  } catch {
    return { error: `could not read the AWS CLI at ${path}` };
  }
}

// ── Calls ────────────────────────────────────────────────────────────────────────────────────

export type AwsErrorKind =
  | 'access-denied'
  | 'not-found'
  | 'throttled'
  | 'credentials'
  | 'timeout'
  | 'truncated'
  | 'invalid-json'
  | 'cli-error';

export interface AwsCallError {
  readonly kind: AwsErrorKind;
  readonly code: string;
  /** First line of the error, account ids masked, at most 300 characters. Never stdout. */
  readonly message: string;
}

export type AwsCallResult =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly error: AwsCallError };

export interface CallRecord {
  readonly service: string;
  readonly operation: string;
  readonly iamAction: string;
  readonly ok: boolean;
  readonly errorCode?: string;
}

export interface AwsCli {
  readonly info: AwsCliInfo;
  readonly records: readonly CallRecord[];
  /** The verified CLI version, once the first call has checked it. */
  version(): string | undefined;
  call(service: string, operation: string, args?: readonly string[]): Promise<AwsCallResult>;
}

/**
 * The AWS CLI release the guard and the discovery tool were verified against
 * (tools/aws-preflight/src/probes.ts VERIFIED_CLI_VERSION; a test keeps them equal).
 */
export const VERIFIED_AWS_CLI_VERSION = '2.35.11';
export const AWS_CLI_PIN_COMMAND =
  'nix shell github:NixOS/nixpkgs/e8be7818e19ada32105a8af937a6a473b38167ca#awscli2';

/** The AWS CLI is not the verified release (or its version cannot be read): nothing is called. */
export class AwsCliRefused extends Error {
  override name = 'AwsCliRefused';
}

export class BoundaryViolation extends Error {
  override name = 'BoundaryViolation';
}

/**
 * Regions an AWS call may target: those with committed sandbox price data (`sandboxRegions`, the
 * default region ap-southeast-1 today). Each executor is further pinned to ONE configured region
 * (`--region`), which every argv must carry exactly.
 */
export const ALLOWED_REGIONS: readonly string[] = Object.freeze(sandboxRegions());
export const PROFILE_RE = /^[A-Za-z0-9_.@+-]{1,64}$/;
const VALUE_RE = /^[A-Za-z0-9_.:/=,@+*#-]{1,2048}$/;

/** Every global option appended to a call, after `--profile <p> --region <r>`. */
export const GLOBAL_ARGS: readonly string[] = [
  '--output',
  'json',
  '--no-cli-pager',
  '--cli-connect-timeout',
  '10',
  '--cli-read-timeout',
  '60',
];

/** Validates a call's own arguments against its definition; throws BoundaryViolation. */
export function assertArgsAllowed(def: OperationDef, args: readonly string[]): void {
  const fail = (why: string): never => {
    throw new BoundaryViolation(`refusing ${def.service} ${def.operation}: ${why}`);
  };
  let expectValue = false;
  let option: string | undefined;
  for (const token of args) {
    if (token.startsWith('-')) {
      if (!token.startsWith('--')) fail(`short option ${token}`);
      if (DENIED_FLAGS.some((f) => token === f || token.startsWith(`${f}=`)))
        fail(`denied flag ${token}`);
      if (RESERVED_FLAGS.some((f) => token === f || token.startsWith(`${f}=`))) {
        fail(`reserved flag ${token}`);
      }
      if (token.includes('=')) fail(`option ${token} must be passed as two tokens`);
      if (def.options.includes(token)) {
        expectValue = true;
        option = token;
      } else if (def.flags?.includes(token)) {
        expectValue = false;
        option = undefined;
      } else fail(`option ${token} is not allowed for this operation`);
      continue;
    }
    if (!VALUE_RE.test(token)) fail('an argument value has disallowed characters');
    const pinned = option ? def.fixedValues?.[option] : undefined;
    if (pinned && !pinned.includes(token)) fail(`${option} may only be ${pinned.join(', ')}`);
    if (VALUE_RESTRICTED.includes(`${def.service} ${def.operation}`) && !pinned) {
      fail('a value-restricted operation takes pinned values only');
    }
    expectValue = false;
  }
  if (expectValue) fail('an option has no value');
}

/** The complete argv (without the executable). */
export function buildArgv(
  def: OperationDef,
  args: readonly string[],
  profile: string,
  region: string,
): string[] {
  return [
    def.service,
    def.operation,
    ...args,
    '--profile',
    profile,
    '--region',
    region,
    ...GLOBAL_ARGS,
  ];
}

/** Independent final check of a complete argv immediately before it is spawned. */
export function assertArgvSafe(argv: readonly string[], profile: string, region: string): void {
  const fail = (why: string): never => {
    throw new BoundaryViolation(`refusing to run aws ${argv[0]} ${argv[1]}: ${why}`);
  };
  const [service = '', operation = ''] = argv;
  const def = OPERATIONS_BY_KEY.get(`${service} ${operation}`);
  if (!def) fail('not in the read-only allowlist');
  if (!OPERATION_RE.test(operation)) fail('not a list-/describe-/get- operation');
  if (isDenied(service, operation)) fail('denylisted');
  if (!ALLOWED_REGIONS.includes(region)) fail(`region ${region} is not allowed`);
  if (!PROFILE_RE.test(profile)) fail('invalid profile name');
  for (const t of argv) {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(t)) fail('control character in argv');
    if (DENIED_FLAGS.some((f) => t === f || t.startsWith(`${f}=`))) fail(`denied flag ${t}`);
  }
  const once = (flag: string) => {
    const n = argv.filter((t) => t === flag).length;
    if (n !== 1) fail(`${flag} must appear exactly once`);
    return argv[argv.indexOf(flag) + 1];
  };
  if (once('--profile') !== profile) fail('--profile does not match');
  if (once('--region') !== region) fail('--region does not match');
  if (once('--output') !== 'json') fail('--output must be json');
  once('--no-cli-pager');
  // Reviewed value-returning reads: exactly the pinned option/value pairs, nothing else.
  if (VALUE_RESTRICTED.includes(`${service} ${operation}`)) {
    const own = argv.slice(2, argv.indexOf('--profile'));
    const pairs = Object.entries(def?.fixedValues ?? {});
    const ok =
      own.length === pairs.length * 2 &&
      pairs.every(([opt, values]) => {
        const at = own.indexOf(opt);
        return at >= 0 && at % 2 === 0 && values.includes(own[at + 1] ?? '');
      });
    if (!ok) fail('a value-restricted operation must use exactly its pinned values');
  }
}

const ACCESS_DENIED =
  /^(AccessDenied|AccessDeniedException|UnauthorizedOperation|AuthorizationError|UnauthorizedAccess|Forbidden|AuthFailure)$/;
const NOT_FOUND = /(NotFound|NoSuch|DoesNotExist|DBInstanceNotFound|DBSnapshotNotFound)/;
const THROTTLED =
  /^(Throttling|ThrottlingException|TooManyRequestsException|RequestLimitExceeded|ThrottledException|SlowDown)$/;
const CREDENTIALS =
  /(Unable to locate credentials|Token has expired|Error when retrieving token from sso|SSO session associated with this profile has expired|ExpiredToken|InvalidClientTokenId|The config profile .* could not be found|UnrecognizedClientException)/i;

export function classifyError(result: ProcessResult): AwsCallError {
  if (result.timedOut)
    return { kind: 'timeout', code: 'Timeout', message: 'the AWS CLI timed out' };
  if (result.spawnError) {
    return {
      kind: 'cli-error',
      code: result.spawnError,
      message: 'the AWS CLI could not be started',
    };
  }
  if (result.outputTooLarge) {
    return {
      kind: 'truncated',
      code: 'OutputTooLarge',
      message: 'the response exceeded the output limit',
    };
  }
  const stderr = result.stderr;
  const firstLine =
    stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? `exit code ${result.exitCode}`;
  const message = maskString(firstLine).slice(0, 300);
  const code = /An error occurred \(([A-Za-z0-9.]+)\)/.exec(stderr)?.[1] ?? 'CliError';
  if (
    CREDENTIALS.test(stderr) ||
    /^(ExpiredToken|InvalidClientTokenId|UnrecognizedClientException)$/.test(code)
  ) {
    return { kind: 'credentials', code, message };
  }
  if (ACCESS_DENIED.test(code)) return { kind: 'access-denied', code, message };
  if (THROTTLED.test(code)) return { kind: 'throttled', code, message };
  if (NOT_FOUND.test(code) || (code === 'ValidationError' && /does not exist/i.test(stderr))) {
    return { kind: 'not-found', code, message };
  }
  return { kind: 'cli-error', code, message };
}

/**
 * A continuation the CLI did not follow (operations it does not auto-paginate). The listing is
 * then incomplete, which makes a clean verdict impossible.
 */
export function hasContinuation(data: Record<string, unknown>): boolean {
  const tokenKeys = [
    'NextToken',
    'nextToken',
    'NextMarker',
    'PaginationToken',
    'NextContinuationToken',
    'ContinuationToken', // s3api list-buckets
    'LastEvaluatedBackupArn', // dynamodb list-backups
  ];
  const check = (o: Record<string, unknown>): boolean =>
    tokenKeys.some((k) => typeof o[k] === 'string' && (o[k] as string).length > 0) ||
    o['IsTruncated'] === true;
  if (check(data)) return true;
  for (const v of Object.values(data)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && check(v as Record<string, unknown>)) {
      return true;
    }
  }
  return false;
}

export function createAwsCli(options: {
  info: AwsCliInfo;
  profile: string;
  region: string;
  parentEnv: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
  runner?: ProcessRunner;
}): AwsCli {
  if (!PROFILE_RE.test(options.profile)) throw new BoundaryViolation('invalid profile name');
  if (!ALLOWED_REGIONS.includes(options.region)) {
    throw new BoundaryViolation(`region ${options.region} is not allowed`);
  }
  const env = buildChildEnv(options.parentEnv);
  const runner = options.runner ?? execFileRunner;
  const records: CallRecord[] = [];
  let version: string | undefined;
  // `aws --version` makes no AWS request; it runs lazily, i.e. after the first guard check (the
  // guard refuses unsafe ~/.aws configurations, which even --version would load).
  const ensureVersion = async () => {
    if (version) return;
    const r = await runner({
      file: options.info.realpath,
      args: ['--version'],
      env,
      cwd: options.cwd,
      timeoutMs: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const m = /\baws-cli\/(\d+\.\d+\.\d+)/.exec(`${r.stdout}\n${r.stderr}`);
    if (r.timedOut || r.spawnError || !m?.[1]) {
      throw new AwsCliRefused('could not determine the AWS CLI version');
    }
    if (m[1] !== VERIFIED_AWS_CLI_VERSION) {
      throw new AwsCliRefused(
        `AWS CLI ${m[1]} is not the verified release ${VERIFIED_AWS_CLI_VERSION}; run with ${AWS_CLI_PIN_COMMAND} -c ...`,
      );
    }
    version = m[1];
  };
  return {
    info: options.info,
    records,
    version: () => version,
    async call(service, operation, args = []) {
      const def = OPERATIONS_BY_KEY.get(`${service} ${operation}`);
      if (!def)
        throw new BoundaryViolation(`refusing ${service} ${operation}: not in the allowlist`);
      assertArgsAllowed(def, args);
      const argv = buildArgv(def, args, options.profile, options.region);
      assertArgvSafe(argv, options.profile, options.region);
      await ensureVersion();
      const result = await runner({
        file: options.info.realpath,
        args: argv,
        env,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs ?? 120_000,
        maxBuffer: MAX_OUTPUT_BYTES,
      });
      const record = (ok: boolean, errorCode?: string) =>
        records.push({
          service,
          operation,
          iamAction: def.iamAction,
          ok,
          ...(errorCode ? { errorCode } : {}),
        });
      if (result.exitCode !== 0 || result.timedOut || result.spawnError) {
        const error = classifyError(result);
        record(false, error.code);
        return { ok: false, error };
      }
      let data: unknown;
      try {
        data = result.stdout.trim() === '' ? {} : JSON.parse(result.stdout);
      } catch {
        record(false, 'InvalidJson');
        return {
          ok: false,
          error: {
            kind: 'invalid-json',
            code: 'InvalidJson',
            message: 'the AWS CLI output is not JSON',
          },
        };
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        record(false, 'UnexpectedShape');
        return {
          ok: false,
          error: {
            kind: 'invalid-json',
            code: 'UnexpectedShape',
            message: 'the AWS CLI output is not a JSON object',
          },
        };
      }
      const obj = data as Record<string, unknown>;
      if (hasContinuation(obj)) {
        record(false, 'Truncated');
        return {
          ok: false,
          error: {
            kind: 'truncated',
            code: 'Truncated',
            message: 'the listing has more pages than the CLI returned',
          },
        };
      }
      record(true);
      return { ok: true, data: obj };
    },
  };
}
