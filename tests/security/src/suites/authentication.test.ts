/**
 * Authentication of every /v1 route, on every target (the API
 * directly and through the proxy). Each negative case must yield 401 — a 2xx (or any other
 * status) fails the test — and each case has a positive control proving the same request
 * succeeds with a valid token.
 */
import { randomUUID } from 'node:crypto';
import { NEGATIVE_TOKEN_CASES, OTHER_CLIENT, type MintOptions } from '@starter/testing/auth';
import { beforeAll, describe, expect, it } from 'vitest';
import { context } from '../context.js';
import { call, describeRes, postDeclaringLength } from '../http.js';
import {
  documentBody,
  expectProblem,
  expectUnauthorized,
  precondition,
  ProblemType,
} from '../support.js';
import { mintToken, principal } from '../tokens.js';

const ctx = context();
const SUITE = 'authn';

/** Every /v1 route plus unknown /v1 paths: anonymous callers learn nothing (no 404/405 oracle). */
const ANONYMOUS_ROUTES: readonly [string, string][] = [
  ['GET', '/v1/jobs'],
  ['GET', '/v1/jobs?limit=1'],
  ['POST', '/v1/jobs'],
  ['GET', `/v1/jobs/${randomUUID()}`],
  ['GET', '/v1/jobs/not-a-uuid'],
  ['DELETE', `/v1/jobs/${randomUUID()}`],
  ['PUT', '/v1/jobs'],
  ['GET', '/v1/no-such-route'],
];

const NEGATIVE_CASES = Object.entries(NEGATIVE_TOKEN_CASES) as [string, MintOptions][];

