/**
 * `pg` pool / client factories used by the API, the database CLIs and the Lambdas.
 *
 * - TLS from `DB_SSL` / `DB_SSL_ROOT_CERT` ({@link pgTlsOptions}); the CA bundle is read and
 *   validated when the pool is created, so a bad path fails at start-up, not on first query.
 * - Credentials from a {@link PasswordProvider} called for every new connection.
 * - Connections are recycled after `maxLifetimeSeconds` (default 15 min), which bounds how long a
 *   session authenticated with a rotated or revoked credential lives on.
 * - Idle-client errors are logged (never thrown: a database restart must not crash the process)
 *   with the PostgreSQL code, severity and message only. The error object itself is never logged:
 *   pg-pool attaches the idle client to it (`err.client`: connection parameters, TLS options,
 *   backend process id and cancel key). This module never logs a client, its parameters or a
 *   connection string.
 */
import type { DatabaseConfig } from '@starter/config';
import pg from 'pg';
import { passwordProvider, type PasswordProviderOptions } from './credentials.js';
import { pgTlsOptions } from './tls.js';

/** Minimal logger surface (pino's `Logger` satisfies it). */
export interface DbLogger {
  warn(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

export interface PgConnectionOptions extends PasswordProviderOptions {
  /** `application_name` shown in `pg_stat_activity` and the server log. */
  applicationName?: string;
  /** TCP + TLS + authentication budget per new connection. @default 5000 */
  connectionTimeoutMillis?: number;
  /** Server-side `statement_timeout`; 0 disables (migrations). @default 5000 */
  statementTimeoutMs?: number;
  /** Client-side query timeout; 0 disables. @default statementTimeoutMs + 1000 */
  queryTimeoutMs?: number;
}

export interface PgPoolOptions extends PgConnectionOptions {
  /** @default config.poolMax */
  max?: number;
  /** @default 30000 */
  idleTimeoutMillis?: number;
  /** Recycle connections after this age (0 = never). @default 900 */
  maxLifetimeSeconds?: number;
  /** Let the process exit while only idle clients remain (Lambda, CLIs). @default false */
  allowExitOnIdle?: boolean;
}

export const DEFAULT_MAX_LIFETIME_SECONDS = 900;

/** `pg.ClientConfig` for one connection (TLS validated, password resolved lazily). */
export function pgClientConfig(
  config: DatabaseConfig,
  options: PgConnectionOptions = {},
): pg.ClientConfig {
  const statementTimeout = options.statementTimeoutMs ?? 5_000;
  const queryTimeout =
    options.queryTimeoutMs ?? (statementTimeout > 0 ? statementTimeout + 1_000 : 0);
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: passwordProvider(config, options),
    ssl: pgTlsOptions(config.ssl),
    application_name: options.applicationName ?? 'starter',
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    ...(statementTimeout > 0 ? { statement_timeout: statementTimeout } : {}),
    ...(queryTimeout > 0 ? { query_timeout: queryTimeout } : {}),
  };
}

/** Connection pool (API, Lambdas). The caller owns `pool.end()`. */
export function createPgPool(
  config: DatabaseConfig,
  logger: DbLogger,
  options: PgPoolOptions = {},
): pg.Pool {
  const pool = new pg.Pool({
    ...pgClientConfig(config, options),
    max: options.max ?? config.poolMax,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    maxLifetimeSeconds: options.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS,
    allowExitOnIdle: options.allowExitOnIdle ?? false,
  });
  pool.on('error', (error) => {
    // Not under `err`: pino's error serializer would rewrite these plain fields.
    logger.warn({ pgError: idleClientError(error) }, 'idle PostgreSQL client error');
  });
  return pool;
}

/** The loggable fields of an idle-client error; never the client pg-pool attaches to it. */
function idleClientError(error: Error): Record<string, string> {
  const { code, severity } = error as Error & { code?: unknown; severity?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof severity === 'string' ? { severity } : {}),
  };
}

/** Single connection (CLIs: migrate, db-bootstrap, retention). The caller owns `connect()`/`end()`. */
export function createPgClient(
  config: DatabaseConfig,
  options: PgConnectionOptions = {},
): pg.Client {
  return new pg.Client(pgClientConfig(config, options));
}
