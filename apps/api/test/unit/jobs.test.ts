import {
  CONTRACT_VERSION,
  JobListSchema,
  JobSchema,
  ProblemSchema,
  ProblemType,
  buildOpenApiDocument,
} from '@starter/contracts';
import { aCreateJobRequestInput } from '@starter/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GENERIC_FAILURE } from '../../src/services/job-service.js';
import { buildTestApp, unitPrincipalKey } from './fakes.js';

type Harness = Awaited<ReturnType<typeof buildTestApp>>;

const json = (body: unknown) => ({
  headers: { 'content-type': 'application/json' },
  payload: JSON.stringify(body),
});

function problem(response: { headers: Record<string, unknown>; json(): unknown }) {
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  return ProblemSchema.parse(response.json());
}

describe('POST /v1/jobs', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildTestApp();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it('accepts a valid job (202), persists it and starts the workflow once', async () => {
    const response = await h.inject({
      method: 'POST',
      url: '/v1/jobs',
      ...json(aCreateJobRequestInput()),
    });
    expect(response.statusCode).toBe(202);
    const job = JobSchema.parse(response.json());
    expect(job).toMatchObject({
      status: 'PENDING',
      title: 'Migration notes',
      options: { topTerms: 10 },
      result: null,
    });
    expect(response.headers.location).toBe(`/v1/jobs/${job.jobId}`);
    expect(response.headers['x-request-id']).toBeTruthy();
    expect(response.headers['idempotent-replayed']).toBeUndefined();
    expect(h.jobs.records.size).toBe(1);
    expect(h.workflow.started).toHaveLength(1);
    // Spec 2.0.0: a job reference only (see workflow-input.test.ts for the leakage proof).
    expect(h.workflow.started[0]).toEqual({
      jobId: job.jobId,
      contractVersion: CONTRACT_VERSION,
      submittedAt: job.createdAt,
    });
    // Principal-scoped derived key (ADR 0211), stored with the job (since spec 2.0.0 the
    // execution input carries the job reference only).
    expect(h.jobs.records.get(job.jobId)?.idempotencyKey).toMatch(
      new RegExp(`^p:${unitPrincipalKey('alice')}:derived:v1:[a-f0-9]{64}$`),
    );
    expect(h.jobs.records.get(job.jobId)?.owner).toEqual({
      issuer: 'https://idp.unit.test',
      subject: 'alice',
    });
    expect(await h.state.get(job.jobId)).toMatchObject({
      status: 'PENDING',
      executionArn: `arn:fake:execution:${job.jobId}`,
    });
    // Request-scoped logging: the acceptance line carries the request id.
    expect(h.lines.find((l) => l.msg === 'job accepted; workflow started')).toMatchObject({
      jobId: job.jobId,
      requestId: response.headers['x-request-id'],
    });
    expect(h.lines.find((l) => l.msg === 'request completed')).toMatchObject({
      requestId: response.headers['x-request-id'],
    });
  });

  it.each([
    ['missing title', { content: 'text' }, 'body.title'],
    ['blank title', { title: '   ', content: 'text' }, 'body.title'],
    ['oversized content', { title: 't', content: 'x'.repeat(40_001) }, 'body.content'],
    ['unknown field', { title: 't', content: 'c', priority: 'high' }, 'body'],
    [
      'bad option',
      { title: 't', content: 'c', options: { topTerms: 99 } },
      'body.options.topTerms',
    ],
  ])('rejects %s with 400 problem+json and writes nothing', async (_n, body, path) => {
    const response = await h.inject({ method: 'POST', url: '/v1/jobs', ...json(body) });
    expect(response.statusCode).toBe(400);
    const p = problem(response);
    expect(p).toMatchObject({ type: ProblemType.Validation, status: 400, instance: '/v1/jobs' });
    expect(p.errors?.map((e) => e.path)).toContain(path);
    expect(p.requestId).toBe(response.headers['x-request-id']);
    expect(h.jobs.records.size).toBe(0);
    expect(h.workflow.started).toHaveLength(0);
  });

  it('rejects a missing body with 400', async () => {
    const response = await h.inject({ method: 'POST', url: '/v1/jobs' });
    expect(response.statusCode).toBe(400);
    problem(response);
  });

  it('rejects malformed JSON with 400', async () => {
    const response = await h.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { 'content-type': 'application/json' },
      payload: '{"title": ',
    });
    expect(response.statusCode).toBe(400);
    expect(problem(response).detail).toBe('The request body is not valid JSON.');
  });

  it('rejects non-JSON media types with 415', async () => {
    const response = await h.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(response.statusCode).toBe(415);
    expect(problem(response).type).toBe(ProblemType.UnsupportedMediaType);
  });

  it('rejects bodies above the size limit with 413', async () => {
    const response = await h.inject({
      method: 'POST',
      url: '/v1/jobs',
      ...json({ title: 't', content: 'x'.repeat(600 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
    expect(problem(response).type).toBe(ProblemType.PayloadTooLarge);
  });

  it('rejects a malformed Idempotency-Key header', async () => {
    const response = await h.inject({
      method: 'POST',
      url: '/v1/jobs',
      ...json(aCreateJobRequestInput()),
      headers: { 'content-type': 'application/json', 'idempotency-key': 'bad key!' },
    });
    expect(response.statusCode).toBe(400);
    expect(problem(response).errors?.[0]?.path).toBe('header.Idempotency-Key');
  });

  describe('idempotency', () => {
    const withKey = (key: string, body: unknown) => ({
      method: 'POST' as const,
      url: '/v1/jobs',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      payload: JSON.stringify(body),
    });

    it('replays the same job for the same Idempotency-Key (200 + Idempotent-Replayed)', async () => {
      const first = await h.inject(withKey('key-12345678', aCreateJobRequestInput()));
      const second = await h.inject(withKey('key-12345678', aCreateJobRequestInput()));
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.json<{ jobId: string }>().jobId).toBe(first.json<{ jobId: string }>().jobId);
      expect(h.jobs.records.size).toBe(1);
      expect(h.workflow.started).toHaveLength(1);
    });

    it('rejects reuse of a key with a different body (422)', async () => {
      await h.inject(withKey('key-12345678', aCreateJobRequestInput()));
      const response = await h.inject(
        withKey('key-12345678', aCreateJobRequestInput({ title: 'Other' })),
      );
      expect(response.statusCode).toBe(422);
      expect(problem(response).type).toBe(ProblemType.IdempotencyMismatch);
      expect(h.jobs.records.size).toBe(1);
    });

    it('deduplicates identical bodies without a header (derived key)', async () => {
      const a = await h.inject({
        method: 'POST',
        url: '/v1/jobs',
        ...json(aCreateJobRequestInput()),
      });
      const b = await h.inject({
        method: 'POST',
        url: '/v1/jobs',
        // Same request after defaults/trimming → same canonical fingerprint.
        ...json({
          ...aCreateJobRequestInput(),
          title: '  Migration notes ',
          options: { topTerms: 10 },
        }),
      });
      const c = await h.inject({
        method: 'POST',
        url: '/v1/jobs',
        ...json(aCreateJobRequestInput({ title: 'Different' })),
      });
      expect(b.statusCode).toBe(200);
      expect(b.json<{ jobId: string }>().jobId).toBe(a.json<{ jobId: string }>().jobId);
      expect(c.statusCode).toBe(202);
      expect(h.jobs.records.size).toBe(2);
    });

    it('resumes a job whose workflow start failed when the client retries (503 then 200)', async () => {
      h.workflow.failNext(
        Object.assign(new Error('throttled'), {
          name: 'ThrottlingException',
          $metadata: { httpStatusCode: 400 },
        }),
      );
      const failed = await h.inject(withKey('retry-key-1', aCreateJobRequestInput()));
      expect(failed.statusCode).toBe(503);
      expect(failed.headers['retry-after']).toBe('1');
      expect(problem(failed).type).toBe(ProblemType.ServiceUnavailable);
      expect(h.workflow.started).toHaveLength(0);

      const retried = await h.inject(withKey('retry-key-1', aCreateJobRequestInput()));
      expect(retried.statusCode).toBe(200);
      expect(h.workflow.started).toHaveLength(1);
      expect(h.jobs.records.size).toBe(1);
    });

    it('repairs an expired DynamoDB claim from the durable PostgreSQL key', async () => {
      const first = await h.inject(withKey('durable-key-1', aCreateJobRequestInput()));
      const jobId = first.json<{ jobId: string }>().jobId;
      // Simulate TTL expiry of the DynamoDB idempotency record.
      const record = await h.state.getIdempotency(
        `p:${unitPrincipalKey('alice')}:h:durable-key-1`,
        new Date('2026-10-13T10:00:05.000Z'),
      );
      await h.state.putIdempotency({ ...record!, expiresAt: 0 });
      const replay = await h.inject(withKey('durable-key-1', aCreateJobRequestInput()));
      expect(replay.statusCode).toBe(200);
      expect(replay.json<{ jobId: string }>().jobId).toBe(jobId);
      expect(h.jobs.records.size).toBe(1);
    });
  });
});

describe('GET /v1/jobs/{jobId}', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildTestApp();
  });
  afterEach(async () => {
    await h.app.close();
  });

  const create = async () => {
    const response = await h.inject({
      method: 'POST',
      url: '/v1/jobs',
      ...json(aCreateJobRequestInput()),
    });
    return response.json<{ jobId: string }>().jobId;
  };

  it('returns 404 problem for an unknown job', async () => {
    const response = await h.inject({ url: '/v1/jobs/0f8fad5b-d9cb-469f-a165-70867728950e' });
    expect(response.statusCode).toBe(404);
    expect(problem(response)).toMatchObject({ type: ProblemType.NotFound, status: 404 });
  });

  it('returns 400 for a malformed job id', async () => {
    const response = await h.inject({ url: '/v1/jobs/not-a-uuid' });
    expect(response.statusCode).toBe(400);
    expect(problem(response).errors?.[0]?.path).toBe('path.jobId');
  });

  it('merges the PostgreSQL record with the DynamoDB result on success', async () => {
    const jobId = await create();
    await h.state.transition(jobId, 'VALIDATING', '2026-10-13T10:01:00.000Z');
    await h.state.transition(jobId, 'PROCESSING', '2026-10-13T10:01:01.000Z');
    const result = {
      algorithmVersion: '1.0.0',
      wordCount: 3,
      uniqueWordCount: 3,
      sentenceCount: 1,
      paragraphCount: 1,
      characterCount: 15,
      averageWordLength: 4.33,
      averageSentenceLength: 3,
      lexicalDiversity: 1,
      readingTimeSeconds: 1,
      topTerms: [{ term: 'hello', count: 1 }],
      checksumSha256: 'b'.repeat(64),
    };
    // Spec 2.0.0: the processor stores the result; RecordSuccess completes the transition.
    await h.state.storeResult(jobId, JSON.stringify(result));
    await h.state.recordSuccess(jobId, '2026-10-13T10:01:02.000Z');
    const response = await h.inject({ url: `/v1/jobs/${jobId}` });
    expect(response.statusCode).toBe(200);
    expect(JobSchema.parse(response.json())).toMatchObject({
      status: 'SUCCEEDED',
      updatedAt: '2026-10-13T10:01:02.000Z',
      result,
      error: null,
    });
  });

  it('surfaces only the message from a Step Functions error Cause (no stack traces)', async () => {
    const jobId = await create();
    const cause = JSON.stringify({
      errorType: 'JobValidationError',
      errorMessage: 'Document rejected: content has 3 word(s)',
      trace: [
        'JobValidationError: Document rejected',
        '    at validateStep (/var/task/index.mjs:1:1)',
      ],
    });
    await h.state.recordFailure(
      jobId,
      { name: 'JobValidationError', message: cause },
      '2026-10-13T10:02:00.000Z',
    );
    const job = JobSchema.parse((await h.inject({ url: `/v1/jobs/${jobId}` })).json());
    expect(job.error).toEqual({
      name: 'JobValidationError',
      message: 'Document rejected: content has 3 word(s)',
    });
    expect(JSON.stringify(job)).not.toContain('/var/task');
  });

  it('hides the raw cause of non-validation failures from clients (AWS errors name accounts and roles)', async () => {
    const jobId = await create();
    await h.state.recordFailure(
      jobId,
      {
        name: 'DynamoDB.AccessDeniedException',
        message:
          'User: arn:aws:sts::123456789012:assumed-role/starter-prod-workflow/abc is not authorized to perform: dynamodb:UpdateItem on resource: arn:aws:dynamodb:ap-southeast-1:123456789012:table/starter-prod-jobs',
      },
      '2026-10-13T10:02:00.000Z',
    );
    const response = await h.inject({ url: `/v1/jobs/${jobId}` });
    const job = JobSchema.parse(response.json());
    expect(job.status).toBe('FAILED');
    expect(job.error).toEqual(GENERIC_FAILURE);
    expect(response.body).not.toContain('123456789012');
    expect(response.body).not.toContain('assumed-role');
  });

  it('answers 503 problem when PostgreSQL is unreachable and 500 without internals otherwise', async () => {
    const jobId = await create();
    h.jobs.failNext(
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' }),
    );
    const unavailable = await h.inject({ url: `/v1/jobs/${jobId}` });
    expect(unavailable.statusCode).toBe(503);
    expect(problem(unavailable).type).toBe(ProblemType.ServiceUnavailable);

    h.jobs.failNext(new Error('secret internal detail'));
    const broken = await h.inject({ url: `/v1/jobs/${jobId}` });
    expect(broken.statusCode).toBe(500);
    expect(broken.body).not.toContain('secret internal detail');
    expect(h.lines.some((l) => l.msg === 'unhandled error')).toBe(true);
  });
});

