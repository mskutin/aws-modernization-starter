/**
 * Credentials never leak through errors or logs: canary passwords and IAM
 * tokens are pushed through every failure path of @starter/db against a real PostgreSQL and must not
 * appear in error messages, stacks, serialised errors, pool logs or config descriptions.
 */
import { Writable } from 'node:stream';
import { SecretValue, describeDbConfig, type DatabaseConfig } from '@starter/config';
import { createLogger } from '@starter/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgPool } from '../../src/pool.js';
import { adminEndpoint, createTestDatabase, temporaryRole, withClient } from './support.js';

const CANARY_PASSWORD = `pw-canary-${Date.now().toString(36)}-x7`;
const CANARY_TOKEN = `localhost:5432/?Action=connect&DBUser=starter_app&X-Amz-Signature=canary${Date.now()}`;

/** Every string a caller could end up logging for an error. */
function everythingAbout(error: unknown): string {
  const e = error as Error & Record<string, unknown>;
  return [
    String(e),
    e.message,
    e.stack,
    JSON.stringify(e),
    JSON.stringify(Object.fromEntries(Object.entries(e))),
    e.cause ? everythingAbout(e.cause) : '',
  ].join('\n');
}

function capturingLogger() {
  let output = '';
  const destination = new Writable({
    write(chunk: Buffer, _enc, done) {
      output += chunk.toString();
      done();
    },
  });
  const logger = createLogger({ service: 'db-leak-test', level: 'trace', destination });
  return { logger, output: () => output };
}

describe('no credential in errors or logs', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let role: Awaited<ReturnType<typeof temporaryRole>>;

  beforeAll(async () => {
    db = await createTestDatabase(adminEndpoint(), 'starter_leak');
    role = await temporaryRole(db.endpoint, `right-${CANARY_PASSWORD}`);
  });
  afterAll(async () => {
    await db?.drop();
    await role?.drop();
  });

  const base = (): Omit<DatabaseConfig, 'auth'> => ({
    host: db.endpoint.host,
    port: db.endpoint.port,
    database: db.endpoint.database,
    user: role.name,
    ssl: { mode: 'disable' },
    poolMax: 1,
  });

  async function failure(config: DatabaseConfig, options = {}) {
    const { logger, output } = capturingLogger();
    const pool = createPgPool(config, logger, { connectionTimeoutMillis: 3_000, ...options });
    let error: unknown;
    try {
      await pool.query('SELECT 1');
    } catch (e) {
      error = e;
      logger.error({ err: e, config: describeDbConfig(config) }, 'query failed');
    } finally {
      await pool.end();
    }
    expect(error).toBeDefined();
    return { error, text: `${everythingAbout(error)}\n${output()}` };
  }

  it('wrong password: 28P01, no password in the error or the log line', async () => {
    const { error, text } = await failure({
      ...base(),
      auth: { mode: 'password', source: 'env', password: new SecretValue(CANARY_PASSWORD) },
    });
    expect((error as { code?: string }).code).toBe('28P01');
    expect(text).not.toContain(CANARY_PASSWORD);
    expect(text).toContain('password authentication failed');
  });

  it('IAM token rejected by the server: the token never appears', async () => {
    const { text } = await failure(
      { ...base(), auth: { mode: 'iam', region: 'ap-southeast-1' } },
      { iamTokenGenerator: async () => CANARY_TOKEN },
    );
    expect(text).not.toContain(CANARY_TOKEN);
    expect(text).not.toContain('X-Amz-Signature');
  });

  it('unreachable server: no password in the error or the log line', async () => {
    const { text } = await failure({
      ...base(),
      host: '127.0.0.1',
      port: 1,
      auth: { mode: 'password', source: 'env', password: new SecretValue(CANARY_PASSWORD) },
    });
    expect(text).toMatch(/ECONNREFUSED/);
    expect(text).not.toContain(CANARY_PASSWORD);
  });

  it('idle client terminated by the server: the pool logs the code, never the client', async () => {
    // A plain logger, not the redacting one: this is what the pool hands to any logger.
    const logged: string[] = [];
    const seen = new WeakSet<object>();
    const json = (value: unknown) =>
      JSON.stringify(value, (_key, v: unknown) => {
        if (typeof v === 'bigint') return v.toString();
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        return v;
      });
    const logger = {
      warn: (obj: object, msg?: string) => void logged.push(`${msg ?? ''} ${json(obj)}`),
      debug: () => undefined,
    };
    const pool = createPgPool(
      {
        ...base(),
        auth: {
          mode: 'password',
          source: 'env',
          password: new SecretValue(`right-${CANARY_PASSWORD}`),
        },
      },
      logger,
    );
    try {
      const client = await pool.connect();
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      client.release();
      const idleError = new Promise<void>((resolve) => pool.once('error', () => resolve()));
      await withClient(adminEndpoint(), (c) =>
        c.query('SELECT pg_terminate_backend($1)', [rows[0]?.pid]),
      );
      await idleError;
    } finally {
      await pool.end();
    }
    const text = logged.join('\n');
    expect(text).toContain('idle PostgreSQL client error');
    expect(text).toContain('57P01');
    for (const internal of ['secretKey', 'processID', 'connectionParameters', role.name]) {
      expect(text).not.toContain(internal);
    }
    expect(text).not.toContain(CANARY_PASSWORD);
  });

  it('the pool object itself never serialises the password', () => {
    const pool = createPgPool(
      {
        ...base(),
        auth: { mode: 'password', source: 'env', password: new SecretValue(CANARY_PASSWORD) },
      },
      { warn: () => undefined, debug: () => undefined },
    );
    try {
      expect(JSON.stringify(pool.options)).not.toContain(CANARY_PASSWORD);
    } finally {
      void pool.end();
    }
  });
});
