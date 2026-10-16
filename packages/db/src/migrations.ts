/**
 * Versioned SQL migrations (ADR 0203; role model ADR 0220).
 *
 * - Files: `migrations/NNNN_slug.sql`, applied in version order, each in its
 *   own transaction (opt out with a `-- migrate:no-transaction` line, e.g. for
 *   CREATE INDEX CONCURRENTLY).
 * - Applied versions are recorded in `schema_migrations` with a SHA-256 of the
 *   file. The runner REFUSES to continue if an applied file was modified or
 *   deleted, or if a new file sorts before the latest applied version.
 * - A session advisory lock serialises concurrent runners (e.g. two deploys).
 * - The runner connects as `starter_migrator` and first runs `SET ROLE starter_owner`: the migrator has
 *   no rights of its own (membership WITH INHERIT FALSE), every object is created by and owned
 *   by `starter_owner`, and runtime roles get exactly the grants written in the migrations.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { quoteIdent, sqlState } from './errors.js';
import { MIGRATION_OWNER_ROLE } from './roles.js';

export interface Migration {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
  transactional: boolean;
}

/** Minimal logger surface (pino's `Logger` satisfies it). */
export interface MigrationLogger {
  info(obj: object, msg?: string): void;
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
/** Arbitrary constant identifying this application's migration lock. */
const ADVISORY_LOCK_KEY = 727_001;

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const seen = new Set<string>();
  const migrations: Migration[] = [];
  for (const filename of files) {
    const match = FILE_PATTERN.exec(filename);
    if (!match) {
      throw new MigrationError(`invalid migration filename "${filename}" (expected NNNN_slug.sql)`);
    }
    const [, version, name] = match as unknown as [string, string, string];
    if (seen.has(version)) throw new MigrationError(`duplicate migration version ${version}`);
    seen.add(version);
    const sql = await readFile(join(dir, filename), 'utf8');
    migrations.push({
      version,
      name,
      filename,
      sql,
      checksum: checksumOf(sql),
      transactional: !/^--\s*migrate:no-transaction\b/m.test(sql),
    });
  }
  return migrations;
}

interface AppliedRow {
  version: string;
  name: string;
  checksum: string;
}

export interface MigrationPlan {
  applied: AppliedRow[];
  pending: Migration[];
}

/** Validates history against disk and returns what still needs to run. */
export function plan(
  migrations: readonly Migration[],
  applied: readonly AppliedRow[],
): MigrationPlan {
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (!file) {
      throw new MigrationError(
        `applied migration ${row.version}_${row.name} is missing from the migrations directory`,
      );
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        `migration ${file.filename} was modified after it was applied (checksum mismatch); ` +
          'add a new migration instead of editing an applied one',
      );
    }
  }
  const appliedVersions = new Set(applied.map((r) => r.version));
  const latest = applied
    .map((r) => r.version)
    .sort()
    .at(-1);
  const pending = migrations.filter((m) => !appliedVersions.has(m.version));
  const outOfOrder = latest ? pending.filter((m) => m.version < latest) : [];
  if (outOfOrder.length > 0) {
    throw new MigrationError(
      `migration(s) ${outOfOrder.map((m) => m.filename).join(', ')} sort before the latest applied ` +
        `version ${latest}; renumber them after ${latest}`,
    );
  }
  return { applied: [...applied], pending };
}

export interface MigrationRunOptions {
  /** `lock_timeout` for DDL, e.g. `10s`. @default '10s' */
  lockTimeout?: string;
  /**
   * Role to `SET ROLE` to before anything else (the object owner). `null` keeps the session
   * user (only for tests of the runner itself). @default 'starter_owner'
   */
  role?: string | null;
}

/**
 * `SET ROLE <owner>` with an actionable error: a missing role means the bootstrap has not run; a
 * permission error means the session user is not the migrator.
 */
export async function assumeOwnerRole(client: pg.ClientBase, role: string): Promise<void> {
  try {
    await client.query(`SET ROLE ${quoteIdent(role)}`);
  } catch (error) {
    const code = sqlState(error);
    const hint =
      code === '22023' || code === '42704'
        ? `role ${role} does not exist: run the database bootstrap (dist/db-bootstrap.js) first`
        : `the session user may not SET ROLE ${role}: run migrations as starter_migrator`;
    throw new MigrationError(`cannot SET ROLE ${role}: ${hint}`, { cause: error });
  }
}

async function ensureHistoryTable(client: pg.ClientBase): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version      text        PRIMARY KEY,
      name         text        NOT NULL,
      checksum     char(64)    NOT NULL,
      applied_at   timestamptz NOT NULL DEFAULT now(),
      execution_ms integer     NOT NULL
    )`);
}

async function appliedRows(client: pg.ClientBase): Promise<AppliedRow[]> {
  const result = await client.query<AppliedRow>(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  );
  return result.rows;
}

export async function migrationStatus(
  client: pg.ClientBase,
  migrations: readonly Migration[],
  options: Pick<MigrationRunOptions, 'role'> = {},
): Promise<MigrationPlan> {
  const role = options.role === undefined ? MIGRATION_OWNER_ROLE : options.role;
  if (role) await assumeOwnerRole(client, role);
  try {
    await ensureHistoryTable(client);
    return plan(migrations, await appliedRows(client));
  } finally {
    if (role) await client.query('RESET ROLE');
  }
}

export async function migrate(
  client: pg.ClientBase,
  migrations: readonly Migration[],
  logger: MigrationLogger,
  options: MigrationRunOptions = {},
): Promise<{ applied: string[] }> {
  const lockTimeout = options.lockTimeout ?? '10s';
  if (!/^\d+(ms|s)$/.test(lockTimeout))
    throw new MigrationError(`invalid lock timeout ${lockTimeout}`);
  const role = options.role === undefined ? MIGRATION_OWNER_ROLE : options.role;
  if (role) await assumeOwnerRole(client, role);
  await client.query(`SET lock_timeout = '${lockTimeout}'`);
  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    await ensureHistoryTable(client);
    const { pending } = plan(migrations, await appliedRows(client));
    const appliedNow: string[] = [];
    for (const migration of pending) {
      const started = Date.now();
      const record = () =>
        client.query(
          'INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)',
          [migration.version, migration.name, migration.checksum, Date.now() - started],
        );
      if (migration.transactional) {
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await record();
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw new MigrationError(
            `migration ${migration.filename} failed: ${(error as Error).message}`,
            {
              cause: error,
            },
          );
        }
      } else {
        try {
          await client.query(migration.sql);
        } catch (error) {
          throw new MigrationError(
            `migration ${migration.filename} failed: ${(error as Error).message}`,
            {
              cause: error,
            },
          );
        }
        await record();
      }
      appliedNow.push(migration.filename);
      logger.info({ migration: migration.filename, ms: Date.now() - started }, 'migration applied');
    }
    return { applied: appliedNow };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    if (role) await client.query('RESET ROLE');
  }
}
