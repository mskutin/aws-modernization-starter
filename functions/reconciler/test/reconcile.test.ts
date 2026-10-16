/**
 * Reconciler core with the in-memory job-state twin and a fake execution-state source: one test
 * per decision rule, plus the batch/time bounds, idempotency, concurrency and dependency outages.
 */
import { randomUUID } from 'node:crypto';
import { RECONCILER_MIN_STALE_AFTER_SECONDS } from '@starter/config';
import { InMemoryJobStateStore, type JobStateStore } from '@starter/job-state';
import { RECONCILIATION, ReconciliationError } from '@starter/workflow-processing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECONCILER_ACTOR,
  reconcileStaleJobs,
  validateOptions,
  type ReconcileOptions,
} from '../src/index.js';
import { FakeExecutions, capturingLogger, throttling } from './helpers.js';

const OLD = '2026-10-14T00:00:00.000Z';
const NOW = '2026-10-14T01:00:00.000Z';
const RECENT = '2026-10-14T00:59:00.000Z';
const ARN = (jobId: string) =>
  `arn:aws:states:ap-southeast-1:123456789012:execution:starter-dev-job-processing:job-${jobId}`;
const OPTIONS: ReconcileOptions = {
  staleAfterSeconds: 900,
  batchSize: 25,
  dryRun: false,
  maxRuntimeMs: 30_000,
};

type Status = 'PENDING' | 'VALIDATING' | 'PROCESSING';

