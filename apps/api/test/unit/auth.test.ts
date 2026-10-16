/**
 * Authentication, authorization and rate limiting at the HTTP layer (fastify.inject, static
 * keys, in-memory stores). Every negative test asserts the REJECTION and that nothing was read
 * or written; a successful unauthorized request fails the test. The same controls are proven
 * over real HTTP, real stores and a remote JWKS in test/integration/auth.test.ts.
 */
import {
  JobListSchema,
  JobSchema,
  ProblemSchema,
  ProblemType,
  type Problem,
} from '@starter/contracts';
import {
  INSUFFICIENT_SCOPE,
  NEGATIVE_TOKEN_CASES,
  aCreateJobRequestInput,
  bearer,
  type NegativeTokenCase,
} from '@starter/testing';
import { once } from 'node:events';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthUnavailableError, StaticKeySource } from '../../src/auth/key-source.js';
import { requirePrincipal } from '../../src/auth/hooks.js';
import { GENEROUS_LIMITS, GatedWorkflow, buildTestApp, testAuth, unitIssuer } from './fakes.js';

type Harness = Awaited<ReturnType<typeof buildTestApp>>;
type Response = Awaited<ReturnType<Harness['inject']>>;

const JOB_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const body = (title = 'Migration notes') => JSON.stringify(aCreateJobRequestInput({ title }));
const post = (h: Harness, opts: { as?: string | null; headers?: Record<string, string> } = {}) =>
  h.inject({
    method: 'POST',
    url: '/v1/jobs',
    payload: body(),
    ...opts,
    headers: { 'content-type': 'application/json', ...opts.headers },
  });

function problemOf(response: Response, status: number, type: string): Problem {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  const problem = ProblemSchema.parse(response.json());
  expect(problem).toMatchObject({ status, type });
  return problem;
}

/** The 401 body is identical for every failure (no hint which check failed). */
function expectUnauthorized(response: Response, tokenPresented: boolean): Problem {
  const problem = problemOf(response, 401, ProblemType.Unauthorized);
  expect(problem.detail).toBe('A valid bearer access token is required.');
  expect(response.headers['www-authenticate']).toBe(
    tokenPresented
      ? 'Bearer realm="starter-api", error="invalid_token"'
      : 'Bearer realm="starter-api"',
  );
  return problem;
}

