/**
 * Mutation guard (README "Mutation guard"): run immediately before EVERY
 * mutating AWS command of a personal-sandbox run. One `sts get-caller-identity` per invocation,
 * through the same machinery as discovery:
 *
 * - the AWS CLI is resolved and pinned exactly like discovery (`resolveAwsCli`: exactly
 *   VERIFIED_CLI_VERSION, not writable by group or others), after the offline `~/.aws` refusals
 *   (`checkAwsCliConfig`), which also compare the profile's `sso_account_id` with the expected
 *   account before any process starts;
 * - the call is the allowlisted `identity.caller` probe through the exec boundary (`execFile`, no
 *   shell, a child environment built from scratch, `--profile` and `--region` explicit);
 * - the caller must be an assumed role in the expected account (optionally matching
 *   `--expected-role-pattern`), the region must be allowed, the profile explicit (never
 *   `default`), and the environment must not carry static keys, `AWS_DEFAULT_PROFILE`, a different
 *   `AWS_PROFILE` / `AWS_REGION` / `AWS_DEFAULT_REGION` or credential / endpoint redirects, because
 *   the guarded command inherits that environment.
 *
 * On success it prints one JSON line (account `********NNNN`, principal ARN with account and
 * session masked) and appends it to the private log; every refusal has its own exit code and is
 * appended to the log as a `refused` line when the log is already open. The guard verifies the
 * identity a command will use; it cannot see or limit what the command then does.
 */
import { isAbsolute, resolve } from 'node:path';
import { checkAwsCliConfig, fallbackIdentityProblems } from './awsconfig.ts';
import { classify } from './errors.ts';
import { createExecutor, resolveAwsCli, type ProcessRunner } from './executor.ts';
import { parsePrincipal } from './gate.ts';
import { scanValue } from './leak.ts';
import {
  appendLine,
  cdkSettingsFiles,
  isExecutionProfile,
  labelProblem,
  maskPrincipalArn,
  openPrivateLog,
  profileLabelOf,
  readExpectedAccountFile,
  sandboxRegionProblem,
  sandboxEnvProblems,
  sandboxProfileProblem,
} from './sandbox.ts';
import { preGateConsoleMask } from './sanitize.ts';
import { isRecord, type Region } from './types.ts';
import { compileRolePattern, maskAccount, PATTERNS } from './validate.ts';

/** Exit codes of `guard-cli.js check` and of the shell helper (README "Mutation guard"). */
export const GUARD_EXIT = {
  /** Verified: the command may run. */
  VERIFIED: 0,
  /** Internal error (nothing verified). */
  ERROR: 1,
  /** Usage: arguments, label, expected-account file, CI, or the strict profile (never mutates). */
  USAGE: 2,
  /** The caller's account (or the profile's sso_account_id, offline) is not the expected one. */
  ACCOUNT_MISMATCH: 3,
  /** Root, IAM user, federated user, or a role outside --expected-role-pattern. */
  PRINCIPAL_REJECTED: 4,
  /** SSO session expired or credentials invalid: `aws sso login --profile <p>`. */
  CREDENTIALS: 6,
  /** --region not allowed, or AWS_REGION / AWS_DEFAULT_REGION differ from it. */
  REGION: 10,
  /** --profile missing, blank or `default`, or not defined in ~/.aws/config. */
  NO_PROFILE: 11,
  /** Static keys, AWS_DEFAULT_PROFILE, a different AWS_PROFILE, or a credential/endpoint redirect. */
  ENVIRONMENT: 12,
  /** sts get-caller-identity failed (network, throttling, timeout, unexpected output). */
  STS_FAILURE: 13,
  /** The AWS CLI is missing, not the pinned release, or writable by group or others. */
  AWS_CLI: 14,
  /**
   * ~/.aws holds configuration that could redirect or replace the call, or an identity a command
   * could fall back to ([default] profile, ~/.aws/credentials, a CDK `profile` setting).
   */
  AWS_CONFIG: 15,
  /** The guard log cannot be written privately. */
  LOG: 16,
  /** dist/ was built from other sources than src/ (rebuild), or the guard is not runnable. */
  STALE_BUILD: 17,
  /** SIGINT/SIGTERM. */
  INTERRUPTED: 130,
} as const;
export type GuardExit = (typeof GUARD_EXIT)[keyof typeof GUARD_EXIT];

