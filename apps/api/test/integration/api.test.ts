/**
 * End-to-end through the HTTP layer with real adapters: PostgreSQL 17,
 * DynamoDB Local and the LOCAL workflow simulator (not Step Functions), as an
 * authenticated caller (tokens verified against a JWKS served over HTTP).
 */
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { JobListSchema, JobSchema, ProblemSchema, type Job } from '@starter/contracts';
import { analyzeDocument } from '@starter/domain';
import {
  CONTROL_CHARACTER_DOCUMENT,
  TOO_SHORT_DOCUMENT,
  VALID_DOCUMENT,
  aCreateJobRequestInput,
  bearer,
} from '@starter/testing';
import { jobStateKey } from '@starter/workflow-processing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/app.js';
import { createLifecycle } from '../../src/health.js';
import { PgJobRepository } from '../../src/persistence/job-repository.js';
import { LocalWorkflowSimulator } from '../../src/workflow/local-simulator.js';
import { PgDocumentSource } from '@starter/documents';
import {
  integrationAuth,
  jobStateTable,
  migratedDatabase,
  processorPool,
  silentLogger,
  type IntegrationAuth,
} from './helpers.js';

describe('API integration (PostgreSQL + DynamoDB Local + local simulator)', () => {
  let db: Awaited<ReturnType<typeof migratedDatabase>>;
  let table: Awaited<ReturnType<typeof jobStateTable>>;
  let processor: Awaited<ReturnType<typeof processorPool>>;
  let simulator: LocalWorkflowSimulator;
  let app: App;
  let identity: IntegrationAuth;
  let authorization: string;

  beforeAll(async () => {
    [db, table, identity] = await Promise.all([
      migratedDatabase(),
      jobStateTable(),
      integrationAuth(),
    ]);
    authorization = bearer(await identity.issuer.mint({ sub: 'it-alice' }));
    processor = await processorPool(db);
    const logger = silentLogger();
    const jobs = new PgJobRepository(db.pool);
    simulator = new LocalWorkflowSimulator({
      store: table.store,
      // Documents are loaded as the processor identity, never through the API pool.
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
      healthChecks: [
        { name: 'postgres', check: () => jobs.ping() },
        { name: 'dynamodb', check: () => table.store.ping() },
      ],
    });
  });

  afterAll(async () => {
    await app?.close();
    await simulator?.drain(5_000);
    await processor?.drop();
    await Promise.all([db?.drop(), table?.drop(), identity?.close()]);
  });

  const submit = (body: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { 'content-type': 'application/json', authorization, ...headers },
      payload: JSON.stringify(body),
    });
  const get = (url: string) => app.inject({ url, headers: { authorization } });

  async function settle(jobId: string): Promise<Job> {
    await simulator.waitFor(jobId);
    return JobSchema.parse((await get(`/v1/jobs/${jobId}`)).json());
  }

  it('is ready when both stores answer', async () => {
    const response = await app.inject({ url: '/health/ready' });
    expect(response.statusCode).toBe(200);
  });

  it('processes a valid document to SUCCEEDED with deterministic results', async () => {
    const response = await submit(aCreateJobRequestInput({ options: { topTerms: 5 } }));
    expect(response.statusCode).toBe(202);
    const accepted = JobSchema.parse(response.json());
    const job = await settle(accepted.jobId);
    expect(job.status).toBe('SUCCEEDED');
    expect(job.result).toEqual(analyzeDocument(VALID_DOCUMENT, { topTerms: 5 }));
    expect(job.error).toBeNull();

    // The DynamoDB state item follows the shared spec layout.
    const raw = await table.clients.doc.send(
      new GetCommand({ TableName: table.tableName, Key: jobStateKey(job.jobId) }),
    );
    expect(raw.Item).toMatchObject({
      pk: `JOB#${job.jobId}`,
      sk: 'STATE',
      status: 'SUCCEEDED',
      gsi1pk: 'STATUS#SUCCEEDED',
      executionArn: expect.stringMatching(/^local-simulation:job-processing:job-/),
    });
    expect(String(raw.Item?.gsi1sk)).toMatch(new RegExp(`#${job.jobId}$`));

    // The business record is in PostgreSQL, owned by the caller (issuer-bound).
    const row = await db.pool.query(
      'SELECT title, content_sha256, owner_issuer, owner_subject FROM jobs WHERE id = $1',
      [job.jobId],
    );
    expect(row.rows[0]).toEqual({
      title: 'Migration notes',
      content_sha256: job.result?.checksumSha256,
      owner_issuer: identity.issuer.issuer,
      owner_subject: 'it-alice',
    });
  });

  it.each([
    ['too few words', TOO_SHORT_DOCUMENT, /at least 10 are required/],
    ['control characters', CONTROL_CHARACTER_DOCUMENT, /forbidden control character/],
  ])('fails a document with %s (JobValidationError → FAILED)', async (_n, content, message) => {
    const response = await submit(aCreateJobRequestInput({ title: `Reject ${_n}`, content }));
    expect(response.statusCode).toBe(202);
    const job = await settle(response.json<{ jobId: string }>().jobId);
    expect(job.status).toBe('FAILED');
    expect(job.error?.name).toBe('JobValidationError');
    expect(job.error?.message).toMatch(message);
    expect(job.result).toBeNull();
  });

  it('returns the same job for an idempotent replay', async () => {
    const body = aCreateJobRequestInput({ title: 'Replay me' });
    const first = await submit(body, { 'idempotency-key': 'it-replay-0001' });
    const second = await submit(body, { 'idempotency-key': 'it-replay-0001' });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    const id = first.json<{ jobId: string }>().jobId;
    expect(second.json<{ jobId: string }>().jobId).toBe(id);
    // Stored principal-scoped (p:<sha256(iss|sub)>:h:<key>), never as the raw header value.
    const count = await db.pool.query(
      "SELECT count(*)::int AS n FROM jobs WHERE idempotency_key LIKE 'p:%:h:it-replay-0001'",
    );
    expect(count.rows[0]).toEqual({ n: 1 });
    const raw = await db.pool.query(
      "SELECT count(*)::int AS n FROM jobs WHERE idempotency_key = 'it-replay-0001'",
    );
    expect(raw.rows[0]).toEqual({ n: 0 });
    await settle(id);

    const mismatch = await submit(
      { ...body, title: 'Changed' },
      { 'idempotency-key': 'it-replay-0001' },
    );
    expect(mismatch.statusCode).toBe(422);
  });

  it('rejects an invalid payload with 400 and stores nothing', async () => {
    const before = await db.pool.query('SELECT count(*)::int AS n FROM jobs');
    const response = await submit({ title: '', content: 42 });
    expect(response.statusCode).toBe(400);
    const problem = ProblemSchema.parse(response.json());
    expect(problem.errors?.map((e) => e.path).sort()).toEqual(['body.content', 'body.title']);
    const after = await db.pool.query('SELECT count(*)::int AS n FROM jobs');
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('returns 404 for an unknown job', async () => {
    const response = await get('/v1/jobs/0f8fad5b-d9cb-469f-a165-70867728950e');
    expect(response.statusCode).toBe(404);
  });

  it('lists jobs newest first with merged statuses', async () => {
    const page = JobListSchema.parse((await get('/v1/jobs?limit=100')).json());
    expect(page.items.length).toBeGreaterThanOrEqual(4);
    const created = page.items.map((i) => i.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
    expect(page.items.some((i) => i.status === 'SUCCEEDED')).toBe(true);
    expect(page.items.some((i) => i.status === 'FAILED')).toBe(true);
  });

  it('reports not ready (503) when PostgreSQL is unreachable', async () => {
    const deadPool = new pg.Pool({
      host: '127.0.0.1',
      port: 1, // nothing listens here
      user: 'x',
      password: 'x',
      database: 'x',
      connectionTimeoutMillis: 500,
    });
    const jobs = new PgJobRepository(deadPool);
    const degraded = await buildApp({
      logger: silentLogger(),
      jobs,
      state: table.store,
      workflow: simulator,
      lifecycle: createLifecycle(),
      auth: identity.auth,
      corsAllowedOrigins: [],
      healthChecks: [
        { name: 'postgres', check: () => jobs.ping() },
        { name: 'dynamodb', check: () => table.store.ping() },
      ],
    });
    try {
      const ready = await degraded.inject({ url: '/health/ready' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({ checks: { postgres: 'fail', dynamodb: 'ok' } });
      expect((await degraded.inject({ url: '/health/live' })).statusCode).toBe(200);
      const fetched = await degraded.inject({
        url: '/v1/jobs/0f8fad5b-d9cb-469f-a165-70867728950e',
        headers: { authorization },
      });
      expect(fetched.statusCode).toBe(503);
    } finally {
      await degraded.close();
      await deadPool.end();
    }
  });
});
