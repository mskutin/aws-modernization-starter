import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_SQL,
  BootstrapError,
  DEFAULT_CONNECTION_LIMITS,
  bootstrapDatabaseRoles,
  loginPasswords,
} from '../../src/bootstrap.js';

const CANARY = 'canary-Pa55word-3c9e1a77';
const passwords = loginPasswords({
  starter_migrator: `m-${CANARY}`,
  starter_app: `a-${CANARY}`,
  starter_processor: `p-${CANARY}`,
  starter_retention: `r-${CANARY}`,
});

/** Records every statement; optionally fails one. Never talks to a database. */
class FakeClient extends EventEmitter {
  readonly statements: { text: string; values?: unknown[] }[] = [];
  constructor(private readonly failOn?: RegExp) {
    super();
  }
  async query(text: string, values?: unknown[]) {
    this.statements.push({ text, values });
    if (this.failOn?.test(text)) {
      throw Object.assign(new Error(`server rejected: ${text}`), { code: '42501' });
    }
    return { rows: [], rowCount: 0 };
  }
}

async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

const run = (client: FakeClient, options: Parameters<typeof bootstrapDatabaseRoles>[1]) =>
  bootstrapDatabaseRoles(client as unknown as pg.ClientBase, options);

describe('bootstrapDatabaseRoles (statements sent; real PostgreSQL in the integration suite)', () => {
  it('password mode: one SCRAM verifier per login role, never the cleartext', async () => {
    const client = new FakeClient();
    const result = await run(client, { loginAuth: 'password', passwords });
    const passwordStatements = client.statements.filter((s) => s.text.startsWith('ALTER ROLE "'));
    expect(passwordStatements.map((s) => s.text.slice(0, s.text.indexOf(' PASSWORD')))).toEqual([
      'ALTER ROLE "starter_migrator"',
      'ALTER ROLE "starter_app"',
      'ALTER ROLE "starter_processor"',
      'ALTER ROLE "starter_retention"',
    ]);
    for (const s of passwordStatements) {
      expect(s.text).toMatch(/ PASSWORD 'SCRAM-SHA-256\$4096:[^']+'$/);
    }
    expect(JSON.stringify(client.statements)).not.toContain(CANARY);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it('runs in one transaction with an advisory lock and passes parameters as settings', async () => {
    const client = new FakeClient();
    await run(client, { loginAuth: 'iam', connectionLimits: { starter_app: 80 } });
    const texts = client.statements.map((s) => s.text.trim().split('\n')[0]);
    expect(texts[0]).toBe('BEGIN');
    expect(texts[1]).toBe('SELECT pg_advisory_xact_lock($1)');
    // The state report is read after COMMIT.
    const commit = texts.indexOf('COMMIT');
    expect(commit).toBeGreaterThan(1);
    expect(texts.slice(commit + 1).map((t) => t?.slice(0, 22))).toEqual([
      'SELECT rolname AS role',
      'SELECT r.rolname AS ro',
    ]);
    const settings = client.statements.find((s) => /set_config/.test(s.text));
    expect(settings?.values).toEqual([
      'iam',
      JSON.stringify({ ...DEFAULT_CONNECTION_LIMITS, starter_app: 80 }),
    ]);
    expect(client.statements.filter((s) => / PASSWORD NULL$/.test(s.text))).toHaveLength(4);
  });

  it('refuses incomplete or weak passwords before touching the database', async () => {
    const client = new FakeClient();
    const { starter_retention: _omitted, ...three } = passwords;
    await expect(
      run(client, { loginAuth: 'password', passwords: three as typeof passwords }),
    ).rejects.toThrow(
      new BootstrapError(
        'a password for starter_retention is required when loginAuth is "password"',
      ),
    );
    await expect(
      run(client, { loginAuth: 'password', passwords: { ...passwords, starter_app: 'short' } }),
    ).rejects.toThrow(/at least 16 characters/);
    await expect(
      run(client, { loginAuth: 'iam', connectionLimits: { starter_app: 0 } }),
    ).rejects.toThrow(/connection limit of starter_app/);
    expect(client.statements).toEqual([]);
  });

  it('a failing credential statement rolls back and reveals neither statement nor server text', async () => {
    const client = new FakeClient(/ALTER ROLE "starter_app" PASSWORD/);
    const error = await rejected(run(client, { loginAuth: 'password', passwords }));
    expect(error).toBeInstanceOf(BootstrapError);
    expect(error.message).toBe(
      'database bootstrap failed at "credentials of starter_app": SQLSTATE 42501',
    );
    expect(error.cause).toBeUndefined();
    expect(client.statements.at(-1)?.text).toBe('ROLLBACK');
  });

  it('a failing role-model step reports the server message and SQLSTATE', async () => {
    const client = new FakeClient(/DO \$bootstrap\$/);
    await expect(run(client, { loginAuth: 'iam' })).rejects.toThrow(
      /failed at "role model": server rejected: .*\(SQLSTATE 42501\)/s,
    );
  });

  it('the SQL block never contains a password literal and pins the contract role names', () => {
    expect(BOOTSTRAP_SQL).not.toMatch(/PASSWORD '/);
    for (const role of [
      'starter_owner',
      'starter_migrator',
      'starter_app',
      'starter_processor',
      'starter_retention',
    ]) {
      expect(BOOTSTRAP_SQL).toContain(`'${role}'`);
    }
    expect(BOOTSTRAP_SQL).toContain(
      'GRANT starter_owner TO starter_migrator WITH INHERIT FALSE, SET TRUE, ADMIN FALSE',
    );
    expect(BOOTSTRAP_SQL).toContain('REVOKE ALL ON DATABASE %I FROM PUBLIC');
    expect(BOOTSTRAP_SQL).toContain('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  });
});
