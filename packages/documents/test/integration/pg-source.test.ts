/**
 * PgDocumentSource against real PostgreSQL 17 with the real role model and
 * migrations, connected as `starter_processor` (no table grant; only the SECURITY DEFINER
 * `load_job_document`).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentUnavailableError, PgDocumentSource } from '../../src/index.js';
import { describeDocumentSourceContract } from '../source-contract.js';
import { processorDatabase, type ProcessorDatabase } from './postgres.js';

describeDocumentSourceContract('PostgreSQL as starter_processor (load_job_document)', async () => {
  const db = await processorDatabase();
  return {
    source: new PgDocumentSource(db.processor),
    seed: db.seed,
    purge: db.purge,
    tamper: async (jobId, content) => {
      await db.admin.query('UPDATE jobs SET content = $2 WHERE id = $1', [jobId, content]);
    },
    cleanup: db.drop,
  };
});

describe('starter_processor cannot bulk-read documents', () => {
  let db: ProcessorDatabase;
  beforeAll(async () => {
    db = await processorDatabase();
    await db.seed(randomUUID(), { title: 'Other user', content: 'someone else', topTerms: 3 });
  });
  afterAll(async () => {
    await db?.drop();
  });

  it.each([
    ['scan the table', 'SELECT id, title, content FROM jobs'],
    ['read any single column', 'SELECT content FROM jobs LIMIT 1'],
    ['count rows', 'SELECT count(*) FROM jobs'],
    ['write', "UPDATE jobs SET title = 'x'"],
    ['delete', 'DELETE FROM jobs'],
  ])('cannot %s (permission denied)', async (_name, statement) => {
    await expect(db.processor.query(statement)).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot read a document outside the processing window, even by id', async () => {
    const old = randomUUID();
    await db.seed(old, {
      title: 'Old document',
      content: 'old body text',
      topTerms: 3,
      createdAt: new Date(Date.now() - 2 * 3_600_000),
    });
    const error = await new PgDocumentSource(db.processor).load(old).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentUnavailableError);
    expect((error as DocumentUnavailableError).reason).toBe('no-document');
  });

  it('reads a document inside the window through the function only', async () => {
    const fresh = randomUUID();
    await db.seed(fresh, { title: 'Fresh', content: 'fresh body text', topTerms: 3 });
    await expect(new PgDocumentSource(db.processor).load(fresh)).resolves.toMatchObject({
      jobId: fresh,
      content: 'fresh body text',
    });
  });
});
