/**
 * AUTH_* / RATE_LIMIT_* / TRUST_PROXY_HOPS. Every unsafe setting must fail
 * start-up: there is no configuration that disables authentication.
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, describeApiConfig, loadApiConfig } from '../src/index.js';

/** AWS-shaped (APP_RUNTIME unset = aws): valid database settings, so only AUTH_* issues show. */
const baseEnv = {
  DB_HOST: 'localhost',
  DB_NAME: 'jobs',
  DB_USER: 'starter_app',
  DB_AUTH: 'iam',
  DB_SSL_ROOT_CERT: '/app/certs/rds-global-bundle.pem',
  JOBS_TABLE_NAME: 'starter-jobs-state',
  AWS_REGION: 'ap-southeast-1',
  STATE_MACHINE_ARN: 'arn:aws:states:ap-southeast-1:123456789012:stateMachine:job-processing',
  AUTH_ISSUER: 'https://idp.example.com/realms/example',
  AUTH_AUDIENCE: 'starter-jobs-api',
  AUTH_ALLOWED_CLIENT_IDS: 'starter-web',
};

function issues(env: Record<string, string | undefined>): { variable: string; message: string }[] {
  try {
    loadApiConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.issues];
    throw error;
  }
  return [];
}

describe('auth configuration', () => {
  it('applies the contract defaults', () => {
    const config = loadApiConfig(baseEnv);
    expect(config.auth).toEqual({
      issuer: 'https://idp.example.com/realms/example',
      audience: 'starter-jobs-api',
      jwksUri: undefined,
      algorithms: ['RS256', 'ES256'],
      clockToleranceSeconds: 30,
      maxTokenAgeSeconds: 3600,
      scopes: { read: 'jobs:read', write: 'jobs:write' },
      allowedClientIds: ['starter-web'],
      allowInsecureIssuer: false,
    });
    expect(config.rateLimit).toEqual({
      windowSeconds: 60,
      readMax: 120,
      writeMax: 20,
      unauthenticatedMax: 30,
    });
    expect(config.trustProxyHops).toBe(0);
  });

  it('requires an issuer and an audience (authentication cannot be configured away)', () => {
    const found = issues({ ...baseEnv, AUTH_ISSUER: undefined, AUTH_AUDIENCE: '' });
    expect(found).toEqual(
      expect.arrayContaining([
        { variable: 'AUTH_ISSUER', message: 'is required' },
        { variable: 'AUTH_AUDIENCE', message: 'is required' },
      ]),
    );
  });

  it('keeps the issuer string exactly as configured (it is compared to `iss` verbatim)', () => {
    const issuer = 'https://login.example.com/tenant-1/v2.0/';
    expect(loadApiConfig({ ...baseEnv, AUTH_ISSUER: issuer }).auth.issuer).toBe(issuer);
  });

  it.each([
    ['none', 'none'],
    ['HS256', 'HS256'],
    ['HS512 mixed in', 'RS256,HS512'],
    ['empty list', ' , '],
    ['unknown', 'RS999'],
  ])('rejects AUTH_ALGORITHMS with %s', (_label, value) => {
    expect(issues({ ...baseEnv, AUTH_ALGORITHMS: value }).map((i) => i.variable)).toContain(
      'AUTH_ALGORITHMS',
    );
  });

  it('accepts and de-duplicates an asymmetric allow-list', () => {
    expect(
      loadApiConfig({ ...baseEnv, AUTH_ALGORITHMS: 'ES256, PS256,ES256' }).auth.algorithms,
    ).toEqual(['ES256', 'PS256']);
  });

  it('rejects a plain-http issuer by default', () => {
    const found = issues({
      ...baseEnv,
      AUTH_ISSUER: 'http://127.0.0.1:9400',
      APP_RUNTIME: 'local',
    });
    expect(found.map((i) => i.variable)).toEqual(['AUTH_ISSUER']);
  });

  it.each(['local', 'ci'])(
    'accepts a plain-http issuer only with APP_RUNTIME=%s and the explicit switch',
    (runtime) => {
      const config = loadApiConfig({
        ...baseEnv,
        // The image, compose and CI run NODE_ENV=production: the switch must not depend on it.
        NODE_ENV: 'production',
        APP_RUNTIME: runtime,
        AUTH_ISSUER: 'http://127.0.0.1:9400',
        AUTH_JWKS_URI: 'http://test-idp:9400/jwks.json',
        AUTH_ALLOW_INSECURE_ISSUER: 'true',
      });
      expect(config.auth).toMatchObject({
        issuer: 'http://127.0.0.1:9400',
        jwksUri: 'http://test-idp:9400/jwks.json',
        allowInsecureIssuer: true,
      });
    },
  );

  it('refuses AUTH_ALLOW_INSECURE_ISSUER=true on AWS (APP_RUNTIME=aws, also the default)', () => {
    for (const runtime of ['aws', undefined]) {
      const found = issues({
        ...baseEnv,
        NODE_ENV: 'development',
        APP_RUNTIME: runtime,
        AUTH_ISSUER: 'http://127.0.0.1:9400',
        AUTH_ALLOW_INSECURE_ISSUER: 'true',
      });
      expect(found.map((i) => i.variable).sort()).toEqual([
        'AUTH_ALLOW_INSECURE_ISSUER',
        'AUTH_ISSUER',
      ]);
    }
  });

  it('rejects an unknown APP_RUNTIME', () => {
    expect(issues({ ...baseEnv, APP_RUNTIME: 'dev' }).map((i) => i.variable)).toEqual([
      'APP_RUNTIME',
    ]);
  });

  it('requires the client allow-list on AWS so the audience is always checked', () => {
    const missing = issues({ ...baseEnv, AUTH_ALLOWED_CLIENT_IDS: undefined });
    expect(missing.map((i) => i.variable)).toEqual(['AUTH_ALLOWED_CLIENT_IDS']);
    // The confusing configuration (audience = SPA client) is therefore always caught on AWS...
    const confused = issues({
      ...baseEnv,
      AUTH_AUDIENCE: 'starter-web',
      AUTH_ALLOWED_CLIENT_IDS: 'starter-web',
    });
    expect(confused.map((i) => i.variable)).toEqual(['AUTH_AUDIENCE']);
    // ...while local and CI runtimes may accept any client of the test issuer.
    for (const runtime of ['local', 'ci']) {
      expect(
        loadApiConfig({ ...baseEnv, APP_RUNTIME: runtime, AUTH_ALLOWED_CLIENT_IDS: undefined }).auth
          .allowedClientIds,
      ).toEqual([]);
    }
  });

  it('bounds the token age', () => {
    expect(
      loadApiConfig({ ...baseEnv, AUTH_MAX_TOKEN_AGE_SECONDS: '900' }).auth.maxTokenAgeSeconds,
    ).toBe(900);
    for (const value of ['59', '86401', 'forever']) {
      expect(
        issues({ ...baseEnv, AUTH_MAX_TOKEN_AGE_SECONDS: value }).map((i) => i.variable),
      ).toContain('AUTH_MAX_TOKEN_AGE_SECONDS');
    }
  });

  it('parses the optional client allow-list', () => {
    const config = loadApiConfig({
      ...baseEnv,
      AUTH_ALLOWED_CLIENT_IDS: 'starter-web, partner-app ,starter-web',
    });
    expect(config.auth.allowedClientIds).toEqual(['starter-web', 'partner-app']);
  });

  it('rejects an audience that is one of the allowed client ids (ID-token confusion)', () => {
    const found = issues({
      ...baseEnv,
      AUTH_AUDIENCE: 'starter-web',
      AUTH_ALLOWED_CLIENT_IDS: 'starter-web',
    });
    expect(found.map((i) => i.variable)).toEqual(['AUTH_AUDIENCE']);
  });

  // The rule must decide on the parsed scheme, not on a case-sensitive prefix.
  it.each([
    ['upper-case scheme', 'HTTP://idp.example.com'],
    ['mixed-case scheme', 'hTtP://idp.example.com'],
    ['a tab inside the scheme', 'ht\ttp://idp.example.com'],
    ['a newline inside the scheme', 'htt\np://idp.example.com'],
  ])('rejects an http issuer written with %s (also as JWKS URL)', (_n, url) => {
    expect(issues({ ...baseEnv, AUTH_ISSUER: url }).map((i) => i.variable)).toContain(
      'AUTH_ISSUER',
    );
    expect(issues({ ...baseEnv, AUTH_JWKS_URI: url }).map((i) => i.variable)).toContain(
      'AUTH_JWKS_URI',
    );
  });

  it('applies the https rule to AUTH_JWKS_URI as well', () => {
    const found = issues({ ...baseEnv, AUTH_JWKS_URI: 'http://idp.internal/jwks' });
    expect(found.map((i) => i.variable)).toEqual(['AUTH_JWKS_URI']);
    // ...also on local/ci unless the switch is set.
    const local = issues({ ...baseEnv, APP_RUNTIME: 'ci', AUTH_JWKS_URI: 'http://idp/jwks' });
    expect(local.map((i) => i.variable)).toEqual(['AUTH_JWKS_URI']);
  });

  it.each([
    ['AUTH_ISSUER', 'not a url'],
    ['AUTH_ISSUER', 'ftp://idp.example.com'],
    ['AUTH_ISSUER', 'https://idp.example.com/?tenant=1'],
    ['AUTH_ISSUER', 'https://user:pw@idp.example.com'],
    ['AUTH_ISSUER', 'https://idp.example.com/#x'],
    ['AUTH_ALLOW_INSECURE_ISSUER', 'yes'],
    ['AUTH_CLOCK_TOLERANCE_SECONDS', '-1'],
    ['AUTH_CLOCK_TOLERANCE_SECONDS', '121'],
    ['AUTH_SCOPE_READ', 'jobs read'],
    ['AUTH_SCOPE_WRITE', 'jobs"write'],
    ['RATE_LIMIT_WINDOW_SECONDS', '0'],
    ['RATE_LIMIT_READ_MAX', '0'],
    ['RATE_LIMIT_WRITE_MAX', 'many'],
    ['RATE_LIMIT_UNAUTHENTICATED_MAX', '-5'],
    ['TRUST_PROXY_HOPS', '11'],
    ['TRUST_PROXY_HOPS', '1.5'],
  ])('rejects %s=%s', (variable, value) => {
    expect(issues({ ...baseEnv, [variable]: value }).map((i) => i.variable)).toContain(variable);
  });

  it('parses explicit limits, scopes and proxy hops', () => {
    const config = loadApiConfig({
      ...baseEnv,
      AUTH_SCOPE_READ: 'api://jobs/read',
      AUTH_SCOPE_WRITE: 'api://jobs/write',
      AUTH_CLOCK_TOLERANCE_SECONDS: '0',
      RATE_LIMIT_WINDOW_SECONDS: '10',
      RATE_LIMIT_READ_MAX: '5',
      RATE_LIMIT_WRITE_MAX: '2',
      RATE_LIMIT_UNAUTHENTICATED_MAX: '3',
      TRUST_PROXY_HOPS: '2',
    });
    expect(config.auth.scopes).toEqual({ read: 'api://jobs/read', write: 'api://jobs/write' });
    expect(config.auth.clockToleranceSeconds).toBe(0);
    expect(config.rateLimit).toEqual({
      windowSeconds: 10,
      readMax: 5,
      writeMax: 2,
      unauthenticatedMax: 3,
    });
    expect(config.trustProxyHops).toBe(2);
  });

  it('describes the auth settings for the start-up log', () => {
    const described = describeApiConfig(loadApiConfig(baseEnv));
    expect(described).toMatchObject({
      auth: { issuer: baseEnv.AUTH_ISSUER, jwksUri: 'discovery', allowInsecureIssuer: false },
      rateLimit: { readMax: 120 },
      trustProxyHops: 0,
    });
  });
});