describe('authentication on /v1', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildTestApp();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it.each([
    ['POST /v1/jobs', 'POST', '/v1/jobs'],
    ['GET /v1/jobs', 'GET', '/v1/jobs'],
    ['GET /v1/jobs/{id}', 'GET', `/v1/jobs/${JOB_ID}`],
    ['HEAD /v1/jobs', 'HEAD', '/v1/jobs'],
    ['an unknown /v1 route', 'GET', '/v1/nope'],
    ['an unsupported method', 'DELETE', `/v1/jobs/${JOB_ID}`],
  ] as const)('%s without a token → 401, nothing read or written', async (_n, method, url) => {
    const response = await h.inject({
      method,
      url,
      as: null,
      ...(method === 'POST'
        ? { payload: body(), headers: { 'content-type': 'application/json' } }
        : {}),
    });
    if (method === 'HEAD') {
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer realm="starter-api"');
    } else {
      expectUnauthorized(response, false);
    }
    expect(h.jobs.records.size).toBe(0);
    expect(h.workflow.started).toHaveLength(0);
  });

  it('authenticates BEFORE reading the body: anonymous oversized or invalid bodies get 401', async () => {
    const oversized = await h.inject({
      method: 'POST',
      url: '/v1/jobs',
      as: null,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 't', content: 'x'.repeat(600 * 1024) }),
    });
    expectUnauthorized(oversized, false);
    const invalidJson = await h.inject({
      method: 'POST',
      url: '/v1/jobs',
      as: null,
      headers: { 'content-type': 'application/json' },
      payload: '{"title": ',
    });
    expectUnauthorized(invalidJson, false);
    const wrongType = await h.inject({
      method: 'POST',
      url: '/v1/jobs',
      as: null,
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expectUnauthorized(wrongType, false);
    // With a token the same requests reach the parser (413/400/415).
    expect(
      (
        await h.inject({
          method: 'POST',
          url: '/v1/jobs',
          headers: { 'content-type': 'text/plain' },
          payload: 'x',
        })
      ).statusCode,
    ).toBe(415);
  });

  it('authenticated callers get 404 for unknown /v1 routes (only after authentication)', async () => {
    problemOf(await h.inject({ url: '/v1/nope' }), 404, ProblemType.NotFound);
  });

  it.each([
    ['Basic credentials', 'Basic YWxpY2U6c2VjcmV0', false],
    ['a bare scheme', 'Bearer', true],
    ['an empty token', 'Bearer   ', true],
    ['two tokens', 'Bearer a.b.c d.e.f', true],
    ['not a JWS', 'Bearer not-a-jwt', true],
    ['four segments', 'Bearer a.b.c.d', true],
    ['an oversized token', `Bearer ${'a'.repeat(9_000)}.b.c`, true],
  ])('rejects %s with 401', async (_n, authorization, presented) => {
    expectUnauthorized(await post(h, { as: null, headers: { authorization } }), presented);
    expect(h.jobs.records.size).toBe(0);
  });

  it.each(Object.keys(NEGATIVE_TOKEN_CASES) as NegativeTokenCase[])(
    'rejects the %s token with an identical 401 (POST and GET)',
    async (name) => {
      const token = await h.mint(NEGATIVE_TOKEN_CASES[name]);
      const authorization = bearer(token);
      const created = await post(h, { as: null, headers: { authorization } });
      const a = expectUnauthorized(created, true);
      const listed = await h.inject({ url: '/v1/jobs', as: null, headers: { authorization } });
      const b = expectUnauthorized(listed, true);
      expect({ ...a, requestId: '', instance: '' }).toEqual({ ...b, requestId: '', instance: '' });
      expect(h.jobs.records.size).toBe(0);
      expect(h.workflow.started).toHaveLength(0);
    },
  );

  it('logs the failure reason, never the token', async () => {
    const token = await h.mint(NEGATIVE_TOKEN_CASES.expired);
    await post(h, { as: null, headers: { authorization: bearer(token) } });
    expect(h.lines.find((l) => l.msg === 'audit')).toMatchObject({
      audit: { event: 'auth.denied', outcome: 'denied', status: 401, reason: 'expired' },
    });
    const logged = JSON.stringify(h.lines);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(token.split('.')[1]);
  });

  it('accepts a valid token and logs only the pseudonymous principal', async () => {
    const response = await post(h);
    expect(response.statusCode).toBe(202);
    const accepted = h.lines.find((l) => l.msg === 'job accepted; workflow started');
    expect(accepted?.principal).toMatch(/^[a-f0-9]{16}$/);
    const logged = JSON.stringify(h.lines);
    expect(logged).not.toContain(await h.tokenFor('alice'));
    expect(logged).not.toContain('"alice"');
  });

  it('answers 503 (not 401) while the issuer keys cannot be obtained', async () => {
    const unavailable = await buildTestApp({
      auth: testAuth({
        current: async () => {
          throw new AuthUnavailableError('IdP down');
        },
        refreshForUnknownKey: async () => null,
      }),
    });
    try {
      const response = await unavailable.inject({ url: '/v1/jobs' });
      problemOf(response, 503, ProblemType.ServiceUnavailable);
      expect(response.headers['retry-after']).toBe('1');
      // Liveness and readiness do not depend on the IdP.
      expect((await unavailable.app.inject({ url: '/health/live' })).statusCode).toBe(200);
      expect((await unavailable.app.inject({ url: '/health/ready' })).statusCode).toBe(200);
    } finally {
      await unavailable.app.close();
    }
  });

  it('keeps /health/* and /openapi.json public', async () => {
    for (const url of ['/health/live', '/health/ready', '/openapi.json']) {
      expect((await h.app.inject({ url })).statusCode, url).toBe(200);
    }
  });

  it('fails closed if a /v1 handler ever runs without a principal', () => {
    expect(() => requirePrincipal({ principal: null } as never)).toThrowError(
      expect.objectContaining({ status: 401 }),
    );
  });
});

