/**
 * Execution profiles and the checks shared by the `personal-sandbox` discovery run and the
 * mutation guard (guard.ts).
 *
 * - `strict` (default): the revision-2 behavior, unchanged. Read-only discovery for a governed
 *   account; an administrator-equivalent identity is a hard stop (exit 5, no override).
 * - `personal-sandbox`: an ordinary, dedicated sandbox account whose owner authorizes the
 *   operator's own permission set, even an administrator-equivalent one, in that account only.
 *   It needs the exact expected account, an explicit named profile (never `default`), the allowed
 *   region, a human-written `--owner-authorization` (discovery) and an environment that cannot
 *   redirect credentials, profile, region or endpoints. Discovery itself stays read-only through
 *   the same allowlist, exec boundary and configuration refusals.
 *
 * Nothing in this module starts a process or reads credentials.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CdkSettingsFile } from './awsconfig.ts';
import { leakRulesIn } from './leak.ts';
import { workloadRegionProblem } from './region.ts';
import { maskAccount, operatorTextProblem } from './validate.ts';

export const EXECUTION_PROFILES = ['strict', 'personal-sandbox'] as const;
export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];

export const isExecutionProfile = (value: unknown): value is ExecutionProfile =>
  typeof value === 'string' && (EXECUTION_PROFILES as readonly string[]).includes(value);

/**
 * Why `region` may not be the region of a personal-sandbox run (discovery or guard), or undefined:
 * any region of the aws partition (default ap-southeast-1); the caller pins exactly one and the
 * environment must not name another (`sandboxEnvProblems`).
 */
export const sandboxRegionProblem = (region: unknown): string | undefined =>
  workloadRegionProblem(region);

/**
 * Name prefixes kept readable in personal-sandbox evidence besides the project's own (`starter*`,
 * `starter-it-*`): the sandbox stage's CloudFormation stacks and the construct-path `Name` tags
 * CDK derives from them (`Sandbox-Foundation/...`). They show whether such resources pre-exist.
 */
export const SANDBOX_KEEP_NAME_PREFIXES: readonly string[] = ['Sandbox-'];

// ── Environment ──────────────────────────────────────────────────────────────────────────────

/** Static credentials: refused outright (the sandbox runs on an IAM Identity Center session). */
export const STATIC_KEY_VARS: readonly string[] = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
];

/**
 * Variables that select another profile, credential source, configuration file, endpoint or
 * service model for a child AWS CLI / SDK process. The guard's STS check would then not describe
 * what the guarded command uses, so they are refused (the discovery child never receives them).
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
 * How a static-key variable is named in messages: the console leak scanner suppresses any line
 * that names the secret-key or session-token variables literally.
 */
const staticKeyLabel = (name: string): string =>
  name === 'AWS_SECRET_ACCESS_KEY'
    ? 'the AWS secret access key variable'
    : name === 'AWS_SESSION_TOKEN'
      ? 'the AWS session token variable'
      : name;

export interface EnvProblem {
  readonly kind: 'environment' | 'region';
  /** Names only; values are never printed. */
  readonly message: string;
}

/**
 * Every reason the environment conflicts with the explicitly selected profile and region. A
 * variable counts as set when it is defined, even when empty.
 */
export function sandboxEnvProblems(
  env: NodeJS.ProcessEnv,
  selected: { readonly profile: string; readonly region: string },
): EnvProblem[] {
  const problems: EnvProblem[] = [];
  const isSet = (name: string) => env[name] !== undefined;
  const keys = STATIC_KEY_VARS.filter(isSet);
  if (keys.length > 0) {
    problems.push({
      kind: 'environment',
      message: `static credentials in the environment (${keys.map(staticKeyLabel).join(', ')}); unset them, the sandbox uses the IAM Identity Center profile only`,
    });
  }
  const redirects = [
    ...REDIRECT_VARS.filter(isSet),
    ...Object.keys(env)
      .filter((n) => /^AWS_ENDPOINT_URL(?:_[A-Z0-9_]+)?$/.test(n) && isSet(n))
      .sort(),
  ];
  if (redirects.length > 0) {
    problems.push({
      kind: 'environment',
      message: `the environment selects another profile, credential source, configuration, endpoint or model (${redirects.join(', ')}); unset them`,
    });
  }
  if (isSet('AWS_PROFILE') && env['AWS_PROFILE'] !== selected.profile) {
    problems.push({
      kind: 'environment',
      message:
        'AWS_PROFILE is set to a different profile than --profile; unset it or make it equal',
    });
  }
  for (const name of ['AWS_REGION', 'AWS_DEFAULT_REGION']) {
    if (isSet(name) && env[name] !== selected.region) {
      problems.push({
        kind: 'region',
        message: `${name} is set to a different region than --region; unset it or make it equal`,
      });
    }
  }
  return problems;
}

