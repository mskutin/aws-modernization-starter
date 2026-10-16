/**
 * Business record of a job in PostgreSQL (source of truth for what was
 * submitted). Workflow status lives in DynamoDB and is merged on read.
 *
 * Authorization lives HERE, in the data access path (ADR 0211): every query that
 * returns a job filters on the issuer-bound owner (`owner_issuer`, `owner_subject`), so
 * another principal's job — and every legacy row without an owner — is
 * indistinguishable from a missing one.
 *
 * Least privilege: the API writes the document `content` but never reads
 * it back; no query selects or returns it. The API therefore needs only INSERT and
 * column-level SELECT (every column except `content`) on `jobs` — no UPDATE or DELETE.
 */
import type { JobOptions } from '@starter/contracts';
import type pg from 'pg';
import type { Cursor } from '../cursor.js';

/** Issuer-bound owner of a job. */
export interface JobOwner {
  issuer: string;
  /** `sub` claim. */
  subject: string;
}

/** A job as the API reads it back. Never contains the document content. */
export interface JobRecord {
  id: string;
  owner: JobOwner;
  title: string;
  contentSha256: string;
  contentLength: number;
  options: JobOptions;
  idempotencyKey: string;
  requestFingerprint: string;
  contractVersion: string;
  createdAt: Date;
}

/** What `insert` writes: the record plus the document content (write-only). */
export interface NewJobRecord extends JobRecord {
  content: string;
}

export type JobRecordSummary = Pick<JobRecord, 'id' | 'title' | 'createdAt'>;

export type InsertOutcome =
  | { status: 'inserted'; record: JobRecord }
  /** Same id already stored for this owner (retry of a partially completed request). */
  | { status: 'exists'; record: JobRecord }
  /** The (owner-scoped) idempotency key belongs to a different job of this owner. */
  | { status: 'key-conflict'; record: JobRecord };

export interface JobRecordRepository {
  insert(record: NewJobRecord): Promise<InsertOutcome>;
  /** The job only if `owner` owns it; null for missing AND foreign jobs (no oracle). */
  findOwned(id: string, owner: JobOwner): Promise<JobRecord | null>;
  /** The owner's jobs, newest first (keyset pagination). */
  listOwned(owner: JobOwner, limit: number, after?: Cursor): Promise<JobRecordSummary[]>;
  ping(signal?: AbortSignal): Promise<void>;
}

/** An insert conflicted with a row this owner cannot see: never resolve it to that row. */
export class OwnershipConflictError extends Error {
  override readonly name = 'OwnershipConflictError';
}

interface JobRow {
  id: string;
  owner_issuer: string;
  owner_subject: string;
  title: string;
  content_sha256: string;
  content_length: number;
  options: JobOptions;
  idempotency_key: string;
  request_fingerprint: string;
  contract_version: string;
  created_at: Date;
}

/** Every column the API may read: deliberately WITHOUT `content`. */
export const READ_COLUMNS =
  'id, owner_issuer, owner_subject, title, content_sha256, content_length, options, idempotency_key, request_fingerprint, contract_version, created_at';

const toRecord = (row: JobRow): JobRecord => ({
  id: row.id,
  owner: { issuer: row.owner_issuer, subject: row.owner_subject },
  title: row.title,
  contentSha256: row.content_sha256,
  contentLength: row.content_length,
  options: row.options,
  idempotencyKey: row.idempotency_key,
  requestFingerprint: row.request_fingerprint,
  contractVersion: row.contract_version,
  createdAt: row.created_at,
});

export class PgJobRepository implements JobRecordRepository {
  constructor(private readonly pool: pg.Pool) {}

  async insert(record: NewJobRecord): Promise<InsertOutcome> {
    if (!record.owner.issuer || !record.owner.subject) {
      throw new OwnershipConflictError('a job must have an owner');
    }
    const inserted = await this.pool.query<JobRow>(
      `INSERT INTO jobs (id, owner_issuer, owner_subject, title, content, content_sha256,
                         content_length, options, idempotency_key, request_fingerprint,
                         contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT DO NOTHING
       RETURNING ${READ_COLUMNS}`,
      [
        record.id,
        record.owner.issuer,
        record.owner.subject,
        record.title,
        record.content,
        record.contentSha256,
        record.contentLength,
        JSON.stringify(record.options),
        record.idempotencyKey,
        record.requestFingerprint,
        record.contractVersion,
        record.createdAt,
      ],
    );
    const row = inserted.rows[0];
    if (row) return { status: 'inserted', record: toRecord(row) };

    // Resolve the conflict only among the owner's rows. Keys are owner-scoped and ids are
    // server-generated, so a conflict outside them is a bug (or a collision) to surface.
    const existing = await this.pool.query<JobRow>(
      `SELECT ${READ_COLUMNS} FROM jobs
       WHERE (id = $1 OR idempotency_key = $2) AND owner_issuer = $3 AND owner_subject = $4
       ORDER BY (id = $1) DESC LIMIT 1`,
      [record.id, record.idempotencyKey, record.owner.issuer, record.owner.subject],
    );
    const found = existing.rows[0];
    if (!found) {
      throw new OwnershipConflictError('insert conflicted with a row of another owner');
    }
    return found.id === record.id
      ? { status: 'exists', record: toRecord(found) }
      : { status: 'key-conflict', record: toRecord(found) };
  }

  async findOwned(id: string, owner: JobOwner): Promise<JobRecord | null> {
    const result = await this.pool.query<JobRow>(
      `SELECT ${READ_COLUMNS} FROM jobs
       WHERE id = $1 AND owner_issuer = $2 AND owner_subject = $3`,
      [id, owner.issuer, owner.subject],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async listOwned(owner: JobOwner, limit: number, after?: Cursor): Promise<JobRecordSummary[]> {
    // Served by jobs_owner_created_at_id_idx (migration 0006).
    const result = after
      ? await this.pool.query<JobRow>(
          `SELECT id, title, created_at FROM jobs
           WHERE owner_issuer = $1 AND owner_subject = $2 AND (created_at, id) < ($3, $4)
           ORDER BY created_at DESC, id DESC LIMIT $5`,
          [owner.issuer, owner.subject, after.createdAt, after.id, limit],
        )
      : await this.pool.query<JobRow>(
          `SELECT id, title, created_at FROM jobs
           WHERE owner_issuer = $1 AND owner_subject = $2
           ORDER BY created_at DESC, id DESC LIMIT $3`,
          [owner.issuer, owner.subject, limit],
        );
    return result.rows.map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at }));
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}
