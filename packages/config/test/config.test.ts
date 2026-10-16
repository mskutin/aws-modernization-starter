import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  describeApiConfig,
  loadApiConfig,
  loadDatabaseConfig,
  loadLambdaConfig,
} from '../src/index.js';

const SFN_ARN = 'arn:aws:states:ap-southeast-1:123456789012:stateMachine:job-processing';

/** AWS-shaped API environment (APP_RUNTIME unset = aws): IAM database auth + verify-full TLS. */
const apiEnv = {
  DB_HOST: 'localhost',
  DB_NAME: 'jobs',
  DB_USER: 'starter_app',
  DB_AUTH: 'iam',
  DB_SSL_ROOT_CERT: '/app/certs/rds-global-bundle.pem',
  JOBS_TABLE_NAME: 'starter-jobs-state',
  AWS_REGION: 'ap-southeast-1',
  STATE_MACHINE_ARN: SFN_ARN,
  // Required; auth-specific cases live in auth.test.ts.
  AUTH_ISSUER: 'https://idp.example.com',
  AUTH_AUDIENCE: 'starter-jobs-api',
  AUTH_ALLOWED_CLIENT_IDS: 'starter-web',
};

/** Local-compose-shaped environment: the only place passwords and plain TCP are accepted. */
const localApiEnv = {
  APP_RUNTIME: 'local',
  DB_HOST: 'localhost',
  DB_NAME: 'jobs',
  DB_USER: 'starter_app',
  DB_PASSWORD: 's3cr3t-value',
  DB_SSL: 'disable',
  JOBS_TABLE_NAME: 'starter-jobs-state',
  AWS_REGION: 'ap-southeast-1',
  WORKFLOW_MODE: 'local',
  // The local compose shape: the TEST ONLY issuer over http, allowed by APP_RUNTIME=local.
  AUTH_ISSUER: 'http://127.0.0.1:9400',
  AUTH_AUDIENCE: 'starter-jobs-api',
  AUTH_ALLOW_INSECURE_ISSUER: 'true',
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

describe('loadApiConfig', () => {
  it('applies secure, contract-aligned defaults', () => {
    const config = loadApiConfig(apiEnv);
    expect(config).toMatchObject({
      port: 8080,
      logLevel: 'info',
      nodeEnv: 'production',
      db: {
        port: 5432,
        user: 'starter_app',
        auth: { mode: 'iam', region: 'ap-southeast-1' },
        ssl: { mode: 'verify-full', rootCertPath: '/app/certs/rds-global-bundle.pem' },
        poolMax: 10,
      },
      workflow: { mode: 'stepfunctions', stateMachineArn: SFN_ARN },
      cors: { allowedOrigins: [] },
      shutdownTimeoutMs: 20_000,
    });
    expect(config.dynamodb.endpoint).toBeUndefined();
  });

  it('parses local development settings', () => {
    const config = loadApiConfig({
      ...localApiEnv,
      DB_PORT: '15432',
      PORT: '9090',
      DYNAMODB_ENDPOINT: 'http://127.0.0.1:18000',
      CORS_ALLOWED_ORIGINS: 'http://localhost:5173, https://app.example.com',
      NODE_ENV: 'development',
    });
    expect(config).toMatchObject({
      port: 9090,
      workflow: { mode: 'local' },
      db: { port: 15432, ssl: { mode: 'disable' }, auth: { mode: 'password', source: 'env' } },
      dynamodb: { endpoint: 'http://127.0.0.1:18000' },
      cors: { allowedOrigins: ['http://localhost:5173', 'https://app.example.com'] },
      environment: 'development',
    });
  });

  it('treats empty variables as unset', () => {
    expect(loadApiConfig({ ...apiEnv, DYNAMODB_ENDPOINT: '', PORT: '' }).port).toBe(8080);
  });

  it('lists every missing variable without leaking values', () => {
    const error = configError(() => loadApiConfig({ DB_PASSWORD: 'leak-me', PORT: 'abc' }));
    const variables = error.issues.map((i) => i.variable);
    expect(variables).toEqual(
      expect.arrayContaining([
        'DB_HOST',
        'DB_NAME',
        'DB_USER',
        'JOBS_TABLE_NAME',
        'AWS_REGION',
        'PORT',
        'AUTH_ISSUER',
        'AUTH_AUDIENCE',
      ]),
    );
    expect(error.issues.find((i) => i.variable === 'DB_HOST')?.message).toBe('is required');
    expect(error.message).toContain('Invalid API configuration');
    expect(error.message).not.toContain('leak-me');
  });

  it('refuses the in-process workflow simulation on AWS', () => {
    // apiEnv is AWS-shaped (APP_RUNTIME unset = aws): only WORKFLOW_MODE differs.
    const error = configError(() => loadApiConfig({ ...apiEnv, WORKFLOW_MODE: 'local' }));
    expect(error.issues).toEqual([
      {
        variable: 'WORKFLOW_MODE',
        message: '"local" is only allowed when APP_RUNTIME is local or ci',
      },
    ]);
    expect(() => loadApiConfig({ ...apiEnv, WORKFLOW_MODE: 'local', APP_RUNTIME: 'aws' })).toThrow(
      ConfigError,
    );
    // The same simulation is accepted in the local and CI runtimes.
    expect(loadApiConfig(localApiEnv).workflow).toEqual({ mode: 'local' });
    expect(loadApiConfig({ ...localApiEnv, APP_RUNTIME: 'ci' }).workflow).toEqual({
      mode: 'local',
    });
  });

  it('requires STATE_MACHINE_ARN in stepfunctions mode', () => {
    const error = configError(() => loadApiConfig({ ...apiEnv, STATE_MACHINE_ARN: undefined }));
    expect(error.issues).toEqual([
      { variable: 'STATE_MACHINE_ARN', message: 'is required when WORKFLOW_MODE=stepfunctions' },
    ]);
  });

  it.each([
    ['WORKFLOW_MODE', 'simulate'],
    ['DB_SSL', 'prefer'],
    ['DB_SSL', 'require'],
    ['DB_AUTH', 'secrets-manager'],
    ['DB_USER', 'Starter-App'],
    ['STATE_MACHINE_ARN', 'arn:aws:lambda:ap-southeast-1:123456789012:function:x'],
    ['CORS_ALLOWED_ORIGINS', '*'],
    ['CORS_ALLOWED_ORIGINS', 'https://app.example.com/'],
    ['DYNAMODB_ENDPOINT', 'not a url'],
    ['AWS_REGION', 'Frankfurt'],
    ['PORT', '70000'],
    ['SHUTDOWN_TIMEOUT_MS', '10'],
    ['LOG_LEVEL', 'verbose'],
    ['JOBS_TABLE_NAME', 'x'],
  ])('rejects invalid %s=%s', (variable, value) => {
    const error = configError(() => loadApiConfig({ ...apiEnv, [variable]: value }));
    expect(error.issues.map((i) => i.variable)).toContain(variable);
  });

  it('describes the config without the database password', () => {
    const config = loadApiConfig(localApiEnv);
    for (const text of [JSON.stringify(describeApiConfig(config)), JSON.stringify(config)]) {
      expect(text).not.toContain('s3cr3t-value');
      expect(text).toContain('localhost');
    }
  });
});

describe('loadLambdaConfig', () => {
  it('parses the Lambda environment', () => {
    expect(
      loadLambdaConfig({
        JOBS_TABLE_NAME: 'starter-jobs',
        AWS_REGION: 'ap-southeast-1',
        LOG_LEVEL: 'debug',
      }),
    ).toEqual({
      tableName: 'starter-jobs',
      region: 'ap-southeast-1',
      endpoint: undefined,
      logLevel: 'debug',
      appVersion: 'unknown',
      environment: 'unknown',
      runtime: 'aws',
    });
  });

  it('fails fast when the table name is missing', () => {
    const error = configError(() => loadLambdaConfig({ AWS_REGION: 'ap-southeast-1' }));
    expect(error.message).toBe('Invalid Lambda configuration:\n  - JOBS_TABLE_NAME: is required');
  });
});

describe('loadDatabaseConfig', () => {
  it('needs only the DB_* variables (migration task)', () => {
    const { db, logLevel, runtime } = loadDatabaseConfig({
      DB_HOST: 'h',
      DB_NAME: 'n',
      DB_USER: 'starter_migrator',
      DB_AUTH: 'iam',
      DB_SSL_ROOT_CERT: '/certs/rds.pem',
      AWS_REGION: 'ap-southeast-1',
    });
    expect(db).toEqual({
      host: 'h',
      port: 5432,
      database: 'n',
      user: 'starter_migrator',
      auth: { mode: 'iam', region: 'ap-southeast-1' },
      ssl: { mode: 'verify-full', rootCertPath: '/certs/rds.pem' },
      poolMax: 10,
    });
    expect(logLevel).toBe('info');
    expect(runtime).toBe('aws');
  });

  it('fails fast without credentials', () => {
    const error = configError(() => loadDatabaseConfig({ DB_HOST: 'h', DB_NAME: 'n' }));
    expect(error.issues.map((i) => i.variable).sort()).toEqual([
      'DB_AUTH',
      'DB_PASSWORD',
      'DB_SSL_ROOT_CERT',
      'DB_USER',
    ]);
  });
});
