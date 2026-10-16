/**
 * Test database with the REAL role model and migrations (`@starter/db/testing`:
 * bootstrap as admin, migrations as starter_migrator): `starter_processor` has NO table grant and may
 * only execute the SECURITY DEFINER `load_job_document(uuid)` (1-hour window, never a purged row).
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DB_ROLES } from '@starter/db';
import { prepareRoleDatabase } from '@starter/db/testing';
import { sha256Hex } from '@starter/domain';
import { createTestDatabase } from '@starter/testing';
import pg from 'pg';
import { inject } from 'vitest';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../apps/api/migrations/', import.meta.url));

export interface ProcessorDatabase {
  /** Superuser of the test database: seeding and test-only mutations. */
  admin: pg.Pool;
  /** starter_processor, exactly as the Lambdas and the local simulator connect. */
  processor: pg.Pool;
  seed(
    jobId: string,
    doc: { title: string; content: string; topTerms: number; createdAt?: Date },
  ): Promise<void>;
  /** The retention job's redaction (migration 0004 constraint: marker + fixed values). */
  purge(jobId: string): Promise<void>;
  drop(): Promise<void>;
}

export async function processorDatabase(): Promise<ProcessorDatabase> {
  const { postgres } = inject('integrationInfra');
  const db = await createTestDatabase(postgres, 'starter_docs');
  const prepared = await prepareRoleDatabase(db.endpoint, { migrationsDir: MIGRATIONS_DIR });
  const admin = new pg.Pool({ ...db.endpoint, max: 2 });
  const processor = new pg.Pool({ ...prepared.roles[DB_ROLES.processor], max: 1 });
  return {
    admin,
    processor,
    seed: async (jobId, doc) => {
      // Every job has an issuer-bound owner (identity's migration 0005 refuses ownerless rows).
      await admin.query(
        `INSERT INTO jobs (id, title, content, content_sha256, content_length, options,
                           idempotency_key, request_fingerprint, contract_version, created_at,
                           owner_issuer, owner_subject)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 'https://idp.example.com', 'documents-test')`,
        [
          jobId,
          doc.title,
          doc.content,
          sha256Hex(doc.content),
          doc.content.length,
          JSON.stringify({ topTerms: doc.topTerms }),
          `key-${randomUUID()}`,
          'f'.repeat(64),
          '1.0.0',
          doc.createdAt ?? new Date(),
        ],
      );
    },
    purge: async (jobId) => {
      await admin.query(
        `UPDATE jobs SET title = '[purged]', content = '', content_purged_at = now() WHERE id = $1`,
        [jobId],
      );
    },
    drop: async () => {
      await processor.end();
      await admin.end();
      await db.drop();
    },
  };
}
