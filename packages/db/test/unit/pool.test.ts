import { SecretValue, type DatabaseConfig } from '@starter/config';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_LIFETIME_SECONDS,
  createPgClient,
  createPgPool,
  pgClientConfig,
} from '../../src/pool.js';
import { rdsCaBundlePath } from '../../src/tls.js';

const CANARY = 'canary-Pa55word-91aa0f3d';
const passwordConfig: DatabaseConfig = {
  host: 'localhost',
  port: 15432,
  database: 'starter_app',
  user: 'starter_app',
  auth: { mode: 'password', source: 'env', password: new SecretValue(CANARY) },
  ssl: { mode: 'disable' },
  poolMax: 7,
};
const iamConfig: DatabaseConfig = {
  ...passwordConfig,
  auth: { mode: 'iam', region: 'ap-southeast-1' },
  ssl: { mode: 'verify-full', rootCertPath: rdsCaBundlePath() },
};
const logger = { warn: vi.fn(), debug: vi.fn() };

describe('pgClientConfig', () => {
  it('resolves the password lazily and applies statement/query timeouts', async () => {
    const options = pgClientConfig(passwordConfig, { applicationName: 'starter-test' });
    expect(options).toMatchObject({
      host: 'localhost',
      port: 15432,
      database: 'starter_app',
      user: 'starter_app',
      ssl: false,
      application_name: 'starter-test',
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      query_timeout: 6_000,
    });
    expect(typeof options.password).toBe('function');
    await expect((options.password as () => Promise<string>)()).resolves.toBe(CANARY);
  });

  it('timeouts can be disabled (migrations, bootstrap)', () => {
    const options = pgClientConfig(passwordConfig, { statementTimeoutMs: 0, queryTimeoutMs: 0 });
    expect(options).not.toHaveProperty('statement_timeout');
    expect(options).not.toHaveProperty('query_timeout');
  });

  it('verify-full loads the CA bundle up front (bad paths fail at start-up)', () => {
    expect(pgClientConfig(iamConfig).ssl).toMatchObject({ rejectUnauthorized: true });
    expect(() =>
      pgClientConfig({ ...iamConfig, ssl: { mode: 'verify-full', rootCertPath: '/nope.pem' } }),
    ).toThrow(/cannot read DB_SSL_ROOT_CERT \/nope.pem/);
  });
});

describe('createPgPool', () => {
  it('pool options: size, recycling, no plain password anywhere in the options', async () => {
    const pool = createPgPool(passwordConfig, logger);
    try {
      expect(pool.options).toMatchObject({
        max: 7,
        idleTimeoutMillis: 30_000,
        maxLifetimeSeconds: DEFAULT_MAX_LIFETIME_SECONDS,
        allowExitOnIdle: false,
      });
      expect(DEFAULT_MAX_LIFETIME_SECONDS).toBe(900);
      expect(JSON.stringify(pool.options)).not.toContain(CANARY);
    } finally {
      await pool.end();
    }
  });

  it('Lambdas: max 1 and exit on idle', async () => {
    const pool = createPgPool(passwordConfig, logger, { max: 1, allowExitOnIdle: true });
    try {
      expect(pool.options).toMatchObject({ max: 1, allowExitOnIdle: true });
    } finally {
      await pool.end();
    }
  });

  it('IAM: the pool signs a fresh token for each new connection (fake signer)', async () => {
    let tokens = 0;
    const pool = createPgPool(iamConfig, logger, {
      iamTokenGenerator: async () => `token-${(tokens += 1)}`,
    });
    try {
      const password = pool.options.password as () => Promise<string>;
      expect(tokens).toBe(0);
      await expect(password()).resolves.toBe('token-1');
      await expect(password()).resolves.toBe('token-2');
    } finally {
      await pool.end();
    }
  });

  it('logs idle-client errors (code and message, never the attached client) instead of crashing', async () => {
    const pool = createPgPool(passwordConfig, logger);
    try {
      pool.emit('error', new Error('Connection terminated unexpectedly'), undefined);
      expect(logger.warn).toHaveBeenLastCalledWith(
        { pgError: { name: 'Error', message: 'Connection terminated unexpectedly' } },
        'idle PostgreSQL client error',
      );
      // pg-pool attaches the idle client (parameters, process id, cancel key) to the error.
      const client = { user: 'starter_app', processID: 4242, secretKey: 1717 };
      const terminated = Object.assign(new Error('terminating connection'), {
        code: '57P01',
        severity: 'FATAL',
        client,
      });
      pool.emit('error', terminated, client);
      expect(logger.warn).toHaveBeenLastCalledWith(
        {
          pgError: {
            name: 'Error',
            message: 'terminating connection',
            code: '57P01',
            severity: 'FATAL',
          },
        },
        'idle PostgreSQL client error',
      );
    } finally {
      await pool.end();
    }
  });
});

describe('createPgClient', () => {
  it('builds a single client with the same settings', async () => {
    const client = createPgClient(passwordConfig, { applicationName: 'starter-migrate' });
    expect(client.user).toBe('starter_app');
    expect(JSON.stringify(client)).not.toContain(CANARY);
  });
});
