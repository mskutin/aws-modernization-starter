import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  SecretValue,
  describeDbConfig,
  loadApiConfig,
  loadDatabaseBootstrapConfig,
  loadDatabaseConfig,
  loadDbConfig,
  loadDbIdentityConfig,
  loadRetentionConfig,
  type Env,
} from '../src/index.js';

/** Canary credential: must never appear in errors, descriptions or serialised configs. */
const CANARY = 'canary-Pa55word-7f3a9c1e';
const ARN =
  'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:starter-dev/rds/master-AbCdEf';

const awsDb: Env = {
  DB_HOST: 'starter-dev-postgres.abc.ap-southeast-1.rds.amazonaws.com',
  DB_NAME: 'starterapp',
  DB_USER: 'starter_app',
  DB_AUTH: 'iam',
  DB_SSL_ROOT_CERT: '/app/certs/rds-global-bundle.pem',
  AWS_REGION: 'ap-southeast-1',
};

const localDb: Env = {
  APP_RUNTIME: 'local',
  DB_HOST: 'postgres',
  DB_NAME: 'starter_app',
  DB_USER: 'starter_app',
  DB_PASSWORD: CANARY,
  DB_SSL: 'verify-full',
  DB_SSL_ROOT_CERT: '/tls/ca.pem',
};

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected ConfigError');
}

const variables = (error: ConfigError) => error.issues.map((i) => i.variable);

describe('DB_* contract', () => {
  it('AWS shape: IAM authentication with verify-full against the RDS bundle', () => {
    expect(loadDbConfig(awsDb)).toEqual({
      host: awsDb.DB_HOST,
      port: 5432,
      database: 'starterapp',
      user: 'starter_app',
      auth: { mode: 'iam', region: 'ap-southeast-1' },
      ssl: { mode: 'verify-full', rootCertPath: '/app/certs/rds-global-bundle.pem' },
      poolMax: 10,
    });
  });

  it.each([
    ['DB_SSL=disable', { DB_SSL: 'disable', DB_SSL_ROOT_CERT: undefined }, 'DB_SSL'],
    ['DB_AUTH=password', { DB_AUTH: 'password', DB_PASSWORD: CANARY }, 'DB_AUTH'],
    ['DB_PASSWORD_FILE', { DB_AUTH: 'password', DB_PASSWORD_FILE: '/run/pw' }, 'DB_AUTH'],
  ])('APP_RUNTIME=aws (also when unset) rejects %s', (_name, override, variable) => {
    for (const runtime of [undefined, 'aws']) {
      const error = configError(() =>
        loadDbConfig({ ...awsDb, APP_RUNTIME: runtime, ...override }),
      );
      expect(variables(error)).toContain(variable);
      expect(error.message).toContain('only allowed when APP_RUNTIME is local or ci');
      expect(error.message).not.toContain(CANARY);
    }
  });

  it.each(['ci', 'local'])('APP_RUNTIME=%s accepts passwords and plain TCP', (runtime) => {
    const config = loadDbConfig({
      ...localDb,
      APP_RUNTIME: runtime,
      DB_SSL: 'disable',
      DB_SSL_ROOT_CERT: undefined,
    });
    expect(config.ssl).toEqual({ mode: 'disable' });
    expect(config.auth).toMatchObject({ mode: 'password', source: 'env' });
  });

  it.each([
    ['require', 'DB_SSL'],
    ['prefer', 'DB_SSL'],
    ['allow', 'DB_SSL'],
    ['verify-ca', 'DB_SSL'],
  ])('has no permissive TLS mode (DB_SSL=%s)', (mode, variable) => {
    const error = configError(() => loadDbConfig({ ...localDb, DB_SSL: mode }));
    expect(variables(error)).toEqual([variable]);
    expect(error.message).toContain('encrypt without verifying the server');
  });

  it('verify-full needs the CA bundle path; disable must not name one', () => {
    expect(
      variables(configError(() => loadDbConfig({ ...awsDb, DB_SSL_ROOT_CERT: undefined }))),
    ).toEqual(['DB_SSL_ROOT_CERT']);
    expect(
      variables(
        configError(() => loadDbConfig({ ...localDb, APP_RUNTIME: 'ci', DB_SSL: 'disable' })),
      ),
    ).toEqual(['DB_SSL_ROOT_CERT']);
  });

  it('iam: no password, no secret, verify-full and a region', () => {
    const error = configError(() =>
      loadDbConfig({
        ...awsDb,
        APP_RUNTIME: 'local',
        DB_PASSWORD: CANARY,
        DB_PASSWORD_FILE: '/run/pw',
        DB_SECRET_ARN: ARN,
        DB_SSL: 'disable',
        DB_SSL_ROOT_CERT: undefined,
        AWS_REGION: undefined,
      }),
    );
    expect(variables(error).sort()).toEqual([
      'AWS_REGION',
      'DB_PASSWORD',
      'DB_PASSWORD_FILE',
      'DB_SECRET_ARN',
      'DB_SSL',
    ]);
    expect(error.message).not.toContain(CANARY);
  });

  it('password: exactly one of DB_PASSWORD and DB_PASSWORD_FILE', () => {
    expect(
      variables(configError(() => loadDbConfig({ ...localDb, DB_PASSWORD: undefined }))),
    ).toEqual(['DB_PASSWORD']);
    expect(
      variables(configError(() => loadDbConfig({ ...localDb, DB_PASSWORD_FILE: '/run/pw' }))),
    ).toEqual(['DB_PASSWORD_FILE']);
    expect(
      loadDbConfig({ ...localDb, DB_PASSWORD: undefined, DB_PASSWORD_FILE: '/run/pw' }).auth,
    ).toEqual({ mode: 'password', source: 'file', passwordFile: '/run/pw' });
  });

  it('secrets-manager is refused for every runtime identity (bootstrap only)', () => {
    const secretEnv = {
      ...awsDb,
      DB_USER: 'starteradmin',
      DB_AUTH: 'secrets-manager',
      DB_SECRET_ARN: ARN,
    };
    const loaders: [string, () => unknown][] = [
      ['loadDbConfig', () => loadDbConfig(secretEnv)],
      ['loadDatabaseConfig', () => loadDatabaseConfig(secretEnv)],
      ['loadRetentionConfig', () => loadRetentionConfig(secretEnv)],
      [
        'loadApiConfig',
        () =>
          loadApiConfig({
            ...secretEnv,
            JOBS_TABLE_NAME: 'starter-jobs',
            STATE_MACHINE_ARN: 'arn:aws:states:ap-southeast-1:123456789012:stateMachine:x',
            // Valid identity settings (required), so DB_AUTH is the only issue.
            AUTH_ISSUER: 'https://idp.example.com',
            AUTH_AUDIENCE: 'starter-jobs-api',
            AUTH_ALLOWED_CLIENT_IDS: 'starter-web',
          }),
      ],
    ];
    for (const [name, load] of loaders) {
      const error = configError(load);
      expect(variables(error), name).toEqual(['DB_AUTH']);
      expect(error.message, name).toContain('reserved for the one-off database bootstrap');
    }
  });

  it('DB_USER must be a lower-case PostgreSQL identifier (safe in SQL and IAM ARNs)', () => {
    for (const user of ['Starter_App', 'starter-app', 'starter app', '1starter', 'a'.repeat(64)]) {
      expect(variables(configError(() => loadDbConfig({ ...awsDb, DB_USER: user })))).toEqual([
        'DB_USER',
      ]);
    }
  });
});

