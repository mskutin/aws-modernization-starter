import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main } from '../lib/emulator-guard-cli.js';
import {
  CI_SERVICE_ENDPOINT,
  EMULATOR_ACCOUNT,
  EMULATOR_CLI_ENV,
  EMULATOR_REFUSAL_EXIT_CODE,
  EMULATOR_SECRET,
  EmulatorGuardRefusal,
  assertEmulatorEnvironment,
  checkEmulatorEnvironment,
} from '../lib/emulator-guard.js';

/** A complete, accepted loopback emulator environment. */
const loopback = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  AWS_ENDPOINT_URL: 'http://127.0.0.1:45660',
  AWS_ACCESS_KEY_ID: EMULATOR_ACCOUNT,
  AWS_SECRET_ACCESS_KEY: EMULATOR_SECRET,
  AWS_REGION: 'ap-southeast-1',
  AWS_CONFIG_FILE: '/dev/null',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  AWS_EC2_METADATA_DISABLED: 'true',
  CDK_DISABLE_CLI_TELEMETRY: 'true',
  CDK_DISABLE_VERSION_CHECK: 'true',
  ...extra,
});

/** The GitLab job environment of the CI-service mode (interface contract with the CI jobs). */
const ciService = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
  loopback({
    GITLAB_CI: 'true',
    STARTER_EMULATOR_MODE: 'ci-service',
    STARTER_EMULATOR_ALLOWED_ENDPOINT: CI_SERVICE_ENDPOINT,
    AWS_ENDPOINT_URL: CI_SERVICE_ENDPOINT,
    ...extra,
  });

const refusalsOf = (env: NodeJS.ProcessEnv, phase: 'incoming' | 'effective' = 'effective') => {
  const r = checkEmulatorEnvironment(env, phase);
  return r.ok ? [] : r.refusals;
};

describe('emulator guard: accepted environments', () => {
  it.each([
    ['loopback 127.0.0.1', loopback()],
    ['loopback with a trailing slash', loopback({ AWS_ENDPOINT_URL: 'http://127.0.0.1:4566/' })],
    ['explicit loopback mode', loopback({ STARTER_EMULATOR_MODE: 'loopback' })],
    ['the GitLab CI service', ciService()],
  ])('%s', (_label, env) => {
    expect(refusalsOf(env)).toEqual([]);
    expect(assertEmulatorEnvironment(env).endpoint).toBe(env.AWS_ENDPOINT_URL);
  });

  it('reports the mode', () => {
    expect(assertEmulatorEnvironment(loopback()).mode).toBe('loopback');
    expect(assertEmulatorEnvironment(ciService()).mode).toBe('ci-service');
  });

  it('incoming phase: unset values are fine, set ones must already be harmless', () => {
    expect(refusalsOf({ PATH: '/usr/bin', HOME: '/tmp' }, 'incoming')).toEqual([]);
    expect(refusalsOf({ AWS_REGION: 'ap-southeast-1' }, 'incoming')).toEqual([]);
    expect(refusalsOf(loopback(), 'incoming')).toEqual([]);
  });
});

