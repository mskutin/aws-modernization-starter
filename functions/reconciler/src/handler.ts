/**
 * AWS Lambda entry point of the stale-job reconciler — exactly ONE scheduled function per
 * environment, reserved concurrency 1.
 * Env: JOBS_TABLE_NAME, AWS_REGION, STATE_MACHINE_ARN, LOG_LEVEL, RECONCILER_STALE_AFTER_SECONDS,
 *      RECONCILER_BATCH_SIZE, RECONCILER_DRY_RUN, RECONCILER_MAX_RUNTIME_SECONDS.
 * Clients are created once per execution environment (outside the handler).
 */
import { SFNClient } from '@aws-sdk/client-sfn';
import { loadReconcilerLambdaConfig } from '@starter/config';
import { DynamoDbJobStateStore, createDynamoDbClients } from '@starter/job-state';
import { WORKFLOW_REDACT_PATHS, createLogger } from '@starter/observability';
import { StepFunctionsExecutions } from './executions.js';
import { createHandler, type ReconcilerHandlerDeps } from './runtime.js';

let deps: ReconcilerHandlerDeps | undefined;

function init(): ReconcilerHandlerDeps {
  const config = loadReconcilerLambdaConfig();
  const logger = createLogger({
    service: 'fn-reconciler',
    version: config.appVersion,
    environment: config.environment,
    level: config.logLevel,
    redact: WORKFLOW_REDACT_PATHS,
    sync: true,
  });
  const { doc } = createDynamoDbClients({
    region: config.region,
    endpoint: config.endpoint,
    maxAttempts: 2,
    requestTimeoutMs: 2_000,
  });
  const sfn = new SFNClient({ region: config.region, maxAttempts: 2 });
  return {
    store: new DynamoDbJobStateStore({ client: doc, tableName: config.tableName }),
    executions: new StepFunctionsExecutions({
      client: sfn,
      stateMachineArn: config.stateMachineArn,
    }),
    logger,
    settings: config.reconciler,
    environment: config.environment,
  };
}

export const handler = createHandler(() => (deps ??= init()));
