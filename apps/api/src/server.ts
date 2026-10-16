/**
 * API process entry point (dist/server.js).
 *
 * Graceful shutdown on SIGTERM/SIGINT: readiness (and liveness) flip to 503,
 * Fastify stops accepting connections and drains in-flight requests, local
 * simulated executions get a bounded wait, pools/clients close, and the
 * process exits — always before SHUTDOWN_TIMEOUT_MS (default 20 s, below the
 * ECS stopTimeout of 30 s).
 *
 * Signal handlers are installed before the first `await`: in the container
 * node runs as PID 1, and the kernel does not apply the default (terminate)
 * action of SIGTERM/SIGINT to PID 1 — without a handler, a stop request during
 * a slow start-up (e.g. while dependencies are unreachable) would be ignored
 * until SIGKILL. A signal during start-up aborts the start-up, closes what was
 * opened and exits 0.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { SFNClient } from '@aws-sdk/client-sfn';
import {
  ConfigError,
  describeApiConfig,
  loadApiConfig,
  loadJobAuditConfig,
  loadLocalReconcilerConfig,
} from '@starter/config';
import { DynamoDbJobStateStore, createDynamoDbClients, ensureJobsTable } from '@starter/job-state';
import { createLogger, type Logger } from '@starter/observability';
import { buildApp } from './app.js';
import { RemoteJwksSource, TokenVerifier } from './auth/index.js';
import { createLifecycle } from './health.js';
import { PgJobRepository } from './persistence/job-repository.js';
import { LocalReconcilerLoop } from './reconciler-loop.js';
import { createPool } from './persistence/pg-pool.js';
import {
  createLocalDocumentSource,
  loadLocalProcessorDb,
  type LocalDocumentSource,
} from './workflow/local-documents.js';
import { LocalWorkflowSimulator } from './workflow/local-simulator.js';
import type { WorkflowPort } from './workflow/port.js';
import { StepFunctionsWorkflow } from './workflow/step-functions.js';

/** Local only (DYNAMODB_ENDPOINT set): create the table so `docker compose up` is enough. */
async function ensureLocalTable(
  logger: Logger,
  create: () => Promise<boolean>,
  stop: AbortSignal,
  attempts = 15,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts && !stop.aborted; attempt += 1) {
    try {
      const created = await create();
      logger.info({ created }, 'DYNAMODB_ENDPOINT set: local job-state table ensured');
      return;
    } catch (error) {
      if (attempt === attempts) {
        logger.warn({ err: error }, 'could not ensure local job-state table; readiness will fail');
        return;
      }
      // Rejects with an AbortError as soon as a stop is requested, ending the retries.
      await delay(1_000, undefined, { signal: stop }).catch(() => undefined);
    }
  }
}