describe('credentials never serialise', () => {
  it('SecretValue renders [REDACTED] everywhere but reveal()', () => {
    const secret = new SecretValue(CANARY);
    expect(secret.reveal()).toBe(CANARY);
    for (const text of [
      JSON.stringify({ secret }),
      String(secret),
      `${secret}`,
      inspect(secret),
      inspect({ nested: { secret } }, { depth: 5 }),
    ]) {
      expect(text).not.toContain(CANARY);
      expect(text).toContain('[REDACTED]');
    }
  });

  it('configs and their descriptions never contain the password', () => {
    const config = loadDbConfig(localDb);
    const described = describeDbConfig(config);
    expect(described).toEqual({
      host: 'postgres',
      port: 5432,
      database: 'starter_app',
      user: 'starter_app',
      auth: 'password',
      passwordSource: 'env',
      ssl: 'verify-full',
      sslRootCert: '/tls/ca.pem',
      poolMax: 10,
    });
    for (const text of [JSON.stringify(config), JSON.stringify(described), inspect(config)]) {
      expect(text).not.toContain(CANARY);
    }
  });

  it('IAM descriptions name the region, never a token', () => {
    expect(describeDbConfig(loadDbConfig(awsDb))).toMatchObject({
      auth: 'iam',
      region: 'ap-southeast-1',
    });
  });
});

describe('loadDbIdentityConfig (second role on the same database)', () => {
  const base = loadDbConfig(localDb);

  it('takes host, database and TLS from the base and the identity from <prefix>DB_*', () => {
    const processor = loadDbIdentityConfig(
      {
        APP_RUNTIME: 'local',
        PROCESSOR_DB_USER: 'starter_processor',
        PROCESSOR_DB_PASSWORD: 'p-' + CANARY,
      },
      'PROCESSOR_',
      base,
    );
    expect(processor).toMatchObject({
      host: 'postgres',
      database: 'starter_app',
      user: 'starter_processor',
      ssl: base.ssl,
      auth: { mode: 'password', source: 'env' },
    });
    expect(JSON.stringify(processor)).not.toContain(CANARY);
  });

  it('defaults to IAM when the base uses IAM, and names prefixed variables in errors', () => {
    const iamBase = loadDbConfig(awsDb);
    expect(
      loadDbIdentityConfig({ PROCESSOR_DB_USER: 'starter_processor' }, 'PROCESSOR_', iamBase).auth,
    ).toEqual({ mode: 'iam', region: 'ap-southeast-1' });
    const error = configError(() =>
      loadDbIdentityConfig({ PROCESSOR_DB_PASSWORD: CANARY }, 'PROCESSOR_', iamBase),
    );
    expect(variables(error).sort()).toEqual(['PROCESSOR_DB_PASSWORD', 'PROCESSOR_DB_USER']);
    expect(error.message).not.toContain(CANARY);
  });
});

