/**
 * The ONE endpoint and credential guard of the AWS emulator layer (MiniStack): every way into an
 * emulator run checks the process environment with this module before any `cdk` or AWS SDK call.
 *
 *  - the CDK app (`resolveDeployTarget`, `-c target=emulator`);
 *  - the live-test harness (`resolveTarget`, `AWS_INTEGRATION_TARGET=emulator`);
 *  - the emulator shell scripts, through the CLI next to it (`emulator-guard-cli.ts`).
 *
 * Dependency-free on purpose (no aws-cdk-lib, no SDK): `@starter/tests-aws-integration` imports it as
 * `@starter/infra/emulator-guard`.
 *
 * Accepted endpoints (`AWS_ENDPOINT_URL`):
 *  - mode `loopback` (default): `http(s)://127.0.0.1[:port]` — a local emulator (not `localhost`:
 *    a name is resolved late and outside the guard);
 *  - mode `ci-service` (`STARTER_EMULATOR_MODE=ci-service`): exactly `STARTER_EMULATOR_ALLOWED_ENDPOINT`,
 *    only when `GITLAB_CI=true`; the allowlisted value itself must be a plain-HTTP single-label
 *    service alias (`http://ministack:4566`), never a dotted or AWS host name.
 * Refused (fail closed): profiles, session tokens, web identity / role assumption, container
 * credentials, any service-specific endpoint (`AWS_ENDPOINT_URL_<SERVICE>`), switching configured
 * endpoints off, a redirected instance-metadata endpoint, any access key but the emulator's fake
 * one, a config/credentials file other than `/dev/null`, and every other endpoint.
 *
 * CDK CLI phone-home (aws-cdk 2.1144 source, `lib/index.js`). The CLI can contact,
 * besides the AWS endpoint: CLI telemetry (`TELEMETRY_ENDPOINT` or
 * `https://cdk-cli-telemetry.us-east-1.api.aws/metrics`, a detached sender process), notices
 * (`https://cli.cdk.dev-tools.aws.dev/notices.json`) and the npm version check
 * (`https://registry.npmjs.org`), each through an optional proxy (`HTTPS_PROXY` & co.). So:
 *  - `TELEMETRY_ENDPOINT` is refused in every phase (it redirects the sender);
 *  - the effective phase requires `CDK_DISABLE_CLI_TELEMETRY=true` and `CDK_DISABLE_VERSION_CHECK=true`
 *    (`EMULATOR_CLI_ENV`), and in any phase a set value must be exactly `true`;
 *  - the effective phase refuses every proxy variable the CLI or npm/pnpm read
 *    (`PROXY_VARIABLE`): the scripts unset them, so only an override that slipped through is refused.
 * Notices are switched off per command (`--no-notices`, which the scripts always pass) — the guard
 * cannot see argv. The scripts additionally isolate `HOME` (no `~/.cdk.json` proxy/plugin/context)
 * and prove the result with the egress audit (`tests/aws-integration/emulator/egress-audit.mjs`).
 */

/** Exit code of a refusal (shell scripts and the CLI): something could reach real AWS. */
export const EMULATOR_REFUSAL_EXIT_CODE = 5;

/** Fake identity: MiniStack derives the account id from a 12-digit access key. */
export const EMULATOR_ACCOUNT = '000000000001';
export const EMULATOR_SECRET = 'ministack-local-only';
export const EMULATOR_REGION = 'ap-southeast-1';
/** The GitLab CI service alias of the emulator (expected `STARTER_EMULATOR_ALLOWED_ENDPOINT`). */
export const CI_SERVICE_ENDPOINT = 'http://ministack:4566';

export type EmulatorMode = 'loopback' | 'ci-service';
/**
 * `incoming`: the environment a script was started with — anything set must be harmless (unset is
 * fine; the script exports the emulator environment next). `effective`: the environment an SDK or
 * `cdk` call runs with — the emulator environment must be complete.
 */
export type GuardPhase = 'incoming' | 'effective';

export interface EmulatorTarget {
  mode: EmulatorMode;
  endpoint: string;
}

export type GuardResult = ({ ok: true } & EmulatorTarget) | { ok: false; refusals: string[] };

