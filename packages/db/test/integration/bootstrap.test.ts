/**
 * The role bootstrap against a real PostgreSQL 17 (ADR 0220). Runs in CI on the job's fresh
 * service and locally on a fresh Testcontainers instance (the first test needs a cluster in which
 * the managed roles do not exist yet, like a new RDS instance).
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { BootstrapError, bootstrapDatabaseRoles, loginPasswords } from '../../src/bootstrap.js';
import { quoteIdent, quoteLiteral, sqlState } from '../../src/errors.js';
import { loadMigrations, migrate } from '../../src/migrations.js';
import { DB_LOGIN_ROLES, DB_MANAGED_ROLES } from '../../src/roles.js';
import { generatePassword, scramSha256Verifier } from '../../src/scram.js';
import { adminEndpoint, createTestDatabase, withClient } from './support.js';

const passwordsPlain = Object.fromEntries(
  DB_LOGIN_ROLES.map((role) => [role, `${role}-${generatePassword()}`]),
) as Record<(typeof DB_LOGIN_ROLES)[number], string>;
const passwords = loginPasswords(passwordsPlain);
const silent = { info: () => undefined };

const managedRolesInCluster = () =>
  withClient(
    adminEndpoint(),
    async (c) =>
      (
        await c.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY ($1)',
          [DB_MANAGED_ROLES],
        )
      ).rows[0]?.n ?? 0,
  );

describe('bootstrapDatabaseRoles on PostgreSQL 17', () => {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
  });

  it('a NON-superuser admin with CREATEROLE that owns the database (RDS master approximation) bootstraps a fresh cluster', async () => {
    if ((await managedRolesInCluster()) > 0) {
      throw new Error(
        'this test needs a cluster without the starter_* roles (fresh Testcontainers or CI service), like a new RDS instance',
      );
    }
    const master = `starter_test_master_${randomBytes(3).toString('hex')}`;
    const masterPassword = generatePassword();
    const database = `starter_test_rds_${randomBytes(3).toString('hex')}`;
    await withClient(adminEndpoint(), async (c) => {
      await c.query(
        `CREATE ROLE ${quoteIdent(master)} LOGIN CREATEROLE CREATEDB PASSWORD ${quoteLiteral(scramSha256Verifier(masterPassword))}`,
      );
    });
    const masterEndpoint = { ...adminEndpoint(), user: master, password: masterPassword };
    await withClient(masterEndpoint, (c) => c.query(`CREATE DATABASE ${quoteIdent(database)}`));
    // Runs at the end of THIS test: the CREATEROLE creator holds ADMIN on every role it created,
    // which a later bootstrap by another admin rightly reports as an unexpected membership.
    const cleanup = () =>
      withClient(adminEndpoint(), async (c) => {
        await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`);
        const grants = await c.query<{ role: string; grantor: string }>(
          `SELECT r.rolname AS role, g.rolname AS grantor FROM pg_auth_members am
           JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles g ON g.oid = am.grantor
           WHERE am.member = $1::regrole`,
          [master],
        );
        for (const grant of grants.rows) {
          await c.query(
            // CASCADE: grants the master made with that ADMIN option (starter_migrator -> starter_owner)
            // go too; the next bootstrap re-creates the migrator membership.
            `REVOKE ${quoteIdent(grant.role)} FROM ${quoteIdent(master)} GRANTED BY ${quoteIdent(grant.grantor)} CASCADE`,
          );
        }
      });
    try {
      const target = { ...masterEndpoint, database };
      const result = await withClient(target, (c) =>
        bootstrapDatabaseRoles(c, { loginAuth: 'password', passwords }),
      );
      expect(result.changes).toEqual(
        expect.arrayContaining([
          'role starter_owner: created',
          'role starter_app: created',
          `admin ${master}: may SET ROLE starter_owner (no inherited rights)`,
          'role starter_migrator: member of starter_owner with SET only',
          'schema public: owner set to starter_owner',
        ]),
      );
      expect(result.warnings).toEqual([]);
      expect(result.roles.every((r) => !r.superuser && !r.createRole && !r.createDb)).toBe(true);

      // The migrator can migrate (as starter_owner) on this database; the master stays a non-superuser.
      const dir = await mkdtemp(join(tmpdir(), 'starter-bootstrap-mig-'));
      try {
        await writeFile(join(dir, '0001_probe.sql'), 'CREATE TABLE probe (id int PRIMARY KEY);');
        const applied = await withClient(
          { ...target, user: 'starter_migrator', password: passwordsPlain.starter_migrator },
          async (c) => migrate(c, await loadMigrations(dir), silent),
        );
        expect(applied.applied).toEqual(['0001_probe.sql']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }

      // Converged: a second run changes nothing but (re)setting the credentials.
      const again = await withClient(target, (c) =>
        bootstrapDatabaseRoles(c, { loginAuth: 'password', passwords }),
      );
      expect(again.changes).toEqual([
        'login roles: SCRAM-SHA-256 passwords set (starter_migrator, starter_app, starter_processor, starter_retention)',
      ]);
    } finally {
      await cleanup();
    }
  });

  it('a superuser admin converges the same way and every login role authenticates with its password', async () => {
    const db = await createTestDatabase(adminEndpoint(), 'starter_boot');
    cleanups.push(() => db.drop());
    const first = await withClient(db.endpoint, (c) =>
      bootstrapDatabaseRoles(c, { loginAuth: 'password', passwords }),
    );
    expect(first.changes).toContain('schema public: owner set to starter_owner');
    for (const role of DB_LOGIN_ROLES) {
      const user = await withClient(
        { ...db.endpoint, user: role, password: passwordsPlain[role] },
        async (c) => (await c.query<{ u: string }>('SELECT current_user AS u')).rows[0]?.u,
      );
      expect(user).toBe(role);
    }
    // Only verifiers are stored.
    const stored = await withClient(db.endpoint, async (c) =>
      (
        await c.query<{ rolpassword: string }>(
          'SELECT rolpassword FROM pg_authid WHERE rolname = ANY ($1)',
          [[...DB_LOGIN_ROLES]],
        )
      ).rows.map((r) => r.rolpassword),
    );
    expect(stored).toHaveLength(4);
    for (const verifier of stored) expect(verifier.startsWith('SCRAM-SHA-256$4096:')).toBe(true);
    for (const plain of Object.values(passwordsPlain)) expect(stored.join()).not.toContain(plain);
  });

  it('aborts on an unexpected membership and changes nothing (one transaction)', async () => {
    const db = await createTestDatabase(adminEndpoint(), 'starter_boot');
    cleanups.push(() => db.drop());
    await withClient(adminEndpoint(), (c) => c.query('GRANT starter_owner TO starter_app'));
    try {
      const error = await withClient(db.endpoint, (c) =>
        bootstrapDatabaseRoles(c, { loginAuth: 'password', passwords }),
      ).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(BootstrapError);
      expect(error?.message).toMatch(
        /unexpected role membership: starter_app is a member of starter_owner/,
      );
      // Rolled back: PUBLIC still has CONNECT on this fresh database, schema owner unchanged.
      const state = await withClient(
        db.endpoint,
        async (c) =>
          (
            await c.query<{ connect: boolean; owner: string }>(
              `SELECT has_database_privilege('public', current_database(), 'CONNECT') AS connect,
                  pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'public'`,
            )
          ).rows[0],
      );
      expect(state).toEqual({ connect: true, owner: 'pg_database_owner' });
    } finally {
      await withClient(adminEndpoint(), (c) => c.query('REVOKE starter_owner FROM starter_app'));
    }
  });

  it('refuses IAM mode where rds_iam does not exist (not Amazon RDS)', async () => {
    const db = await createTestDatabase(adminEndpoint(), 'starter_boot');
    cleanups.push(() => db.drop());
    await expect(
      withClient(db.endpoint, (c) => bootstrapDatabaseRoles(c, { loginAuth: 'iam' })),
    ).rejects.toThrow(/needs the rds_iam role/);
  });

  it('refuses to run as one of the managed roles', async () => {
    const db = await createTestDatabase(adminEndpoint(), 'starter_boot');
    cleanups.push(() => db.drop());
    await withClient(db.endpoint, (c) =>
      bootstrapDatabaseRoles(c, { loginAuth: 'password', passwords }),
    );
    const error = await withClient(
      { ...db.endpoint, user: 'starter_app', password: passwordsPlain.starter_app },
      (c) => bootstrapDatabaseRoles(c, { loginAuth: 'password', passwords }),
    ).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(
      /run the bootstrap as the database admin, not as the managed role starter_app/,
    );
  });

  it('per-role connection limits are enforced by the server (53300)', async () => {
    const db = await createTestDatabase(adminEndpoint(), 'starter_boot');
    cleanups.push(() => db.drop());
    await withClient(db.endpoint, (c) =>
      bootstrapDatabaseRoles(c, {
        loginAuth: 'password',
        passwords,
        connectionLimits: { starter_retention: 1 },
      }),
    );
    const endpoint = {
      ...db.endpoint,
      user: 'starter_retention',
      password: passwordsPlain.starter_retention,
    };
    const first = new pg.Client(endpoint);
    await first.connect();
    try {
      const error = await withClient(endpoint, async () => undefined).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(sqlState(error)).toBe('53300');
    } finally {
      await first.end();
    }
    // Restore the default for the other suites sharing this cluster.
    await withClient(db.endpoint, (c) =>
      bootstrapDatabaseRoles(c, { loginAuth: 'password', passwords }),
    );
  });
});
