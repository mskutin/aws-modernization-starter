/**
 * Migration CLI (dist/migrate.js).
 *
 *   node dist/migrate.js [up|status]
 *
 * Connects as `starter_migrator` (DB_*; `DB_AUTH=iam` on AWS) and runs `SET ROLE starter_owner` before
 * touching anything (ADR 0220): the database bootstrap (dist/db-bootstrap.js) must have run.
 * MIGRATIONS_DIR overrides the directory (default: ../migrations relative to this file).
 * Exit codes: 0 success, 1 failure (including refused/modified migrations). Output never contains
 * a password or token.
 */
import { fileURLToPath } from 'node:url';
import { ConfigError, describeDbConfig, loadDatabaseConfig } from '@starter/config';
import { createPgClient, loadMigrations, migrate, migrationStatus } from '@starter/db';
import { createLogger } from '@starter/observability';

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'up';
  if (command !== 'up' && command !== 'status') {
    console.error(`usage: migrate.js [up|status] (got "${command}")`);
    return 1;
  }
  const config = loadDatabaseConfig();
  const logger = createLogger({
    service: 'api-migrate',
    version: config.appVersion,
    environment: config.environment,
    level: config.logLevel,
    sync: true,
  });
  const dir =
    process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../migrations/', import.meta.url));
  logger.info({ db: describeDbConfig(config.db), command }, 'migration runner starting');
  const client = createPgClient(config.db, {
    applicationName: 'starter-migrate',
    statementTimeoutMs: 0,
    queryTimeoutMs: 0,
  });
  try {
    await client.connect();
    const migrations = await loadMigrations(dir);
    if (command === 'status') {
      const status = await migrationStatus(client, migrations);
      logger.info(
        {
          applied: status.applied.map((r) => `${r.version}_${r.name}`),
          pending: status.pending.map((m) => m.filename),
        },
        'migration status',
      );
      return 0;
    }
    const { applied } = await migrate(client, migrations, logger);
    logger.info(
      { applied, total: migrations.length },
      applied.length ? 'migrations complete' : 'schema up to date',
    );
    return 0;
  } catch (error) {
    logger.error({ err: error }, 'migration failed');
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof ConfigError ? error.message : String(error);
    console.error(JSON.stringify({ level: 'fatal', service: 'api-migrate', msg: message }));
    process.exit(1);
  },
);