describe('GET /v1/jobs', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildTestApp();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it('pages newest-first with an opaque cursor and merges statuses', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await h.inject({
        method: 'POST',
        url: '/v1/jobs',
        ...json(aCreateJobRequestInput({ title: `Doc ${i}` })),
      });
      ids.push(r.json<{ jobId: string }>().jobId);
    }
    await h.state.recordFailure(ids[4]!, { name: 'X', message: 'y' }, '2026-10-13T11:00:00.000Z');

    const page1 = JobListSchema.parse((await h.inject({ url: '/v1/jobs?limit=2' })).json());
    expect(page1.items.map((i) => i.title)).toEqual(['Doc 4', 'Doc 3']);
    expect(page1.items[0]).toMatchObject({
      status: 'FAILED',
      updatedAt: '2026-10-13T11:00:00.000Z',
    });
    expect(page1.nextCursor).toBeTruthy();

    const page2 = JobListSchema.parse(
      (await h.inject({ url: `/v1/jobs?limit=2&cursor=${page1.nextCursor}` })).json(),
    );
    expect(page2.items.map((i) => i.title)).toEqual(['Doc 2', 'Doc 1']);
    const page3 = JobListSchema.parse(
      (await h.inject({ url: `/v1/jobs?limit=2&cursor=${page2.nextCursor}` })).json(),
    );
    expect(page3.items.map((i) => i.title)).toEqual(['Doc 0']);
    expect(page3.nextCursor).toBeNull();
  });

  it.each([
    '/v1/jobs?limit=0',
    '/v1/jobs?limit=500',
    '/v1/jobs?cursor=bm90LWpzb24',
    '/v1/jobs?foo=1',
  ])('rejects %s with 400', async (url) => {
    const response = await h.inject({ url });
    expect(response.statusCode).toBe(400);
    expect(problem(response).type).toBe(ProblemType.Validation);
  });
});

