/**
 * Behavioural contract shared by every JobStateStore implementation. The
 * in-memory twin runs it as a unit test; the DynamoDB store runs it against
 * DynamoDB Local as an integration test.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IdempotencyRecord, JobStateStore } from '../src/index.js';

const T0 = '2026-10-13T10:00:00.000Z';
const T1 = '2026-10-13T10:00:01.000Z';
const T2 = '2026-10-13T10:00:02.000Z';
const T3 = '2026-10-13T10:00:03.000Z';
const NOW = new Date('2026-10-13T10:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);

export interface StoreHarness {
  store: JobStateStore;
  cleanup?: () => Promise<void>;
}

/** Polls `read` until `done` holds (eventually consistent indexes), at most 5 s. */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function describeJobStateStoreContract(
  label: string,
  setup: () => Promise<StoreHarness>,
): void {
  describe(`JobStateStore contract: ${label}`, () => {
    let harness: StoreHarness;
    let store: JobStateStore;

    beforeAll(async () => {
      harness = await setup();
      store = harness.store;
    });
    afterAll(async () => {
      await harness?.cleanup?.();
    });

    const newJob = async () => {
      const jobId = randomUUID();
      await store.createInitial(jobId, T0);
      return jobId;
    };

    it('creates the initial PENDING state exactly once', async () => {
      const jobId = randomUUID();
      const first = await store.createInitial(jobId, T0);
      expect(first).toEqual({
        created: true,
        state: { jobId, status: 'PENDING', version: 1, createdAt: T0, updatedAt: T0 },
      });
      const second = await store.createInitial(jobId, T1);
      expect(second.created).toBe(false);
      expect(second.state).toMatchObject({ status: 'PENDING', version: 1, updatedAt: T0 });
    });

    it('returns null for unknown jobs', async () => {
      expect(await store.get(randomUUID())).toBeNull();
    });

    it('walks the happy path and bumps the version on every write', async () => {
      const jobId = await newJob();
      const validating = await store.transition(jobId, 'VALIDATING', T1);
      expect(validating).toMatchObject({
        kind: 'applied',
        state: { status: 'VALIDATING', version: 2, updatedAt: T1 },
      });
      const processing = await store.transition(jobId, 'PROCESSING', T2);
      expect(processing).toMatchObject({
        kind: 'applied',
        state: { status: 'PROCESSING', version: 3 },
      });
      const stored = await store.storeResult(jobId, '{"wordCount":3}');
      expect(stored).toMatchObject({
        kind: 'stored',
        state: { status: 'PROCESSING', version: 4, resultJson: '{"wordCount":3}', updatedAt: T2 },
      });
      const done = await store.recordSuccess(jobId, T3);
      expect(done).toMatchObject({
        kind: 'applied',
        state: { status: 'SUCCEEDED', version: 5, resultJson: '{"wordCount":3}', createdAt: T0 },
      });
      expect(await store.get(jobId)).toMatchObject({ status: 'SUCCEEDED', version: 5 });
    });

    it('stores the result at most once, only while PROCESSING (duplicate deliveries keep the first)', async () => {
      const jobId = await newJob();
      expect(await store.storeResult(jobId, '{"a":1}')).toMatchObject({
        kind: 'rejected',
        reason: 'cannot store a result in status PENDING',
      });
      await store.transition(jobId, 'VALIDATING', T1);
      await store.transition(jobId, 'PROCESSING', T2);
      await store.storeResult(jobId, '{"a":1}');
      expect(await store.storeResult(jobId, '{"a":2}')).toMatchObject({
        kind: 'exists',
        state: { resultJson: '{"a":1}' },
      });
      expect(await store.storeResult(randomUUID(), '{}')).toEqual({
        kind: 'rejected',
        state: null,
        reason: 'job state not found',
      });
    });

    it('never records success without a stored result', async () => {
      const jobId = await newJob();
      await store.transition(jobId, 'VALIDATING', T1);
      await store.transition(jobId, 'PROCESSING', T2);
      expect(await store.recordSuccess(jobId, T3)).toMatchObject({
        kind: 'rejected',
        reason: 'no stored result',
        state: { status: 'PROCESSING' },
      });
      expect(await store.get(jobId)).toMatchObject({ status: 'PROCESSING', version: 3 });
    });

    it('removes a stored result when the job fails (no derived data on failed jobs)', async () => {
      const jobId = await newJob();
      await store.transition(jobId, 'VALIDATING', T1);
      await store.transition(jobId, 'PROCESSING', T2);
      await store.storeResult(jobId, '{"topTerms":[]}');
      await store.recordFailure(jobId, { name: 'States.Timeout', message: 'timed out' }, T3);
      const failed = await store.get(jobId);
      expect(failed).toMatchObject({ status: 'FAILED', errorName: 'States.Timeout' });
      expect(failed?.resultJson).toBeUndefined();
    });

    it('applies terminal writes only at the expected version (reconciler)', async () => {
      const jobId = await newJob();
      await store.transition(jobId, 'VALIDATING', T1);
      expect(
        await store.recordFailure(jobId, { name: 'X', message: 'y' }, T2, { expectedVersion: 1 }),
      ).toMatchObject({ kind: 'rejected', reason: 'version conflict: expected 1, found 2' });
      expect(
        await store.recordFailure(jobId, { name: 'X', message: 'y' }, T2, { expectedVersion: 2 }),
      ).toMatchObject({ kind: 'applied', state: { status: 'FAILED', version: 3 } });
      // A second reconciler run observing the old version: already terminal, nothing written.
      expect(
        await store.recordFailure(jobId, { name: 'Z', message: 'z' }, T3, { expectedVersion: 2 }),
      ).toMatchObject({ kind: 'noop', state: { errorName: 'X', version: 3 } });

      const other = await newJob();
      await store.transition(other, 'VALIDATING', T1);
      await store.transition(other, 'PROCESSING', T2);
      await store.storeResult(other, '{}');
      expect(await store.recordSuccess(other, T3, { expectedVersion: 3 })).toMatchObject({
        kind: 'rejected',
        reason: 'version conflict: expected 3, found 4',
      });
      expect(await store.recordSuccess(other, T3, { expectedVersion: 4 })).toMatchObject({
        kind: 'applied',
        state: { status: 'SUCCEEDED' },
      });
    });

    it('applies reconciler writes only for the observed status AND version', async () => {
      const jobId = await newJob();
      await store.transition(jobId, 'VALIDATING', T1);
      expect(
        await store.recordFailure(jobId, { name: 'X', message: 'y' }, T2, {
          expectedStatus: 'PENDING',
          expectedVersion: 2,
        }),
      ).toMatchObject({
        kind: 'rejected',
        reason: 'status conflict: expected PENDING, found VALIDATING',
      });
      expect(
        await store.recordFailure(jobId, { name: 'X', message: 'y' }, T2, {
          expectedStatus: 'VALIDATING',
          expectedVersion: 2,
        }),
      ).toMatchObject({ kind: 'applied', state: { status: 'FAILED', version: 3 } });
    });

    it('lists stale jobs of one status from the status index, oldest first and bounded', async () => {
      const at = [
        '2001-01-01T00:00:01.000Z',
        '2001-01-01T00:00:02.000Z',
        '2001-01-01T00:00:03.000Z',
      ];
      const ids: string[] = [];
      for (const t of at) {
        const id = randomUUID();
        await store.createInitial(id, t);
        ids.push(id);
      }
      await store.transition(ids[2]!, 'VALIDATING', '2001-01-01T00:00:04.000Z');
      const cutoff = '2001-01-01T00:00:03.500Z';
      // The status index is eventually consistent on AWS: poll with a deadline.
      const stale = await eventually(
        () => store.listStale('PENDING', cutoff, 10),
        (items) => items.length === 2,
      );
      expect(stale.map((s) => s.jobId)).toEqual(ids.slice(0, 2));
      expect(stale[0]).toEqual({ jobId: ids[0], status: 'PENDING', updatedAt: at[0] });
      expect(await store.listStale('PENDING', cutoff, 1)).toHaveLength(1);
      expect(await store.listStale('VALIDATING', cutoff, 10)).toEqual([]);
      const validating = await eventually(
        () => store.listStale('VALIDATING', '2001-01-01T00:00:05.000Z', 10),
        (items) => items.length === 1,
      );
      expect(validating.map((s) => s.jobId)).toEqual([ids[2]]);
      await expect(store.listStale('PENDING', cutoff, 0)).rejects.toThrow(RangeError);
    });

    it('treats re-entering the current status as a no-op (duplicate delivery)', async () => {
      const jobId = await newJob();
      await store.transition(jobId, 'VALIDATING', T1);
      const again = await store.transition(jobId, 'VALIDATING', T2);
      expect(again).toMatchObject({
        kind: 'noop',
        state: { status: 'VALIDATING', version: 2, updatedAt: T1 },
      });
    });

    it('rejects illegal transitions and never leaves a terminal status', async () => {
      const jobId = await newJob();
      expect(await store.transition(jobId, 'PROCESSING', T1)).toMatchObject({
        kind: 'rejected',
        reason: 'illegal transition PENDING → PROCESSING',
      });
      expect(await store.recordSuccess(jobId, T1)).toMatchObject({ kind: 'rejected' });
      await store.recordFailure(jobId, { name: 'JobValidationError', message: 'too short' }, T1);
      expect(await store.transition(jobId, 'VALIDATING', T2)).toMatchObject({
        kind: 'rejected',
        state: { status: 'FAILED' },
      });
      expect(await store.recordSuccess(jobId, T2)).toMatchObject({ kind: 'rejected' });
      expect(await store.get(jobId)).toMatchObject({
        status: 'FAILED',
        errorName: 'JobValidationError',
        errorMessage: 'too short',
      });
    });

    it('records failure once; repeating it is a no-op', async () => {
      const jobId = await newJob();
      await store.transition(jobId, 'VALIDATING', T1);
      const failed = await store.recordFailure(jobId, { name: 'X', message: 'boom' }, T2);
      expect(failed).toMatchObject({ kind: 'applied', state: { status: 'FAILED', version: 3 } });
      const again = await store.recordFailure(jobId, { name: 'Y', message: 'other' }, T3);
      expect(again).toMatchObject({ kind: 'noop', state: { errorName: 'X', version: 3 } });
    });

    it('rejects transitions for missing jobs', async () => {
      expect(await store.transition(randomUUID(), 'VALIDATING', T1)).toEqual({
        kind: 'rejected',
        state: null,
        reason: 'job state not found',
      });
    });

    it('enforces optimistic concurrency with expectedVersion', async () => {
      const jobId = await newJob();
      expect(await store.transition(jobId, 'VALIDATING', T1, { expectedVersion: 7 })).toMatchObject(
        {
          kind: 'rejected',
          reason: 'version conflict: expected 7, found 1',
        },
      );
      expect(await store.transition(jobId, 'VALIDATING', T1, { expectedVersion: 1 })).toMatchObject(
        {
          kind: 'applied',
        },
      );
    });

    it('lets exactly one of several concurrent writers win', async () => {
      const jobId = await newJob();
      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => store.transition(jobId, 'VALIDATING', T1)),
      );
      expect(outcomes.filter((o) => o.kind === 'applied')).toHaveLength(1);
      expect(outcomes.filter((o) => o.kind === 'noop')).toHaveLength(4);
      expect((await store.get(jobId))?.version).toBe(2);
    });

    it('attaches the execution ARN once', async () => {
      const jobId = await newJob();
      expect(await store.attachExecution(jobId, 'arn:1')).toBe(true);
      expect(await store.attachExecution(jobId, 'arn:1')).toBe(true);
      expect(await store.attachExecution(jobId, 'arn:2')).toBe(false);
      expect(await store.get(jobId)).toMatchObject({ executionArn: 'arn:1', version: 3 });
      expect(await store.attachExecution(randomUUID(), 'arn:3')).toBe(false);
    });

    it('batch-reads states beyond the 100-key BatchGet limit and skips unknown ids', async () => {
      const ids = await Promise.all(Array.from({ length: 105 }, () => newJob()));
      const missing = randomUUID();
      const states = await store.getMany([...ids, missing, ids[0]!]);
      expect(states.size).toBe(105);
      expect(states.has(missing)).toBe(false);
      expect(states.get(ids[3]!)?.status).toBe('PENDING');
      expect((await store.getMany([])).size).toBe(0);
    });

    describe('idempotency records', () => {
      const record = (key: string, jobId: string, expiresAt = NOW_S + 3600): IdempotencyRecord => ({
        key,
        fingerprint: 'f'.repeat(64),
        jobId,
        createdAt: T0,
        expiresAt,
      });

      it('claims a key once and returns the existing record afterwards', async () => {
        const key = `k-${randomUUID()}`;
        const first = await store.claimIdempotency(record(key, 'job-a'), NOW);
        expect(first.claimed).toBe(true);
        const second = await store.claimIdempotency(record(key, 'job-b'), NOW);
        expect(second).toEqual({ claimed: false, existing: record(key, 'job-a') });
        expect(await store.getIdempotency(key, NOW)).toEqual(record(key, 'job-a'));
      });

      it('lets exactly one concurrent claimant win', async () => {
        const key = `k-${randomUUID()}`;
        const outcomes = await Promise.all(
          ['a', 'b', 'c', 'd'].map((j) => store.claimIdempotency(record(key, j), NOW)),
        );
        expect(outcomes.filter((o) => o.claimed)).toHaveLength(1);
        const winner = outcomes.find((o) => o.claimed);
        for (const o of outcomes) {
          if (!o.claimed && winner?.claimed) expect(o.existing.jobId).toBe(winner.record.jobId);
        }
      });

      it('treats expired records as absent (TTL deletion is lazy)', async () => {
        const key = `k-${randomUUID()}`;
        await store.claimIdempotency(record(key, 'old', NOW_S - 1), NOW);
        expect(await store.getIdempotency(key, NOW)).toBeNull();
        const reclaimed = await store.claimIdempotency(record(key, 'new'), NOW);
        expect(reclaimed.claimed).toBe(true);
        expect((await store.getIdempotency(key, NOW))?.jobId).toBe('new');
      });

      it('stores optional cached results and allows explicit re-pointing', async () => {
        const key = `step:${randomUUID()}:ProcessJob`;
        await store.claimIdempotency({ ...record(key, 'j'), resultJson: '{"a":1}' }, NOW);
        expect((await store.getIdempotency(key, NOW))?.resultJson).toBe('{"a":1}');
        await store.putIdempotency(record(key, 'j2'));
        expect(await store.getIdempotency(key, NOW)).toEqual(record(key, 'j2'));
      });
    });

    it('appends and lists the step audit trail in time order', async () => {
      const jobId = await newJob();
      await store.appendStep({ jobId, state: 'ProcessJob', at: T2, outcome: 'succeeded' });
      await store.appendStep({
        jobId,
        state: 'ValidateJob',
        at: T1,
        outcome: 'succeeded',
        detail: 'ok',
      });
      const steps = await store.listSteps(jobId);
      expect(steps.map((s) => s.state)).toEqual(['ValidateJob', 'ProcessJob']);
      expect(steps[0]).toEqual({
        jobId,
        state: 'ValidateJob',
        at: T1,
        outcome: 'succeeded',
        detail: 'ok',
      });
      // Step items never leak into the state read.
      expect(await store.get(jobId)).toMatchObject({ status: 'PENDING' });
    });

    it('answers health pings', async () => {
      await expect(store.ping()).resolves.toBeUndefined();
    });
  });
}
