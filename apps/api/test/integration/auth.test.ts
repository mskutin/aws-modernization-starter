/**
 * Authentication, authorization, scoped idempotency and rate limiting over REAL HTTP:
 * a listening Fastify server, PostgreSQL 17 and DynamoDB Local, the LOCAL workflow simulator,
 * and issuer keys fetched over HTTP from the TEST-ONLY in-process issuer (discovery + JWKS).
 *
 * Every negative test asserts the rejection AND that nothing was stored or disclosed: a
 * successful unauthorized request fails the test (sprint brief: prove the rejection).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  JobListSchema,
  JobSchema,
  ProblemSchema,
  ProblemType,
  type Problem,
} from '@starter/contracts';
import { createLogger } from '@starter/observability';
import {
  INSUFFICIENT_SCOPE,
  NEGATIVE_TOKEN_CASES,
  OTHER_CLIENT,
  aCreateJobRequestInput,
  bearer,
  type NegativeTokenCase,
} from '@starter/testing';
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

interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  body: unknown;
}

async function call(
  base: string,
  method: string,
  path: string,
  opts: {
    token?: string;
    authorization?: string;
    headers?: Record<string, string>;
    json?: unknown;
  } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  else if (opts.token) headers.authorization = bearer(opts.token);
  let body: string | undefined;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['content-type'] ??= 'application/json';
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, headers: response.headers, text, body: parsed };
}

function problem(r: HttpResult, status: number, type: string): Problem {
  expect(r.status, r.text).toBe(status);
  expect(r.headers.get('content-type')).toMatch(/^application\/problem\+json/);
  const p = ProblemSchema.parse(r.body);
  expect(p.type).toBe(type);
  return p;
}

const stripVolatile = (p: Problem) => ({ ...p, requestId: '', instance: '' });

describe('auth over HTTP (PostgreSQL + DynamoDB Local + JWKS over HTTP)', () => {
  let db: Awaited<ReturnType<typeof migratedDatabase>>;
  let table: Awaited<ReturnType<typeof jobStateTable>>;
  let identity: IntegrationAuth;
  let processor: Awaited<ReturnType<typeof processorPool>>;
  let simulator: LocalWorkflowSimulator;
  let app: App;
  let base: string;
  let jwksClock = Date.parse('2026-10-14T00:00:00.000Z');
  const lines: Record<string, unknown>[] = [];
  const tokens = new Map<string, string>();

  const tokenFor = async (sub: string) => {
    let token = tokens.get(sub);
    if (!token) {
      token = await identity.issuer.mint({ sub });
      tokens.set(sub, token);
    }
    return token;
  };
  const countJobs = async () =>
    Number((await db.pool.query('SELECT count(*)::int AS n FROM jobs')).rows[0]?.n);
  const submit = async (sub: string, body: unknown, headers: Record<string, string> = {}) =>
    call(base, 'POST', '/v1/jobs', { token: await tokenFor(sub), json: body, headers });

  beforeAll(async () => {
    [db, table, identity] = await Promise.all([
      migratedDatabase(),
      jobStateTable(),
      integrationAuth({ jwks: { now: () => jwksClock, cooldownMs: 30_000 } }),
    ]);
    const logger = createLogger({
      service: 'api-it',
      level: 'info',
      destination: new Writable({
        write(chunk: Buffer, _enc, cb) {
          for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
            lines.push(JSON.parse(line) as Record<string, unknown>);
          }
          cb();
        },
      }),
    });
    const jobs = new PgJobRepository(db.pool);
    processor = await processorPool(db);
    simulator = new LocalWorkflowSimulator({
      store: table.store,
      // Documents are loaded as the processor identity, never through the API pool.
      documents: new PgDocumentSource(processor.pool),
      logger: silentLogger(),
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
    await app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await simulator?.drain(5_000);
    await processor?.drop();
    await Promise.all([db?.drop(), table?.drop(), identity?.close()]);
  });

  describe('401 for missing, malformed and invalid tokens (nothing stored)', () => {
    it.each([
      ['POST /v1/jobs', 'POST', '/v1/jobs'],
      ['GET /v1/jobs', 'GET', '/v1/jobs'],
      ['GET /v1/jobs/{id}', 'GET', `/v1/jobs/${randomUUID()}`],
      ['unknown /v1 route', 'GET', '/v1/admin'],
    ])('missing token: %s → 401', async (_n, method, path) => {
      const before = await countJobs();
      const r = await call(
        base,
        method,
        path,
        method === 'POST' ? { json: aCreateJobRequestInput() } : {},
      );
      problem(r, 401, ProblemType.Unauthorized);
      expect(r.headers.get('www-authenticate')).toBe('Bearer realm="starter-api"');
      expect(await countJobs()).toBe(before);
    });

    it('an anonymous 512 KiB POST is answered 401 before the body is parsed', async () => {
      const r = await call(base, 'POST', '/v1/jobs', {
        json: { title: 'big', content: 'x'.repeat(512 * 1024) },
      });
      problem(r, 401, ProblemType.Unauthorized);
    });

    it.each(Object.keys(NEGATIVE_TOKEN_CASES) as NegativeTokenCase[])(
      '%s token → 401 with the same body as every other failure',
      async (name) => {
        const before = await countJobs();
        const token = await identity.issuer.mintWith(NEGATIVE_TOKEN_CASES[name]);
        const created = await call(base, 'POST', '/v1/jobs', {
          token,
          json: aCreateJobRequestInput(),
        });
        const listed = await call(base, 'GET', '/v1/jobs', { token });
        const a = problem(created, 401, ProblemType.Unauthorized);
        const b = problem(listed, 401, ProblemType.Unauthorized);
        expect(created.headers.get('www-authenticate')).toBe(
          'Bearer realm="starter-api", error="invalid_token"',
        );
        expect(stripVolatile(a)).toEqual(stripVolatile(b));
        expect(created.text).not.toMatch(/expired|signature|audience|issuer|kid|alg/i);
        expect(await countJobs()).toBe(before);
      },
    );

    it.each([
      ['Basic credentials', 'Basic YWxpY2U6c2VjcmV0'],
      ['an empty bearer', 'Bearer '],
      ['a non-JWT bearer', 'Bearer abc.def'],
      ['two tokens', 'Bearer a.b.c d.e.f'],
    ])('malformed header (%s) → 401', async (_n, authorization) => {
      problem(
        await call(base, 'GET', '/v1/jobs', { authorization }),
        401,
        ProblemType.Unauthorized,
      );
    });

    it('never fetches a jku/x5u URL a token names', async () => {
      let attackerHits = 0;
      const attacker: Server = createServer((_req, res) => {
        attackerHits += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [] }));
      });
      await new Promise<void>((resolve) => attacker.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(attacker.address() as AddressInfo).port}/jwks.json`;
      try {
        for (const header of [{ jku: url }, { x5u: url }]) {
          const token = await identity.issuer.mintWith({ foreignKey: true, header });
          problem(await call(base, 'GET', '/v1/jobs', { token }), 401, ProblemType.Unauthorized);
        }
        expect(attackerHits).toBe(0);
      } finally {
        await new Promise<void>((resolve) => attacker.close(() => resolve()));
      }
    });
  });

  it('a valid token without the scope → 403 (insufficient_scope), nothing stored', async () => {
    const before = await countJobs();
    const token = await identity.issuer.mintWith(INSUFFICIENT_SCOPE);
    const r = await call(base, 'POST', '/v1/jobs', { token, json: aCreateJobRequestInput() });
    problem(r, 403, ProblemType.Forbidden);
    expect(r.headers.get('www-authenticate')).toBe(
      'Bearer realm="starter-api", error="insufficient_scope", scope="jobs:write"',
    );
    expect(await countJobs()).toBe(before);
  });

  describe('ownership (another principal cannot reach a job by its id)', () => {
    it("create, get, list and the result of alice's job are invisible to bob", async () => {
      const created = await submit('it-alice', aCreateJobRequestInput({ title: 'Alice report' }));
      expect(created.status).toBe(202);
      const { jobId } = JobSchema.parse(created.body);
      await simulator.waitFor(jobId);

      const own = await call(base, 'GET', `/v1/jobs/${jobId}`, {
        token: await tokenFor('it-alice'),
      });
      const job = JobSchema.parse(own.body);
      expect(job.status).toBe('SUCCEEDED');
      expect(job.result?.topTerms.length).toBeGreaterThan(0);

      const foreign = await call(base, 'GET', `/v1/jobs/${jobId}`, {
        token: await tokenFor('it-bob'),
      });
      const missing = await call(base, 'GET', `/v1/jobs/${randomUUID()}`, {
        token: await tokenFor('it-bob'),
      });
      const a = problem(foreign, 404, ProblemType.NotFound);
      const b = problem(missing, 404, ProblemType.NotFound);
      expect({ ...stripVolatile(a), detail: '' }).toEqual({ ...stripVolatile(b), detail: '' });
      expect(foreign.text).not.toContain('Alice report');
      expect(foreign.text).not.toContain('topTerms');

      const bobList = JobListSchema.parse(
        (await call(base, 'GET', '/v1/jobs?limit=100', { token: await tokenFor('it-bob') })).body,
      );
      expect(bobList.items.map((i) => i.jobId)).not.toContain(jobId);
      const aliceList = JobListSchema.parse(
        (await call(base, 'GET', '/v1/jobs?limit=100', { token: await tokenFor('it-alice') })).body,
      );
      expect(aliceList.items.map((i) => i.jobId)).toContain(jobId);

      // The row is owned by the issuer-bound principal.
      const row = await db.pool.query(
        'SELECT owner_issuer, owner_subject FROM jobs WHERE id = $1',
        [jobId],
      );
      expect(row.rows[0]).toEqual({
        owner_issuer: identity.issuer.issuer,
        owner_subject: 'it-alice',
      });
    });

    it('tokens of any other issuer are rejected outright (one trusted issuer)', async () => {
      // The issuer-bound owner predicate itself is proven in job-owner.test.ts.
      const token = await identity.issuer.mintWith({ issuer: 'https://idp.other.example' });
      problem(await call(base, 'GET', '/v1/jobs', { token }), 401, ProblemType.Unauthorized);
    });

    it("bob's cursor pages never reach alice's jobs", async () => {
      for (let i = 0; i < 3; i += 1) {
        await submit('it-cursor-alice', aCreateJobRequestInput({ title: `Cursor ${i}` }));
      }
      const page = JobListSchema.parse(
        (await call(base, 'GET', '/v1/jobs?limit=1', { token: await tokenFor('it-cursor-alice') }))
          .body,
      );
      expect(page.nextCursor).toBeTruthy();
      const replayed = JobListSchema.parse(
        (
          await call(
            base,
            'GET',
            `/v1/jobs?limit=10&cursor=${encodeURIComponent(page.nextCursor ?? '')}`,
            {
              token: await tokenFor('it-cursor-bob'),
            },
          )
        ).body,
      );
      expect(replayed.items).toEqual([]);
    });
  });

  describe('idempotency is scoped to the principal', () => {
    it('the same Idempotency-Key from two principals creates two jobs, never a cross replay', async () => {
      const key = `shared-${randomUUID()}`;
      const body = aCreateJobRequestInput({ title: `Shared key ${key}` });
      const a = await submit('it-idem-alice', body, { 'idempotency-key': key });
      const b = await submit('it-idem-bob', body, { 'idempotency-key': key });
      expect(a.status).toBe(202);
      expect(b.status).toBe(202);
      expect(b.headers.get('idempotent-replayed')).toBeNull();
      const jobA = JobSchema.parse(a.body).jobId;
      const jobB = JobSchema.parse(b.body).jobId;
      expect(jobB).not.toBe(jobA);

      // Stored with the same fixed prefix in PostgreSQL and DynamoDB, never the raw key.
      const rows = await db.pool.query<{
        id: string;
        owner_subject: string;
        idempotency_key: string;
      }>(
        'SELECT id, owner_subject, idempotency_key FROM jobs WHERE id = ANY($1) ORDER BY owner_subject',
        [[jobA, jobB]],
      );
      expect(rows.rows.map((r) => r.owner_subject)).toEqual(['it-idem-alice', 'it-idem-bob']);
      for (const row of rows.rows) {
        expect(row.idempotency_key).toMatch(new RegExp(`^p:[a-f0-9]{64}:h:${key}$`));
        const claim = await table.store.getIdempotency(row.idempotency_key, new Date());
        expect(claim?.jobId).toBe(row.id);
      }
      expect(rows.rows[0]?.idempotency_key).not.toBe(rows.rows[1]?.idempotency_key);
      expect(await table.store.getIdempotency(key, new Date())).toBeNull();

      // Replays stay within one principal.
      const again = await submit('it-idem-alice', body, { 'idempotency-key': key });
      expect(again.status).toBe(200);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(JobSchema.parse(again.body).jobId).toBe(jobA);
    });

    it('an identical body without a header from two principals creates two jobs', async () => {
      const body = aCreateJobRequestInput({ title: `Derived ${randomUUID()}` });
      const a = await submit('it-derived-alice', body);
      const b = await submit('it-derived-bob', body);
      expect([a.status, b.status]).toEqual([202, 202]);
      expect(b.headers.get('idempotent-replayed')).toBeNull();
      expect(JobSchema.parse(b.body).jobId).not.toBe(JobSchema.parse(a.body).jobId);
    });

    it('reusing a key with another body is still 422 within one principal', async () => {
      const key = `mine-${randomUUID()}`;
      await submit('it-422', aCreateJobRequestInput({ title: 'First' }), {
        'idempotency-key': key,
      });
      const r = await submit('it-422', aCreateJobRequestInput({ title: 'Second' }), {
        'idempotency-key': key,
      });
      problem(r, 422, ProblemType.IdempotencyMismatch);
    });
  });

  it('writes one audit event per request with the principal pseudonym and job ids', async () => {
    const created = await submit('it-audit', aCreateJobRequestInput({ title: 'Audited title' }));
    const jobId = JobSchema.parse(created.body).jobId;
    const requestId = created.headers.get('x-request-id');
    const events = lines.filter(
      (l) => l.msg === 'audit' && (l.audit as { requestId?: string }).requestId === requestId,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.audit).toMatchObject({
      event: 'job.create',
      status: 202,
      jobIds: [jobId],
      principal: expect.stringMatching(/^[a-f0-9]{16}$/),
    });
    expect(JSON.stringify(lines)).not.toContain('Audited title');
    expect(JSON.stringify(lines)).not.toContain(await tokenFor('it-audit'));
  });

  describe('issuer keys (JWKS over HTTP)', () => {
    it('a flood of unknown kids causes at most one JWKS refetch per cooldown', async () => {
      await call(base, 'GET', '/v1/jobs', { token: await tokenFor('it-flood') }); // keys loaded
      jwksClock += 31_000; // past the cooldown of every earlier fetch
      identity.issuer.resetStats();
      const results = await Promise.all(
        Array.from({ length: 100 }, async (_, i) =>
          call(base, 'GET', '/v1/jobs', {
            token: await identity.issuer.mintWith({ kid: `random-kid-${i}` }),
          }),
        ),
      );
      expect(results.every((r) => r.status === 401)).toBe(true);
      expect(identity.issuer.stats.jwksRequests).toBeLessThanOrEqual(1);
      // ...and none at all while still cooling down.
      identity.issuer.resetStats();
      await call(base, 'GET', '/v1/jobs', {
        token: await identity.issuer.mintWith({ kid: 'one-more' }),
      });
      expect(identity.issuer.stats.jwksRequests).toBe(0);
    });

    it('rotation: the new key is accepted after the refetch, the removed key is rejected', async () => {
      const oldToken = await identity.issuer.mint({ sub: 'it-rotation' });
      expect((await call(base, 'GET', '/v1/jobs', { token: oldToken })).status).toBe(200);
      await identity.issuer.rotate(); // old key unpublished
      jwksClock += 31_000;
      const newToken = await identity.issuer.mint({ sub: 'it-rotation' });
      expect((await call(base, 'GET', '/v1/jobs', { token: newToken })).status).toBe(200);
      problem(
        await call(base, 'GET', '/v1/jobs', { token: oldToken }),
        401,
        ProblemType.Unauthorized,
      );
      tokens.clear(); // cached tokens were signed by the removed key
    });

    it('an IdP outage keeps cached keys working; without cached keys the answer is 503', async () => {
      const token = await tokenFor('it-outage');
      identity.issuer.setOutage('error');
      try {
        expect((await call(base, 'GET', '/v1/jobs', { token })).status).toBe(200);
        // A second API instance that never loaded the keys cannot verify anything: 503, not 401.
        const fresh = await integrationAuth();
        fresh.issuer.setOutage('error');
        const cold = await buildApp({
          logger: silentLogger(),
          jobs: new PgJobRepository(db.pool),
          state: table.store,
          workflow: simulator,
          lifecycle: createLifecycle(),
          auth: fresh.auth,
          corsAllowedOrigins: [],
          healthChecks: [],
        });
        try {
          await cold.listen({ host: '127.0.0.1', port: 0 });
          const coldBase = `http://127.0.0.1:${(cold.server.address() as AddressInfo).port}`;
          const r = await call(coldBase, 'GET', '/v1/jobs', {
            token: await fresh.issuer.mint({ sub: 'it-outage' }),
          });
          problem(r, 503, ProblemType.ServiceUnavailable);
          expect(r.headers.get('retry-after')).toBe('1');
          expect((await call(coldBase, 'GET', '/health/live')).status).toBe(200);
          expect((await call(coldBase, 'GET', '/health/ready')).status).toBe(200);
        } finally {
          await cold.close();
          await fresh.close();
        }
      } finally {
        identity.issuer.setOutage('none');
      }
    });
  });

  describe('client allow-list (AUTH_ALLOWED_CLIENT_IDS)', () => {
    it('rejects an SPA ID token and a token issued to another client', async () => {
      const restricted = await integrationAuth({ allowedClientIds: ['starter-web-local'] });
      const api = await buildApp({
        logger: silentLogger(),
        jobs: new PgJobRepository(db.pool),
        state: table.store,
        workflow: simulator,
        lifecycle: createLifecycle(),
        auth: restricted.auth,
        corsAllowedOrigins: [],
        healthChecks: [],
      });
      try {
        await api.listen({ host: '127.0.0.1', port: 0 });
        const url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
        const ok = await call(url, 'GET', '/v1/jobs', { token: await restricted.issuer.mint() });
        expect(ok.status).toBe(200);
        for (const opts of [OTHER_CLIENT, NEGATIVE_TOKEN_CASES.idToken]) {
          const token = await restricted.issuer.mintWith(opts);
          problem(await call(url, 'GET', '/v1/jobs', { token }), 401, ProblemType.Unauthorized);
        }
      } finally {
        await api.close();
        await restricted.close();
      }
    });
  });

  describe('rate limiting (direct path, TRUST_PROXY_HOPS=0)', () => {
    let limited: App;
    let url: string;
    let limits: IntegrationAuth;

    beforeAll(async () => {
      limits = await integrationAuth({
        rateLimit: { readMax: 5, writeMax: 2, unauthenticatedMax: 3 },
      });
      limited = await buildApp({
        logger: silentLogger(),
        jobs: new PgJobRepository(db.pool),
        state: table.store,
        workflow: simulator,
        lifecycle: createLifecycle(),
        auth: limits.auth,
        corsAllowedOrigins: [],
        healthChecks: [],
      });
      await limited.listen({ host: '127.0.0.1', port: 0 });
      url = `http://127.0.0.1:${(limited.server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await limited?.close();
      await limits?.close();
    });

    it('request N+1 of a principal is 429 with Retry-After; another principal is unaffected', async () => {
      const token = await limits.issuer.mint({ sub: `rl-${randomUUID()}` });
      for (let i = 0; i < 5; i += 1) {
        expect((await call(url, 'GET', '/v1/jobs', { token })).status).toBe(200);
      }
      const r = await call(url, 'GET', '/v1/jobs', { token });
      problem(r, 429, ProblemType.TooManyRequests);
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(r.headers.get('ratelimit-limit')).toBe('5');
      expect(r.headers.get('ratelimit-remaining')).toBe('0');
      const other = await limits.issuer.mint({ sub: `rl-other-${randomUUID()}` });
      expect((await call(url, 'GET', '/v1/jobs', { token: other })).status).toBe(200);
    });

    it('a submission flood stops at the write limit before anything is stored', async () => {
      const sub = `rl-writer-${randomUUID()}`;
      const token = await limits.issuer.mint({ sub });
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        statuses.push(
          (
            await call(url, 'POST', '/v1/jobs', {
              token,
              json: aCreateJobRequestInput({ title: `Flood ${sub} ${i}` }),
            })
          ).status,
        );
      }
      expect(statuses).toEqual([202, 202, 429, 429]);
      const stored = await db.pool.query(
        'SELECT count(*)::int AS n FROM jobs WHERE owner_subject = $1',
        [sub],
      );
      expect(stored.rows[0]?.n).toBe(2);
    });

    it('failed authentication is limited per client; rotating X-Forwarded-For does not help', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        statuses.push(
          (
            await call(url, 'GET', '/v1/jobs', {
              headers: { 'x-forwarded-for': `198.51.100.${i}` },
            })
          ).status,
        );
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429, 429]);
      // A valid token from the same address still works (no lock-out of shared egress IPs).
      const token = await limits.issuer.mint({ sub: `rl-shared-${randomUUID()}` });
      expect((await call(url, 'GET', '/v1/jobs', { token })).status).toBe(200);
    });
  });
});