async function main(): Promise<void> {
  const config = loadApiConfig();
  // Workflow settings, validated before any await (fail fast): STEP# audit retention and, for
  // the local simulation only, the starter_processor identity used to load documents.
  const jobAudit = loadJobAuditConfig();
  const processorDb =
    config.workflow.mode === 'local' ? loadLocalProcessorDb(process.env, config.db) : undefined;
  // In-process reconciler: WORKFLOW_MODE=local and APP_RUNTIME local/ci only (rejected otherwise).
  const localReconciler = loadLocalReconcilerConfig();
  const logger = createLogger({
    service: 'api',
    version: config.appVersion,
    environment: config.environment,
    level: config.logLevel,
  });

  // Before any await — see the module comment (PID 1).
  const stop = new AbortController();
  // Set once start-up has finished; until then a signal only aborts the start-up.
  const shutdown: { run?: (signal: NodeJS.Signals) => Promise<void> } = {};
  const handleSignal = (signal: NodeJS.Signals) => {
    if (stop.signal.aborted) return;
    stop.abort();
    const force = setTimeout(() => {
      logger.error({ signal }, 'graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    force.unref();
    if (shutdown.run) void shutdown.run(signal);
    else logger.info({ signal }, 'shutdown requested during start-up; aborting start-up');
  };
  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);

  logger.info({ config: describeApiConfig(config) }, 'starting API');

  const pool = createPool(config.db, logger);
  const dynamo = createDynamoDbClients({
    region: config.dynamodb.region,
    endpoint: config.dynamodb.endpoint,
  });
  let sfn: SFNClient | undefined;
  // Workflow (local simulation only): documents are read as starter_processor, never via `pool`.
  let localDocuments: LocalDocumentSource | undefined;
  let reconcilerLoop: LocalReconcilerLoop | undefined;
  const closeClients = async () => {
    await pool.end();
    await localDocuments?.close();
    dynamo.destroy();
    sfn?.destroy();
  };
  /** Checked between start-up steps: a pending stop request ends the start-up here. */
  const exitIfStopping = async (app?: { close(): Promise<unknown> }) => {
    if (!stop.signal.aborted) return;
    await app?.close();
    await closeClients();
    logger.info('start-up aborted; exiting');
    process.exit(0);
  };

  if (config.dynamodb.endpoint) {
    await ensureLocalTable(
      logger,
      () => ensureJobsTable(dynamo.client, config.dynamodb.tableName),
      stop.signal,
    );
  }
  await exitIfStopping();
  const state = new DynamoDbJobStateStore({
    client: dynamo.doc,
    tableName: config.dynamodb.tableName,
    // STEP# audit retention (only written by the local simulation's steps); unset = kept.
    auditTtlDays: jobAudit.auditTtlDays,
  });

  let workflow: WorkflowPort;
  if (config.workflow.mode === 'local') {
    if (!processorDb) throw new Error('processor database settings were not loaded');
    localDocuments = createLocalDocumentSource(processorDb, logger);
    const simulator = new LocalWorkflowSimulator({
      store: state,
      documents: localDocuments.documents,
      logger,
    });
    workflow = simulator;
    if (localReconciler.intervalSeconds > 0) {
      reconcilerLoop = new LocalReconcilerLoop({
        store: state,
        simulator,
        logger,
        config: localReconciler,
        environment: config.environment,
      });
    }
  } else {
    sfn = new SFNClient({ region: config.dynamodb.region, maxAttempts: 3 });
    workflow = new StepFunctionsWorkflow({
      client: sfn,
      stateMachineArn: config.workflow.stateMachineArn,
      logger,
    });
  }

  const jobs = new PgJobRepository(pool);
  const lifecycle = createLifecycle();
  // Identity: issuer keys are fetched lazily and refreshed with a cooldown; an IdP
  // outage yields 503 for /v1 requests and never blocks start-up, liveness or readiness.
  const issuerKeys = new RemoteJwksSource({
    issuer: config.auth.issuer,
    jwksUri: config.auth.jwksUri,
    allowInsecure: config.auth.allowInsecureIssuer,
    algorithms: config.auth.algorithms,
    logger,
  });
  void issuerKeys.warmUp();
  const app = await buildApp({
    logger,
    jobs,
    state,
    workflow,
    lifecycle,
    auth: {
      verifier: new TokenVerifier({
        issuer: config.auth.issuer,
        audience: config.auth.audience,
        algorithms: config.auth.algorithms,
        clockToleranceSeconds: config.auth.clockToleranceSeconds,
        maxTokenAgeSeconds: config.auth.maxTokenAgeSeconds,
        allowedClientIds: config.auth.allowedClientIds,
        keys: issuerKeys,
      }),
      scopes: config.auth.scopes,
      rateLimit: config.rateLimit,
    },
    trustProxyHops: config.trustProxyHops,
    corsAllowedOrigins: config.cors.allowedOrigins,
    healthChecks: [
      { name: 'postgres', check: () => jobs.ping() },
      { name: 'dynamodb', check: () => state.ping() },
    ],
  });
  await exitIfStopping(app);

  shutdown.run = async (signal: NodeJS.Signals) => {
    const deadline = Date.now() + config.shutdownTimeoutMs;
    lifecycle.beginDrain();
    logger.info(
      { signal, timeoutMs: config.shutdownTimeoutMs },
      'shutdown: draining (readiness 503)',
    );
    try {
      await app.close(); // stop accepting; wait for in-flight requests
      await reconcilerLoop?.stop();
      await workflow.drain(Math.max(0, deadline - Date.now() - 1_000));
      await closeClients();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  try {
    await app.listen({ host: '0.0.0.0', port: config.port });
    reconcilerLoop?.start();
  } catch (error) {
    // A stop request closed the server while listen() was pending; shutdown.run exits.
    if (stop.signal.aborted) return;
    throw error;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : String(error);
  console.error(JSON.stringify({ level: 'fatal', service: 'api', msg: message }));
  process.exit(1);
});