describe.each(ctx.targets)('authentication — $name: $description', (target) => {
  let valid: string;
  const sub = principal(ctx.runId, SUITE, target.name);

  beforeAll(async () => {
    valid = await mintToken(ctx.tokenEndpoint, { sub });
  });

  it('positive control: a valid access token reads and writes (2xx)', async () => {
    const list = await call(target, 'GET', '/v1/jobs', { token: valid });
    expect(list.status, describeRes(list)).toBe(200);
    const created = await call(target, 'POST', '/v1/jobs', {
      token: valid,
      json: documentBody(`authn positive ${ctx.runId}`),
      headers: { 'idempotency-key': `authn-${randomUUID()}` },
    });
    expect([200, 202], describeRes(created)).toContain(created.status);
  });

  it.each(ANONYMOUS_ROUTES)('%s %s without credentials → 401', async (method, path) => {
    const r = await call(
      target,
      method,
      path,
      method === 'POST' || method === 'PUT' ? { json: {} } : {},
    );
    expectUnauthorized(r, false);
    expect(r.headers.get('www-authenticate')).toBe('Bearer realm="starter-api"');
  });

  it('public endpoints stay public: /health/live, /health/ready, /openapi.json', async () => {
    for (const path of ['/health/live', '/health/ready', '/openapi.json']) {
      const r = await call(target, 'GET', path);
      expect(r.status, `${path}: ${describeRes(r)}`).toBe(200);
    }
  });

  it.each([
    ['empty Bearer', 'Bearer'],
    ['Bearer with spaces only', 'Bearer    '],
    ['Basic credentials', 'Basic dXNlcjpwYXNzd29yZA=='],
    ['two-part token', 'Bearer abc.def'],
    ['garbage token', 'Bearer not-a-jwt-at-all'],
  ])('malformed Authorization header (%s) → 401', async (_name, header) => {
    const r = await call(target, 'GET', '/v1/jobs', { authorization: header });
    expect(r.status, describeRes(r)).toBe(401);
    expectProblem(r, 401, ProblemType.Unauthorized);
  });

  it('a valid token with trailing junk or a second credential → 401', async () => {
    for (const header of [
      `Bearer ${valid} extra`,
      `Bearer ${valid}, Bearer ${valid}`,
      `Token ${valid}`,
      valid,
    ]) {
      const r = await call(target, 'GET', '/v1/jobs', { authorization: header });
      expect(r.status, describeRes(r)).toBe(401);
    }
  });

  it.each(NEGATIVE_CASES)('forged or misused token (%s) → 401', async (_name, options) => {
    const token = await mintToken(ctx.tokenEndpoint, { sub, options });
    for (const [method, path] of [
      ['GET', '/v1/jobs'],
      ['POST', '/v1/jobs'],
    ] as const) {
      const r = await call(target, method, path, {
        token,
        ...(method === 'POST' ? { json: documentBody(`authn negative ${ctx.runId}`) } : {}),
      });
      expectUnauthorized(r, true);
    }
  });

  it(`token age: accepted below AUTH_MAX_TOKEN_AGE_SECONDS (${ctx.maxTokenAgeSeconds} s), 401 beyond it`, async () => {
    // Both valid by `exp`; the margins are far outside the clock tolerance (≤ 120 s).
    const max = ctx.maxTokenAgeSeconds;
    const [young, old] = await Promise.all(
      [max - 300, max + 300].map((age) =>
        mintToken(ctx.tokenEndpoint, { sub, options: { issuedAtOffsetSeconds: -age } }),
      ),
    );
    const accepted = await call(target, 'GET', '/v1/jobs', { token: young });
    expect(
      accepted.status,
      `positive control, issued ${max - 300} s ago: ${describeRes(accepted)}`,
    ).toBe(200);
    expectUnauthorized(await call(target, 'GET', '/v1/jobs', { token: old }), true);
  });

  it('a token for another client of the same issuer → 401', async () => {
    const otherAudience = await mintToken(ctx.tokenEndpoint, {
      sub,
      options: { audience: 'some-other-client' },
    });
    expectUnauthorized(await call(target, 'GET', '/v1/jobs', { token: otherAudience }), true);
    // Right audience but issued to another OAuth client: needs AUTH_ALLOWED_CLIENT_IDS.
    const otherClient = await mintToken(ctx.tokenEndpoint, { sub, options: OTHER_CLIENT });
    const r = await call(target, 'GET', '/v1/jobs', { token: otherClient });
    expect(r.status, `${describeRes(r)} — configure AUTH_ALLOWED_CLIENT_IDS`).toBe(401);
  });

  it('every 401 looks the same: the response never says which check failed', async () => {
    const shapes = new Set<string>();
    for (const [, options] of NEGATIVE_CASES) {
      const r = await call(target, 'GET', '/v1/jobs', {
        token: await mintToken(ctx.tokenEndpoint, { sub, options }),
      });
      const { requestId: _r, instance: _i, ...problem } = expectUnauthorized(r, true);
      shapes.add(JSON.stringify({ problem, challenge: r.headers.get('www-authenticate') }));
    }
    expect([...shapes]).toHaveLength(1);
  });

  it('an anonymous 512 KiB POST gets 401 before the body is read', async () => {
    const declared = 600 * 1024;
    const r =
      target.name === 'direct'
        ? await postDeclaringLength(target.baseUrl, '/v1/jobs', declared)
        : // Proxies buffer request bodies; send the whole body through them.
          await call(target, 'POST', '/v1/jobs', {
            body: `{"title":"x","content":"${'a'.repeat(declared)}"}`,
            headers: { 'content-type': 'application/json' },
          });
    expect(r.status, describeRes(r)).toBe(401);
    // Not even an invalid-JSON body is looked at.
    const garbage = await call(target, 'POST', '/v1/jobs', {
      body: '{"this is not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(garbage.status, describeRes(garbage)).toBe(401);
  });
});

describe('authentication — a configured AUTH_MAX_TOKEN_AGE_SECONDS', () => {
  it(`is honoured: a token the default accepts is refused by the API configured lower${ctx.gated ? '' : ' [skipped: self-started harness only]'}`, async (t) => {
    precondition(
      t,
      ctx,
      ctx.gated !== undefined,
      'needs the self-started harness (an API with a non-default AUTH_MAX_TOKEN_AGE_SECONDS)',
    );
    const { target: gated, maxTokenAgeSeconds: max } = ctx.gated;
    const direct = ctx.targets.find((x) => x.name === 'direct');
    expect(max, 'the gated API runs below the default').toBeLessThan(ctx.maxTokenAgeSeconds - 300);
    const sub = principal(ctx.runId, SUITE, 'configured-age');
    const [young, old] = await Promise.all(
      [max - 120, max + 180].map((age) =>
        mintToken(ctx.tokenEndpoint, { sub, options: { issuedAtOffsetSeconds: -age } }),
      ),
    );
    const accepted = await call(gated, 'GET', '/v1/jobs', { token: young });
    expect(accepted.status, `positive control: ${describeRes(accepted)}`).toBe(200);
    expectUnauthorized(await call(gated, 'GET', '/v1/jobs', { token: old }), true);
    // The very same token is fine where the default (3600 s) applies: the age setting decided.
    if (direct) {
      const elsewhere = await call(direct, 'GET', '/v1/jobs', { token: old });
      expect(elsewhere.status, describeRes(elsewhere)).toBe(200);
    }
  });
});
