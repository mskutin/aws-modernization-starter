/**
 * Migrations 0005/0006 on the MERGED chain
 * with the REAL role model, against PostgreSQL 17:
 *
 *  - UPGRADE from a database at 0002 that already holds (ownerless) jobs, not just a fresh one;
 *  - the role bootstrap and 0003/0004 (as starter_migrator through SET ROLE starter_owner),
 *    then this branch's 0005/0006 — merge order;
 *  - legacy rows are visible to nobody through the owner-scoped repository;
 *  - the NOT VALID check refuses new ownerless rows without touching old ones;
 *  - the owner index is built CONCURRENTLY and ends up valid;
 *  - least privilege of the API role at the END of the chain: 0003's TRANSITIONAL
 *    `SELECT (content)` is in force before 0005 and gone after it — no column or table SELECT on
 *    content — and as starter_app `SELECT content` fails with 42501 while every repository query works.
 *
 * starter_app is a plain login role here, created by the bootstrap in every environment (local
 * Testcontainers and CI services), so every privilege assertion is unconditional.
 */
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRoleDatabase, type PreparedDatabase } from '@starter/db/testing';
import { createTestDatabase } from '@starter/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  OwnershipConflictError,
  PgJobRepository,
  type NewJobRecord,
} from '../../src/persistence/job-repository.js';
import { loadMigrations, migrate } from '../../src/persistence/migrations.js';
import { MIGRATIONS_DIR, silentLogger, withClient } from './helpers.js';

const ISSUER = 'https://idp.example.com';
const alice = { issuer: ISSUER, subject: 'alice' };

/** Copies the migrations up to and including `lastVersion` into a temporary directory. */
async function migrationsUpTo(lastVersion: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'starter-owner-migrations-'));
  for (const file of await readdir(MIGRATIONS_DIR)) {
    if (file.endsWith('.sql') && file.slice(0, 4) <= lastVersion) {
      await cp(join(MIGRATIONS_DIR, file), join(dir, file));
    }
  }
  return dir;
}

const legacyRow = (title: string) => ({
  id: randomUUID(),
  title,
  content: `legacy document ${title}`,
  key: `legacy-${randomUUID()}`,
});

const CONTENT_SELECTABLE = `SELECT has_column_privilege('starter_app', 'jobs', 'content', 'SELECT') AS content,
        has_table_privilege('starter_app', 'jobs', 'SELECT') AS "table"`;

