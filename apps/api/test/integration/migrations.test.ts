/**
 * Versioned migrations against PostgreSQL 17 with the REAL role model (ADR 0203/0220): the
 * runner connects as starter_migrator and acts only through SET ROLE starter_owner. Includes the upgrade
 * upgrade paths (a database at 0002, the legacy local volume shape).
 */
import { cp, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPermissionDenied, quoteLiteral, scramSha256Verifier } from '@starter/db';
import { prepareRoleDatabase, testRolePassword, type PreparedDatabase } from '@starter/db/testing';
import { createTestDatabase, type PostgresEndpoint } from '@starter/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  MigrationError,
  loadMigrations,
  migrate,
  migrationStatus,
} from '../../src/persistence/migrations.js';
import { MIGRATIONS_DIR, silentLogger, withClient } from './helpers.js';

const REPOSITORY_MIGRATIONS = [
  '0001_create_jobs.sql',
  '0002_jobs_listing_index.sql',
  '0003_role_privileges.sql',
  '0004_job_content_retention.sql',
  '0005_job_owner.sql',
  '0006_job_owner_index.sql',
];

/** Owner of every object in schema public (tables, sequences, functions), keyed by name. */
async function ownersOf(admin: PostgresEndpoint): Promise<Record<string, string>> {
  return withClient(admin, async (client) => {
    const rows = await client.query<{ name: string; owner: string }>(`
      SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      UNION ALL
      SELECT p.proname, pg_get_userbyid(p.proowner)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
      UNION ALL
      SELECT 'schema public', pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'`);
    return Object.fromEntries(rows.rows.map((r) => [r.name, r.owner]));
  });
}