describe('reconcileStaleJobs', () => {
  let store: InMemoryJobStateStore;
  let executions: FakeExecutions;
  let log: ReturnType<typeof capturingLogger>;
  const run = (
    options: Partial<ReconcileOptions> = {},
    overrides: { store?: JobStateStore } = {},
  ) =>
    reconcileStaleJobs(
      {
        store: overrides.store ?? store,
        executions,
        logger: log.logger,
        now: () => new Date(NOW),
      },
      { ...OPTIONS, ...options },
    );

  /** A job last written at `at` in `status` (with an execution ARN unless told otherwise). */
  async function seed(
    status: Status,
    opts: { at?: string; executionArn?: boolean; result?: string } = {},
  ): Promise<string> {
    const jobId = randomUUID();
    const at = opts.at ?? OLD;
    await store.createInitial(jobId, at);
    if (opts.executionArn !== false) await store.attachExecution(jobId, ARN(jobId));
    if (status !== 'PENDING') await store.transition(jobId, 'VALIDATING', at);
    if (status === 'PROCESSING') await store.transition(jobId, 'PROCESSING', at);
    if (opts.result !== undefined) await store.storeResult(jobId, opts.result);
    return jobId;
  }

  beforeEach(() => {
    store = new InMemoryJobStateStore();
    executions = new FakeExecutions();
    log = capturingLogger();
  });

  it('never touches a stale job whose execution is still RUNNING', async () => {
    const jobId = await seed('PROCESSING');
    executions.states.set(jobId, { status: 'RUNNING' });
    const before = await store.get(jobId);
    const summary = await run();
    expect(summary).toMatchObject({ staleCandidates: 1, skippedRunning: 1, markedFailed: 0 });
    expect(await store.get(jobId)).toEqual(before);
  });

  it('only considers jobs whose last transition is older than the threshold', async () => {
    await seed('VALIDATING', { at: RECENT });
    const summary = await run();
    expect(summary.staleCandidates).toBe(0);
    expect(executions.lookups).toEqual([]);
  });

  it('treats the status index as candidates only: a consistent read that shows progress wins', async () => {
    const moved = await seed('PROCESSING');
    const finished = await seed('PROCESSING', { result: '{}' });
    await store.recordSuccess(finished, NOW);
    // Simulate an eventually consistent index that still lists both as stale PROCESSING jobs.
    const laggingIndex: JobStateStore = Object.assign(Object.create(store) as JobStateStore, {
      listStale: async (status: string) =>
        status === 'PROCESSING'
          ? [moved, finished].map((jobId) => ({
              jobId,
              status: 'PROCESSING' as const,
              updatedAt: OLD,
            }))
          : [],
    });
    store.patchState(moved, { updatedAt: RECENT });
    const summary = await run({}, { store: laggingIndex });
    expect(summary).toMatchObject({ staleCandidates: 2, skippedNotStale: 2, markedFailed: 0 });
    expect(executions.lookups).toEqual([]);
    expect((await store.get(finished))?.status).toBe('SUCCEEDED');
  });

  it.each([
    ['FAILED', ReconciliationError.ExecutionFailed],
    ['TIMED_OUT', ReconciliationError.ExecutionTimedOut],
    ['ABORTED', ReconciliationError.ExecutionAborted],
  ] as const)(
    'closes a job whose execution ended %s, conditioned on the observed status and version',
    async (status, errorName) => {
      const jobId = await seed('PROCESSING', { result: '{"partial":true}' });
      executions.states.set(jobId, { status });
      const observed = (await store.get(jobId))!;
      const spy = vi.spyOn(store, 'recordFailure');
      const summary = await run();
      expect(summary).toMatchObject({ markedFailed: 1, conflicts: 0, dependencyErrors: 0 });
      expect(spy).toHaveBeenCalledWith(
        jobId,
        { name: errorName, message: expect.stringContaining('closed by the stale-job reconciler') },
        NOW,
        { expectedStatus: 'PROCESSING', expectedVersion: observed.version },
      );
      const after = await store.get(jobId);
      expect(after).toMatchObject({ status: 'FAILED', errorName, version: observed.version + 1 });
      expect(after?.resultJson).toBeUndefined();
      expect(executions.lookups).toEqual([{ jobId, executionArn: ARN(jobId) }]);
    },
  );

  it('closes a never-started PENDING job as WorkflowNotStarted and never starts a workflow', async () => {
    const jobId = await seed('PENDING', { executionArn: false });
    const summary = await run();
    expect(summary.markedFailed).toBe(1);
    expect(await store.get(jobId)).toMatchObject({
      status: 'FAILED',
      errorName: ReconciliationError.WorkflowNotStarted,
    });
    // Looked up by the deterministic name only (no ARN); the source has no way to start anything.
    expect(executions.lookups).toEqual([{ jobId, executionArn: undefined }]);
    expect(Object.keys(executions)).not.toContain('start');
  });

  it('closes a job whose recorded execution no longer exists as ExecutionNotFound', async () => {
    const jobId = await seed('VALIDATING');
    await run();
    expect((await store.get(jobId))?.errorName).toBe(ReconciliationError.ExecutionNotFound);
  });

  it('completes a PROCESSING job with a stored result whose execution SUCCEEDED (anomaly)', async () => {
    const jobId = await seed('PROCESSING', { result: '{"wordCount":12}' });
    executions.states.set(jobId, { status: 'SUCCEEDED' });
    const summary = await run();
    expect(summary).toMatchObject({ completed: 1, anomalies: 1, markedFailed: 0 });
    expect(await store.get(jobId)).toMatchObject({
      status: 'SUCCEEDED',
      resultJson: '{"wordCount":12}',
    });
  });

  it('marks a SUCCEEDED execution without a stored result as ExecutionStateMismatch', async () => {
    const jobId = await seed('PROCESSING');
    executions.states.set(jobId, { status: 'SUCCEEDED' });
    const summary = await run();
    expect(summary).toMatchObject({ markedFailed: 1, anomalies: 1 });
    expect((await store.get(jobId))?.errorName).toBe(ReconciliationError.StateMismatch);
  });

  it('dry run: decides and counts, writes nothing', async () => {
    const failed = await seed('PROCESSING');
    executions.states.set(failed, { status: 'FAILED' });
    const notStarted = await seed('PENDING', { executionArn: false });
    const before = [await store.get(failed), await store.get(notStarted)];
    const summary = await run({ dryRun: true });
    expect(summary).toMatchObject({ dryRun: true, dryRunDecisions: 2, markedFailed: 0 });
    expect([await store.get(failed), await store.get(notStarted)]).toEqual(before);
    expect(log.lines.filter((l) => l.outcome === 'dry-run')).toHaveLength(2);
  });

  it('examines at most batchSize jobs per run, oldest first, then continues next run', async () => {
    const pending: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      pending.push(
        await seed('PENDING', {
          at: `2026-10-14T00:00:${String(i).padStart(2, '0')}.000Z`,
          executionArn: false,
        }),
      );
    }
    for (let i = 0; i < 3; i += 1) await seed('VALIDATING');
    const first = await run({ batchSize: 10 });
    expect(first).toMatchObject({ staleCandidates: 10, examined: 10, markedFailed: 10 });
    expect((await store.get(pending[0]!))?.status).toBe('FAILED');
    expect((await store.get(pending[11]!))?.status).toBe('PENDING');
    const second = await run({ batchSize: 10 });
    expect(second).toMatchObject({ staleCandidates: 5, markedFailed: 5 });
  });

  it('stops examining jobs when the time budget is used up', async () => {
    for (let i = 0; i < 5; i += 1) await seed('PENDING', { executionArn: false });
    let tick = Date.parse(NOW);
    const summary = await reconcileStaleJobs(
      { store, executions, logger: log.logger, now: () => new Date((tick += 1_000)) },
      { ...OPTIONS, maxRuntimeMs: 4_500 },
    );
    expect(summary.outOfTime).toBe(true);
    expect(summary.examined).toBeLessThan(5);
    expect(summary.markedFailed).toBe(summary.examined);
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    const jobId = await seed('VALIDATING');
    executions.states.set(jobId, { status: 'TIMED_OUT' });
    await run();
    const version = (await store.get(jobId))?.version;
    const again = await run();
    expect(again).toMatchObject({ staleCandidates: 0, markedFailed: 0 });
    expect((await store.get(jobId))?.version).toBe(version);
  });

  it('is safe under concurrency: two runs transition each job exactly once', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seed('PENDING', { executionArn: false }));
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.markedFailed + b.markedFailed).toBe(5);
    for (const id of ids)
      expect(await store.get(id)).toMatchObject({ status: 'FAILED', version: 2 });
  });

  it('loses (and counts a conflict) when the workflow records the outcome concurrently', async () => {
    const jobId = await seed('PROCESSING', { result: '{"ok":true}' });
    // Stale view: the reconciler sees FAILED while RecordSuccess lands before its write.
    executions.describe = async (job) => {
      executions.lookups.push(job);
      await store.recordSuccess(jobId, NOW);
      return { status: 'FAILED' };
    };
    const summary = await run();
    expect(summary).toMatchObject({ markedFailed: 0, conflicts: 1 });
    expect((await store.get(jobId))?.status).toBe('SUCCEEDED');
  });

  describe('dependency outages: no transition, an error metric, the run stops', () => {
    it.each([
      ['DescribeExecution is throttled', () => executions.failNext(throttling())],
      [
        'DescribeExecution fails',
        () => executions.failNext(Object.assign(new Error('x'), { name: 'InternalServerError' })),
      ],
      ['the DynamoDB read fails', () => store.failNext('get', throttling())],
      ['the DynamoDB write fails', () => store.failNext('recordFailure', new Error('ECONNRESET'))],
    ])('%s', async (_name, inject) => {
      const first = await seed('PENDING', { executionArn: false });
      const second = await seed('PENDING', { executionArn: false, at: '2026-10-14T00:00:01.000Z' });
      const before = [await store.get(first), await store.get(second)];
      inject();
      const summary = await run();
      expect(summary).toMatchObject({ aborted: true, dependencyErrors: 1, markedFailed: 0 });
      expect([await store.get(first), await store.get(second)]).toEqual(before);
      const error = log.lines.find((l) => l.level === 'error');
      expect(error).toMatchObject({
        actor: RECONCILER_ACTOR,
        msg: 'reconciler dependency failure; run stopped without a transition',
        errorName: expect.any(String),
      });
    });

    it('the status index query fails', async () => {
      await seed('PENDING', { executionArn: false });
      store.failNext('listStale', throttling());
      const summary = await run();
      expect(summary).toMatchObject({ aborted: true, dependencyErrors: 1, examined: 0 });
    });
  });

  it('logs every transition as system:reconciler, never document data', async () => {
    const jobId = await seed('PROCESSING', {
      result: '{"topTerms":[{"term":"zzsecretterm","count":2}]}',
    });
    executions.states.set(jobId, { status: 'FAILED', error: 'RecordFailureFailed' });
    await run();
    const transition = log.lines.find((l) => l.msg === 'reconciler transition');
    expect(transition).toMatchObject({
      actor: RECONCILER_ACTOR,
      jobId,
      observedStatus: 'PROCESSING',
      executionStatus: 'FAILED',
      executionError: 'RecordFailureFailed',
      action: 'fail',
      outcome: 'applied',
      newStatus: 'FAILED',
    });
    expect(log.raw.join('\n')).not.toContain('zzsecretterm');
  });

  it('refuses a threshold inside the execution timeout + grace, and unbounded batches', () => {
    expect(RECONCILER_MIN_STALE_AFTER_SECONDS).toBe(RECONCILIATION.minimumStaleAfterSeconds);
    expect(() => validateOptions({ ...OPTIONS, staleAfterSeconds: 600 })).toThrow(RangeError);
    expect(() => validateOptions({ ...OPTIONS, batchSize: 0 })).toThrow(RangeError);
    expect(() => validateOptions({ ...OPTIONS, batchSize: 101 })).toThrow(RangeError);
  });
});
