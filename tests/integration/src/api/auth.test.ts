/**
 * Black-box authentication and authorization (identity) against the running stack —
 * directly against the API and, when WEB_BASE_URL is set (local compose: the nginx web tier,
 * the CloudFront stand-in), through the web-facing proxy with the SAME assertions.
 * The exhaustive negative matrix lives in tests/security (SecTest) and apps/api integration tests.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JobListSchema, ProblemType } from '@starter/contracts';
import { expectJobResponse, expectProblem, request, submitJob } from '../support/api.js';
import { mintToken, principal } from '../support/auth.js';
import { config } from '../support/env.js';
import { validDocument } from '../support/fixtures.js';

const targets: [string, string][] = [['direct', config.apiBaseUrl]];
const webBaseUrl = process.env.WEB_BASE_URL;
if (webBaseUrl) targets.push(['web tier', webBaseUrl]);

describe.each(targets)('authentication and ownership (%s: %s)', (_label, baseUrl) => {
  it.each([
    ['POST', '/v1/jobs'],
    ['GET', '/v1/jobs'],
    ['GET', `/v1/jobs/${randomUUID()}`],
  ] as const)('anonymous %s %s → 401 with a Bearer challenge', async (method, path) => {
    const r = await request(method, path, {
      as: null,
      baseUrl,
      ...(method === 'POST' ? { json: validDocument('anonymous') } : {}),
    });
    expectProblem(r, 401, ProblemType.Unauthorized);
    expect(r.headers.get('www-authenticate')).toBe('Bearer realm="starter-api"');
  });

  it.each([
    ['expired', { options: { expiresInSeconds: -600 } }],
    ['wrong audience', { options: { audience: 'another-api' } }],
    ['tampered signature', { options: { tamperSignature: true } }],
    ['alg none', { options: { algNone: true } }],
  ])('%s token → 401', async (_n, mint) => {
    const token = await mintToken({ sub: principal('negative'), ...mint });
    const r = await request('GET', '/v1/jobs', {
      baseUrl,
      headers: { authorization: `Bearer ${token}` },
    });
    expectProblem(r, 401, ProblemType.Unauthorized);
    expect(r.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('a token without the API scopes → 403', async () => {
    const token = await mintToken({ sub: principal('noscope'), scope: 'profile' });
    const r = await request('GET', '/v1/jobs', {
      baseUrl,
      headers: { authorization: `Bearer ${token}` },
    });
    expectProblem(r, 403, ProblemType.Forbidden);
  });

  it("another principal's job answers 404 and never appears in their list", async () => {
    const alice = principal('alice');
    const bob = principal('bob');
    const job = expectJobResponse(await submitJob(validDocument('owned'), { as: alice, baseUrl }));
    const foreign = await request('GET', `/v1/jobs/${job.jobId}`, { as: bob, baseUrl });
    expectProblem(foreign, 404, ProblemType.NotFound);
    expect(foreign.text).not.toContain(job.title);
    const list = await request('GET', '/v1/jobs?limit=100', { as: bob, baseUrl });
    expect(JobListSchema.parse(list.body).items.map((i) => i.jobId)).not.toContain(job.jobId);
    expect((await request('GET', `/v1/jobs/${job.jobId}`, { as: alice, baseUrl })).status).toBe(
      200,
    );
  });

  it('the same Idempotency-Key from two principals creates two jobs', async () => {
    const key = `bb-${randomUUID()}`;
    const body = validDocument('shared-key');
    const a = expectJobResponse(
      await submitJob(body, { idempotencyKey: key, as: principal('k1'), baseUrl }),
    );
    const second = await submitJob(body, { idempotencyKey: key, as: principal('k2'), baseUrl });
    const b = expectJobResponse(second);
    expect(b.jobId).not.toBe(a.jobId);
    expect(second.headers.get('idempotent-replayed')).toBeNull();
  });
});
