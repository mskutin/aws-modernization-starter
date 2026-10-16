/**
 * The in-process reconciler of the LOCAL SIMULATION (not Step Functions): the simulator is the
 * authoritative execution state, for this process only.
 */
import { JobValidationError } from '@starter/domain';
import { InMemoryDocumentSource } from '@starter/documents';
import { InMemoryJobStateStore } from '@starter/job-state';
import { VALID_DOCUMENT, anExecutionInput } from '@starter/testing';
import { ReconciliationError } from '@starter/workflow-processing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalReconcilerLoop, simulatorExecutions } from '../../src/reconciler-loop.js';
import { LocalWorkflowSimulator } from '../../src/workflow/local-simulator.js';
import { capturingLogger } from './fakes.js';

const OLD = '2026-10-14T00:00:00.000Z';
const LATER = new Date('2026-10-14T01:00:00.000Z');
const CONFIG = {
  staleAfterSeconds: 900,
  batchSize: 25,
  dryRun: false,
  maxRuntimeSeconds: 30,
  intervalSeconds: 60,
};

async function setup(steps?: ConstructorParameters<typeof LocalWorkflowSimulator>[0]['steps']) {
  const store = new InMemoryJobStateStore();
  const documents = new InMemoryDocumentSource();
  const { logger, lines } = capturingLogger();
  const simulator = new LocalWorkflowSimulator({
    store,
    documents,
    logger,
    sleep: async () => undefined,
    now: () => new Date(OLD),
    ...(steps ? { steps } : {}),
  });
  const loop = new LocalReconcilerLoop({
    store,
    simulator,
    logger,
    config: CONFIG,
    environment: 'local',
    now: () => LATER,
  });
  return { store, documents, simulator, loop, lines };
}

describe('local reconciler loop (LOCAL SIMULATION)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes a job whose simulated RecordFailure could not be written (RecordingFailed)', async () => {
    const { store, simulator, loop } = await setup({
      validate: async () => {
        throw new JobValidationError('Document rejected: too short');
      },
    });
    const input = anExecutionInput({ submittedAt: OLD });
    await store.createInitial(input.jobId, OLD);
    store.failNext('recordFailure', new Error('dynamodb down'), 3);
    await simulator.start(input);
    await simulator.waitFor(input.jobId);
    expect((await store.get(input.jobId))?.status).toBe('PENDING');
    expect(simulator.describe(input.jobId)).toBe('FAILED');

    const summary = await loop.runOnce();
    expect(summary.markedFailed).toBe(1);
    expect(await store.get(input.jobId)).toMatchObject({
      status: 'FAILED',
      errorName: ReconciliationError.ExecutionFailed,
    });
  });

  it('closes a job that never started, and one whose simulation was lost with a restart', async () => {
    const { store, loop } = await setup();
    const neverStarted = anExecutionInput();
    await store.createInitial(neverStarted.jobId, OLD);
    const lost = anExecutionInput();
    await store.createInitial(lost.jobId, OLD);
    await store.attachExecution(lost.jobId, 'local-simulation:job-processing:job-lost');
    await store.transition(lost.jobId, 'VALIDATING', OLD);

    await loop.runOnce();
    expect((await store.get(neverStarted.jobId))?.errorName).toBe(
      ReconciliationError.WorkflowNotStarted,
    );
    expect((await store.get(lost.jobId))?.errorName).toBe(ReconciliationError.ExecutionNotFound);
  });

  it('leaves a job whose simulated execution is still running alone', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, documents, simulator, loop } = await setup({
      validate: async () => {
        await gate;
        throw new JobValidationError('later');
      },
    });
    const input = anExecutionInput({ submittedAt: OLD });
    documents.put(input.jobId, { title: 't', content: VALID_DOCUMENT });
    await store.createInitial(input.jobId, OLD);
    await simulator.start(input);
    await expect(simulatorExecutions(simulator).describe({ jobId: input.jobId })).resolves.toEqual({
      status: 'RUNNING',
    });
    const summary = await loop.runOnce();
    expect(summary).toMatchObject({ skippedRunning: 1, markedFailed: 0 });
    expect((await store.get(input.jobId))?.status).toBe('PENDING');
    release();
    await simulator.waitFor(input.jobId);
  });

  it('runs on its interval without overlap and stops cleanly', async () => {
    vi.useFakeTimers();
    const { loop } = await setup();
    const runOnce = vi.spyOn(loop, 'runOnce');
    loop.start();
    loop.start(); // idempotent
    await vi.advanceTimersByTimeAsync(CONFIG.intervalSeconds * 1_000);
    expect(runOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CONFIG.intervalSeconds * 1_000);
    expect(runOnce).toHaveBeenCalledTimes(2);
    await loop.stop();
    await vi.advanceTimersByTimeAsync(10 * CONFIG.intervalSeconds * 1_000);
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the interval is 0 (the default)', async () => {
    vi.useFakeTimers();
    const store = new InMemoryJobStateStore();
    const { logger } = capturingLogger();
    const loop = new LocalReconcilerLoop({
      store,
      simulator: { describe: () => 'NOT_FOUND' },
      logger,
      config: { ...CONFIG, intervalSeconds: 0 },
      environment: 'local',
    });
    const runOnce = vi.spyOn(loop, 'runOnce');
    loop.start();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(runOnce).not.toHaveBeenCalled();
  });
});