// ── Profile ──────────────────────────────────────────────────────────────────────────────────

/** Why `--profile` cannot select the sandbox profile explicitly (undefined = fine). */
export function sandboxProfileProblem(profile: string | undefined): string | undefined {
  if (profile === undefined || profile.trim() === '') {
    return '--profile is required: select the sandbox profile explicitly';
  }
  if (!/^(?!-)[A-Za-z0-9_.+-]{1,64}$/.test(profile)) {
    return '--profile must be a profile name (letters, digits, _ . + -; max 64; no leading -)';
  }
  if (profile === 'default') {
    return '--profile default is refused: the default profile is never used in personal-sandbox';
  }
  return undefined;
}

/** A profile name with digits could carry an account ID; it is printed as `<profile>`. */
export const profileLabelOf = (profile: string): string =>
  /\d/.test(profile) ? '<profile>' : profile;

// ── Expected account file ────────────────────────────────────────────────────────────────────

const uid = (): number | undefined =>
  typeof process.getuid === 'function' ? process.getuid() : undefined;

/**
 * Reads the expected account from a private file (`$SANDBOX_HOME/expected-account`): a regular
 * file (not a symbolic link) owned by the current user, without any group or other permission,
 * holding exactly 12 digits (one trailing newline allowed). The content is never printed.
 */
export function readExpectedAccountFile(
  path: string,
): { readonly account: string } | { readonly error: string } {
  // One descriptor for every check and the read: no window to swap the file for a link.
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ELOOP' || code === 'EMLINK'
      ? { error: 'the expected-account file is a symbolic link' }
      : { error: 'the expected-account file does not exist or cannot be read' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { error: 'the expected-account file is not a regular file' };
    const me = uid();
    if (me !== undefined && st.uid !== me) {
      return { error: 'the expected-account file is not owned by the current user' };
    }
    if ((st.mode & 0o077) !== 0) {
      return {
        error: `the expected-account file has mode ${(st.mode & 0o777).toString(8)}; it must be private (0600)`,
      };
    }
    if (st.size > 64) return { error: 'the expected-account file is not a 12-digit account ID' };
    const text = readFileSync(fd, 'utf8');
    const value = text.endsWith('\n') ? text.slice(0, -1) : text;
    if (!/^\d{12}$/.test(value)) {
      return { error: 'the expected-account file must hold exactly one 12-digit account ID' };
    }
    return { account: value };
  } catch {
    return { error: 'the expected-account file cannot be read' };
  } finally {
    closeSync(fd);
  }
}

// ── CDK settings files ───────────────────────────────────────────────────────────────

/** The nearest ancestor holding pnpm-workspace.yaml (the repository root), if any. */
export function findRepoRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The CDK settings files whose `profile` key the CDK CLI would prefer over `AWS_PROFILE`:
 * `~/.cdk.json`, `cdk.json` in the working directory (where a guarded `cdk` runs) and the
 * project's `infra/cdk.json`.
 */
