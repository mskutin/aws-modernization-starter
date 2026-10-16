/**
 * Credential rotation without a restart (ADR 0221), against a real PostgreSQL: the pool resolves
 * the password for every NEW connection (here from DB_PASSWORD_FILE, re-read each time; on AWS an
 * IAM token is signed per connection through the same hook). After the role's password changes:
 * - connections opened before the rotation keep working (PostgreSQL does not re-authenticate),
 * - new connections succeed with the new password, with no restart,
 * - the old password is rejected,
 * - connections are recycled after maxLifetimeSeconds, so old sessions do not live forever.
 * Not a test of AWS-managed rotation or IAM authentication: neither was exercised here.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretValue, type DatabaseConfig } from '@starter/config';
import { pollUntil } from '@starter/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyDbError, sqlState } from '../../src/errors.js';
import { createPgPool } from '../../src/pool.js';
import { generatePassword } from '../../src/scram.js';
import { adminEndpoint, createTestDatabase, temporaryRole } from './support.js';

const silent = { warn: () => undefined, debug: () => undefined };

describe('password rotation without restart (DB_PASSWORD_FILE)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let role: Awaited<ReturnType<typeof temporaryRole>>;
  let dir: string;
  let passwordFile: string;
  const oldPassword = `old-${generatePassword()}`;
  const newPassword = `new-${generatePassword()}`;

  const config = (auth: DatabaseConfig['auth']): DatabaseConfig => ({
    host: db.endpoint.host,
    port: db.endpoint.port,
    database: db.endpoint.database,
    user: role.name,
    auth,
    ssl: { mode: 'disable' },
    poolMax: 4,
  });

  beforeAll(async () => {
    db = await createTestDatabase(adminEndpoint(), 'starter_rotation');
    role = await temporaryRole(db.endpoint, oldPassword);
    dir = await mkdtemp(join(tmpdir(), 'starter-rotation-'));
    passwordFile = join(dir, 'password');
    await writeFile(passwordFile, `${oldPassword}\n`, { mode: 0o600 });
  });

  afterAll(async () => {
    await db?.drop();
    await role?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('keeps existing sessions, uses the new password for new ones, rejects the old one', async () => {
    const pool = createPgPool(config({ mode: 'password', source: 'file', passwordFile }), silent);
    try {
      const before = await pool.connect(); // held open across the rotation
      try {
        const pidBefore = (await before.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]?.pid;

        // Rotate: the secret store changes first (here: the file), then the database.
        await writeFile(passwordFile, `${newPassword}\n`);
        await role.setPassword(newPassword);

        // 1. The session authenticated with the old password still works.
        expect((await before.query('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]);

        // 2. A new physical connection (the first one is checked out) uses the new password.
        const after = await pool.connect();
        try {
          const row = (
            await after.query<{ pid: number; user: string }>(
              'SELECT pg_backend_pid() AS pid, current_user AS user',
            )
          ).rows[0];
          expect(row?.user).toBe(role.name);
          expect(row?.pid).not.toBe(pidBefore);
        } finally {
          after.release();
        }
      } finally {
        before.release();
      }
    } finally {
      await pool.end();
    }

    // 3. A client still holding the old password can no longer connect.
    const stale = new pg.Client({ ...db.endpoint, user: role.name, password: oldPassword });
    const error = await stale.connect().then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    await stale.end().catch(() => undefined);
    expect(sqlState(error)).toBe('28P01');
    expect(classifyDbError(error)).toBe('permanent');
    expect(`${error?.message} ${error?.stack}`).not.toContain(oldPassword);
    expect(`${error?.message} ${error?.stack}`).not.toContain(newPassword);
  });

  it('a static DB_PASSWORD keeps the old value until restart: the documented limitation', async () => {
    const pool = createPgPool(
      config({ mode: 'password', source: 'env', password: new SecretValue(oldPassword) }),
      silent,
    );
    try {
      const error = await pool.query('SELECT 1').then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(sqlState(error)).toBe('28P01');
    } finally {
      await pool.end();
    }
  });

  it('recycles connections after maxLifetimeSeconds (sessions do not outlive a rotation forever)', async () => {
    const pool = createPgPool(config({ mode: 'password', source: 'file', passwordFile }), silent, {
      maxLifetimeSeconds: 1,
      max: 1,
    });
    try {
      const pid = async () =>
        (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      const first = await pid();
      const next = await pollUntil(
        'the pool to replace its expired connection',
        async () => {
          const current = await pid();
          return current !== first ? current : undefined;
        },
        { deadlineMs: 15_000, initialDelayMs: 200, maxDelayMs: 500 },
      );
      expect(next).not.toBe(first);
    } finally {
      await pool.end();
    }
  });
});