describe('emulator guard: refusal matrix (fail closed)', () => {
  const cases: [string, NodeJS.ProcessEnv, RegExp][] = [
    ['a profile', { AWS_PROFILE: 'starter-sandbox-developer' }, /AWS_PROFILE is set/],
    ['a default profile', { AWS_DEFAULT_PROFILE: 'default' }, /AWS_DEFAULT_PROFILE is set/],
    ['a session token', { AWS_SESSION_TOKEN: 'token' }, /AWS_SESSION_TOKEN is set/],
    ['a legacy security token', { AWS_SECURITY_TOKEN: 'token' }, /AWS_SECURITY_TOKEN is set/],
    [
      'a web identity token file',
      { AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/t' },
      /AWS_WEB_IDENTITY_TOKEN_FILE/,
    ],
    ['a role to assume', { AWS_ROLE_ARN: 'arn:aws:iam::1:role/r' }, /AWS_ROLE_ARN is set/],
    [
      'container credentials (relative)',
      { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/c' },
      /AWS_CONTAINER_CREDENTIALS_RELATIVE_URI/,
    ],
    [
      'container credentials (full)',
      { AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1' },
      /AWS_CONTAINER_CREDENTIALS_FULL_URI/,
    ],
    [
      'a container authorization token',
      { AWS_CONTAINER_AUTHORIZATION_TOKEN: 'x' },
      /AWS_CONTAINER_AUTHORIZATION_TOKEN is set/,
    ],
    [
      'a container authorization token file',
      { AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/x' },
      /AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE/,
    ],
    [
      'a service-specific endpoint',
      { AWS_ENDPOINT_URL_DYNAMODB: 'http://127.0.0.1:45660' },
      /AWS_ENDPOINT_URL_DYNAMODB is set/,
    ],
    [
      'a service-specific STS endpoint',
      { AWS_ENDPOINT_URL_STS: 'https://sts.amazonaws.com' },
      /AWS_ENDPOINT_URL_STS is set/,
    ],
    [
      'configured endpoints switched off',
      { AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' },
      /AWS_IGNORE_CONFIGURED_ENDPOINT_URLS/,
    ],
    [
      'a real-looking long-term key',
      { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE00' },
      /looks like a real AWS access key/,
    ],
    [
      'a real-looking temporary key',
      { AWS_ACCESS_KEY_ID: 'ASIAEXAMPLEEXAMPLE00' },
      /looks like a real AWS access key/,
    ],
    ['another fake key', { AWS_ACCESS_KEY_ID: '123456789012' }, /not the emulator key/],
    [
      'another secret',
      { AWS_SECRET_ACCESS_KEY: 'not-the-emulator-secret' },
      /AWS_SECRET_ACCESS_KEY/,
    ],
    [
      'a real config file',
      { AWS_CONFIG_FILE: '/home/u/.aws/config' },
      /AWS_CONFIG_FILE must be \/dev\/null/,
    ],
    [
      'a real credentials file',
      { AWS_SHARED_CREDENTIALS_FILE: '/home/u/.aws/credentials' },
      /AWS_SHARED_CREDENTIALS_FILE/,
    ],
    [
      'an AWS endpoint',
      { AWS_ENDPOINT_URL: 'https://dynamodb.ap-southeast-1.amazonaws.com' },
      /loopback/,
    ],
    [
      'a lookalike loopback host',
      { AWS_ENDPOINT_URL: 'http://127.0.0.1.evil.example:4566' },
      /loopback/,
    ],
    ['a service alias without CI mode', { AWS_ENDPOINT_URL: CI_SERVICE_ENDPOINT }, /loopback/],
    // A name is resolved late (DNS search, /etc/hosts), outside the guard.
    ['localhost instead of 127.0.0.1', { AWS_ENDPOINT_URL: 'http://localhost:4566' }, /loopback/],
    ['an unknown mode', { STARTER_EMULATOR_MODE: 'aws' }, /not a known emulator mode/],
    // CDK CLI phone-home.
    [
      'a CDK telemetry endpoint (redirect of the telemetry sender)',
      { TELEMETRY_ENDPOINT: 'https://127.0.0.1:47124/metrics' },
      /TELEMETRY_ENDPOINT is set/,
    ],
    [
      'CDK CLI telemetry switched back on',
      { CDK_DISABLE_CLI_TELEMETRY: 'false' },
      /CDK_DISABLE_CLI_TELEMETRY must be true/,
    ],
    [
      'CDK CLI telemetry "disabled" with a value the CLI does not honour',
      { CDK_DISABLE_CLI_TELEMETRY: 'yes' },
      /CDK_DISABLE_CLI_TELEMETRY must be true/,
    ],
    [
      'a version-check switch other than true',
      { CDK_DISABLE_VERSION_CHECK: 'false' },
      /CDK_DISABLE_VERSION_CHECK must be true/,
    ],
    [
      'a redirected instance-metadata endpoint',
      { AWS_EC2_METADATA_SERVICE_ENDPOINT: 'http://169.254.169.254' },
      /AWS_EC2_METADATA_SERVICE_ENDPOINT is set/,
    ],
  ];

  it.each(cases)('refuses %s', (_label, extra, message) => {
    const refusals = refusalsOf(loopback(extra));
    expect(refusals.join('\n')).toMatch(message);
    expect(() => assertEmulatorEnvironment(loopback(extra))).toThrow(EmulatorGuardRefusal);
    // The same environment is refused before the script exports anything.
    expect(refusalsOf(loopback(extra), 'incoming').join('\n')).toMatch(message);
  });

  it('never echoes a credential value in a refusal', () => {
    const r = refusalsOf(
      loopback({ AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE00', AWS_SESSION_TOKEN: 'sekrit-token' }),
    ).join('\n');
    expect(r).not.toContain('AKIAEXAMPLEEXAMPLE00');
    expect(r).not.toContain('sekrit-token');
  });

  it.each([
    ['AWS_ENDPOINT_URL', /AWS_ENDPOINT_URL is not set/],
    ['AWS_ACCESS_KEY_ID', /AWS_ACCESS_KEY_ID is not the emulator key/],
    ['AWS_SECRET_ACCESS_KEY', /AWS_SECRET_ACCESS_KEY/],
    ['AWS_CONFIG_FILE', /AWS_CONFIG_FILE must be/],
    ['AWS_SHARED_CREDENTIALS_FILE', /AWS_SHARED_CREDENTIALS_FILE must be/],
    ['AWS_EC2_METADATA_DISABLED', /AWS_EC2_METADATA_DISABLED/],
    ['CDK_DISABLE_CLI_TELEMETRY', /CDK_DISABLE_CLI_TELEMETRY must be true/],
    ['CDK_DISABLE_VERSION_CHECK', /CDK_DISABLE_VERSION_CHECK must be true/],
  ])('effective phase: refuses a missing %s', (name, message) => {
    expect(refusalsOf(loopback({ [name]: undefined })).join('\n')).toMatch(message);
  });

  it('requires exactly the CDK CLI switches the scripts export', () => {
    expect(EMULATOR_CLI_ENV).toEqual({
      CDK_DISABLE_CLI_TELEMETRY: 'true',
      CDK_DISABLE_VERSION_CHECK: 'true',
    });
  });

  it.each([
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'ALL_PROXY',
    'all_proxy',
    'npm_config_proxy',
    'npm_config_https_proxy',
    'NPM_CONFIG_HTTP_PROXY',
  ])('effective phase: refuses a proxy (%s), incoming phase leaves it to the scripts', (name) => {
    const env = loopback({ [name]: 'http://proxy.example:3128' });
    expect(refusalsOf(env).join('\n')).toMatch(new RegExp(`${name} is set \\(a proxy`));
    expect(refusalsOf(env).join('\n')).not.toContain('proxy.example');
    expect(refusalsOf(env, 'incoming')).toEqual([]);
  });

  it('NO_PROXY is not a proxy', () => {
    expect(refusalsOf(loopback({ NO_PROXY: '127.0.0.1', no_proxy: '*' }))).toEqual([]);
  });

  describe('CI-service mode', () => {
    it('requires GITLAB_CI=true', () => {
      expect(refusalsOf(ciService({ GITLAB_CI: undefined })).join('\n')).toMatch(/GITLAB_CI=true/);
      expect(refusalsOf(ciService({ GITLAB_CI: 'false' })).join('\n')).toMatch(/GITLAB_CI=true/);
    });
    it('requires the allowlist', () => {
      expect(
        refusalsOf(ciService({ STARTER_EMULATOR_ALLOWED_ENDPOINT: undefined })).join('\n'),
      ).toMatch(/needs STARTER_EMULATOR_ALLOWED_ENDPOINT/);
    });
    it('accepts only exactly the allowlisted endpoint', () => {
      for (const endpoint of [
        'http://evil:4566',
        'http://ministack:4567',
        'http://ministack:4566/',
      ]) {
        expect(refusalsOf(ciService({ AWS_ENDPOINT_URL: endpoint })).join('\n')).toMatch(
          /not exactly STARTER_EMULATOR_ALLOWED_ENDPOINT/,
        );
      }
    });
    it('refuses an allowlist that is not a single-label plain-HTTP alias', () => {
      for (const allowed of [
        'https://dynamodb.ap-southeast-1.amazonaws.com',
        'http://ministack.example.com:4566',
        'https://ministack:4566',
        'http://ministack',
      ]) {
        expect(
          refusalsOf(
            ciService({ STARTER_EMULATOR_ALLOWED_ENDPOINT: allowed, AWS_ENDPOINT_URL: allowed }),
          ).join('\n'),
        ).toMatch(/single-label service alias/);
      }
    });
    it('still refuses credentials and per-service endpoints', () => {
      expect(refusalsOf(ciService({ AWS_PROFILE: 'x' })).join('\n')).toMatch(/AWS_PROFILE/);
      expect(
        refusalsOf(ciService({ AWS_ENDPOINT_URL_S3: CI_SERVICE_ENDPOINT })).join('\n'),
      ).toMatch(/AWS_ENDPOINT_URL_S3/);
    });
  });
});

describe('emulator guard CLI', () => {
  const run = (argv: string[], env: NodeJS.ProcessEnv) => {
    const out: string[] = [];
    const err: string[] = [];
    const rc = main(argv, env, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { rc, out, err };
  };

  it('prints the target on success', () => {
    const r = run(['--phase', 'effective'], ciService());
    expect(r.rc).toBe(0);
    expect(JSON.parse(r.out[0]!)).toEqual({ mode: 'ci-service', endpoint: CI_SERVICE_ENDPOINT });
  });

  it('exits with the refusal code and one line per finding', () => {
    const r = run(['--phase', 'incoming'], { AWS_PROFILE: 'p', AWS_ENDPOINT_URL_STS: 'x' });
    expect(r.rc).toBe(EMULATOR_REFUSAL_EXIT_CODE);
    expect(r.err).toEqual([
      '[emulator-guard] refusing: AWS_PROFILE is set',
      '[emulator-guard] refusing: AWS_ENDPOINT_URL_STS is set',
    ]);
  });

  it('rejects an unknown phase', () => {
    expect(run(['--phase', 'later'], loopback()).rc).toBe(2);
  });

  it('the built CLI exits 5 in a real process', () => {
    const cli = fileURLToPath(new URL('../dist/lib/emulator-guard-cli.js', import.meta.url));
    const r = spawnSync(process.execPath, [cli, '--phase', 'effective'], {
      env: { PATH: process.env.PATH ?? '', AWS_PROFILE: 'p' },
      encoding: 'utf8',
    });
    expect(r.status).toBe(EMULATOR_REFUSAL_EXIT_CODE);
    expect(r.stderr).toMatch(/refusing: AWS_PROFILE is set/);
  });
});

describe('emulator guard: CDK entry point', () => {
  const source = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('takes the target resolution and account check from this gated module', () => {
    const entry = source('../bin/integration.ts');
    expect(entry).toMatch(
      /import \{ assertEmulatorAccount, resolveDeployTarget \} from '\.\.\/lib\/emulator-guard\.js';/,
    );
    // The ungated stack file may only re-export them, never define its own.
    const stack = source('../stacks/integration-workflow-stack.ts');
    expect(stack).not.toMatch(/function (?:resolveDeployTarget|assertEmulatorAccount)\b/);
  });
});
