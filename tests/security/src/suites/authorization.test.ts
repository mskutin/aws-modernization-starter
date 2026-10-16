/**
 * Authorization and scopes: a caller only ever sees its own jobs. Cross-user reads answer exactly like a
 * job that does not exist (no existence oracle), lists never contain other callers' jobs, and a
 * pagination cursor does not carry another caller's data. A 200 for another user's job fails.
 */
import { randomUUID } from 'node:crypto';
import { INSUFFICIENT_SCOPE } from '@starter/testing/auth';
import { beforeAll, describe, expect, it } from 'vitest';
import { context } from '../context.js';
import { call, describeRes } from '../http.js';
import {
  documentBody,
  expectAccepted,
  expectProblem,
  getJob,
  listJobs,
  ProblemType,
  submit,
} from '../support.js';
import { mintToken, principal } from '../tokens.js';

const ctx = context();
const SUITE = 'authz';

/** Problem body without the per-request fields, with the job id masked. */
const shapeOf = (json: unknown, jobId: string) => {
  const { requestId: _r, instance: _i, ...rest } = json as Record<string, unknown>;
  return JSON.parse(JSON.stringify(rest).replaceAll(jobId, '<id>')) as unknown;
};

describe.each(ctx.targets)('authorization — $name: $description', (target) => {
  const alice = principal(ctx.runId, SUITE, `alice-${target.name}`);
  const bob = principal(ctx.runId, SUITE, `bob-${target.name}`);
  let aliceToken: string;
  let bobToken: string;
  const aliceJobs: string[] = [];

  beforeAll(async () => {
    [aliceToken, bobToken] = await Promise.all([
      mintToken(ctx.tokenEndpoint, { sub: alice }),
      mintToken(ctx.tokenEndpoint, { sub: bob }),
    ]);
    for (let i = 0; i < 3; i++) {
      const job = expectAccepted(
        await submit(
          target,
          aliceToken,
          documentBody(`alice private ${ctx.runId} ${i}`, randomUUID()),
        ),
      );
      aliceJobs.push(job.jobId);
    }
  });

  it('positive control: the owner reads her job (200)', async () => {
    const r = await getJob(target, aliceToken, aliceJobs[0] ?? '');
    expect(r.status, describeRes(r)).toBe(200);
  });

  it("another user's job answers 404, identical to a job that does not exist", async () => {
    for (const jobId of aliceJobs) {
      const foreign = await getJob(target, bobToken, jobId);
      expectProblem(foreign, 404, ProblemType.NotFound);
      const missingId = randomUUID();
      const missing = await getJob(target, bobToken, missingId);
      expectProblem(missing, 404, ProblemType.NotFound);
      expect(shapeOf(foreign.json, jobId)).toEqual(shapeOf(missing.json, missingId));
      expect(foreign.headers.get('content-type')).toBe(missing.headers.get('content-type'));
    }
  });

  it("another user's list never contains the owner's jobs", async () => {
    const bobJob = expectAccepted(
      await submit(target, bobToken, documentBody(`bob ${ctx.runId}`, randomUUID())),
    );
    const { res, list } = await listJobs(target, bobToken, '?limit=100');
    expect(res.status, describeRes(res)).toBe(200);
    const ids = list?.items.map((j) => j.jobId) ?? [];
    expect(ids).toContain(bobJob.jobId);
    expect(ids.filter((id) => aliceJobs.includes(id))).toEqual([]);
    const own = await listJobs(target, aliceToken, '?limit=100');
    expect(own.list?.items.map((j) => j.jobId)).not.toContain(bobJob.jobId);
  });

  it("a pagination cursor from one user does not page through another user's jobs", async () => {
    const page = await listJobs(target, aliceToken, '?limit=1');
    expect(page.res.status, describeRes(page.res)).toBe(200);
    const cursor = page.list?.nextCursor;
    expect(cursor, 'alice has more than one job, so a cursor exists').toBeTruthy();
    const replay = await listJobs(
      target,
      bobToken,
      `?limit=100&cursor=${encodeURIComponent(cursor ?? '')}`,
    );
    expect([200, 400], describeRes(replay.res)).toContain(replay.res.status);
    const leaked = (replay.list?.items ?? [])
      .map((j) => j.jobId)
      .filter((id) => aliceJobs.includes(id));
    expect(leaked).toEqual([]);
    expect(replay.res.text).not.toContain(alice);
  });

  it('enumerating random job ids yields only 404s', async () => {
    for (let i = 0; i < 5; i++) {
      expectProblem(await getJob(target, bobToken, randomUUID()), 404, ProblemType.NotFound);
    }
  });

  it('a valid token without the required scope → 403 insufficient_scope (read and write)', async () => {
    const noScope = await mintToken(ctx.tokenEndpoint, { sub: bob, options: INSUFFICIENT_SCOPE });
    const read = await call(target, 'GET', '/v1/jobs', { token: noScope });
    expectProblem(read, 403, ProblemType.Forbidden);
    expect(read.headers.get('www-authenticate') ?? '').toMatch(/error="insufficient_scope"/);
    const readOnly = await mintToken(ctx.tokenEndpoint, { sub: bob, scope: 'jobs:read' });
    const write = await call(target, 'POST', '/v1/jobs', {
      token: readOnly,
      json: documentBody(`scope ${ctx.runId}`),
      headers: { 'idempotency-key': `authz-${randomUUID()}` },
    });
    expectProblem(write, 403, ProblemType.Forbidden);
    expect(write.headers.get('www-authenticate') ?? '').toContain('scope="jobs:write"');
    // Positive control: the same read-only token may read.
    expect((await call(target, 'GET', '/v1/jobs', { token: readOnly })).status).toBe(200);
  });

  it('the same subject from another issuer is a different principal (issuer-bound owner)', async () => {
    const forged = await mintToken(ctx.tokenEndpoint, {
      sub: alice,
      options: { issuer: 'https://evil-issuer.invalid' },
    });
    const r = await getJob(target, forged, aliceJobs[0] ?? '');
    expect(r.status, describeRes(r)).toBe(401);
  });
});