describe('scopes (403)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildTestApp();
  });
  afterEach(async () => {
    await h.app.close();
  });

  const withToken = async (scope: string | null) => ({
    authorization: bearer(await h.mint({ scope })),
  });

  it('a valid token without any API scope → 403 with an insufficient_scope challenge', async () => {
    const headers = { authorization: bearer(await h.mint(INSUFFICIENT_SCOPE)) };
    const created = await post(h, { as: null, headers });
    problemOf(created, 403, ProblemType.Forbidden);
    expect(created.headers['www-authenticate']).toBe(
      'Bearer realm="starter-api", error="insufficient_scope", scope="jobs:write"',
    );
    const listed = await h.inject({ url: '/v1/jobs', as: null, headers });
    problemOf(listed, 403, ProblemType.Forbidden);
    expect(listed.headers['www-authenticate']).toContain('scope="jobs:read"');
    expect(h.jobs.records.size).toBe(0);
  });

  it('jobs:read can read but not create', async () => {
    const headers = await withToken('jobs:read');
    problemOf(await post(h, { as: null, headers }), 403, ProblemType.Forbidden);
    expect(h.jobs.records.size).toBe(0);
    expect((await h.inject({ url: '/v1/jobs', as: null, headers })).statusCode).toBe(200);
  });

  it('jobs:write can create but not read', async () => {
    const headers = await withToken('jobs:write');
    expect((await post(h, { as: null, headers })).statusCode).toBe(202);
    problemOf(await h.inject({ url: '/v1/jobs', as: null, headers }), 403, ProblemType.Forbidden);
  });

  it('a token without a scope claim is not authorized', async () => {
    const headers = await withToken(null);
    problemOf(await h.inject({ url: '/v1/jobs', as: null, headers }), 403, ProblemType.Forbidden);
  });

  it('accepts scopes from an `scp` array claim as well', async () => {
    const token = await h.mint({ scope: null }, { scp: ['jobs:read', 'jobs:write'] });
    const headers = { authorization: bearer(token) };
    expect((await h.inject({ url: '/v1/jobs', as: null, headers })).statusCode).toBe(200);
  });
});