const REASON: Readonly<Record<number, string>> = {
  [GUARD_EXIT.ERROR]: 'error',
  [GUARD_EXIT.USAGE]: 'usage',
  [GUARD_EXIT.ACCOUNT_MISMATCH]: 'account-mismatch',
  [GUARD_EXIT.PRINCIPAL_REJECTED]: 'principal-rejected',
  [GUARD_EXIT.CREDENTIALS]: 'credentials',
  [GUARD_EXIT.REGION]: 'region',
  [GUARD_EXIT.NO_PROFILE]: 'no-profile',
  [GUARD_EXIT.ENVIRONMENT]: 'environment',
  [GUARD_EXIT.STS_FAILURE]: 'sts-failure',
  [GUARD_EXIT.AWS_CLI]: 'aws-cli',
  [GUARD_EXIT.AWS_CONFIG]: 'aws-config',
  [GUARD_EXIT.LOG]: 'log',
  [GUARD_EXIT.STALE_BUILD]: 'stale-build',
  [GUARD_EXIT.INTERRUPTED]: 'interrupted',
};

export const DEFAULT_GUARD_CALL_TIMEOUT_SECONDS = 60;

export interface GuardArgs {
  readonly executionProfile?: string | undefined;
  readonly profile?: string | undefined;
  readonly expectedAccountFile?: string | undefined;
  readonly region?: string | undefined;
  readonly label?: string | undefined;
  readonly log?: string | undefined;
  readonly expectedRolePattern?: string | undefined;
  readonly awsCli?: string | undefined;
  readonly callTimeout?: string | undefined;
}

export interface GuardDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly runner?: ProcessRunner;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  /** SHA-256 of the tool sources that run (provenance.ts), recorded in every line. */
  readonly toolSourceSha256?: string;
  /** A reason the build cannot be trusted (stale dist/), or undefined. */
  readonly buildProblem?: string | undefined;
  /** Repository root, for the project's infra/cdk.json. */
  readonly repoRoot?: string | undefined;
}

type Line = Record<string, string | number | null>;

