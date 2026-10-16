/**
 * Idempotent submission: replay, key/body mismatch, body-derived keys and concurrent duplicates.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { IDEMPOTENT_REPLAYED_HEADER, ProblemType } from '@starter/contracts';
import { ProcessingState } from '@starter/workflow-processing';
import {
  expectJobResponse,
  expectProblem,
  newKey,
  submitJob,
  waitForTerminal,
} from '../support/api.js';
import { storedKey } from '../support/auth.js';
import { validDocument } from '../support/fixtures.js';
import {
  closeStores,
  countJobRowsForKey,
  dynamoSkipReason,
  getIdempotencyItem,
  getStepItems,
  pgSkipReason,
} from '../support/stores.js';

afterAll(closeStores);

describe('idempotency', () => {
  it('same Idempotency-Key + same body → original job replayed (200, Idempotent-Replayed: true)', async () => {
    const key = newKey('replay');
    const doc = validDocument('replay');
    const firstResponse = await submitJob(doc, { idempotencyKey: key });
    const first = expectJobResponse(firstResponse);
    expect(firstResponse.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    const replay = await submitJob(doc, { idempotencyKey: key });
    const replayed = expectJobResponse(replay, 200);
    expect(replayed.jobId).toBe(first.jobId);
    expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');

    // replay after completion still returns the same job, now terminal
    const { job } = await waitForTerminal(first.jobId);
    const late = expectJobResponse(await submitJob(doc, { idempotencyKey: key }), 200);
    expect(late.jobId).toBe(job.jobId);
    expect(late.status).toBe(job.status);
  });

  it('same Idempotency-Key + different body → 422 problem, no new job', async () => {
    const key = newKey('mismatch');
    expectJobResponse(await submitJob(validDocument('mismatch-a'), { idempotencyKey: key }));
    const r = await submitJob(validDocument('mismatch-b'), { idempotencyKey: key });
    expectProblem(r, 422, ProblemType.IdempotencyMismatch);
  });

  it('without the header, an identical body is deduplicated by a server-derived key', async () => {
    const doc = validDocument('derived');
    const first = expectJobResponse(await submitJob(doc, { idempotencyKey: null }));
    const again = await submitJob(doc, { idempotencyKey: null });
    expect(expectJobResponse(again, 200).jobId).toBe(first.jobId);
    expect(again.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    // a different body without a header is a different job
    const other = expectJobResponse(
      await submitJob(validDocument('derived-2'), { idempotencyKey: null }),
    );
    expect(other.jobId).not.toBe(first.jobId);
  });

  it('concurrent duplicate submissions → exactly one job created, all callers get it', async () => {
    const key = newKey('concurrent');
    const doc = validDocument('concurrent');
    const N = 12;
    const responses = await Promise.all(
      Array.from({ length: N }, () => submitJob(doc, { idempotencyKey: key })),
    );
    const statuses = responses.map((r) => r.status).sort();
    // Exactly one creator (202); the rest are replays (200). A 409/503 would mean the race was
    // surfaced to clients instead of being absorbed by the conditional write.
    expect(
      statuses.filter((s) => s === 202),
      `statuses: ${statuses.join(',')}`,
    ).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(N - 1);
    const ids = new Set(
      responses.map((r) => expectJobResponse(r, r.status === 202 ? 202 : 200).jobId),
    );
    expect(ids.size).toBe(1);
    const [jobId] = [...ids] as [string];
    const { job } = await waitForTerminal(jobId);
    expect(job.status).toBe('SUCCEEDED');

    // Stored principal-scoped (p:<sha256(iss|sub)>:h:<key>), identically in both stores.
    const stored = await storedKey(key);
    if (!pgSkipReason) {
      expect(await countJobRowsForKey(stored)).toBe(1);
      expect(await countJobRowsForKey(key)).toBe(0);
    }
    if (!dynamoSkipReason) {
      // one idempotency record pointing at the job, and the workflow ran once
      const rec = await getIdempotencyItem(stored);
      expect(rec?.jobId).toBe(jobId);
      const steps = await getStepItems(jobId);
      const validates = steps.filter(
        (s) => s.state === ProcessingState.Validate && s.outcome === 'succeeded',
      );
      expect(validates, JSON.stringify(steps)).toHaveLength(1);
    }
  });

  it('concurrent submissions with distinct keys create distinct jobs', async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) => submitJob(validDocument(`distinct-${i}`))),
    );
    const ids = responses.map((r) => expectJobResponse(r).jobId);
    expect(new Set(ids).size).toBe(6);
  });
});
