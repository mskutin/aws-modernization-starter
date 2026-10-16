/**
 * Retention CLI (dist/retention.js, ADR 0223) — DISABLED BY DEFAULT.
 *
 *   RETENTION_MODE=disabled            (default) logs that no approved policy exists; reads nothing
 *   RETENTION_MODE=dry-run             counts the jobs whose documents would be purged
 *   RETENTION_MODE=apply               purges them; requires RETENTION_APPROVAL_REF
 *   RETENTION_CONTENT_DAYS=<days>      age threshold (required unless disabled)
 *   RETENTION_BATCH_SIZE / RETENTION_MAX_BATCHES   bounds per run (100 / 50)
 *
 * Connects as `starter_retention` (DB_*; `DB_AUTH=iam` on AWS). Exit codes: 0 success (also when
 * disabled), 1 failure. Purging stays disabled until a retention period is approved (ADR 0223).
 */
import { ConfigError, describeDbConfig, loadRetentionConfig } from '@starter/config';
import { createPgClient } from '@starter/db';
import { createLogger } from '@starter/observability';
import { runContentRetention } from './retention-job.js';

async function main(): Promise<number> {
  const config = loadRetentionConfig();
  const logger = createLogger({
    service: 'retention',
    version: config.appVersion,
    environment: config.environment,
    level: config.logLevel,
    sync: true,
  });
  const { policy } = config;
  if (policy.mode === 'disabled') {
    logger.warn(
      { mode: policy.mode },
      'retention is disabled: no approved retention policy is configured; nothing was read or changed',
    );
    return 0;
  }
  logger.info({ db: describeDbConfig(config.db), policy }, 'retention run starting');
  const client = createPgClient(config.db, {
    applicationName: 'starter-retention',
    statementTimeoutMs: 60_000,
  });
  try {
    await client.connect();
    const result = await runContentRetention(client, policy, logger);
    logger.info({ result }, 'retention run finished');
    return 0;
  } catch (error) {
    logger.error({ err: error }, 'retention run failed');
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof ConfigError ? error.message : String(error);
    console.error(JSON.stringify({ level: 'fatal', service: 'retention', msg: message }));
    process.exit(1);
  },
);
