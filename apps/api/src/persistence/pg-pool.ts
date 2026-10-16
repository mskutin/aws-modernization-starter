/**
 * The API's PostgreSQL pool: `@starter/db` with the API's timeouts. TLS (`DB_SSL=verify-full` +
 * `DB_SSL_ROOT_CERT`) and per-connection credentials (`DB_AUTH=iam` on AWS) come from the config;
 * see ADRs 0221/0222.
 */
import type { DatabaseConfig } from '@starter/config';
import { createPgPool } from '@starter/db';
import type { Logger } from '@starter/observability';
import type pg from 'pg';

export function createPool(db: DatabaseConfig, logger: Logger): pg.Pool {
  return createPgPool(db, logger, {
    applicationName: 'starter-api',
    // TCP + TLS + IAM token signing; the readiness probe waits at most this long.
    connectionTimeoutMillis: 5_000,
    statementTimeoutMs: 5_000,
    idleTimeoutMillis: 30_000,
  });
}
