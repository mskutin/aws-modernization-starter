/**
 * Document source of the workflow Lambdas (validator, processor): `@starter/db` pool from
 * `loadDbConfig(env)` wrapped in `PgDocumentSource` (ADR 0230).
 *
 * On AWS the environment (set by CDK, never `APP_RUNTIME`) is `DB_USER=starter_processor`,
 * `DB_AUTH=iam` (a fresh RDS IAM token for every NEW connection, never one at start-up),
 * `DB_SSL=verify-full` with `DB_SSL_ROOT_CERT` pointing at the RDS CA bundle copied into the
 * function asset. One connection per execution environment (`max: 1`), reused across warm
 * invocations and recycled after `maxLifetimeSeconds`; client timeouts from the spec's
 * `STEP_CLIENT_SETTINGS`, so a slow database fails the attempt with a classified error inside
 * the task timeout. Configuration errors throw `ConfigError` at initialisation (fail fast).
 */
import { createPgPool, loadDbConfig, type DbLogger } from '@starter/db';
import { STEP_CLIENT_SETTINGS } from '@starter/workflow-processing';
import { PgDocumentSource } from './pg-source.js';
import type { DocumentSource } from './types.js';

export interface LambdaDocumentSourceOptions {
  /** `application_name` for `pg_stat_activity` (e.g. `starter-fn-validator`). */
  applicationName: string;
}

export function createLambdaDocumentSource(
  env: Record<string, string | undefined>,
  logger: DbLogger,
  options: LambdaDocumentSourceOptions,
): DocumentSource {
  const { db } = STEP_CLIENT_SETTINGS;
  const pool = createPgPool(loadDbConfig(env), logger, {
    max: db.poolMax,
    allowExitOnIdle: true,
    applicationName: options.applicationName,
    connectionTimeoutMillis: db.connectionTimeoutMs,
    statementTimeoutMs: db.statementTimeoutMs,
    queryTimeoutMs: db.queryTimeoutMs,
  });
  return new PgDocumentSource(pool);
}
