import type { JobOptions } from '@starter/contracts';

/**
 * A submitted document as stored in the system of record (PostgreSQL `jobs`). Loaded by the
 * workflow steps by job id (claim check, ADR 0230) and held in memory for the duration of one
 * step only: never logged, never returned from a step, never written anywhere else.
 */
export interface StoredDocument {
  jobId: string;
  title: string;
  content: string;
  options: JobOptions;
  /** SHA-256 (hex) of `content` recorded at submission; verified on every load. */
  contentSha256: string;
  /** Contract version the document was submitted with. */
  contractVersion: string;
}

/** Port through which the validator and processor (Lambda or local simulation) read documents. */
export interface DocumentSource {
  /**
   * Loads the job's document. Throws
   *  - `DocumentUnavailableError` (permanent, never retried) when it is missing, purged by
   *    retention or fails SHA-256 verification;
   *  - `TransientDependencyError` (retried by the workflow) when the store is temporarily
   *    unreachable;
   *  - `DocumentSourceError` for anything else (permissions, schema, TLS, malformed rows).
   * Error messages carry the job id and an error code only — never document data.
   */
  load(jobId: string): Promise<StoredDocument>;
}

/**
 * The subset of a PostgreSQL pool the source needs (`pg.Pool`, or the pool `@starter/db` creates
 * for `starter_processor`). Structural, so the source does not depend on a driver.
 */
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}
