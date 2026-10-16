/**
 * Document-data leakage with real stores: PostgreSQL 17 (documents read as a processor identity through
 * load_job_document), DynamoDB Local and the LOCAL workflow SIMULATION (not Step Functions).
 * A canary document (raw sentence, non-term token, title) must appear in NO captured log line
 * (API + step logs) and in NO DynamoDB item; it may only live in PostgreSQL. The AWS execution
 * history is covered by tests/aws-integration (opt-in, never run here).
 */
import { Writable } from 'node:stream';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { JobSchema } from '@starter/contracts';
import { PgDocumentSource } from '@starter/documents';
import { createLogger } from '@starter/observability';
import { bearer, findLeaks, leakCanary, rejectedLeakCanary } from '@starter/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/app.js';
import { createLifecycle } from '../../src/health.js';
import { PgJobRepository } from '../../src/persistence/job-repository.js';
import { LocalWorkflowSimulator } from '../../src/workflow/local-simulator.js';
import {
  integrationAuth,
  jobStateTable,
  migratedDatabase,
  processorPool,
  withClient,
  type IntegrationAuth,
} from './helpers.js';

describe('canary leakage — API + PostgreSQL + DynamoDB Local + local simulation', () => {
  let db: Awaited<ReturnType<typeof migratedDatabase>>;
  let table: Awaited<ReturnType<typeof jobStateTable>>;
  let processor: Awaited<ReturnType<typeof processorPool>>;
  let identity: IntegrationAuth;
  let authorization: string;
  let simulator: LocalWorkflowSimulator;
  let app: App;
  const raw: string[] = [];

  beforeAll(async () => {
    [db, table, identity] = await Promise.all([
      migratedDatabase(),
      jobStateTable(),
      integrationAuth(),
    ]);
    authorization = bearer(await identity.issuer.mint({ sub: 'leakage-user' }));
    processor = await processorPool(db);
    const logger = createLogger({
      service: 'api-leakage-it',
      level: 'trace',
      destination: new Writable({
        write(chunk: Buffer, _enc, cb) {
          raw.push(...chunk.toString('utf8').split('\n').filter(Boolean));
          cb();
        },
      }),
    });
    const jobs = new PgJobRepository(db.pool);
    simulator = new LocalWorkflowSimulator({
      store: table.store,
      documents: new PgDocumentSource(processor.pool),
      logger,
      timeScale: 0.01,
    });
    app = await buildApp({
      logger,
      jobs,
      state: table.store,
      workflow: simulator,
      lifecycle: createLifecycle(),
      auth: identity.auth,
      corsAllowedOrigins: [],
      healthChecks: [],
    });
  });

  afterAll(async () => {
    await app?.close();
    await simulator?.drain(5_000);
    await processor?.drop();
    await Promise.all([db?.drop(), table?.drop(), identity?.close()]);
  });

  async function allItems(): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await table.clients.doc.send(
        new ScanCommand({
          TableName: table.tableName,
          ExclusiveStartKey: start,
          ConsistentRead: true,
        }),
      );
      items.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start);
    return items;
  }

  it.each([
    ['an accepted document', leakCanary, 'SUCCEEDED'],
    ['a rejected document', rejectedLeakCanary, 'FAILED'],
  ] as const)('%s: raw text only in PostgreSQL', async (_name, make, status) => {
    const canary = make();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { 'content-type': 'application/json', authorization },
      payload: JSON.stringify({ title: canary.title, content: canary.content }),
    });
    expect(response.statusCode).toBe(202);
    const { jobId } = response.json<{ jobId: string }>();
    await simulator.waitFor(jobId);
    const job = JobSchema.parse(
      (await app.inject({ url: `/v1/jobs/${jobId}`, headers: { authorization } })).json(),
    );
    expect(job.status).toBe(status);

    // Control: the document really is in PostgreSQL (the only place it may live). Read as the
    // test admin: the API identity starter_app cannot SELECT content.
    const stored = await withClient(db.admin, (c) =>
      c.query('SELECT content FROM jobs WHERE id = $1', [jobId]),
    );
    expect(findLeaks(stored.rows, canary).length).toBeGreaterThan(0);

    expect(findLeaks(raw, canary)).toEqual([]);
    const items = await allItems();
    expect(items.some((i) => i.pk === `JOB#${jobId}`)).toBe(true);
    expect(findLeaks(items, canary)).toEqual([]);
  });
});