describe('loadDatabaseBootstrapConfig (dist/db-bootstrap.js)', () => {
  const passwords = {
    DB_BOOTSTRAP_MIGRATOR_PASSWORD: `m-${CANARY}`,
    DB_BOOTSTRAP_APP_PASSWORD: `a-${CANARY}`,
    DB_BOOTSTRAP_PROCESSOR_PASSWORD: `p-${CANARY}`,
    DB_BOOTSTRAP_RETENTION_PASSWORD: `r-${CANARY}`,
  };
  const awsBootstrap: Env = {
    ...awsDb,
    DB_USER: 'starteradmin',
    DB_AUTH: 'secrets-manager',
    DB_SECRET_ARN: ARN,
    DB_BOOTSTRAP_LOGIN_AUTH: 'iam',
  };

  it('AWS: master secret read at runtime, login roles on IAM, no passwords', () => {
    const config = loadDatabaseBootstrapConfig({
      ...awsBootstrap,
      DB_BOOTSTRAP_APP_CONNECTION_LIMIT: '60',
    });
    expect(config.db.auth).toEqual({
      mode: 'secrets-manager',
      region: 'ap-southeast-1',
      secretArn: ARN,
    });
    expect(config.loginAuth).toBe('iam');
    expect(config.passwords).toBeUndefined();
    expect(config.connectionLimits).toEqual({ starter_app: 60 });
  });

  it('AWS: password login roles are refused, as are passwords with IAM', () => {
    const error = configError(() =>
      loadDatabaseBootstrapConfig({
        ...awsBootstrap,
        DB_BOOTSTRAP_LOGIN_AUTH: 'password',
        ...passwords,
      }),
    );
    expect(variables(error)).toEqual(['DB_BOOTSTRAP_LOGIN_AUTH']);
    const withPasswords = configError(() =>
      loadDatabaseBootstrapConfig({ ...awsBootstrap, ...passwords }),
    );
    expect(variables(withPasswords).sort()).toEqual(Object.keys(passwords).sort());
    expect(withPasswords.message).not.toContain(CANARY);
  });

  it('local/CI: requires all four role passwords and wraps them', () => {
    const env: Env = {
      ...localDb,
      DB_USER: 'starter_admin',
      DB_BOOTSTRAP_LOGIN_AUTH: 'password',
      ...passwords,
    };
    const config = loadDatabaseBootstrapConfig(env);
    expect(config.passwords?.starter_app.reveal()).toBe(`a-${CANARY}`);
    expect(JSON.stringify(config)).not.toContain(CANARY);
    const error = configError(() =>
      loadDatabaseBootstrapConfig({ ...env, DB_BOOTSTRAP_PROCESSOR_PASSWORD: undefined }),
    );
    expect(variables(error)).toEqual(['DB_BOOTSTRAP_PROCESSOR_PASSWORD']);
  });

  it('requires an explicit login mode', () => {
    expect(
      variables(
        configError(() =>
          loadDatabaseBootstrapConfig({ ...awsBootstrap, DB_BOOTSTRAP_LOGIN_AUTH: undefined }),
        ),
      ),
    ).toEqual(['DB_BOOTSTRAP_LOGIN_AUTH']);
  });
});

describe('loadRetentionConfig (dist/retention.js)', () => {
  const retentionDb = { ...awsDb, DB_USER: 'starter_retention' };

  it('is disabled by default', () => {
    expect(loadRetentionConfig(retentionDb).policy).toEqual({ mode: 'disabled' });
  });

  it('dry-run needs the age threshold; apply also the approval reference', () => {
    expect(
      variables(
        configError(() => loadRetentionConfig({ ...retentionDb, RETENTION_MODE: 'dry-run' })),
      ),
    ).toEqual(['RETENTION_CONTENT_DAYS']);
    expect(
      variables(
        configError(() =>
          loadRetentionConfig({
            ...retentionDb,
            RETENTION_MODE: 'apply',
            RETENTION_CONTENT_DAYS: '90',
          }),
        ),
      ),
    ).toEqual(['RETENTION_APPROVAL_REF']);
    expect(
      loadRetentionConfig({
        ...retentionDb,
        RETENTION_MODE: 'apply',
        RETENTION_CONTENT_DAYS: '90',
        RETENTION_APPROVAL_REF: 'RET-2026-001',
      }).policy,
    ).toEqual({
      mode: 'apply',
      contentDays: 90,
      approvalRef: 'RET-2026-001',
      batchSize: 100,
      maxBatches: 50,
    });
  });

  it.each([
    ['RETENTION_MODE', 'delete-everything'],
    ['RETENTION_CONTENT_DAYS', '0'],
    ['RETENTION_BATCH_SIZE', '5000'],
    ['RETENTION_MAX_BATCHES', '0'],
  ])('rejects %s=%s', (variable, value) => {
    expect(
      variables(configError(() => loadRetentionConfig({ ...retentionDb, [variable]: value }))),
    ).toContain(variable);
  });
});
