/**
 * Database bootstrap CLI (dist/db-bootstrap.js, ADR 0220) — run by the database ADMIN before the
 * migrations: once per environment and after any change to the role model. Idempotent.
 *
 *   node dist/db-bootstrap.js
 *
 * - AWS: one-off ECS task (`DatabaseBootstrapTask`), `APP_RUNTIME=aws`, `DB_USER=<master>`,
 *   `DB_AUTH=secrets-manager` + `DB_SECRET_ARN` (the RDS-managed master secret, read when the
 *   connection opens, so a rotated master password is always current), `DB_SSL=verify-full`,
 *   `DB_BOOTSTRAP_LOGIN_AUTH=iam` (login roles get `rds_iam`, no passwords). NOT validated on AWS.
 * - Local / CI: `APP_RUNTIME=local|ci`, the admin superuser with `DB_AUTH=password`,
 *   `DB_BOOTSTRAP_LOGIN_AUTH=password` and `DB_BOOTSTRAP_{MIGRATOR,APP,PROCESSOR,RETENTION}_PASSWORD`.
 * - Optional `DB_BOOTSTRAP_{MIGRATOR,APP,PROCESSOR,RETENTION}_CONNECTION_LIMIT`.
 *
 * Output: the changes made and the resulting role attributes/memberships; never a password,
 * verifier, token or SQL statement. Exit codes: 0 success, 1 failure.
 */
import { ConfigError, describeDbConfig, loadDatabaseBootstrapConfig } from '@starter/config';
import { bootstrapDatabaseRoles, createPgClient } from '@starter/db';
import { createLogger } from '@starter/observability';

async function main(): Promise<number> {
  const config = loadDatabaseBootstrapConfig();
  const logger = createLogger({
    service: 'db-bootstrap',
    version: config.appVersion,
    environment: config.environment,
    level: config.logLevel,
    sync: true,
  });
  logger.info(
    {
      db: describeDbConfig(config.db),
      runtime: config.runtime,
      loginAuth: config.loginAuth,
      connectionLimits: config.connectionLimits,
    },
    'database bootstrap starting',
  );
  const client = createPgClient(config.db, {
    applicationName: 'starter-db-bootstrap',
    statementTimeoutMs: 0,
    queryTimeoutMs: 0,
  });
  try {
    await client.connect();
    const result = await bootstrapDatabaseRoles(client, {
      loginAuth: config.loginAuth,
      ...(config.passwords ? { passwords: config.passwords } : {}),
      connectionLimits: config.connectionLimits,
    });
    for (const warning of result.warnings) logger.warn({ warning }, 'server warning');
    logger.info(
      { changes: result.changes, roles: result.roles, memberships: result.memberships },
      'database bootstrap complete',
    );
    return 0;
  } catch (error) {
    logger.error({ err: error }, 'database bootstrap failed');
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof ConfigError ? error.message : String(error);
    console.error(JSON.stringify({ level: 'fatal', service: 'db-bootstrap', msg: message }));
    process.exit(1);
  },
);
