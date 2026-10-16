/**
 * Content retention for job documents (ADR 0223).
 *
 * The purge REDACTS the document of jobs older than `contentDays`: `title` becomes `[purged]`,
 * `content` becomes empty and `content_purged_at` is set (a check constraint enforces the pair).
 * The row itself (id, timestamps, hashes, idempotency key) stays for the audit trail and for
 * idempotent replays. Runs as `starter_retention`, which can read only `id, created_at,
 * content_purged_at` and update only the three redacted columns.
 *
 * Safety: the CLI does nothing unless RETENTION_MODE is explicitly `dry-run` (count only) or
 * `apply` (requires RETENTION_APPROVAL_REF, the reference of the approved policy); `apply` works
 * in bounded batches (`FOR UPDATE SKIP LOCKED`, one short transaction each). The cut-off uses the
 * database clock. Logs carry counts and the approval reference, never titles, content or ids.
 */
import type { RetentionPolicy } from '@starter/config';
import type pg from 'pg';

export const PURGED_TITLE = '[purged]';

export interface RetentionLogger {
  info(obj: object, msg?: string): void;
}

export interface RetentionRunResult {
  mode: RetentionPolicy['mode'];
  contentDays?: number;
  /** Jobs eligible for purge when the run started (dry-run and apply). */
  candidates?: number;
  purged: number;
  batches: number;
  /** False when `maxBatches` stopped an apply run before every candidate was purged. */
  complete: boolean;
}

async function countCandidates(client: pg.ClientBase, contentDays: number): Promise<number> {
  const result = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM jobs
     WHERE created_at < now() - make_interval(days => $1::int) AND content_purged_at IS NULL`,
    [contentDays],
  );
  return Number(result.rows[0]?.n ?? 0);
}

export async function runContentRetention(
  client: pg.ClientBase,
  policy: RetentionPolicy,
  logger: RetentionLogger,
): Promise<RetentionRunResult> {
  if (policy.mode === 'disabled') {
    return { mode: 'disabled', purged: 0, batches: 0, complete: true };
  }
  const candidates = await countCandidates(client, policy.contentDays);
  if (policy.mode === 'dry-run') {
    logger.info(
      { contentDays: policy.contentDays, candidates },
      'retention dry run: no data was changed',
    );
    return {
      mode: 'dry-run',
      contentDays: policy.contentDays,
      candidates,
      purged: 0,
      batches: 0,
      complete: true,
    };
  }

  let purged = 0;
  let batches = 0;
  let lastBatch = policy.batchSize;
  while (batches < policy.maxBatches && lastBatch === policy.batchSize) {
    const result = await client.query<{ id: string }>(
      `UPDATE jobs SET title = $3, content = '', content_purged_at = now()
       WHERE id IN (
         SELECT id FROM jobs
         WHERE created_at < now() - make_interval(days => $1::int) AND content_purged_at IS NULL
         ORDER BY created_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED)
       RETURNING id`,
      [policy.contentDays, policy.batchSize, PURGED_TITLE],
    );
    lastBatch = result.rowCount ?? 0;
    batches += 1;
    purged += lastBatch;
    logger.info(
      { batch: batches, purged: lastBatch, approvalRef: policy.approvalRef },
      'retention batch applied',
    );
  }
  const complete = lastBatch < policy.batchSize;
  return { mode: 'apply', contentDays: policy.contentDays, candidates, purged, batches, complete };
}
