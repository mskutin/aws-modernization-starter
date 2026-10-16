/**
 * AWS INTEGRATION MINI-STACK ONLY (ADR 0232) — entry point for the ProcessJob state.
 *
 * Same step code and configuration as handler.ts, but documents come from the mini-stack's
 * TEST-ONLY DynamoDB document table (TEST_DOCUMENTS_TABLE_NAME; synthetic documents seeded by
 * tests/aws-integration), because the mini-stack has no PostgreSQL. The environment stages never
 * deploy this entry (infra tests assert that no stage function carries TEST_DOCUMENTS_TABLE_NAME).
 *
 * TEST fault injection (`@starter/documents/test-faults`): only when the mini-stack sets
 * TEST_FAULT_INJECTION=enabled does the document source honour a fault plan that a test wrote on
 * its synthetic document item (transient failures, delays). Without a plan nothing changes.
 */
import { ConfigError, loadJobAuditConfig, loadLambdaConfig } from '@starter/config';
import {
  FaultInjectingDocumentSource,
  TEST_FAULT_INJECTION_ENV,
  testFaultInjectionEnabled,
} from '@starter/documents/test-faults';
import { DynamoDbTestDocumentSource } from '@starter/documents/test-table';
import { DynamoDbJobStateStore, createDynamoDbClients } from '@starter/job-state';
import { WORKFLOW_REDACT_PATHS, createLogger } from '@starter/observability';
import { ProcessingState } from '@starter/workflow-processing';
import { createHandler } from './runtime.js';
import type { StepDeps } from './step.js';

let deps: StepDeps | undefined;

/**
 * Builds the step dependencies from the environment (creates clients, makes no AWS call).
 * Exported for the arming tests.
 */
export function integrationDeps(env: NodeJS.ProcessEnv = process.env): StepDeps {
  const config = loadLambdaConfig(env);
  const audit = loadJobAuditConfig(env);
  const documentsTable = env.TEST_DOCUMENTS_TABLE_NAME;
  if (!documentsTable || !/^[A-Za-z0-9_.-]{3,255}$/.test(documentsTable)) {
    throw new ConfigError('integration processor', [
      { variable: 'TEST_DOCUMENTS_TABLE_NAME', message: 'is required (a DynamoDB table name)' },
    ]);
  }
  let faultsArmed: boolean;
  try {
    faultsArmed = testFaultInjectionEnabled(env);
  } catch {
    throw new ConfigError('integration processor', [
      { variable: TEST_FAULT_INJECTION_ENV, message: 'must be "enabled" or unset' },
    ]);
  }
  const logger = createLogger({
    service: 'fn-processor',
    version: config.appVersion,
    environment: config.environment,
    level: config.logLevel,
    redact: WORKFLOW_REDACT_PATHS,
    sync: true,
  });
  const { doc } = createDynamoDbClients({ region: config.region, endpoint: config.endpoint });
  const source = new DynamoDbTestDocumentSource({ client: doc, tableName: documentsTable });
  return {
    store: new DynamoDbJobStateStore({
      client: doc,
      tableName: config.tableName,
      auditTtlDays: audit.auditTtlDays,
    }),
    documents: faultsArmed
      ? new FaultInjectingDocumentSource(source, {
          client: doc,
          documentsTableName: documentsTable,
          jobsTableName: config.tableName,
          step: ProcessingState.Process,
          onFault: (fault) =>
            logger.warn({ testFault: fault }, 'TEST fault injected (mini-stack only)'),
        })
      : source,
    logger,
  };
}

export const handler = createHandler(() => (deps ??= integrationDeps()));
