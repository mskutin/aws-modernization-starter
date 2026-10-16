/**
 * Least-privilege proof against a REAL PostgreSQL 17:
 * every identity can do exactly what its component needs, and every forbidden statement fails
 * with a permission error. Forbidden statements run inside a transaction that is always rolled
 * back, and a statement that unexpectedly SUCCEEDS fails the test.
 */
import { randomUUID } from 'node:crypto';
import { DB_LOGIN_ROLES, sqlState } from '@starter/db';
import type { PgEndpoint } from '@starter/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PgJobRepository, type NewJobRecord } from '../../src/persistence/job-repository.js';
import { migratedDatabase, withClient, type MigratedDatabase } from './helpers.js';

const PERMISSION_DENIED = '42501';

/** Runs `sql` in a rolled-back transaction; returns the SQLSTATE, or fails if it succeeded. */
async function deniedState(endpoint: PgEndpoint, sql: string, params: unknown[] = []) {
  return withClient(endpoint, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(sql, params);
    } catch (error) {
      return sqlState(error) ?? `non-SQL error: ${(error as Error).message}`;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    throw new Error(`expected a permission error, but this succeeded as ${endpoint.user}: ${sql}`);
  });
}

const expectDenied = async (endpoint: PgEndpoint, sql: string, params: unknown[] = []) =>
  expect(await deniedState(endpoint, sql, params), sql).toBe(PERMISSION_DENIED);

/**
 * For statements PostgreSQL refuses inside a transaction block (CREATE DATABASE, ALTER SYSTEM):
 * runs them in autocommit mode; if one unexpectedly succeeds, `undo` reverts it and the test fails.
 */
async function expectDeniedOutsideTransaction(endpoint: PgEndpoint, sql: string, undo: string) {
  const state = await withClient(endpoint, async (client) => {
    try {
      await client.query(sql);
    } catch (error) {
      return sqlState(error);
    }
    return 'SUCCEEDED';
  });
  if (state === 'SUCCEEDED') {
    await withClient(inject('integrationInfra').postgres, (c) => c.query(undo)).catch(
      () => undefined,
    );
  }
  expect(state, sql).toBe(PERMISSION_DENIED);
}

const rows = <T extends pg.QueryResultRow>(
  endpoint: PgEndpoint,
  sql: string,
  params: unknown[] = [],
) => withClient(endpoint, async (client) => (await client.query<T>(sql, params)).rows);

/** Every job has an issuer-bound owner (identity's 0005; ownerless inserts fail the check). */
const OWNER = { issuer: 'https://idp.example.com', subject: 'permission-test' };

function aRecord(overrides: Partial<NewJobRecord> = {}): NewJobRecord {
  const id = randomUUID();
  return {
    id,
    owner: OWNER,
    title: 'Permission test',
    content: 'a document body that only the processor may read',
    contentSha256: 'c'.repeat(64),
    contentLength: 49,
    options: { topTerms: 5 },
    idempotencyKey: `perm-${id}`,
    requestFingerprint: 'f'.repeat(64),
    contractVersion: '1.0.0',
    createdAt: new Date(),
    ...overrides,
  };
}