describe('job owner migrations on the merged chain (upgrade from 0002, real roles)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let prepared: PreparedDatabase;
  let admin: pg.Client;
  /** The API identity, exactly as the API connects. */
  let app: pg.Pool;
  const legacy = [legacyRow('Legacy A'), legacyRow('Legacy B')];
  let identityApplied: string[] = [];
  let beforeIdentity: { content: boolean; table: boolean } | undefined;

  beforeAll(async () => {
    db = await createTestDatabase(inject('integrationInfra').postgres);
    // 1. A database at 0002, migrated by the admin the legacy way, with ownerless jobs.
    const upTo0002 = await migrationsUpTo('0002');
    const upTo0004 = await migrationsUpTo('0004');
    try {
      await withClient(db.endpoint, async (client) => {
        await migrate(client, await loadMigrations(upTo0002), silentLogger(), { role: null });
        for (const row of legacy) {
          await client.query(
            `INSERT INTO jobs (id, title, content, content_sha256, content_length, options,
                               idempotency_key, request_fingerprint, contract_version)
             VALUES ($1, $2, $3, $4, 10, '{"topTerms":10}', $5, $6, '1.0.0')`,
            [row.id, row.title, row.content, 'a'.repeat(64), row.key, 'b'.repeat(64)],
          );
        }
      });
      // 2. The real role bootstrap, then 0003/0004 as starter_migrator ...
      prepared = await prepareRoleDatabase(db.endpoint, { migrationsDir: upTo0004 });
      expect(prepared.migrations).toEqual([
        '0003_role_privileges.sql',
        '0004_job_content_retention.sql',
      ]);
      beforeIdentity = await withClient(db.endpoint, async (client) => {
        const row = (await client.query<{ content: boolean; table: boolean }>(CONTENT_SELECTABLE))
          .rows[0];
        if (!row) throw new Error('no privilege row');
        return row;
      });
      // 3. ... then this branch's 0005/0006, as starter_migrator too (merge order).
      identityApplied = await withClient(prepared.roles.starter_migrator, async (client) => {
        const { applied } = await migrate(
          client,
          await loadMigrations(MIGRATIONS_DIR),
          silentLogger(),
        );
        return applied;
      });
    } finally {
      await rm(upTo0002, { recursive: true, force: true });
      await rm(upTo0004, { recursive: true, force: true });
    }
    admin = new pg.Client(db.endpoint);
    await admin.connect();
    app = new pg.Pool({ ...prepared.roles.starter_app, max: 2 });
  });

  afterAll(async () => {
    await app?.end();
    await admin?.end();
    await db?.drop();
  });

  it('applies 0005 and 0006 after 0003 and 0004', () => {
    expect(identityApplied).toEqual(['0005_job_owner.sql', '0006_job_owner_index.sql']);
  });

  it('keeps legacy rows but makes them visible to nobody', async () => {
    const rows = await admin.query('SELECT owner_issuer, owner_subject FROM jobs');
    expect(rows.rows).toEqual([
      { owner_issuer: null, owner_subject: null },
      { owner_issuer: null, owner_subject: null },
    ]);
    const repository = new PgJobRepository(app);
    for (const row of legacy) {
      expect(await repository.findOwned(row.id, alice)).toBeNull();
    }
    expect(await repository.listOwned(alice, 100)).toEqual([]);
  });

  it("never resolves an insert conflict to another owner's row (id or key collision)", async () => {
    const repository = new PgJobRepository(app);
    const record = (owner: typeof alice, id: string, key: string): NewJobRecord => ({
      id,
      owner,
      title: `Owned by ${owner.subject}`,
      content: 'Document content.',
      contentSha256: '1'.repeat(64),
      contentLength: 17,
      options: { topTerms: 5 },
      idempotencyKey: key,
      requestFingerprint: '2'.repeat(64),
      contractVersion: '1.1.0',
      createdAt: new Date(),
    });
    const id = randomUUID();
    const key = `p:${'3'.repeat(64)}:h:collide-${randomUUID()}`;
    expect((await repository.insert(record(alice, id, key))).status).toBe('inserted');
    const bob = { issuer: ISSUER, subject: 'bob' };
    // Same id (e.g. a UUID collision), then same key: bob must get an error, never alice's job.
    await expect(
      repository.insert(record(bob, id, `p:${'4'.repeat(64)}:h:x`)),
    ).rejects.toBeInstanceOf(OwnershipConflictError);
    await expect(repository.insert(record(bob, randomUUID(), key))).rejects.toBeInstanceOf(
      OwnershipConflictError,
    );
    // Same issuer-bound owner retrying: resolved to its own row.
    expect((await repository.insert(record(alice, id, key))).status).toBe('exists');
  });

  // The issuer is part of EVERY owner predicate. Same subject, other issuer
  // = another principal: no conflict resolution to the row, no listing (first or cursor page).
  it('binds ownership to the issuer in the insert-conflict lookup and in listOwned', async () => {
    const repository = new PgJobRepository(app);
    const subject = `same-sub-${randomUUID()}`;
    const home = { issuer: ISSUER, subject };
    const elsewhere = { issuer: 'https://other-idp.example.com', subject };
    const newRecord = (owner: typeof home, id: string, key: string): NewJobRecord => ({
      id,
      owner,
      title: `Owned via ${owner.issuer}`,
      content: 'Document content.',
      contentSha256: '5'.repeat(64),
      contentLength: 17,
      options: { topTerms: 5 },
      idempotencyKey: key,
      requestFingerprint: '6'.repeat(64),
      contractVersion: '1.1.0',
      createdAt: new Date(),
    });
    const id = randomUUID();
    const key = `p:${'7'.repeat(64)}:h:issuer-bound-${randomUUID()}`;
    expect((await repository.insert(newRecord(home, id, key))).status).toBe('inserted');
    // Insert conflicts (same id, then same key) from the same subject at another issuer.
    await expect(
      repository.insert(newRecord(elsewhere, id, `p:${'8'.repeat(64)}:h:x-${randomUUID()}`)),
    ).rejects.toBeInstanceOf(OwnershipConflictError);
    await expect(repository.insert(newRecord(elsewhere, randomUUID(), key))).rejects.toBeInstanceOf(
      OwnershipConflictError,
    );
    // Listing: the other issuer's principal sees nothing, on the first and on a cursor page.
    expect(await repository.listOwned(elsewhere, 100)).toEqual([]);
    const afterEverything = {
      createdAt: new Date(Date.now() + 86_400_000),
      id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
    };
    expect(await repository.listOwned(elsewhere, 100, afterEverything)).toEqual([]);
    // The home principal sees its job on both paths.
    expect((await repository.listOwned(home, 100)).map((r) => r.id)).toContain(id);
    expect((await repository.listOwned(home, 100, afterEverything)).map((r) => r.id)).toContain(id);
  });

  it('refuses new ownerless rows (CHECK ... NOT VALID), without validating old ones', async () => {
    const error = await app
      .query(
        `INSERT INTO jobs (id, title, content, content_sha256, content_length, options,
                           idempotency_key, request_fingerprint, contract_version)
         VALUES ($1, 'x', 'y', $2, 1, '{}', $3, $2, '1.1.0')`,
        [randomUUID(), 'c'.repeat(64), `k-${randomUUID()}`],
      )
      .catch((e: unknown) => e as { code?: string; constraint?: string });
    expect(error).toMatchObject({ code: '23514', constraint: 'jobs_owner_present' });
    const constraint = await admin.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'jobs_owner_present'`,
    );
    expect(constraint.rows).toEqual([{ convalidated: false }]);
  });

  it('builds the owner index concurrently and leaves it valid', async () => {
    const index = await admin.query<{ indisvalid: boolean; definition: string }>(
      `SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS definition
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'jobs_owner_created_at_id_idx'`,
    );
    expect(index.rows[0]?.indisvalid).toBe(true);
    expect(index.rows[0]?.definition).toContain(
      '(owner_issuer, owner_subject, created_at DESC, id DESC)',
    );
  });

  // 0003 grants a TRANSITIONAL SELECT (content); 0005 must revoke it, so
  // the END of the merged chain is what counts (a later grant would silently undo it).
  it('ends the merged chain with no SELECT on content for starter_app, by column or by table', async () => {
    expect(beforeIdentity).toEqual({ content: true, table: false }); // 0003's transitional grant
    const after = await admin.query<{ content: boolean; table: boolean }>(CONTENT_SELECTABLE);
    expect(after.rows).toEqual([{ content: false, table: false }]);
    // A plain role that owns nothing: the catalogue answers are meaningful.
    const role = await admin.query<{ rolsuper: boolean; owner: string }>(
      `SELECT r.rolsuper, (SELECT tableowner FROM pg_tables WHERE tablename = 'jobs') AS owner
         FROM pg_roles r WHERE r.rolname = 'starter_app'`,
    );
    expect(role.rows).toEqual([{ rolsuper: false, owner: 'starter_owner' }]);

    const privileges = await admin.query<{ column: string; select: boolean; insert: boolean }>(
      `SELECT a.attname AS column,
              has_column_privilege('starter_app', 'jobs', a.attname, 'SELECT') AS select,
              has_column_privilege('starter_app', 'jobs', a.attname, 'INSERT') AS insert
         FROM pg_attribute a
        WHERE a.attrelid = 'jobs'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
    );
    const selectable = privileges.rows.filter((r) => r.select).map((r) => r.column);
    expect(selectable.sort()).toEqual(
      [
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
      ].sort(),
    );
    // Content stays writable: the API stores the document it never reads back.
    expect(privileges.rows.find((r) => r.column === 'content')?.insert).toBe(true);
  });

  it('as starter_app: SELECT content fails with 42501, every repository query works', async () => {
    const denied = await app
      .query('SELECT content FROM jobs LIMIT 1')
      .catch((e: unknown) => e as { code?: string });
    expect(denied).toMatchObject({ code: '42501' });
    await expect(app.query('SELECT * FROM jobs LIMIT 1')).rejects.toMatchObject({
      code: '42501',
    });

    const repository = new PgJobRepository(app);
    const probeOwner = { issuer: ISSUER, subject: `alice-probe-${randomUUID()}` };
    const id = randomUUID();
    const inserted = await repository.insert({
      id,
      owner: probeOwner,
      title: 'Owned by alice',
      content: 'Document content written but never read back.',
      contentSha256: 'd'.repeat(64),
      contentLength: 46,
      options: { topTerms: 5 },
      idempotencyKey: `p:${'e'.repeat(64)}:h:probe-key-1`,
      requestFingerprint: 'f'.repeat(64),
      contractVersion: '1.1.0',
      createdAt: new Date(),
    });
    expect(inserted.status).toBe('inserted');
    expect(inserted.record).not.toHaveProperty('content');
    // Conflict lookup (same id) also runs without content.
    expect(
      (
        await repository.insert({
          ...inserted.record,
          content: 'Document content written but never read back.',
        })
      ).status,
    ).toBe('exists');
    expect((await repository.findOwned(id, probeOwner))?.title).toBe('Owned by alice');
    expect(await repository.findOwned(id, { issuer: ISSUER, subject: 'bob' })).toBeNull();
    // Issuer-bound owner: the same subject from another issuer is someone else.
    expect(
      await repository.findOwned(id, {
        issuer: 'https://other.example',
        subject: probeOwner.subject,
      }),
    ).toBeNull();
    expect((await repository.listOwned(probeOwner, 10)).map((r) => r.id)).toEqual([id]);
    // No UPDATE or DELETE either.
    await expect(app.query(`DELETE FROM jobs WHERE id = $1`, [id])).rejects.toMatchObject({
      code: '42501',
    });
  });
});
