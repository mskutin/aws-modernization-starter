import { InMemoryJobStateStore } from '@starter/job-state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandler, SAFETY_MARGIN_MS } from '../src/index.js';
import { FakeExecutions, capturingLogger } from './helpers.js';

const settings = { staleAfterSeconds: 900, batchSize: 25, dryRun: false, maxRuntimeSeconds: 45 };

describe('reconciler Lambda handler', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('runs one bounded pass, ignores the event and emits one EMF record', async () => {
    const store = new InMemoryJobStateStore();
    const jobId = '4194b63d-9c1e-4c8a-9f43-1a2b3c4d5e6f';
    await store.createInitial(jobId, '2026-10-14T00:00:00.000Z');
    const { logger, lines } = capturingLogger();
    const handler = createHandler(() => ({
      store,
      executions: new FakeExecutions(),
      logger,
      settings,
      environment: 'dev',
      now: () => new Date('2026-10-14T01:00:00.000Z'),
    }));
    const summary = await handler(
      { 'detail-type': 'Scheduled Event', detail: { dryRun: false, injected: '<x>' } },
      {
        awsRequestId: 'req-1',
        functionName: 'starter-dev-reconciler',
        getRemainingTimeInMillis: () => 60_000,
      },
    );
    expect(summary).toMatchObject({ markedFailed: 1, dryRun: false });
    const emf = lines.filter((l) => l.msg === 'reconciler metrics');
    expect(emf).toHaveLength(1);
    expect(emf[0]).toMatchObject({ Environment: 'dev', MarkedFailed: 1, requestId: 'req-1' });
  });

  it('keeps a safety margin before the Lambda timeout', async () => {
    const store = new InMemoryJobStateStore();
    for (let i = 0; i < 3; i += 1) {
      await store.createInitial(
        `00000000-0000-4000-8000-00000000000${i}`,
        '2026-10-14T00:00:00.000Z',
      );
    }
    let tick = Date.parse('2026-10-14T01:00:00.000Z');
    const handler = createHandler(() => ({
      store,
      executions: new FakeExecutions(),
      logger: capturingLogger().logger,
      settings,
      environment: 'dev',
      now: () => new Date((tick += 1_000)),
    }));
    // 7 s remaining − 5 s margin = 2 s budget: the clock advances 1 s per call.
    const summary = await handler(
      {},
      {
        awsRequestId: 'r',
        functionName: 'f',
        getRemainingTimeInMillis: () => SAFETY_MARGIN_MS + 2_000,
      },
    );
    expect(summary.outOfTime).toBe(true);
  });

  it('fails fast with ConfigError when the environment is incomplete', async () => {
    vi.stubEnv('JOBS_TABLE_NAME', 'starter-jobs');
    vi.stubEnv('AWS_REGION', 'ap-southeast-1');
    vi.stubEnv('STATE_MACHINE_ARN', '');
    const { handler } = await import('../src/handler.js');
    await expect(handler({}, { awsRequestId: 'r', functionName: 'f' })).rejects.toMatchObject({
      name: 'ConfigError',
      message: expect.stringContaining('STATE_MACHINE_ARN: is required'),
    });
  });
});
