/**
 * Content retention (ADR 0223) against a real PostgreSQL,
 * as starter_retention: disabled by default, dry-run changes nothing, apply redacts only expired
 * documents in bounded batches and is idempotent; a purged document is unreadable by the
 * processor and the redaction is enforced by a check constraint.
 */
import { randomUUID } from 'node:crypto';
import type { RetentionPolicy } from '@starter/config';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PURGED_TITLE, runContentRetention } from '../../src/retention-job.js';
import { migratedDatabase, withClient, type MigratedDatabase } from './helpers.js';

const logs: Record<string, unknown>[] = [];
const logger = { info: (obj: object) => void logs.push(obj as Record<string, unknown>) };

describe('content retention job (starter_retention)', () => {
  let db: MigratedDatabase;
  let retention: pg.Client;

  /** Inserts as the API would (starter_app, with an issuer-bound owner since 0005), with a chosen age. */
  async function job(ageDays: number, title = `job ${randomUUID().slice(0, 8)}`): Promise<string> {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO jobs (id, title, content, content_sha256, content_length, options, idempotency_key,
                         request_fingerprint, contract_version, created_at, owner_issuer, owner_subject)
       VALUES ($1, $2, 'secret document body', repeat('c', 64), 20, '{}', $3, repeat('f', 64), '1.0.0',
               now() - make_interval(days => $4::int), 'https://idp.example.com', 'retention-test')`,
      [id, title, `ret-${id}`, ageDays],
    );
    return id;
  }

  const state = (id: string) =>
    withClient(
      db.admin,
      async (c) =>
        (
          await c.query<{ title: string; content: string; purged: boolean }>(
            'SELECT title, content, content_purged_at IS NOT NULL AS purged FROM jobs WHERE id = $1',
            [id],
          )
        ).rows[0],
    );

  beforeAll(async () => {
    db = await migratedDatabase();
    retention = new pg.Client(db.roles.starter_retention);
    await retention.connect();
  });
  afterAll(async () => {
    await retention?.end();
    await db?.drop();
  });
  beforeEach(async () => {
    logs.length = 0;
    await withClient(db.admin, (c) => c.query('DELETE FROM jobs'));
  });

  it('disabled (the default policy) touches nothing', async () => {
    const old = await job(400);
    expect(await runContentRetention(retention, { mode: 'disabled' }, logger)).toEqual({
      mode: 'disabled',
      purged: 0,
      batches: 0,
      complete: true,
    });
    expect(await state(old)).toEqual({
      title: expect.any(String),
      content: 'secret document body',
      purged: false,
    });
  });

  it('dry-run counts the expired documents and changes nothing', async () => {
    const [old1, old2] = [await job(120), await job(91)];
    const recent = await job(10);
    const policy: RetentionPolicy = {
      mode: 'dry-run',
      contentDays: 90,
      batchSize: 100,
      maxBatches: 5,
    };
    expect(await runContentRetention(retention, policy, logger)).toMatchObject({
      mode: 'dry-run',
      candidates: 2,
      purged: 0,
    });
    for (const id of [old1, old2, recent]) expect((await state(id))?.purged).toBe(false);
  });

  it('apply redacts only expired documents, in bounded batches, and is idempotent', async () => {
    const old = await Promise.all([200, 150, 120, 95, 91].map((d) => job(d)));
    const recent = await job(30);
    const policy: RetentionPolicy = {
      mode: 'apply',
      contentDays: 90,
      approvalRef: 'RET-TEST-001',
      batchSize: 2,
      maxBatches: 2,
    };
    // 2 batches of 2: 4 purged, 1 left for the next run.
    expect(await runContentRetention(retention, policy, logger)).toMatchObject({
      candidates: 5,
      purged: 4,
      batches: 2,
      complete: false,
    });
    expect(await runContentRetention(retention, policy, logger)).toMatchObject({
      purged: 1,
      complete: true,
    });
    expect(await runContentRetention(retention, policy, logger)).toMatchObject({
      candidates: 0,
      purged: 0,
      complete: true,
    });
    for (const id of old) {
      expect(await state(id)).toEqual({ title: PURGED_TITLE, content: '', purged: true });
    }
    expect((await state(recent))?.purged).toBe(false);
    // Logs carry counts and the approval reference; never titles, content or ids.
    const text = JSON.stringify(logs);
    expect(text).toContain('RET-TEST-001');
    expect(text).not.toContain('secret document body');
    for (const id of old) expect(text).not.toContain(id);
  });

  it('a purged document is never returned to the processor', async () => {
    // Recent (inside the processing window) but purged: the function must still return nothing.
    const id = await job(0);
    await withClient(db.admin, (c) =>
      c.query(`UPDATE jobs SET title = $2, content = '', content_purged_at = now() WHERE id = $1`, [
        id,
        PURGED_TITLE,
      ]),
    );
    const rows = await withClient(
      db.roles.starter_processor,
      async (c) => (await c.query('SELECT * FROM load_job_document($1)', [id])).rows,
    );
    expect(rows).toEqual([]);
  });

  it('the database rejects a half-redacted purge (check constraint)', async () => {
    const id = await job(100);
    const error: unknown = await retention
      .query(`UPDATE jobs SET content_purged_at = now() WHERE id = $1`, [id])
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((error as { code?: string } | undefined)?.code).toBe('23514');
  });
});