describe('platform routes', () => {
  it('serves the generated OpenAPI document', async () => {
    const h = await buildTestApp();
    const response = await h.inject({ url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(buildOpenApiDocument());
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    await h.app.close();
  });

  it('answers unknown routes with a 404 problem', async () => {
    const h = await buildTestApp();
    const response = await h.inject({ url: '/v2/jobs' });
    expect(response.statusCode).toBe(404);
    expect(problem(response).detail).toBe('No route for GET /v2/jobs.');
    await h.app.close();
  });

  it('echoes a safe X-Request-Id and replaces unsafe ones', async () => {
    const h = await buildTestApp();
    const safe = await h.inject({
      url: '/health/live',
      headers: { 'x-request-id': 'trace-abc' },
    });
    expect(safe.headers['x-request-id']).toBe('trace-abc');
    const unsafe = await h.inject({
      url: '/health/live',
      headers: { 'x-request-id': 'bad id' },
    });
    expect(unsafe.headers['x-request-id']).not.toBe('bad id');
    await h.app.close();
  });

  it('applies CORS only for configured origins', async () => {
    const h = await buildTestApp({ corsAllowedOrigins: ['https://app.example.com'] });
    const allowed = await h.inject({
      url: '/v1/jobs',
      headers: { origin: 'https://app.example.com' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');
    const denied = await h.inject({
      url: '/v1/jobs',
      headers: { origin: 'https://evil.example' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    await h.app.close();

    const sameOrigin = await buildTestApp();
    const none = await sameOrigin.inject({
      url: '/v1/jobs',
      headers: { origin: 'https://app.example.com' },
    });
    expect(none.headers['access-control-allow-origin']).toBeUndefined();
    await sameOrigin.app.close();
  });
});
