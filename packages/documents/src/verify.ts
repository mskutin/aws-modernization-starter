/**
 * Shared record → document mapping, so every source applies the same purge and integrity
 * semantics: a purged record (marker set, or content/title gone) is unavailable; a record whose
 * content does not hash to the stored SHA-256 is unavailable (integrity) — tampering or a
 * partial purge must never be analysed as if it were the submitted document.
 */
import { JobOptionsSchema } from '@starter/contracts';
import { sha256Hex } from '@starter/domain';
import { z } from 'zod';
import { DocumentSourceError, DocumentUnavailableError } from './errors.js';
import type { StoredDocument } from './types.js';

export interface DocumentRecord {
  title: string | null;
  content: string | null;
  options: unknown;
  contentSha256: string;
  contractVersion: string;
  /** Set by the retention job (migration 0005) when the content was purged. */
  purgedAt?: Date | string | null | undefined;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

const RecordSchema = z.object({
  title: z.string().nullable(),
  content: z.string().nullable(),
  options: JobOptionsSchema,
  contentSha256: z.string().regex(SHA256_HEX),
  contractVersion: z.string().min(1).max(32),
  purgedAt: z.union([z.date(), z.string(), z.null()]).optional(),
});

export function toVerifiedDocument(jobId: string, record: DocumentRecord): StoredDocument {
  const parsed = RecordSchema.safeParse({
    ...record,
    contentSha256: record.contentSha256.trim().toLowerCase(),
  });
  if (!parsed.success) {
    // Field names only — never values.
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))];
    throw new DocumentSourceError(
      `stored document for job ${jobId} is malformed (${fields.join(', ')})`,
      'MALFORMED_RECORD',
    );
  }
  const r = parsed.data;
  if (r.purgedAt !== undefined && r.purgedAt !== null) {
    throw new DocumentUnavailableError(jobId, 'purged');
  }
  if (r.content === null || r.title === null) {
    throw new DocumentUnavailableError(jobId, 'purged');
  }
  if (sha256Hex(r.content) !== r.contentSha256) {
    throw new DocumentUnavailableError(jobId, 'integrity');
  }
  return {
    jobId,
    title: r.title,
    content: r.content,
    options: r.options,
    contentSha256: r.contentSha256,
    contractVersion: r.contractVersion,
  };
}