const LOOPBACK_ENDPOINT = /^https?:\/\/127\.0\.0\.1(?::\d{1,5})?\/?$/;
/** A GitLab service alias: one DNS label, plain HTTP, explicit port. */
const SERVICE_ALIAS_ENDPOINT = /^http:\/\/[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?:\d{1,5}$/;

/** Variables that select credentials, a profile or a role: never present in an emulator run. */
const FORBIDDEN_VARIABLES = [
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  // Would make the SDK ignore AWS_ENDPOINT_URL and talk to the real service endpoints.
  'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
  // Redirects instance-metadata calls (credentials, region) to another host.
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
  // Redirects the CDK CLI telemetry sender (and enables it even with a malformed default).
  'TELEMETRY_ENDPOINT',
] as const;

/**
 * Switches every `cdk` call of an emulator run needs (aws-cdk 2.1144): no CLI telemetry, no npm
 * version check. Required in the effective phase; the scripts export exactly these values.
 */
export const EMULATOR_CLI_ENV = {
  CDK_DISABLE_CLI_TELEMETRY: 'true',
  CDK_DISABLE_VERSION_CHECK: 'true',
} as const;

/**
 * Proxy variables read by the CDK CLI (`proxy-from-env`: `<proto>_proxy`, `all_proxy`, their
 * `npm_config_` forms, either case) and by pnpm/npm. A proxy would carry every emulator request —
 * and the telemetry/notices requests — to another host.
 */
export const PROXY_VARIABLE = /^(?:npm_config_)?(?:https?_|all_)?proxy$/i;

/** Prefixes of forbidden variable families (container credentials, per-service endpoints). */
const FORBIDDEN_PREFIXES = [
  'AWS_CONTAINER_CREDENTIALS_',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_ENDPOINT_URL_',
] as const;

/** Prefixes of real AWS access key ids (IAM unique-id prefixes). */
const REAL_KEY_PREFIX = /^(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|APKA|AROA|ASCA)/;

const isSet = (value: string | undefined): value is string => value !== undefined && value !== '';

export function isLoopbackEndpoint(endpoint: string): boolean {
  return LOOPBACK_ENDPOINT.test(endpoint);
}

function resolveMode(env: NodeJS.ProcessEnv, refusals: string[]): EmulatorMode | undefined {
  const mode = env.STARTER_EMULATOR_MODE;
  if (!isSet(mode) || mode === 'loopback') return 'loopback';
  if (mode === 'ci-service') return 'ci-service';
  refusals.push(
    `STARTER_EMULATOR_MODE=${mode} is not a known emulator mode (loopback | ci-service)`,
  );
  return undefined;
}

function checkEndpoint(
  env: NodeJS.ProcessEnv,
  mode: EmulatorMode | undefined,
  phase: GuardPhase,
  refusals: string[],
): string | undefined {
  const endpoint = env.AWS_ENDPOINT_URL;
  if (!isSet(endpoint)) {
    if (phase === 'effective') {
      refusals.push('AWS_ENDPOINT_URL is not set: an emulator call would go to real AWS');
    }
    return undefined;
  }
  if (mode === 'loopback') {
    if (!isLoopbackEndpoint(endpoint)) {
      refusals.push(
        'AWS_ENDPOINT_URL is not a loopback emulator URL (http://127.0.0.1:<port>); a CI service ' +
          'endpoint needs STARTER_EMULATOR_MODE=ci-service',
      );
    }
    return endpoint;
  }
  if (mode === 'ci-service') {
    const allowed = env.STARTER_EMULATOR_ALLOWED_ENDPOINT;
    if (env.GITLAB_CI !== 'true') {
      refusals.push(
        'STARTER_EMULATOR_MODE=ci-service is only accepted inside GitLab CI (GITLAB_CI=true)',
      );
    } else if (!isSet(allowed)) {
      refusals.push('STARTER_EMULATOR_MODE=ci-service needs STARTER_EMULATOR_ALLOWED_ENDPOINT');
    } else if (!SERVICE_ALIAS_ENDPOINT.test(allowed)) {
      refusals.push(
        'STARTER_EMULATOR_ALLOWED_ENDPOINT must be a plain-HTTP single-label service alias ' +
          `(${CI_SERVICE_ENDPOINT})`,
      );
    } else if (endpoint !== allowed) {
      refusals.push('AWS_ENDPOINT_URL is not exactly STARTER_EMULATOR_ALLOWED_ENDPOINT');
    }
  }
  return endpoint;
}

/**
 * Checks `env` against the emulator rules. Never throws; lists every refusal (messages name
 * variables, never their values, except the harmless mode).
 */
export function checkEmulatorEnvironment(
  env: NodeJS.ProcessEnv,
  phase: GuardPhase = 'effective',
): GuardResult {
  const refusals: string[] = [];
  for (const name of FORBIDDEN_VARIABLES) {
    if (isSet(env[name])) refusals.push(`${name} is set`);
  }
  for (const name of Object.keys(env).sort()) {
    if (FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix)) && isSet(env[name])) {
      refusals.push(`${name} is set`);
    }
  }

  const key = env.AWS_ACCESS_KEY_ID;
  if (isSet(key) && key !== EMULATOR_ACCOUNT) {
    refusals.push(
      REAL_KEY_PREFIX.test(key)
        ? 'AWS_ACCESS_KEY_ID looks like a real AWS access key'
        : 'AWS_ACCESS_KEY_ID is not the emulator key',
    );
  } else if (!isSet(key) && phase === 'effective') {
    refusals.push('AWS_ACCESS_KEY_ID is not the emulator key (unset)');
  }
  const secret = env.AWS_SECRET_ACCESS_KEY;
  if (isSet(secret) ? secret !== EMULATOR_SECRET : phase === 'effective') {
    refusals.push('AWS_SECRET_ACCESS_KEY is not the emulator secret');
  }

  for (const name of ['AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE'] as const) {
    const value = env[name];
    if (isSet(value) ? value !== '/dev/null' : phase === 'effective') {
      refusals.push(`${name} must be /dev/null`);
    }
  }
  if (phase === 'effective' && env.AWS_EC2_METADATA_DISABLED !== 'true') {
    refusals.push('AWS_EC2_METADATA_DISABLED must be true');
  }
  for (const [name, value] of Object.entries(EMULATOR_CLI_ENV)) {
    if (isSet(env[name]) ? env[name] !== value : phase === 'effective') {
      refusals.push(`${name} must be ${value} (CDK CLI phone-home)`);
    }
  }
  if (phase === 'effective') {
    for (const name of Object.keys(env).sort()) {
      if (PROXY_VARIABLE.test(name) && isSet(env[name])) {
        refusals.push(`${name} is set (a proxy would carry emulator and CLI requests elsewhere)`);
      }
    }
  }

  const mode = resolveMode(env, refusals);
  const endpoint = checkEndpoint(env, mode, phase, refusals);
  if (refusals.length > 0 || mode === undefined) return { ok: false, refusals };
  return { ok: true, mode, endpoint: endpoint ?? '' };
}