export async function runGuardCheck(args: GuardArgs, deps: GuardDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? (() => new Date());
  const out = deps.stdout ?? ((line: string) => console.log(line));
  const err = deps.stderr ?? ((line: string) => console.error(line));

  // Fields logged with every line once they are known to be safe.
  const known: Line = {
    label: null,
    region: null,
    profile: null,
    executionProfile: null,
  };
  let logFd: number | undefined;
  const refuse = (code: GuardExit, message: string, extra: Line = {}): number => {
    const reason = REASON[code] ?? 'error';
    err(preGateConsoleMask(`GUARD REFUSED (exit ${code}, ${reason}) — ${message}`));
    if (logFd !== undefined) {
      const fd = logFd;
      logFd = undefined;
      try {
        appendLine(
          fd,
          JSON.stringify({
            time: now().toISOString(),
            result: 'refused',
            reason,
            exitCode: code,
            ...known,
            ...extra,
            toolSourceSha256: deps.toolSourceSha256 ?? null,
          }),
        );
      } catch {
        err('GUARD — the refusal could not be appended to the guard log');
      }
    }
    return code;
  };

  // ── 1. Never in a pipeline; never the strict profile ──────────────────────────────────────
  if (env['CI'] !== undefined || env['GITLAB_CI'] !== undefined) {
    return refuse(
      GUARD_EXIT.USAGE,
      'CI or GITLAB_CI is set: the personal-sandbox guard is for a human-operated SSO session only.',
    );
  }
  const executionProfile = args.executionProfile ?? 'strict';
  if (!isExecutionProfile(executionProfile)) {
    return refuse(GUARD_EXIT.USAGE, '--execution-profile must be strict or personal-sandbox');
  }
  if (executionProfile !== 'personal-sandbox') {
    return refuse(
      GUARD_EXIT.USAGE,
      'the strict execution profile never authorizes a mutation. The guard runs only with --execution-profile personal-sandbox (a dedicated sandbox account).',
    );
  }
  known['executionProfile'] = executionProfile;

  // ── 2. Arguments and environment (no file is read, no process started) ───────────────────
  const labelIssue = labelProblem(args.label);
  if (labelIssue || args.label === undefined) {
    return refuse(GUARD_EXIT.USAGE, labelIssue ?? '--label is required');
  }
  const label = args.label;
  known['label'] = label;
  const profileIssue = sandboxProfileProblem(args.profile);
  if (profileIssue || args.profile === undefined) {
    return refuse(GUARD_EXIT.NO_PROFILE, profileIssue ?? '--profile is required');
  }
  const profile = args.profile;
  const profileLabel = profileLabelOf(profile);
  known['profile'] = profileLabel;
  const regionIssue = args.region === undefined ? 'missing' : sandboxRegionProblem(args.region);
  if (regionIssue !== undefined || args.region === undefined) {
    return refuse(
      GUARD_EXIT.REGION,
      `--region is required and must be an aws-partition region (${regionIssue ?? 'missing'})`,
    );
  }
  const region: Region = args.region;
  known['region'] = region;
  const envProblems = sandboxEnvProblems(env, { profile, region });
  const envConflicts = envProblems.filter((p) => p.kind === 'environment');
  if (envConflicts.length > 0) {
    return refuse(GUARD_EXIT.ENVIRONMENT, envConflicts.map((p) => p.message).join('; '));
  }
  if (envProblems.length > 0) {
    return refuse(GUARD_EXIT.REGION, envProblems.map((p) => p.message).join('; '));
  }
  const home = env['HOME'];
  if (!home || !isAbsolute(home)) {
    return refuse(GUARD_EXIT.USAGE, 'HOME must be an absolute path (the profile is in $HOME/.aws)');
  }
  const timeoutSeconds =
    args.callTimeout === undefined
      ? DEFAULT_GUARD_CALL_TIMEOUT_SECONDS
      : /^\d{1,3}$/.test(args.callTimeout)
        ? Number(args.callTimeout)
        : Number.NaN;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
    return refuse(GUARD_EXIT.USAGE, '--call-timeout must be an integer between 1 and 600 seconds');
  }
  let rolePattern: RegExp | undefined;
  if (args.expectedRolePattern !== undefined) {
    const compiled = compileRolePattern(args.expectedRolePattern);
    if (!(compiled instanceof RegExp)) {
      return refuse(GUARD_EXIT.USAGE, `--expected-role-pattern: ${compiled.error}`);
    }
    rolePattern = compiled;
  }
  if (args.expectedAccountFile === undefined) {
    return refuse(
      GUARD_EXIT.USAGE,
      '--expected-account-file is required (the private file holding the sandbox account)',
    );
  }
  const expectedRead = readExpectedAccountFile(resolve(cwd, args.expectedAccountFile));
  if ('error' in expectedRead) {
    return refuse(GUARD_EXIT.USAGE, `--expected-account-file: ${expectedRead.error}`);
  }
  const expected = expectedRead.account;

  // ── 3. Private log (from here on, refusals are logged) ────────────────────────────────────
  const logArg = args.log ?? (env['SANDBOX_GUARD_LOG'] ? env['SANDBOX_GUARD_LOG'] : undefined);
  if (logArg !== undefined) {
    const opened = openPrivateLog(resolve(cwd, logArg));
    if ('error' in opened) return refuse(GUARD_EXIT.LOG, opened.error);
    logFd = opened.fd;
  }
  if (deps.buildProblem) return refuse(GUARD_EXIT.STALE_BUILD, deps.buildProblem);

  // ── 4. AWS CLI configuration (offline) and the pinned CLI ─────────────────────────────────
  const config = checkAwsCliConfig({
    home,
    profile,
    expectedAccount: expected,
    rolePattern: args.expectedRolePattern,
  });
  if (!config.ok) {
    const code = config.accountMismatch
      ? GUARD_EXIT.ACCOUNT_MISMATCH
      : config.profileMissing
        ? GUARD_EXIT.NO_PROFILE
        : GUARD_EXIT.AWS_CONFIG;
    return refuse(code, `${config.problems.join('; ')}. Nothing was run.`, {
      expectedAccount: maskAccount(expected),
    });
  }
  // A child that loses AWS_PROFILE (or the CDK CLI, which prefers a configured profile) must
  // have no other identity to fall back to.
  const fallback = fallbackIdentityProblems({
    home,
    cdkSettings: cdkSettingsFiles(home, cwd, deps.repoRoot),
  });
  if (fallback.length > 0) {
    return refuse(GUARD_EXIT.AWS_CONFIG, `${fallback.join('; ')}. Nothing was run.`);
  }
  const tilde = (text: string) => (home === '/' ? text : text.split(home).join('~'));
  const cli = await resolveAwsCli({
    explicitPath: args.awsCli,
    parentEnv: env,
    cwd,
    runner: deps.runner,
  });
  if ('error' in cli) return refuse(GUARD_EXIT.AWS_CLI, tilde(cli.error));

  // ── 5. One sts get-caller-identity through the exec boundary ──────────────────────────────
  const executor = createExecutor({
    cli,
    profile,
    workloadRegion: region,
    parentEnv: env,
    cwd: '/',
    timeoutMs: timeoutSeconds * 1000,
    runner: deps.runner,
    signal: deps.signal,
  });
  const { result } = await executor.call({ probeId: 'identity.caller', region, values: {} });
  const c = classify(result);
  if (c.kind === 'credentials') {
    return refuse(
      GUARD_EXIT.CREDENTIALS,
      `the AWS session is expired or invalid (${c.code}). Run: aws sso login --profile ${profileLabel}`,
    );
  }
  if (c.kind === 'interrupted') return refuse(GUARD_EXIT.INTERRUPTED, 'interrupted');
  if (c.kind !== 'ok') {
    return refuse(GUARD_EXIT.STS_FAILURE, `sts get-caller-identity failed (${c.kind}: ${c.code})`);
  }
  const account = isRecord(c.data) ? c.data['Account'] : undefined;
  const arn = isRecord(c.data) ? c.data['Arn'] : undefined;
  if (typeof account !== 'string' || !PATTERNS.account.test(account) || typeof arn !== 'string') {
    return refuse(GUARD_EXIT.STS_FAILURE, 'unexpected sts get-caller-identity output');
  }
  const principal = parsePrincipal(arn, account);
  const observed: Line = {
    account: maskAccount(account),
    principalArn: maskPrincipalArn(arn),
    principalType: principal.type,
  };
  if (account !== expected) {
    return refuse(
      GUARD_EXIT.ACCOUNT_MISMATCH,
      `ACCOUNT MISMATCH — the profile resolves to account ${maskAccount(account)}, expected ${maskAccount(expected)}. Nothing may run.`,
      { ...observed, expectedAccount: maskAccount(expected) },
    );
  }
  if (principal.type !== 'assumed-role') {
    return refuse(
      GUARD_EXIT.PRINCIPAL_REJECTED,
      `the caller is a ${principal.type} principal, not an IAM Identity Center role session`,
      observed,
    );
  }
  if (rolePattern && !rolePattern.test(principal.roleName)) {
    return refuse(
      GUARD_EXIT.PRINCIPAL_REJECTED,
      `role ${principal.roleName} does not match --expected-role-pattern ${args.expectedRolePattern ?? ''}`,
      observed,
    );
  }

  // ── 6. Verified: one leak-scanned JSON line to the log, then stdout ───────────────────────
  const line = {
    time: now().toISOString(),
    result: 'verified',
    label,
    account: maskAccount(account),
    principalArn: maskPrincipalArn(arn),
    principalType: principal.type,
    region,
    profile: profileLabel,
    executionProfile,
    toolSourceSha256: deps.toolSourceSha256 ?? null,
  };
  const findings = scanValue(line, { account, sessionName: principal.sessionName });
  if (findings.length > 0) {
    return refuse(
      GUARD_EXIT.ERROR,
      `the guard line failed the leak scanner (${findings.map((f) => `${f.rule} at ${f.path}`).join(', ')}); change the label`,
    );
  }
  const text = JSON.stringify(line);
  if (logFd !== undefined) {
    const fd = logFd;
    logFd = undefined;
    try {
      appendLine(fd, text);
    } catch {
      return refuse(GUARD_EXIT.LOG, 'the guard log could not be appended');
    }
  }
  out(text);
  return GUARD_EXIT.VERIFIED;
}