describe('ownership (no cross-principal access)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildTestApp();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("another principal's job is indistinguishable from a missing one (404, same body)", async () => {
    const created = JobSchema.parse((await post(h, { as: 'alice' })).json());
    const foreign = await h.inject({ url: `/v1/jobs/${created.jobId}`, as: 'bob' });
    const missing = await h.inject({ url: `/v1/jobs/${JOB_ID}`, as: 'bob' });
    const a = problemOf(foreign, 404, ProblemType.NotFound);
    const b = problemOf(missing, 404, ProblemType.NotFound);
    expect(a.detail).toBe(`Job ${created.jobId} does not exist.`);
    expect({ ...a, detail: '', instance: '', requestId: '' }).toEqual({
      ...b,
      detail: '',
      instance: '',
      requestId: '',
    });
    expect(foreign.body).not.toContain('Migration notes');
    // The owner still sees it.
    expect((await h.inject({ url: `/v1/jobs/${created.jobId}`, as: 'alice' })).statusCode).toBe(
      200,
    );
  });

  it('lists only the caller’s jobs', async () => {
    await post(h, { as: 'alice' });
    await h.inject({
      method: 'POST',
      url: '/v1/jobs',
      as: 'bob',
      headers: { 'content-type': 'application/json' },
      payload: body('Bob only'),
    });
    const alice = JobListSchema.parse((await h.inject({ url: '/v1/jobs', as: 'alice' })).json());
    const bob = JobListSchema.parse((await h.inject({ url: '/v1/jobs', as: 'bob' })).json());
    const mallory = JobListSchema.parse(
      (await h.inject({ url: '/v1/jobs', as: 'mallory' })).json(),
    );
    expect(alice.items.map((i) => i.title)).toEqual(['Migration notes']);
    expect(bob.items.map((i) => i.title)).toEqual(['Bob only']);
    expect(mallory.items).toEqual([]);
  });

  it('a cursor from another principal never reveals their jobs', async () => {
    for (let i = 0; i < 3; i += 1) {
      await h.inject({
        method: 'POST',
        url: '/v1/jobs',
        as: 'alice',
        headers: { 'content-type': 'application/json' },
        payload: body(`Alice ${i}`),
      });
    }
    const page = JobListSchema.parse(
      (await h.inject({ url: '/v1/jobs?limit=1', as: 'alice' })).json(),
    );
    expect(page.nextCursor).toBeTruthy();
    const replayed = JobListSchema.parse(
      (
        await h.inject({ url: `/v1/jobs?limit=5&cursor=${page.nextCursor ?? ''}`, as: 'bob' })
      ).json(),
    );
    expect(replayed.items).toEqual([]);
  });

  it('the same Idempotency-Key from two principals creates two jobs; no cross replay', async () => {
    const send = (as: string) => post(h, { as, headers: { 'idempotency-key': 'shared-key-0001' } });
    const a = await send('alice');
    const b = await send('bob');
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(b.headers['idempotent-replayed']).toBeUndefined();
    expect(b.json<{ jobId: string }>().jobId).not.toBe(a.json<{ jobId: string }>().jobId);
    expect(h.jobs.records.size).toBe(2);
    expect(h.workflow.started).toHaveLength(2);
    // Within one principal the replay still works.
    const again = await send('alice');
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json<{ jobId: string }>().jobId).toBe(a.json<{ jobId: string }>().jobId);
  });

  it('identical bodies without a header from two principals create two jobs', async () => {
    const a = await post(h, { as: 'alice' });
    const b = await post(h, { as: 'bob' });
    expect(b.statusCode).toBe(202);
    expect(b.headers['idempotent-replayed']).toBeUndefined();
    expect(b.json<{ jobId: string }>().jobId).not.toBe(a.json<{ jobId: string }>().jobId);
  });

  it('key reuse with another body is still rejected within one principal (422)', async () => {
    await post(h, { as: 'alice', headers: { 'idempotency-key': 'mine-00000001' } });
    const reuse = await h.inject({
      method: 'POST',
      url: '/v1/jobs',
      as: 'alice',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'mine-00000001' },
      payload: body('Another body'),
    });
    problemOf(reuse, 422, ProblemType.IdempotencyMismatch);
    // ...while bob may use the same key for that other body.
    const bob = await h.inject({
      method: 'POST',
      url: '/v1/jobs',
      as: 'bob',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'mine-00000001' },
      payload: body('Another body'),
    });
    expect(bob.statusCode).toBe(202);
  });
});

