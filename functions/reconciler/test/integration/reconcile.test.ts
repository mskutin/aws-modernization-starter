/**
 * The reconciler against DynamoDB Local: the real status-index (gsi1) query, consistent reads and
 * conditional writes of `DynamoDbJobStateStore`. DynamoDB Local is not DynamoDB (index
 * consistency and throughput differ); this proves the expressions and the decision flow, not AWS.
 */
import { randomUUID } from 'node:crypto';
import { DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  DynamoDbJobStateStore,
  createDynamoDbClients,
  ensureJobsTable,
  type DynamoDbClients,
} from '@starter/job-state';
import { uniqueTableName } from '@starter/testing';
import { ReconciliationError, jobStateKey } from '@starter/workflow-processing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { reconcileStaleJobs, type ReconcileOptions } from '../../src/index.js';
import { FakeExecutions, capturingLogger, throttling } from '../helpers.js';

const NOW = new Date('2026-10-14T01:00:00.000Z');
const OPTIONS: ReconcileOptions = {
  staleAfterSeconds: 900,
  batchSize: 25,
  dryRun: false,
  maxRuntimeMs: 30_000,
};

describe('reconciler on DynamoDB Local', () => {
  let clients: DynamoDbClients;
  let tableName: string;
  let store: DynamoDbJobStateStore;

  beforeAll(async () => {
    const { dynamodbEndpoint } = inject('integrationInfra');
    clients = createDynamoDbClients({ region: 'ap-southeast-1', endpoint: dynamodbEndpoint });
    tableName = uniqueTableName('starter-reconciler-it');
    await ensureJobsTable(clients.client, tableName);
    store = new DynamoDbJobStateStore({ client: clients.doc, tableName });
  });
  afterAll(async () => {
    await clients.client.send(new DeleteTableCommand({ TableName: tableName }));
    clients.destroy();
  });

  /** Unique old timestamps per test so runs only see their own jobs. */
  let minute = 0;
  const oldAt = () => {
    minute += 1;
    return new Date(Date.parse('2026-10-13T00:00:00.000Z') + minute * 60_000).toISOString();
  };

  async function seed(status: 'PENDING' | 'VALIDATING' | 'PROCESSING', at = oldAt()) {
    const jobId = randomUUID();
    await store.createInitial(jobId, at);
    if (status !== 'PENDING') await store.transition(jobId, 'VALIDATING', at);
    if (status === 'PROCESSING') await store.transition(jobId, 'PROCESSING', at);
    return jobId;
  }

  const run = (executions: FakeExecutions, options: Partial<ReconcileOptions> = {}, s = store) =>
    reconcileStaleJobs(
      { store: s, executions, logger: capturingLogger().logger, now: () => NOW },
      { ...OPTIONS, ...options },
    );

  it('applies every rule with real index reads and conditional writes', async () => {
    const running = await seed('PROCESSING');
    const failed = await seed('PROCESSING');
    const notStarted = await seed('PENDING');
    const fresh = await seed('VALIDATING', new Date(NOW.getTime() - 60_000).toISOString());
    const executions = new FakeExecutions();
    executions.states.set(running, { status: 'RUNNING' });
    executions.states.set(failed, { status: 'FAILED' });
    executions.states.set(fresh, { status: 'FAILED' });

    const summary = await run(executions);
    expect(summary.dependencyErrors).toBe(0);
    expect(await store.get(running)).toMatchObject({ status: 'PROCESSING', version: 3 });
    expect(await store.get(failed)).toMatchObject({
      status: 'FAILED',
      errorName: ReconciliationError.ExecutionFailed,
      version: 4,
    });
    // The real item left the PROCESSING index partition (the reconciler wrote the transition).
    const raw = await clients.doc.send(
      new GetCommand({ TableName: tableName, Key: jobStateKey(failed), ConsistentRead: true }),
    );
    expect(raw.Item).toMatchObject({ gsi1pk: 'STATUS#FAILED', status: 'FAILED' });
    expect(await store.get(notStarted)).toMatchObject({
      status: 'FAILED',
      errorName: ReconciliationError.WorkflowNotStarted,
    });
    expect((await store.get(fresh))?.status).toBe('VALIDATING');
    expect(executions.lookups.map((l) => l.jobId)).not.toContain(fresh);

    // Idempotent: the next run has nothing left but the running job.
    const again = await run(executions);
    expect(again).toMatchObject({ markedFailed: 0, skippedRunning: 1 });
  });

  it('two concurrent runs transition each job exactly once', async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => seed('PENDING')));
    const executions = new FakeExecutions();
    const [a, b] = await Promise.all([run(executions), run(executions)]);
    const mine = (s: typeof a) => s.markedFailed;
    expect(mine(a) + mine(b)).toBeGreaterThanOrEqual(6);
    for (const id of ids) {
      expect(await store.get(id)).toMatchObject({ status: 'FAILED', version: 2 });
    }
  });

  it('makes no transition when Step Functions is throttled', async () => {
    const jobId = await seed('PROCESSING');
    const before = await store.get(jobId);
    const executions = new FakeExecutions();
    executions.failNext(throttling());
    const summary = await run(executions, { batchSize: 1 });
    expect(summary).toMatchObject({ aborted: true, dependencyErrors: 1, markedFailed: 0 });
    expect(await store.get(jobId)).toEqual(before);
  });

  it('makes no transition when DynamoDB is unreachable', async () => {
    const jobId = await seed('PENDING');
    const before = await store.get(jobId);
    const dead = createDynamoDbClients({
      region: 'ap-southeast-1',
      endpoint: 'http://127.0.0.1:9', // discard port: nothing answers
      maxAttempts: 1,
      requestTimeoutMs: 300,
      connectionTimeoutMs: 300,
    });
    try {
      const unreachable = new DynamoDbJobStateStore({ client: dead.doc, tableName });
      const summary = await run(new FakeExecutions(), {}, unreachable);
      expect(summary).toMatchObject({ aborted: true, dependencyErrors: 1, examined: 0 });
    } finally {
      dead.destroy();
    }
    expect(await store.get(jobId)).toEqual(before);
  });
});
