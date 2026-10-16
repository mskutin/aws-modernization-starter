/**
 * AWS Lambda entry point for the ValidateJob state.
 * Env: JOBS_TABLE_NAME, AWS_REGION, LOG_LEVEL, optional DYNAMODB_ENDPOINT,
 *      optional JOB_AUDIT_TTL_DAYS (STEP# audit retention; unset = keep),
 *      DB_* for the document source: DB_USER=starter_processor, DB_AUTH=iam,
 *      DB_SSL=verify-full, DB_SSL_ROOT_CERT=<RDS CA bundle in the asset>.
 * Clients are created once per execution environment (outside the handler).
 */
import { loadJobAuditConfig, loadLambdaConfig } from '@starter/config';
import { createLambdaDocumentSource } from '@starter/documents/lambda';
import { DynamoDbJobStateStore, createDynamoDbClients } from '@starter/job-state';
import { WORKFLOW_REDACT_PATHS, createLogger } from '@starter/observability';
import { createHandler } from './runtime.js';
import type { StepDeps } from './step.js';

let deps: StepDeps | undefined;

function init(): StepDeps {
  const config = loadLambdaConfig();
  const audit = loadJobAuditConfig();
  const logger = createLogger({
    service: 'fn-validator',
    version: config.appVersion,
    environment: config.environment,
    level: config.logLevel,
    redact: WORKFLOW_REDACT_PATHS,
    sync: true,
  });
  const { doc } = createDynamoDbClients({ region: config.region, endpoint: config.endpoint });
  return {
    store: new DynamoDbJobStateStore({
      client: doc,
      tableName: config.tableName,
      auditTtlDays: audit.auditTtlDays,
    }),
    documents: createLambdaDocumentSource(process.env, logger, {
      applicationName: 'starter-fn-validator',
    }),
    logger,
  };
}

export const handler = createHandler(() => (deps ??= init()));
