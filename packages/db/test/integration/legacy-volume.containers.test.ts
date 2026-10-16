/**
 * LOCAL ONLY: the legacy local volume, initialised with POSTGRES_USER=starter_app, so the API role
 * is the cluster's BOOTSTRAP superuser (oid 10) and owns the database and the tables. PostgreSQL
 * 16+ refuses to demote that role; the bootstrap renames and locks it, creates a fresh starter_app
 * and moves every object to starter_owner, keeping the data. Uses its own throw-away container,
 * never the developer's starter-app-pgdata volume.
 */
import { randomBytes } from 'node:crypto';
import { DEFAULT_POSTGRES_IMAGE } from '@starter/testing';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapDatabaseRoles, loginPasswords } from '../../src/bootstrap.js';
import { sqlState } from '../../src/errors.js';
import { DB_LOGIN_ROLES } from '../../src/roles.js';
import { generatePassword } from '../../src/scram.js';
import { withClient } from './support.js';

const LEGACY_PASSWORD = generatePassword();
const ADMIN_PASSWORD = generatePassword();
const passwordsPlain = Object.fromEntries(
  DB_LOGIN_ROLES.map((r) => [r, `${r}-${generatePassword()}`]),
) as Record<(typeof DB_LOGIN_ROLES)[number], string>;

describe('upgrade of a legacy local volume (starter_app = bootstrap superuser)', () => {
  let container: StartedTestContainer;
  let endpoint: (
    user: string,
    password: string,
  ) => {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };

  beforeAll(async () => {
    container = await new GenericContainer(DEFAULT_POSTGRES_IMAGE)
      .withName(`starter-test-postgres-legacy-${randomBytes(4).toString('hex')}`)
      .withLabels({
        'starter.project': 'aws-modernization-starter',
        'starter.purpose': 'integration-test',
      })
      .withEnvironment({
        POSTGRES_USER: 'starter_app',
        POSTGRES_PASSWORD: LEGACY_PASSWORD,
        POSTGRES_DB: 'starter_app',
      })
      .withExposedPorts(5432)
      .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(120_000)
      .start();
    endpoint = (user, password) => ({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user,
      password,
      database: 'starter_app',
    });
    // Legacy schema and data, owned by the old superuser.
    await withClient(endpoint('starter_app', LEGACY_PASSWORD), async (c) => {
      await c.query(
        `CREATE TABLE jobs (id uuid PRIMARY KEY, title text NOT NULL, content text NOT NULL)`,
      );
      await c.query(`CREATE TABLE schema_migrations (version text PRIMARY KEY)`);
      await c.query(
        `INSERT INTO jobs VALUES ('0f8fad5b-d9cb-469f-a165-70867728950e', 'kept', 'kept body')`,
      );
      // What local/compose's postgres-admin step does once: a separate admin superuser.
      await c.query(`CREATE ROLE starter_admin LOGIN SUPERUSER PASSWORD '${ADMIN_PASSWORD}'`);
    });
  });
  afterAll(async () => {
    await container?.stop();
  });

  it('renames and locks the old superuser, creates a least-privilege starter_app, keeps the data', async () => {
    const result = await withClient(endpoint('starter_admin', ADMIN_PASSWORD), (c) =>
      bootstrapDatabaseRoles(c, {
        loginAuth: 'password',
        passwords: loginPasswords(passwordsPlain),
      }),
    );
    expect(result.changes).toEqual(
      expect.arrayContaining([
        'role starter_app: was the cluster bootstrap superuser (cannot be demoted); renamed to starter_app_legacy_bootstrap, NOLOGIN, password removed',
        'role starter_app: created',
        'database starter_app: owner set to the admin starter_admin',
        'public.jobs: owner starter_app_legacy_bootstrap -> starter_owner',
        'public.schema_migrations: owner starter_app_legacy_bootstrap -> starter_owner',
      ]),
    );
    expect(result.roles.find((r) => r.role === 'starter_app')).toMatchObject({
      superuser: false,
      login: true,
    });

    // The old superuser can no longer log in; the old starter_app password is gone with it.
    for (const [user, password] of [
      ['starter_app_legacy_bootstrap', LEGACY_PASSWORD],
      ['starter_app', LEGACY_PASSWORD],
    ] as const) {
      const error = await withClient(endpoint(user, password), async () => undefined).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(['28P01', '28000'], user).toContain(sqlState(error));
    }

    // Data kept, now owned by starter_owner; the new starter_app logs in with its new password.
    const state = await withClient(
      endpoint('starter_admin', ADMIN_PASSWORD),
      async (c) =>
        (
          await c.query<{ title: string; owner: string; superuser: boolean }>(
            `SELECT j.title, pg_get_userbyid(c.relowner) AS owner,
                  (SELECT rolsuper FROM pg_roles WHERE oid = 10) AS superuser
           FROM jobs j, pg_class c WHERE c.relname = 'jobs'`,
          )
        ).rows[0],
    );
    expect(state).toEqual({ title: 'kept', owner: 'starter_owner', superuser: true });
    const user = await withClient(
      endpoint('starter_app', passwordsPlain.starter_app),
      async (c) => (await c.query<{ u: string }>('SELECT current_user AS u')).rows[0]?.u,
    );
    expect(user).toBe('starter_app');
  });

  it('is idempotent on the upgraded volume', async () => {
    const again = await withClient(endpoint('starter_admin', ADMIN_PASSWORD), (c) =>
      bootstrapDatabaseRoles(c, {
        loginAuth: 'password',
        passwords: loginPasswords(passwordsPlain),
      }),
    );
    expect(again.changes).toEqual([
      'login roles: SCRAM-SHA-256 passwords set (starter_migrator, starter_app, starter_processor, starter_retention)',
    ]);
  });
});
