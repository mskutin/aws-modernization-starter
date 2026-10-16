/**
 * Idempotency keys are scoped to the principal. The same `Idempotency-Key` with the same
 * body from two users creates two jobs, never a replay of the other user's job; the same holds
 * for body-derived keys (no header). Positive controls prove replay still works for the owner.
 */
import { randomUUID } from 'node:crypto';
import { IDEMPOTENT_REPLAYED_HEADER } from '@starter/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { context } from '../context.js';
import { describeRes } from '../http.js';
import { documentBody, expectAccepted, getJob, submit } from '../support.js';
import { mintToken, principal } from '../tokens.js';

const ctx = context();
const SUITE = 'idem';

describe.each(ctx.targets)('idempotency scoping — $name: $description', (target) => {
  let aliceToken: string;
  let bobToken: string;

  beforeAll(async () => {
    [aliceToken, bobToken] = await Promise.all([
      mintToken(ctx.tokenEndpoint, { sub: principal(ctx.runId, SUITE, `alice-${target.name}`) }),
      mintToken(ctx.tokenEndpoint, { sub: principal(ctx.runId, SUITE, `bob-${target.name}`) }),
    ]);
  });

  it('same Idempotency-Key and identical body from two users → two distinct jobs, no cross-user replay', async () => {
    const key = `shared-${randomUUID()}`;
    const body = documentBody(`idempotency ${ctx.runId}`, randomUUID());
    const first = await submit(target, aliceToken, body, key);
    const aliceJob = expectAccepted(first);
    expect(first.status, describeRes(first)).toBe(202);

    const other = await submit(target, bobToken, body, key);
    const bobJob = expectAccepted(other);
    expect(other.status, describeRes(other)).toBe(202);
    expect(other.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(bobJob.jobId).not.toBe(aliceJob.jobId);

    // Positive control: the owner's replay IS a replay of her own job.
    const replay = await submit(target, aliceToken, body, key);
    expect(replay.status, describeRes(replay)).toBe(200);
    expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(expectAccepted(replay).jobId).toBe(aliceJob.jobId);

    // And neither can read the other's job through the shared key.
    expect((await getJob(target, bobToken, aliceJob.jobId)).status).toBe(404);
    expect((await getJob(target, aliceToken, bobJob.jobId)).status).toBe(404);
  });

  it('same body without a key (body-derived key) from two users → two distinct jobs', async () => {
    const body = documentBody(`derived ${ctx.runId}`, randomUUID());
    const a = expectAccepted(await submit(target, aliceToken, body, null));
    const b = await submit(target, bobToken, body, null);
    expect(b.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(expectAccepted(b).jobId).not.toBe(a.jobId);
    const again = await submit(target, aliceToken, body, null);
    expect(expectAccepted(again).jobId).toBe(a.jobId);
  });

  it("a key reused by another user with a different body is that user's own new job, not a conflict with the owner's", async () => {
    const key = `conflict-${randomUUID()}`;
    expectAccepted(
      await submit(target, aliceToken, documentBody(`a ${ctx.runId}`, randomUUID()), key),
    );
    const r = await submit(target, bobToken, documentBody(`b ${ctx.runId}`, randomUUID()), key);
    // 422 (key reused with a different body) would reveal that someone else used this key.
    expect(r.status, describeRes(r)).toBe(202);
  });
});
