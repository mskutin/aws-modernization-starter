/**
 * LOCAL SIMULATION ONLY: the document source of the in-process workflow (`WORKFLOW_MODE=local`).
 *
 * Documents are loaded exactly as the Lambdas load them — `SELECT * FROM load_job_document($1)`
 * as `starter_processor` — through a SEPARATE pool. The API's own pool (`starter_app`) is never used for
 * documents: it has no `SELECT (content)`, and the API task holds no processor credentials
 * on AWS.
 *
 * Settings (validated at start-up, `loadDbIdentityConfig` of `@starter/db`): host, port, database
 * and TLS from the API's `DB_*`; `PROCESSOR_DB_USER` (default `starter_processor`),
 * `PROCESSOR_DB_AUTH` (default: the API's mode), `PROCESSOR_DB_PASSWORD` or
 * `PROCESSOR_DB_PASSWORD_FILE`, `PROCESSOR_DB_POOL_MAX`. Password authentication is accepted only
 * when `APP_RUNTIME` is `local` or `ci`.
 */
import type { Env } from '@starter/config';
import { DB_ROLES, createPgPool, loadDbIdentityConfig, type DatabaseConfig } from '@starter/db';
import { PgDocumentSource, type DocumentSource } from '@starter/documents';
import type { Logger } from '@starter/observability';

export const PROCESSOR_DB_PREFIX = 'PROCESSOR_';

export interface LocalDocumentSource {
  documents: DocumentSource;
  close(): Promise<void>;
}

/** The processor identity on the API's database (`PROCESSOR_DB_*`). */
export function loadLocalProcessorDb(env: Env, apiDb: DatabaseConfig): DatabaseConfig {
  return loadDbIdentityConfig(
    { [`${PROCESSOR_DB_PREFIX}DB_USER`]: DB_ROLES.processor, ...env },
    PROCESSOR_DB_PREFIX,
    apiDb,
  );
}

export function createLocalDocumentSource(
  processorDb: DatabaseConfig,
  logger: Logger,
): LocalDocumentSource {
  const pool = createPgPool(processorDb, logger, {
    max: 2,
    applicationName: 'starter-api-local-workflow',
    connectionTimeoutMillis: 5_000,
    statementTimeoutMs: 5_000,
  });
  logger.info(
    { dbUser: processorDb.user },
    'LOCAL SIMULATION: workflow steps load documents as the processor identity',
  );
  return { documents: new PgDocumentSource(pool), close: () => pool.end() };
}
