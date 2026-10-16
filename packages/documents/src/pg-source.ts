/**
 * PostgreSQL document source — the claim check of ADR 0230, restricted to one SECURITY DEFINER function.
 *
 * `starter_processor` has NO table grant on `jobs`. It may only call the `SECURITY DEFINER` function
 * provided by the migrations (owned by `starter_owner`, fixed `search_path`, `EXECUTE` revoked from PUBLIC):
 *
 *   SELECT * FROM load_job_document($1)
 *
 * which returns at most one row — title, content, options, content_sha256, contract_version
 * (+ content_purged_at once migration 0005 exists) — and only for a job inside the processing
 * window (≈ 1 h, longer than the 600 s execution timeout). A compromised Lambda can therefore
 * neither scan the table nor read old documents. "No row" means missing, purged or outside the
 * window: a permanent, non-retried `DocumentUnavailableError('no-document')` with a
 * non-sensitive message.
 *
 * On AWS the pool authenticates as `starter_processor` with RDS IAM (a token per connection) over
 * TLS `verify-full` and holds one connection (`@starter/db`). The source never writes, caches or
 * logs the document.
 */
import { DocumentSourceError, DocumentUnavailableError, classifySourceError } from './errors.js';
import type { DocumentSource, SqlClient, StoredDocument } from './types.js';
import { toVerifiedDocument } from './verify.js';

/** Name of the SECURITY DEFINER function. */
export const LOAD_DOCUMENT_FUNCTION = 'load_job_document';
/** The only statement the source ever sends (parameterised; no table access). */
export const DOCUMENT_QUERY = `SELECT * FROM ${LOAD_DOCUMENT_FUNCTION}($1)`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DocumentRow {
  title?: unknown;
  content?: unknown;
  options?: unknown;
  content_sha256?: unknown;
  contract_version?: unknown;
  content_purged_at?: unknown;
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' ? value : value === null || value === undefined ? null : String(value);

export class PgDocumentSource implements DocumentSource {
  constructor(private readonly db: SqlClient) {}

  async load(jobId: string): Promise<StoredDocument> {
    // Job ids are UUIDs (validated by the step parser); anything else cannot exist.
    if (!UUID.test(jobId)) throw new DocumentUnavailableError(jobId, 'no-document');
    let rows: unknown[];
    try {
      ({ rows } = await this.db.query(DOCUMENT_QUERY, [jobId]));
    } catch (error) {
      throw classifySourceError(error, jobId);
    }
    if (rows.length > 1) {
      throw new DocumentSourceError(
        `${LOAD_DOCUMENT_FUNCTION} returned ${rows.length} rows for job ${jobId}`,
        'MULTIPLE_ROWS',
      );
    }
    const row = rows[0] as DocumentRow | undefined;
    if (!row) throw new DocumentUnavailableError(jobId, 'no-document');
    return toVerifiedDocument(jobId, {
      title: asString(row.title),
      content: asString(row.content),
      options: row.options,
      contentSha256: asString(row.content_sha256) ?? '',
      contractVersion: asString(row.contract_version) ?? '',
      purgedAt: row.content_purged_at as Date | string | null | undefined,
    });
  }
}