describe('SQL migrations against PostgreSQL 17 (as starter_migrator)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let prepared: PreparedDatabase;
  let client: pg.Client;
  let dir: string;

  beforeAll(async () => {
    db = await createTestDatabase(inject('integrationInfra').postgres);
    prepared = await prepareRoleDatabase(db.endpoint); // bootstrap only, no migrations yet
    client = new pg.Client(prepared.roles.starter_migrator);
    await client.connect();
    dir = await mkdtemp(join(tmpdir(), 'starter-migrations-'));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
  });

  afterAll(async () => {
    await client?.end();
    await db?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('the migrator has no rights of its own: without SET ROLE it cannot create anything', async () => {
    const error = await client
      .query('CREATE TABLE public.sneaky (id int)')
      .catch((e: unknown) => e);
    expect(isPermissionDenied(error)).toBe(true);
    // Unqualified, the schema is not even visible to it (no USAGE): 3F000 "no schema selected".
    await expect(
      migrate(client, await loadMigrations(dir), silentLogger(), { role: null }),
    ).rejects.toMatchObject({ code: '3F000' });
  });

  it('applies every migration once, records checksums, and starter_owner owns everything', async () => {
    const migrations = await loadMigrations(dir);
    expect((await migrate(client, migrations, silentLogger())).applied).toEqual(
      REPOSITORY_MIGRATIONS,
    );
    const rows = await withClient(db.endpoint, (admin) =>
      admin.query<{ version: string; checksum: string }>(
        'SELECT version, checksum FROM schema_migrations ORDER BY version',
      ),
    );
    expect(rows.rows).toEqual(
      migrations.map((m) => ({ version: m.version, checksum: m.checksum })),
    );
    const index = await withClient(db.endpoint, (admin) =>
      admin.query("SELECT indexname FROM pg_indexes WHERE tablename = 'jobs' ORDER BY indexname"),
    );
    expect(index.rows.map((r: { indexname: string }) => r.indexname)).toEqual([
      'jobs_created_at_id_idx',
      'jobs_idempotency_key_uq',
      'jobs_owner_created_at_id_idx',
      'jobs_pkey',
    ]);
    expect(await ownersOf(db.endpoint)).toEqual({
      jobs: 'starter_owner',
      schema_migrations: 'starter_owner',
      load_job_document: 'starter_owner',
      'schema public': 'starter_owner',
    });
    // The session is back to starter_migrator after the run.
    expect((await client.query<{ u: string }>('SELECT current_user AS u')).rows[0]?.u).toBe(
      'starter_migrator',
    );
  });

  it('is a no-op when re-run, and status works as the migrator', async () => {
    expect((await migrate(client, await loadMigrations(dir), silentLogger())).applied).toEqual([]);
    expect((await migrationStatus(client, await loadMigrations(dir))).pending).toEqual([]);
  });

  it('serialises concurrent runners with an advisory lock', async () => {
    await writeFile(join(dir, '0100_add_note.sql'), 'ALTER TABLE jobs ADD COLUMN note text;');
    const other = new pg.Client(prepared.roles.starter_migrator);
    await other.connect();
    try {
      const migrations = await loadMigrations(dir);
      const results = await Promise.all([
        migrate(client, migrations, silentLogger()),
        migrate(other, migrations, silentLogger()),
      ]);
      expect(results.flatMap((r) => r.applied)).toEqual(['0100_add_note.sql']);
    } finally {
      await other.end();
    }
  });

  it('rolls back a failing migration and does not record it', async () => {
    await writeFile(
      join(dir, '0101_broken.sql'),
      'ALTER TABLE jobs ADD COLUMN extra text; SELECT * FROM table_that_does_not_exist;',
    );
    await expect(migrate(client, await loadMigrations(dir), silentLogger())).rejects.toThrow(
      /0101_broken\.sql failed/,
    );
    const state = await withClient(db.endpoint, async (admin) => ({
      column: await admin.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'jobs' AND column_name = 'extra'",
      ),
      recorded: await admin.query("SELECT 1 FROM schema_migrations WHERE version = '0101'"),
    }));
    expect(state.column.rowCount).toBe(0);
    expect(state.recorded.rowCount).toBe(0);
    await rm(join(dir, '0101_broken.sql'));
  });

  it('runs a no-transaction migration outside a transaction (CREATE INDEX CONCURRENTLY)', async () => {
    await writeFile(
      join(dir, '0102_note_index.sql'),
      '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_note_idx ON jobs (note);\n',
    );
    const migrations = await loadMigrations(dir);
    expect(migrations.find((m) => m.version === '0102')?.transactional).toBe(false);
    expect((await migrate(client, migrations, silentLogger())).applied).toEqual([
      '0102_note_index.sql',
    ]);
    const index = await withClient(db.endpoint, (admin) =>
      admin.query<{ valid: boolean; owner: string }>(`
        SELECT i.indisvalid AS valid, pg_get_userbyid(c.relowner) AS owner
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'jobs_note_idx'`),
    );
    expect(index.rows).toEqual([{ valid: true, owner: 'starter_owner' }]);
  });

  it('refuses to run when an applied migration was modified', async () => {
    await appendFile(join(dir, '0001_create_jobs.sql'), '\n-- sneaky edit\n');
    const error = await migrate(client, await loadMigrations(dir), silentLogger()).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as Error).message).toMatch(
      /0001_create_jobs\.sql was modified after it was applied/,
    );
  });
});

