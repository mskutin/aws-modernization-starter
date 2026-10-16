/**
 * Vitest `globalSetup` helper: starts (or discovers) PostgreSQL and DynamoDB
 * Local once per test run and shares the endpoints with test files via
 * `inject('integrationInfra')`.
 *
 *   // test/integration/global-setup.ts
 *   export { setupIntegrationInfra as default } from '@starter/testing';
 */
import type { TestProject } from 'vitest/node';
import { startDynamoDbLocal, startPostgres, type PostgresEndpoint } from './infra.js';

export interface IntegrationInfraInfo {
  postgres: PostgresEndpoint;
  dynamodbEndpoint: string;
  sources: { postgres: 'env' | 'container'; dynamodb: 'env' | 'container' };
}

export interface PostgresInfraInfo {
  postgres: PostgresEndpoint;
  source: 'env' | 'container';
}

declare module 'vitest' {
  export interface ProvidedContext {
    integrationInfra: IntegrationInfraInfo;
    postgresInfra: PostgresInfraInfo;
  }
}

export async function setupIntegrationInfra(project: TestProject): Promise<() => Promise<void>> {
  const [postgres, dynamodb] = await Promise.all([startPostgres(), startDynamoDbLocal()]);
  project.provide('integrationInfra', {
    postgres: postgres.endpoint,
    dynamodbEndpoint: dynamodb.endpoint,
    sources: { postgres: postgres.source, dynamodb: dynamodb.source },
  });
  return async () => {
    await Promise.allSettled([postgres.stop(), dynamodb.stop()]);
  };
}

/**
 * PostgreSQL only (suites that need no DynamoDB, e.g. `@starter/db`): shared with test files via
 * `inject('postgresInfra')`.
 */
export async function setupPostgresInfra(project: TestProject): Promise<() => Promise<void>> {
  const postgres = await startPostgres();
  project.provide('postgresInfra', { postgres: postgres.endpoint, source: postgres.source });
  return async () => {
    await postgres.stop();
  };
}
