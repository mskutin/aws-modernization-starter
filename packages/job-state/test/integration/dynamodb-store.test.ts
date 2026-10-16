import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { uniqueTableName } from '@starter/testing';
import { DynamoDbJobStateStore, createDynamoDbClients, ensureJobsTable } from '../../src/index.js';
import { describeJobStateStoreContract } from '../store-contract.js';
import { DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { jobStepKey } from '@starter/workflow-processing';

describeJobStateStoreContract('DynamoDB Local', async () => {
  const { dynamodbEndpoint } = inject('integrationInfra');
  const clients = createDynamoDbClients({ region: 'ap-southeast-1', endpoint: dynamodbEndpoint });
  const tableName = uniqueTableName();
  await ensureJobsTable(clients.client, tableName);
  return {
    store: new DynamoDbJobStateStore({ client: clients.doc, tableName, backoffMs: 5 }),
    cleanup: async () => {
      await clients.client.send(new DeleteTableCommand({ TableName: tableName }));
      clients.destroy();
    },
  };
});

describe('DynamoDB STEP# audit retention (JOB_AUDIT_TTL_DAYS) on DynamoDB Local', () => {
  let clients: ReturnType<typeof createDynamoDbClients>;
  let tableName: string;
  beforeAll(async () => {
    const { dynamodbEndpoint } = inject('integrationInfra');
    clients = createDynamoDbClients({ region: 'ap-southeast-1', endpoint: dynamodbEndpoint });
    tableName = uniqueTableName();
    await ensureJobsTable(clients.client, tableName);
  });
  afterAll(async () => {
    await clients.client.send(new DeleteTableCommand({ TableName: tableName }));
    clients.destroy();
  });

  const rawStep = async (auditTtlDays: number | undefined) => {
    const store = new DynamoDbJobStateStore({ client: clients.doc, tableName, auditTtlDays });
    const entry = {
      jobId: randomUUID(),
      state: 'ProcessJob' as const,
      at: '2026-10-13T10:00:00.000Z',
      outcome: 'succeeded' as const,
    };
    await store.appendStep(entry);
    const out = await clients.doc.send(
      new GetCommand({ TableName: tableName, Key: jobStepKey(entry.jobId, entry.at, entry.state) }),
    );
    return out.Item;
  };

  it('writes no TTL attribute by default (audit items are kept)', async () => {
    expect(await rawStep(undefined)).not.toHaveProperty('expiresAt');
  });

  it('writes the table TTL attribute when configured', async () => {
    expect((await rawStep(7))?.expiresAt).toBe(
      Date.parse('2026-10-13T10:00:00.000Z') / 1000 + 7 * 86_400,
    );
  });
});