describe('rate limiting', () => {
  let now = Date.parse('2026-10-14T00:00:10.000Z');
  const clock = () => now;

  async function limitedApp(limits: Partial<typeof GENEROUS_LIMITS>, trustProxyHops = 0) {
    const issuer = await unitIssuer();
    return buildTestApp({
      trustProxyHops,
      auth: testAuth(new StaticKeySource(issuer.jwks()), {
        rateLimit: { ...GENEROUS_LIMITS, ...limits },
        now: clock,
      }),
    });
  }

  beforeEach(() => {
    now = Date.parse('2026-10-14T00:00:10.000Z');
  });

  it('the N+1th read of a principal is 429 with Retry-After; other principals are unaffected', async () => {
    const h = await limitedApp({ readMax: 3 });
    try {
      for (let i = 1; i <= 3; i += 1) {
        const ok = await h.inject({ url: '/v1/jobs', as: 'alice' });
        expect(ok.statusCode).toBe(200);
        expect(ok.headers['ratelimit-limit']).toBe('3');
        expect(ok.headers['ratelimit-remaining']).toBe(String(3 - i));
        expect(ok.headers['ratelimit-reset']).toBe('50');
      }
      const limited = await h.inject({ url: '/v1/jobs', as: 'alice' });
      problemOf(limited, 429, ProblemType.TooManyRequests);
      expect(limited.headers['retry-after']).toBe('50');
      expect(limited.headers['ratelimit-remaining']).toBe('0');
      expect((await h.inject({ url: '/v1/jobs', as: 'bob' })).statusCode).toBe(200);
      expect(h.lines.find((l) => l.msg === 'rate limit exceeded')).toMatchObject({
        rateLimit: 'read',
        principal: expect.stringMatching(/^[a-f0-9]{16}$/),
      });

      now += 50_000; // next window
      expect((await h.inject({ url: '/v1/jobs', as: 'alice' })).statusCode).toBe(200);
    } finally {
      await h.app.close();
    }
  });

  it('limits writes separately and stops the flood before anything is stored', async () => {
    const h = await limitedApp({ writeMax: 2 });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const r = await h.inject({
          method: 'POST',
          url: '/v1/jobs',
          as: 'alice',
          headers: { 'content-type': 'application/json' },
          payload: body(`Flood ${i}`),
        });
        statuses.push(r.statusCode);
      }
      expect(statuses).toEqual([202, 202, 429, 429]);
      expect(h.jobs.records.size).toBe(2);
      expect(h.workflow.started).toHaveLength(2);
      // Reads still have their own budget.
      expect((await h.inject({ url: '/v1/jobs', as: 'alice' })).statusCode).toBe(200);
    } finally {
      await h.app.close();
    }
  });

  it('failed authentication is limited per client address; valid tokens from it still work', async () => {
    const h = await limitedApp({ unauthenticatedMax: 2 });
    try {
      const anon = (remoteAddress: string) =>
        h.inject({ url: '/v1/jobs', as: null, remoteAddress });
      expect((await anon('203.0.113.7')).statusCode).toBe(401);
      expect((await anon('203.0.113.7')).statusCode).toBe(401);
      const limited = await anon('203.0.113.7');
      problemOf(limited, 429, ProblemType.TooManyRequests);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // Another address has its own budget; a valid token from the same address is not blocked.
      expect((await anon('198.51.100.1')).statusCode).toBe(401);
      expect(
        (await h.inject({ url: '/v1/jobs', as: 'alice', remoteAddress: '203.0.113.7' })).statusCode,
      ).toBe(200);
    } finally {
      await h.app.close();
    }
  });

  it('ignores a spoofed X-Forwarded-For unless proxies are trusted (TRUST_PROXY_HOPS=0)', async () => {
    const h = await limitedApp({ unauthenticatedMax: 1 });
    try {
      const statuses = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await h.inject({
          url: '/v1/jobs',
          as: null,
          remoteAddress: '203.0.113.7',
          headers: { 'x-forwarded-for': `10.0.0.${i}` },
        });
        statuses.push(r.statusCode);
      }
      expect(statuses).toEqual([401, 429, 429]);
    } finally {
      await h.app.close();
    }
  });

  it('with TRUST_PROXY_HOPS=1 the proxy-appended address counts, not client-supplied ones', async () => {
    const h = await limitedApp({ unauthenticatedMax: 1 }, 1);
    try {
      const viaProxy = (spoofed: string, client: string) =>
        h.inject({
          url: '/v1/jobs',
          as: null,
          remoteAddress: '10.89.0.5', // the proxy
          headers: { 'x-forwarded-for': `${spoofed}, ${client}` },
        });
      expect((await viaProxy('1.1.1.1', '203.0.113.7')).statusCode).toBe(401);
      // Rotating the spoofed part does not create a new budget...
      expect((await viaProxy('2.2.2.2', '203.0.113.7')).statusCode).toBe(429);
      // ...while a different real client has its own.
      expect((await viaProxy('1.1.1.1', '198.51.100.9')).statusCode).toBe(401);
    } finally {
      await h.app.close();
    }
  });
});