describe('database identities: least privilege on a migrated database', () => {
  let db: MigratedDatabase;
  let app: PgEndpoint;
  let processor: PgEndpoint;
  let migrator: PgEndpoint;
  let retention: PgEndpoint;
  let freshJob: NewJobRecord;
  let oldJob: NewJobRecord;

  beforeAll(async () => {
    db = await migratedDatabase();
    ({
      starter_app: app,
      starter_processor: processor,
      starter_migrator: migrator,
      starter_retention: retention,
    } = db.roles);
    const jobs = new PgJobRepository(db.pool); // the API's own repository, as starter_app
    freshJob = aRecord();
    expect((await jobs.insert(freshJob)).status).toBe('inserted');
    // Outside the processing window: inserted by the admin with an old timestamp.
    oldJob = aRecord({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });
    expect((await jobs.insert(oldJob)).status).toBe('inserted');
  });

  afterAll(async () => {
    await db?.drop();
  });

  describe('role attributes and memberships', () => {
    it('no managed role has SUPERUSER, CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS', async () => {
      const roles = await rows<{
        rolname: string;
        dangerous: boolean;
        login: boolean;
        limit: number;
      }>(
        db.admin,
        `SELECT rolname, (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls) AS dangerous,
                rolcanlogin AS login, rolconnlimit AS limit
         FROM pg_roles WHERE rolname LIKE 'starter\\_%' AND rolname NOT LIKE '%legacy%'
           -- the bootstrap admin (current_user: starter_admin in CI) is not a managed role
           AND rolname <> current_user ORDER BY rolname`,
      );
      expect(roles).toEqual([
        { rolname: 'starter_app', dangerous: false, login: true, limit: 40 },
        { rolname: 'starter_migrator', dangerous: false, login: true, limit: 3 },
        { rolname: 'starter_owner', dangerous: false, login: false, limit: -1 },
        { rolname: 'starter_processor', dangerous: false, login: true, limit: 20 },
        { rolname: 'starter_retention', dangerous: false, login: true, limit: 2 },
      ]);
    });

    it('the only membership is starter_migrator -> starter_owner, SET only (no inherited rights)', async () => {
      const memberships = await rows(
        db.admin,
        `SELECT r.rolname AS role, m.rolname AS member, am.admin_option, am.inherit_option, am.set_option
         FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
         WHERE (r.rolname LIKE 'starter\\_%' OR m.rolname LIKE 'starter\\_%')
           AND r.rolname <> current_user AND m.rolname <> current_user ORDER BY 1, 2`,
      );
      expect(memberships).toEqual([
        {
          role: 'starter_owner',
          member: 'starter_migrator',
          admin_option: false,
          inherit_option: false,
          set_option: true,
        },
      ]);
    });

    it('per-database defaults bound statements and idle transactions of the runtime roles', async () => {
      const settings = await rows<{ role: string; config: string[] }>(
        db.admin,
        `SELECT r.rolname AS role, s.setconfig AS config FROM pg_db_role_setting s
         JOIN pg_roles r ON r.oid = s.setrole JOIN pg_database d ON d.oid = s.setdatabase
         WHERE d.datname = current_database() ORDER BY 1`,
      );
      const byRole = Object.fromEntries(settings.map((s) => [s.role, [...s.config].sort()]));
      expect(byRole).toEqual({
        starter_app: [
          'idle_in_transaction_session_timeout=30s',
          'search_path=public',
          'statement_timeout=5s',
        ],
        starter_migrator: ['search_path=public'],
        starter_processor: [
          'idle_in_transaction_session_timeout=30s',
          'idle_session_timeout=60s',
          'search_path=public',
          'statement_timeout=5s',
        ],
        starter_retention: [
          'idle_in_transaction_session_timeout=60s',
          'search_path=public',
          'statement_timeout=60s',
        ],
      });
    });

    it('starter_owner cannot log in', async () => {
      const error = await withClient(
        { ...app, user: 'starter_owner' },
        async () => undefined,
      ).catch((e: unknown) => e);
      // 28P01 (no password to authenticate with) or 28000 (role not permitted to log in).
      expect(['28000', '28P01']).toContain(sqlState(error));
    });
  });

  describe('exact grants (any new or wider grant fails here and needs review)', () => {
    it('table, column and function privileges of every managed role and PUBLIC', async () => {
      const grants = await rows<{ grantee: string; privilege: string }>(
        db.admin,
        `SELECT grantee, privilege_type || ' ON ' || table_name AS privilege
           FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND grantee IN ('PUBLIC', 'starter_migrator', 'starter_app', 'starter_processor', 'starter_retention')
         UNION ALL
         SELECT grantee, privilege_type || ' (' || column_name || ') ON ' || table_name
           FROM information_schema.column_privileges
          WHERE table_schema = 'public' AND grantee IN ('PUBLIC', 'starter_migrator', 'starter_app', 'starter_processor', 'starter_retention')
         UNION ALL
         SELECT grantee, privilege_type || ' ON FUNCTION ' || routine_name
           FROM information_schema.routine_privileges
          WHERE routine_schema = 'public' AND grantee IN ('PUBLIC', 'starter_migrator', 'starter_app', 'starter_processor', 'starter_retention')
         ORDER BY 1, 2`,
      );
      // SELECT: every column the API reads back. Not `content` (0003's transitional grant is
      // revoked by 0005) and not `content_purged_at`.
      const appSelectColumns = [
        'content_length',
        'content_sha256',
        'contract_version',
        'created_at',
        'id',
        'idempotency_key',
        'options',
        'owner_issuer',
        'owner_subject',
        'request_fingerprint',
        'title',
      ];
      // INSERT is table-level (0003), so it covers every column, content included (written once,
      // never read back).
      const appInsertColumns = [...appSelectColumns, 'content', 'content_purged_at'];
      const byCodePoint = (a: { grantee: string; privilege: string }, b: typeof a) =>
        a.grantee === b.grantee
          ? a.privilege < b.privilege
            ? -1
            : a.privilege > b.privilege
              ? 1
              : 0
          : a.grantee < b.grantee
            ? -1
            : 1;
      expect([...grants].sort(byCodePoint)).toEqual(
        [
          ...appInsertColumns.map((c) => ({
            grantee: 'starter_app',
            privilege: `INSERT (${c}) ON jobs`,
          })),
          { grantee: 'starter_app', privilege: 'INSERT ON jobs' },
          ...appSelectColumns.map((c) => ({
            grantee: 'starter_app',
            privilege: `SELECT (${c}) ON jobs`,
          })),
          { grantee: 'starter_processor', privilege: 'EXECUTE ON FUNCTION load_job_document' },
          { grantee: 'starter_retention', privilege: 'SELECT (content_purged_at) ON jobs' },
          { grantee: 'starter_retention', privilege: 'SELECT (created_at) ON jobs' },
          { grantee: 'starter_retention', privilege: 'SELECT (id) ON jobs' },
          { grantee: 'starter_retention', privilege: 'UPDATE (content) ON jobs' },
          { grantee: 'starter_retention', privilege: 'UPDATE (content_purged_at) ON jobs' },
          { grantee: 'starter_retention', privilege: 'UPDATE (title) ON jobs' },
        ].sort(byCodePoint),
      );
    });

    it('PUBLIC has no CONNECT/TEMPORARY on the database and no USAGE/CREATE on the schema', async () => {
      const [acl] = await rows<{
        database_public: boolean;
        schema_public: boolean;
        temp_public: boolean;
      }>(
        db.admin,
        `SELECT has_database_privilege('public', current_database(), 'CONNECT') AS database_public,
                has_database_privilege('public', current_database(), 'TEMPORARY') AS temp_public,
                has_schema_privilege('public', 'public', 'USAGE') OR has_schema_privilege('public', 'public', 'CREATE') AS schema_public`,
      );
      expect(acl).toEqual({ database_public: false, schema_public: false, temp_public: false });
    });

    it('a role without an explicit grant cannot even connect', async () => {
      const stranger = `starter_test_stranger_${randomUUID().slice(0, 8)}`;
      const password = `stranger-${randomUUID()}`;
      await withClient(db.admin, (c) =>
        c.query(`CREATE ROLE ${stranger} LOGIN PASSWORD '${password}'`),
      );
      try {
        const error = await withClient(
          { ...app, user: stranger, password },
          async () => undefined,
        ).catch((e: unknown) => e);
        expect(sqlState(error)).toBe(PERMISSION_DENIED);
      } finally {
        await withClient(db.admin, (c) => c.query(`DROP ROLE ${stranger}`));
      }
    });
  });

  describe('starter_app (API runtime)', () => {
    it('can do what the API does: insert, read by id, list, detect key conflicts', async () => {
      const pool = new pg.Pool({ ...app, max: 2 });
      try {
        const jobs = new PgJobRepository(pool);
        expect((await jobs.findOwned(freshJob.id, OWNER))?.title).toBe('Permission test');
        expect((await jobs.listOwned(OWNER, 10)).map((j) => j.id)).toEqual(
          expect.arrayContaining([freshJob.id]),
        );
        expect(
          (await jobs.insert({ ...aRecord(), idempotencyKey: freshJob.idempotencyKey })).status,
        ).toBe('key-conflict');
        await jobs.ping();
      } finally {
        await pool.end();
      }
    });

    it.each([
      ['UPDATE', `UPDATE jobs SET title = 'x'`],
      ['DELETE', 'DELETE FROM jobs'],
      ['TRUNCATE', 'TRUNCATE jobs'],
      ['CREATE TABLE', 'CREATE TABLE stolen (body text)'],
      ['ALTER TABLE', 'ALTER TABLE jobs ADD COLUMN backdoor text'],
      ['DROP TABLE', 'DROP TABLE jobs'],
      ['CREATE INDEX', 'CREATE INDEX evil_idx ON jobs (title)'],
      ['CREATE FUNCTION', 'CREATE FUNCTION evil() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$'],
      ['CREATE VIEW', 'CREATE VIEW all_jobs AS SELECT id FROM jobs'],
      ['CREATE SCHEMA', 'CREATE SCHEMA evil'],
      ['CREATE TEMP TABLE', 'CREATE TEMP TABLE scratch (i int)'],
      ['COMMENT', `COMMENT ON TABLE jobs IS 'owned'`],
      ['GRANT a role', 'GRANT starter_owner TO starter_app'],
      ['CREATE ROLE', 'CREATE ROLE evil LOGIN'],
      ['ALTER ROLE SUPERUSER', 'ALTER ROLE starter_app SUPERUSER'],
      ['ALTER ROLE CREATEROLE', 'ALTER ROLE starter_app CREATEROLE'],
      ['lift its CONNECTION LIMIT', 'ALTER ROLE starter_app CONNECTION LIMIT -1'],
      ['SET ROLE starter_owner', 'SET ROLE starter_owner'],
      ['SET ROLE starter_migrator', 'SET ROLE starter_migrator'],
      ['SET SESSION AUTHORIZATION', 'SET SESSION AUTHORIZATION starter_owner'],
      ['trusted extension', 'CREATE EXTENSION IF NOT EXISTS pgcrypto'],
      ['untrusted extension', 'CREATE EXTENSION IF NOT EXISTS file_fdw'],
      ['read server files', `SELECT pg_read_file('/etc/hostname')`],
      ['server-side large objects', `SELECT lo_import('/etc/hostname')`],
      ['run programs', `COPY (SELECT 1) TO PROGRAM 'id'`],
      ['reload the server configuration', 'SELECT pg_reload_conf()'],
      ['disable triggers for the session', 'SET session_replication_role = replica'],
      ['password hashes', 'SELECT rolpassword FROM pg_authid'],
      ['migration history', 'SELECT * FROM schema_migrations'],
      ['load_job_document (processor only)', 'SELECT * FROM load_job_document($1)'],
    ])('is denied: %s', async (_name, sql) => {
      await expectDenied(app, sql, sql.includes('$1') ? [freshJob.id] : []);
    });

    it('cannot create databases or change the server configuration', async () => {
      await expectDeniedOutsideTransaction(
        app,
        'CREATE DATABASE starter_evil_app',
        'DROP DATABASE starter_evil_app',
      );
      await expectDeniedOutsideTransaction(
        app,
        `ALTER SYSTEM SET work_mem = '1MB'`,
        'ALTER SYSTEM RESET work_mem',
      );
    });

    it('GRANT on the table is a no-op: PostgreSQL only warns, PUBLIC gains nothing', async () => {
      const outcome = await withClient(app, async (client) => {
        const warnings: string[] = [];
        client.on('notice', (n: { message?: string }) => warnings.push(n.message ?? ''));
        await client.query('BEGIN');
        try {
          await client.query('GRANT SELECT, INSERT, UPDATE ON jobs TO PUBLIC');
          const check = await client.query<{ s: boolean; i: boolean; u: boolean }>(
            `SELECT has_table_privilege('public', 'jobs', 'SELECT') AS s,
                    has_table_privilege('public', 'jobs', 'INSERT') AS i,
                    has_table_privilege('public', 'jobs', 'UPDATE') AS u`,
          );
          return { privileges: check.rows[0], warnings };
        } finally {
          await client.query('ROLLBACK');
        }
      });
      expect(outcome.privileges).toEqual({ s: false, i: false, u: false });
      expect(outcome.warnings.join(' ')).toMatch(/no privileges were granted/);
    });

    it('cannot terminate other sessions', async () => {
      await withClient(db.admin, async (adminSession) => {
        const pid = (await adminSession.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]?.pid;
        await expectDenied(app, 'SELECT pg_terminate_backend($1)', [pid]);
      });
    });
  });

  describe('starter_app without content (0003 grants it transitionally, 0005 revokes)', () => {
    it('reading content fails with 42501; everything else the API needs still works', async () => {
      const appEndpoint = app;
      const record = aRecord();
      await withClient(appEndpoint, async (c) => {
        const inserted = await c.query(
          `INSERT INTO jobs (id, title, content, content_sha256, content_length, options, idempotency_key,
                             request_fingerprint, contract_version, created_at, owner_issuer, owner_subject)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id, title, content_sha256, content_length, options, idempotency_key,
                     request_fingerprint, contract_version, created_at`,
          [
            record.id,
            record.title,
            record.content,
            record.contentSha256,
            record.contentLength,
            JSON.stringify(record.options),
            record.idempotencyKey,
            record.requestFingerprint,
            record.contractVersion,
            record.createdAt,
            record.owner.issuer,
            record.owner.subject,
          ],
        );
        expect(inserted.rows[0]).toMatchObject({ id: record.id, title: record.title });
      });
      await expectDenied(appEndpoint, 'SELECT content FROM jobs');
      await expectDenied(appEndpoint, 'SELECT * FROM jobs');
      await expectDenied(appEndpoint, 'SELECT id FROM jobs WHERE content LIKE $1', ['%body%']);
      await expectDenied(
        appEndpoint,
        `INSERT INTO jobs (id, title, content, content_sha256, content_length, idempotency_key,
                           request_fingerprint, contract_version, owner_issuer, owner_subject)
         VALUES (gen_random_uuid(), 't', 'c', repeat('a', 64), 1, 'k-' || gen_random_uuid(), repeat('b', 64), '1',
                 'https://idp.example.com', 'permission-test')
         RETURNING content`,
      );
    });
  });

  describe('starter_processor (Lambdas, local simulator): one document at a time via load_job_document', () => {
    it('loads the document of a job inside the processing window', async () => {
      expect(await rows(processor, 'SELECT * FROM load_job_document($1)', [freshJob.id])).toEqual([
        {
          title: freshJob.title,
          content: freshJob.content,
          options: freshJob.options,
          content_sha256: freshJob.contentSha256,
          contract_version: freshJob.contractVersion,
          content_purged_at: null,
        },
      ]);
    });

    it('gets no row outside the window, for unknown ids and for NULL', async () => {
      expect(await rows(processor, 'SELECT * FROM load_job_document($1)', [oldJob.id])).toEqual([]);
      expect(await rows(processor, 'SELECT * FROM load_job_document($1)', [randomUUID()])).toEqual(
        [],
      );
      expect(await rows(processor, 'SELECT * FROM load_job_document(NULL)')).toEqual([]);
    });

    it.each([
      ['scan the table', 'SELECT id, title, content FROM jobs'],
      ['read one column', 'SELECT content FROM jobs WHERE id = $1'],
      ['count rows', 'SELECT count(*) FROM jobs'],
      ['probe existence', 'SELECT 1 FROM jobs LIMIT 1'],
      ['insert', `INSERT INTO jobs (id) VALUES (gen_random_uuid())`],
      ['update', `UPDATE jobs SET content = ''`],
      ['delete', 'DELETE FROM jobs'],
      [
        'replace the function',
        `CREATE OR REPLACE FUNCTION load_job_document(p_job_id uuid)
         RETURNS TABLE (title text, content text, options jsonb, content_sha256 text, contract_version text, content_purged_at timestamptz)
         LANGUAGE sql AS $$ SELECT NULL::text, NULL::text, NULL::jsonb, NULL::text, NULL::text, NULL::timestamptz $$`,
      ],
      ['create objects to shadow names', 'CREATE TABLE jobs_shadow (id uuid)'],
      ['create temp objects', 'CREATE TEMP TABLE jobs (id uuid)'],
      ['change roles', 'SET ROLE starter_owner'],
    ])('cannot %s', async (_name, sql) => {
      await expectDenied(processor, sql, sql.includes('$1') ? [freshJob.id] : []);
    });

    it('the function runs as its owner with a pinned search_path and no PUBLIC execute', async () => {
      const [fn] = await rows<{
        secdef: boolean;
        config: string[];
        owner: string;
        public_exec: boolean;
      }>(
        db.admin,
        `SELECT p.prosecdef AS secdef, p.proconfig AS config, pg_get_userbyid(p.proowner) AS owner,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
         FROM pg_proc p WHERE p.proname = 'load_job_document'`,
      );
      expect(fn).toEqual({
        secdef: true,
        config: ['search_path=pg_catalog, public, pg_temp'],
        owner: 'starter_owner',
        public_exec: false,
      });
    });
  });

  describe('starter_migrator (migration task)', () => {
    it.each([
      ['CREATE ROLE', 'CREATE ROLE evil'],
      ['make the API role superuser', 'ALTER ROLE starter_app SUPERUSER'],
      ['hand out the owner role', 'GRANT starter_owner TO starter_app'],
      ['become the API role', 'SET ROLE starter_app'],
      ['read password hashes', 'SELECT rolpassword FROM pg_authid'],
      // Without SET ROLE the migrator cannot even use the schema (no USAGE).
      ['DDL without SET ROLE', 'CREATE TABLE public.evil (id int)'],
      ['read data without SET ROLE', 'SELECT id FROM public.jobs'],
    ])('is denied: %s', async (_name, sql) => {
      await expectDenied(migrator, sql);
    });

    it('cannot create databases', async () => {
      await expectDeniedOutsideTransaction(
        migrator,
        'CREATE DATABASE starter_evil_migrator',
        'DROP DATABASE starter_evil_migrator',
      );
    });

    it('as starter_owner it may change the schema but still not roles, extensions or the server', async () => {
      for (const sql of [
        'CREATE ROLE evil',
        'ALTER ROLE starter_owner SUPERUSER',
        'CREATE EXTENSION IF NOT EXISTS file_fdw',
        `SELECT pg_read_file('/etc/hostname')`,
        'SELECT rolpassword FROM pg_authid',
      ]) {
        expect(await deniedState(migrator, `SET ROLE starter_owner; ${sql}`), sql).toBe(
          PERMISSION_DENIED,
        );
      }
      const created = await withClient(migrator, async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SET LOCAL ROLE starter_owner');
          await c.query('CREATE TABLE ddl_probe (id int)');
          return (
            await c.query<{ owner: string }>(
              `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'ddl_probe'`,
            )
          ).rows[0]?.owner;
        } finally {
          await c.query('ROLLBACK');
        }
      });
      expect(created).toBe('starter_owner');
    });
  });

  describe('starter_retention (retention job, disabled by default)', () => {
    it.each([
      ['read titles', 'SELECT title FROM jobs'],
      ['read content', 'SELECT content FROM jobs'],
      ['delete', 'DELETE FROM jobs'],
      ['insert', `INSERT INTO jobs (id) VALUES (gen_random_uuid())`],
      ['update other columns', `UPDATE jobs SET options = '{}'::jsonb`],
      ['DDL', 'ALTER TABLE jobs ADD COLUMN x int'],
    ])('cannot %s', async (_name, sql) => {
      await expectDenied(retention, sql);
    });

    it('can redact exactly the purge columns (rolled back here; the job is tested separately)', async () => {
      const purged = await withClient(retention, async (c) => {
        await c.query('BEGIN');
        try {
          return (
            await c.query(
              `UPDATE jobs SET title = '[purged]', content = '', content_purged_at = now()
               WHERE id = $1 AND content_purged_at IS NULL RETURNING id`,
              [oldJob.id],
            )
          ).rowCount;
        } finally {
          await c.query('ROLLBACK');
        }
      });
      expect(purged).toBe(1);
    });
  });

  it('every login role in the contract was exercised', () => {
    expect([...DB_LOGIN_ROLES].sort()).toEqual(
      ['starter_app', 'starter_migrator', 'starter_processor', 'starter_retention'].sort(),
    );
  });
});