export function cdkSettingsFiles(
  home: string,
  cwd: string,
  repoRoot: string | undefined,
): CdkSettingsFile[] {
  const files: CdkSettingsFile[] = [
    { path: join(home, '.cdk.json'), label: '~/.cdk.json' },
    { path: resolve(cwd, 'cdk.json'), label: 'cdk.json in the working directory' },
    ...(repoRoot ? [{ path: join(repoRoot, 'infra', 'cdk.json'), label: 'infra/cdk.json' }] : []),
  ];
  const seen = new Set<string>();
  return files.filter((f) => !seen.has(f.path) && seen.add(f.path));
}

// ── Owner authorization ──────────────────────────────────────────────────────────────────────

/**
 * `--owner-authorization` is a statement the account owner writes and enters personally (who,
 * when, why; naming the permission set and the dedicated sandbox). It is copied verbatim into
 * committable evidence, so it must already pass the leak scanner (no e-mail addresses, account
 * IDs, phone numbers or key material), and template placeholders are refused.
 */
export function ownerAuthorizationProblem(text: string): string | undefined {
  const problem = operatorTextProblem(text);
  if (problem) return problem;
  if (/[<>]/.test(text)) {
    return 'must not contain < or > (a template placeholder is not an owner statement)';
  }
  return undefined;
}

// ── Principal ────────────────────────────────────────────────────────────────────────────────

/**
 * A caller ARN for logs and evidence: the account becomes `********NNNN`, the role session name
 * (usually the person's user name or e-mail address) `<session>`, IAM and federated user names
 * `<user>`. Unrecognized shapes are not echoed.
 */
export function maskPrincipalArn(arn: string): string {
  const m = /^arn:(aws[a-z-]*):(sts|iam)::(\d{12}):(.+)$/.exec(arn);
  if (!m) return '<unrecognized-principal>';
  const [, partition, service, account = '', resource = ''] = m;
  const prefix = `arn:${partition}:${service}::${maskAccount(account)}:`;
  const role = /^assumed-role\/([A-Za-z0-9+=,.@_-]{1,64})\/.+$/.exec(resource);
  if (service === 'sts' && role?.[1]) return `${prefix}assumed-role/${role[1]}/<session>`;
  if (service === 'iam' && resource === 'root') return `${prefix}root`;
  if (service === 'iam' && resource.startsWith('user/')) return `${prefix}user/<user>`;
  if (service === 'sts' && resource.startsWith('federated-user/')) {
    return `${prefix}federated-user/<user>`;
  }
  return `${prefix}<other>`;
}

// ── Labels and the private JSON-lines log ────────────────────────────────────────────────────

/** A guard label names the mutation about to run; it is logged, so it must be leak-free. */
export function labelProblem(label: string | undefined): string | undefined {
  if (label === undefined || label.trim() === '')
    return '--label is required (what is about to run)';
  if (label.length > 200) return '--label must be at most 200 characters';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(label))
    return '--label must be one line without control characters';
  const hits = leakRulesIn(label);
  if (hits.length > 0) {
    return `--label must not contain ${hits.join(', ')} (it is written to the guard log)`;
  }
  return undefined;
}

/**
 * Opens (creating it 0600 if needed) the guard log for appending: never through a symbolic link,
 * only a regular file owned by the current user without group or other permissions.
 */
export function openPrivateLog(path: string): { readonly fd: number } | { readonly error: string } {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      error:
        code === 'ELOOP' || code === 'EMLINK'
          ? 'the guard log is a symbolic link'
          : `the guard log cannot be opened for appending (${code ?? 'error'}); its directory must exist`,
    };
  }
  const st = fstatSync(fd);
  const me = uid();
  const problem = !st.isFile()
    ? 'the guard log is not a regular file'
    : me !== undefined && st.uid !== me
      ? 'the guard log is not owned by the current user'
      : (st.mode & 0o077) !== 0
        ? `the guard log has mode ${(st.mode & 0o777).toString(8)}; it must be private (0600)`
        : undefined;
  if (problem) {
    closeSync(fd);
    return { error: problem };
  }
  return { fd };
}

/** Appends one line (a single write, O_APPEND) and closes the log. */
export function appendLine(fd: number, line: string): void {
  try {
    writeSync(fd, `${line}\n`);
  } finally {
    closeSync(fd);
  }
}
