/**
 * The REAL account guard (tools/aws-preflight) installed into an offline test world:
 * the sandbox-guard.sh helper copied next to a dist/guard-cli.js that runs the guard CLI's current
 * sources (the guard's own test pattern; no build needed, no stale-build check), and a
 * private `~/.aws/config` with the operator's IAM Identity Center profile shape. The guard's AWS
 * CLI calls (`aws --version`, one `sts get-caller-identity` per check) go to the first `aws` on
 * PATH, which the world must make a fake: a test that installs this guard must put its fake `aws`
 * first on PATH and point HOME at a private directory, or the guard would use the operator's.
 */
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REAL_GUARD_SCRIPT = fileURLToPath(
  new URL('../../../../../tools/aws-preflight/scripts/sandbox-guard.sh', import.meta.url),
);
/** The region default and rules sourced by sandbox-guard.sh from its own directory. */
export const REAL_REGION_SCRIPT = fileURLToPath(
  new URL('../../../../../tools/aws-preflight/scripts/region.sh', import.meta.url),
);
const REAL_GUARD_SRC = fileURLToPath(
  new URL('../../../../../tools/aws-preflight/src/guard-cli.ts', import.meta.url),
);

export const FAKE_AWS_VERSION = 'aws-cli/2.35.11 Python/3.13.7 Darwin/25.0.0 source/arm64';
/** What the fake `sts get-caller-identity` answers for `account` (an SSO role session). */
export const callerIdentity = (account: string) => ({
  UserId: 'AROAFAKEROLEID00000001:jane.doe@example.com',
  Account: account,
  Arn: `arn:aws:sts::${account}:assumed-role/AWSReservedSSO_Developer_0123456789abcdef/jane.doe@example.com`,
});

/** `~/.aws/config`: the sandbox profile exactly as `aws configure sso` writes it (fake ids). */
export const SSO_CONFIG = [
  '[profile starter-sandbox-developer]',
  'sso_session = starter-sandbox',
  'sso_account_id = 111122223333',
  'sso_role_name = Developer',
  'region = ap-southeast-1',
  'output = json',
  '',
  '[sso-session starter-sandbox]',
  'sso_start_url = https://d-0000000000.awsapps.com/start',
  'sso_region = ap-southeast-1',
  'sso_registration_scopes = sso:account:access',
  '',
].join('\n');

/**
 * Variables the real guard refuses (static keys, configuration/endpoint redirects). The Phase 1
 * self-test sets them for its SDK fake, so a real-guard run must unset them.
 */
export const GUARD_REFUSED_ENV: readonly string[] = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_ENDPOINT_URL',
];

/** Installs the real guard under `toolRoot` and the profile under `home`; returns the helper path. */
export async function installRealGuard(toolRoot: string, home: string): Promise<string> {
  const tool = join(toolRoot, 'aws-preflight');
  await mkdir(join(tool, 'scripts'), { recursive: true });
  await mkdir(join(tool, 'dist'), { recursive: true });
  await copyFile(REAL_GUARD_SCRIPT, join(tool, 'scripts', 'sandbox-guard.sh'));
  await copyFile(REAL_REGION_SCRIPT, join(tool, 'scripts', 'region.sh'));
  await writeFile(
    join(tool, 'dist', 'guard-cli.js'),
    `import { main } from ${JSON.stringify(REAL_GUARD_SRC)};\nprocess.exitCode = await main(process.argv.slice(2));\n`,
  );
  await mkdir(join(home, '.aws'), { recursive: true, mode: 0o700 });
  await chmod(join(home, '.aws'), 0o700);
  await writeFile(join(home, '.aws', 'config'), SSO_CONFIG, { mode: 0o600 });
  return join(tool, 'scripts', 'sandbox-guard.sh');
}