export class EmulatorGuardRefusal extends Error {
  readonly refusals: readonly string[];
  constructor(refusals: readonly string[]) {
    super(`refusing the emulator run: ${refusals.join('; ')}`);
    this.name = 'EmulatorGuardRefusal';
    this.refusals = refusals;
  }
}

/** The effective emulator target, or an `EmulatorGuardRefusal`. */
export function assertEmulatorEnvironment(env: NodeJS.ProcessEnv): EmulatorTarget {
  const result = checkEmulatorEnvironment(env, 'effective');
  if (!result.ok) throw new EmulatorGuardRefusal(result.refusals);
  return { mode: result.mode, endpoint: result.endpoint };
}

/**
 * `-c target=aws` (default) or `-c target=emulator`. The emulator variant is only synthesized when
 * the process environment passes the shared emulator guard (this module: a loopback or
 * the allowlisted CI-service `AWS_ENDPOINT_URL`, the fake emulator keys, `/dev/null` config files,
 * no profile, token, role or per-service endpoint), so it can never be deployed to AWS by mistake.
 */
export function resolveDeployTarget(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
): 'aws' | 'emulator' {
  if (value === undefined || value === '' || value === 'aws') return 'aws';
  if (value !== 'emulator') throw new Error(`Invalid -c target=${value}: expected aws or emulator`);
  assertEmulatorEnvironment(env);
  return 'emulator';
}

/** The emulator variant runs only in the emulator's fake account. */
export function assertEmulatorAccount(account: string | undefined): void {
  if (account !== EMULATOR_ACCOUNT) {
    throw new Error(
      `-c target=emulator requires -c account=${EMULATOR_ACCOUNT} (the emulator's fake account)`,
    );
  }
}