describe('CORS (when configured) works with bearer tokens', () => {
  it('answers the preflight without authentication and allows the Authorization header', async () => {
    const h = await buildTestApp({ corsAllowedOrigins: ['https://app.example.com'] });
    try {
      const preflight = await h.app.inject({
        method: 'OPTIONS',
        url: '/v1/jobs',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      expect(preflight.statusCode).toBe(204);
      expect(String(preflight.headers['access-control-allow-headers'])).toContain('authorization');
      const anonymous = await h.inject({
        url: '/v1/jobs',
        as: null,
        headers: { origin: 'https://app.example.com' },
      });
      expect(anonymous.statusCode).toBe(401);
      expect(String(anonymous.headers['access-control-expose-headers'])).toContain(
        'www-authenticate',
      );
    } finally {
      await h.app.close();
    }
  });
});

describe('audit trail: one event per /v1 request', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildTestApp();
  });
  afterEach(async () => {
    await h.app.close();
  });

  type AuditLine = {
    requestId: string;
    audit: {
      event: string;
      outcome: string;
      status: number;
      principal?: string;
      jobIds?: string[];
      count?: number;
      reason?: string;
      requestId: string;
    };
  };
  const audits = () => h.lines.filter((l) => l.msg === 'audit') as unknown as AuditLine[];
  /** The single audit event of a response (matched by request id). */
  function auditOf(response: Response): AuditLine['audit'] {
    const requestId = String(response.headers['x-request-id']);
    const lines = audits().filter((l) => l.audit.requestId === requestId);
    expect(lines, `audit lines for ${requestId}`).toHaveLength(1);
    expect(lines[0]?.requestId).toBe(requestId);
    return lines[0]!.audit;
  }

  it('job.create records the principal pseudonym and the job id (and a replay)', async () => {
    const created = await post(h, { headers: { 'idempotency-key': 'audit-key-0001' } });
    const jobId = created.json<{ jobId: string }>().jobId;
    const event = auditOf(created);
    expect(event).toEqual({
      event: 'job.create',
      outcome: 'success',
      status: 202,
      principal: expect.stringMatching(/^[a-f0-9]{16}$/),
      jobIds: [jobId],
      requestId: created.headers['x-request-id'],
    });
    const replay = await post(h, { headers: { 'idempotency-key': 'audit-key-0001' } });
    expect(auditOf(replay)).toMatchObject({
      event: 'job.create',
      outcome: 'replayed',
      status: 200,
    });
    const invalid = await h.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ title: '' }),
    });
    expect(auditOf(invalid)).toMatchObject({
      event: 'job.create',
      outcome: 'invalid',
      status: 400,
    });
  });

  it('job.read records found, foreign (404) and missing (404) reads with the requested id', async () => {
    const jobId = (await post(h, { as: 'alice' })).json<{ jobId: string }>().jobId;
    const own = await h.inject({ url: `/v1/jobs/${jobId}`, as: 'alice' });
    const foreign = await h.inject({ url: `/v1/jobs/${jobId}`, as: 'bob' });
    const missing = await h.inject({ url: `/v1/jobs/${JOB_ID}`, as: 'bob' });
    const malformed = await h.inject({ url: '/v1/jobs/not-a-uuid', as: 'bob' });
    expect(auditOf(own)).toMatchObject({ event: 'job.read', outcome: 'success', jobIds: [jobId] });
    const a = auditOf(foreign);
    const b = auditOf(missing);
    expect(a).toMatchObject({
      event: 'job.read',
      outcome: 'not_found',
      status: 404,
      jobIds: [jobId],
    });
    expect(b).toMatchObject({ event: 'job.read', outcome: 'not_found', jobIds: [JOB_ID] });
    expect(a.principal).toBe(b.principal); // bob
    expect(a.principal).not.toBe(auditOf(own).principal); // alice
    // Caller-supplied junk is not echoed into the audit log.
    expect(auditOf(malformed)).toEqual(expect.not.objectContaining({ jobIds: expect.anything() }));
  });

  it('job.list records the ids and number of listed jobs', async () => {
    const jobId = (await post(h)).json<{ jobId: string }>().jobId;
    const listed = await h.inject({ url: '/v1/jobs' });
    expect(auditOf(listed)).toMatchObject({
      event: 'job.list',
      outcome: 'success',
      count: 1,
      jobIds: [jobId],
    });
    const bad = await h.inject({ url: '/v1/jobs?limit=0' });
    expect(auditOf(bad)).toMatchObject({ event: 'job.list', outcome: 'invalid', status: 400 });
  });

  it('auth.denied covers 401 (with the reason), 403 and 429', async () => {
    const anonymous = await h.inject({ url: '/v1/jobs', as: null });
    expect(auditOf(anonymous)).toEqual({
      event: 'auth.denied',
      outcome: 'denied',
      status: 401,
      reason: 'missing_token',
      requestId: anonymous.headers['x-request-id'],
    });
    const forged = await h.inject({
      url: `/v1/jobs/${JOB_ID}`,
      as: null,
      headers: { authorization: bearer(await h.mint(NEGATIVE_TOKEN_CASES.algNone)) },
    });
    expect(auditOf(forged)).toMatchObject({ status: 401, reason: 'alg_not_allowed' });
    const scope = await h.inject({
      url: '/v1/jobs',
      as: null,
      headers: { authorization: bearer(await h.mint(INSUFFICIENT_SCOPE)) },
    });
    expect(auditOf(scope)).toMatchObject({
      event: 'auth.denied',
      status: 403,
      reason: 'insufficient_scope',
      principal: expect.stringMatching(/^[a-f0-9]{16}$/),
    });
  });

  it('auth.denied covers rate limiting and an IdP outage (503)', async () => {
    const issuer = await unitIssuer();
    const limited = await buildTestApp({
      auth: testAuth(new StaticKeySource(issuer.jwks()), {
        rateLimit: { ...GENEROUS_LIMITS, readMax: 1, unauthenticatedMax: 1 },
      }),
    });
    try {
      await limited.inject({ url: '/v1/jobs' });
      const tooMany = await limited.inject({ url: '/v1/jobs' });
      await limited.inject({ url: '/v1/jobs', as: null });
      const anonymousFlood = await limited.inject({ url: '/v1/jobs', as: null });
      const lines = limited.lines.filter((l) => l.msg === 'audit') as unknown as AuditLine[];
      const of = (r: Response) =>
        lines.find((l) => l.audit.requestId === r.headers['x-request-id']);
      expect(of(tooMany)?.audit).toMatchObject({
        event: 'auth.denied',
        status: 429,
        reason: 'rate_limited',
      });
      expect(of(anonymousFlood)?.audit).toMatchObject({
        status: 429,
        reason: 'rate_limited:missing_token',
      });
    } finally {
      await limited.app.close();
    }

    const down = await buildTestApp({
      auth: testAuth({
        current: async () => {
          throw new AuthUnavailableError('IdP down');
        },
        refreshForUnknownKey: async () => null,
      }),
    });
    try {
      const response = await down.inject({ url: '/v1/jobs' });
      const line = down.lines.find((l) => l.msg === 'audit') as unknown as AuditLine;
      expect(line.audit).toMatchObject({
        event: 'auth.denied',
        outcome: 'unavailable',
        status: 503,
        reason: 'keys_unavailable',
      });
      expect(line.audit.requestId).toBe(response.headers['x-request-id']);
    } finally {
      await down.app.close();
    }
  });

  it('request.unrouted for authenticated requests to unknown /v1 routes; nothing for public routes', async () => {
    const unknown = await h.inject({ url: '/v1/nope' });
    expect(auditOf(unknown)).toMatchObject({ event: 'request.unrouted', status: 404 });
    const before = audits().length;
    await h.app.inject({ url: '/health/live' });
    await h.app.inject({ url: '/openapi.json' });
    expect(audits()).toHaveLength(before);
  });

  it('names the job even when a step after the insert fails', async () => {
    h.workflow.failNext(new Error('state machine unavailable'));
    const failed = await post(h);
    expect(failed.statusCode).toBe(500);
    const [stored] = [...h.jobs.records.keys()];
    expect(stored).toBeDefined();
    expect(auditOf(failed)).toMatchObject({
      event: 'job.create',
      outcome: 'error',
      status: 500,
      jobIds: [stored],
    });
  });

  describe('over a real connection', () => {
    /** Sends one POST /v1/jobs over a raw socket; resolves with both ends once it is written. */
    async function submit(g: Harness, extraHeaders: string[] = []) {
      await g.app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = g.app.server.address() as AddressInfo;
      const accepted = once(g.app.server, 'connection') as Promise<[Socket]>;
      const client = connect({ host: '127.0.0.1', port });
      await once(client, 'connect');
      const payload = body();
      client.write(
        [
          'POST /v1/jobs HTTP/1.1',
          'Host: api.test',
          `Authorization: ${bearer(await g.tokenFor('alice'))}`,
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(payload)}`,
          ...extraHeaders,
          '',
          payload,
        ].join('\r\n'),
      );
      const [server] = await accepted;
      return { client, server };
    }
    const auditsOf = (g: Harness) =>
      g.lines.filter((l) => l.msg === 'audit') as unknown as AuditLine[];

    it('writes ONE `aborted` event with the job id when the client disconnects after submitting', async () => {
      const workflow = new GatedWorkflow();
      const g = await buildTestApp({ workflow });
      try {
        const { client, server } = await submit(g);
        await workflow.entered; // the job row exists; the workflow start is still running
        const serverSaw = once(server, 'close');
        client.destroy();
        await serverSaw; // the API has noticed the disconnect
        workflow.release();
        await vi.waitFor(() => expect(auditsOf(g)).toHaveLength(1), { timeout: 2_000 });
        const [jobId] = [...g.jobs.records.keys()];
        expect(workflow.started.map((s) => s.jobId)).toEqual([jobId]); // the job was created
        expect(auditsOf(g)[0]!.audit).toMatchObject({
          event: 'job.create',
          outcome: 'aborted',
          status: 202,
          jobIds: [jobId],
          principal: expect.stringMatching(/^[0-9a-f]{16}$/),
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(auditsOf(g)).toHaveLength(1);
      } finally {
        await g.app.close();
      }
    });

    it('writes ONE ordinary event when the connection closes after the response', async () => {
      const g = await buildTestApp();
      try {
        const { client, server } = await submit(g, ['Connection: close']);
        const chunks: Buffer[] = [];
        client.on('data', (chunk: Buffer) => chunks.push(chunk));
        await Promise.all([once(client, 'end'), server.destroyed ? null : once(server, 'close')]);
        expect(Buffer.concat(chunks).toString('utf8')).toMatch(/^HTTP\/1\.1 202 /);
        await new Promise((resolve) => setImmediate(resolve));
        expect(auditsOf(g).map((l) => l.audit)).toEqual([
          expect.objectContaining({ event: 'job.create', outcome: 'success', status: 202 }),
        ]);
      } finally {
        await g.app.close();
      }
    });
  });

  it('never contains titles, content, tokens or subjects', async () => {
    const token = await h.tokenFor('alice');
    await h.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(aCreateJobRequestInput({ title: 'Secret project Falcon' })),
    });
    await h.inject({ url: '/v1/jobs' });
    const logged = JSON.stringify(audits());
    expect(audits().length).toBe(2);
    for (const forbidden of ['Secret project Falcon', 'Cloud migration', token, '"alice"']) {
      expect(logged).not.toContain(forbidden);
    }
  });
});