describe('upgrade paths', () => {
  const admin = () => inject('integrationInfra').postgres;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'starter-migrations-0002-'));
    for (const file of REPOSITORY_MIGRATIONS.slice(0, 2)) {
      await cp(join(MIGRATIONS_DIR, file), join(dir, file));
    }
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    // Never leave the cluster-wide role elevated, even if a test failed half-way.
    await withClient(admin(), (c) => c.query('ALTER ROLE starter_app NOSUPERUSER')).catch(
      () => undefined,
    );
  });

  /** One legacy job row, inserted by whoever ran the old migrations. */
  const insertLegacyRow = (client: pg.Client) =>
    client.query(`
      INSERT INTO jobs (id, title, content, content_sha256, content_length, options, idempotency_key,
                        request_fingerprint, contract_version, created_at)
      VALUES ('0f8fad5b-d9cb-469f-a165-70867728950e', 'Legacy title', 'legacy body', repeat('a', 64), 11,
              '{}', 'legacy-key-0001', repeat('b', 64), '1.0.0', now() - interval '30 days')`);

  async function assertUpgraded(database: PostgresEndpoint, prepared: PreparedDatabase) {
    expect(await ownersOf(database)).toEqual({
      jobs: 'starter_owner',
      schema_migrations: 'starter_owner',
      load_job_document: 'starter_owner',
      'schema public': 'starter_owner',
    });
    const versions = await withClient(database, (c) =>
      c.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version'),
    );
    expect(versions.rows.map((r) => r.version)).toEqual(
      REPOSITORY_MIGRATIONS.map((file) => file.slice(0, 4)),
    );
    // The old row is intact and readable by the API identity (without content).
    const row = await withClient(prepared.roles.starter_app, (c) =>
      c.query('SELECT title, idempotency_key FROM jobs'),
    );
    expect(row.rows).toEqual([{ title: 'Legacy title', idempotency_key: 'legacy-key-0001' }]);
  }

  it('from a database at 0002 (applied by the admin, no roles yet) to the latest version', async () => {
    const db = await createTestDatabase(admin());
    try {
      await withClient(db.endpoint, async (c) => {
        expect(
          (await migrate(c, await loadMigrations(dir), silentLogger(), { role: null })).applied,
        ).toEqual(REPOSITORY_MIGRATIONS.slice(0, 2));
        await insertLegacyRow(c);
      });
      const prepared = await prepareRoleDatabase(db.endpoint, { migrationsDir: MIGRATIONS_DIR });
      expect(prepared.migrations).toEqual(REPOSITORY_MIGRATIONS.slice(2));
      expect(prepared.bootstrap.changes).toEqual(
        expect.arrayContaining([
          `public.jobs: owner ${admin().user} -> starter_owner`,
          `public.schema_migrations: owner ${admin().user} -> starter_owner`,
          'schema public: owner set to starter_owner',
        ]),
      );
      await assertUpgraded(db.endpoint, prepared);
    } finally {
      await db.drop();
    }
  });

  it('from the legacy local volume shape: starter_app a superuser that owns the tables', async () => {
    const db = await createTestDatabase(admin());
    try {
      // Legacy compose: POSTGRES_USER=starter_app made the API role a superuser and the owner.
      await withClient(admin(), (c) =>
        c.query(`DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'starter_app') THEN CREATE ROLE starter_app LOGIN; END IF;
        END $$; ALTER ROLE starter_app SUPERUSER CREATEROLE CREATEDB`),
      );
      const legacyPassword = testRolePassword(db.endpoint, 'starter_app');
      await withClient(db.endpoint, async (c) => {
        await bootstrapLessPassword(c, legacyPassword);
        await c.query(`ALTER DATABASE "${db.endpoint.database}" OWNER TO starter_app`);
      });
      await withClient(
        { ...db.endpoint, user: 'starter_app', password: legacyPassword },
        async (c) => {
          await migrate(c, await loadMigrations(dir), silentLogger(), { role: null });
          await insertLegacyRow(c);
        },
      );

      const prepared = await prepareRoleDatabase(db.endpoint, { migrationsDir: MIGRATIONS_DIR });
      expect(prepared.bootstrap.changes).toEqual(
        expect.arrayContaining([
          'role starter_app: SUPERUSER removed',
          'role starter_app: CREATEROLE removed',
          'role starter_app: CREATEDB removed',
          `database ${db.endpoint.database}: owner set to the admin ${admin().user}`,
          'public.jobs: owner starter_app -> starter_owner',
          'public.schema_migrations: owner starter_app -> starter_owner',
        ]),
      );
      expect(prepared.bootstrap.roles.find((r) => r.role === 'starter_app')).toMatchObject({
        superuser: false,
        createRole: false,
        createDb: false,
      });
      await assertUpgraded(db.endpoint, prepared);
    } finally {
      await db.drop();
    }
  });
});

/** Sets a role password the way the bootstrap does (verifier only), outside the bootstrap. */
async function bootstrapLessPassword(client: pg.Client, password: string): Promise<void> {
  await client.query(
    `ALTER ROLE starter_app PASSWORD ${quoteLiteral(scramSha256Verifier(password))}`,
  );
}
