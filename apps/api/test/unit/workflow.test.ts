import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import { analyzeDocument, JobValidationError, TransientDependencyError } from '@starter/domain';
import { InMemoryDocumentSource } from '@starter/documents';
import { InMemoryJobStateStore } from '@starter/job-state';
import {
  TOO_SHORT_DOCUMENT,
  VALID_DOCUMENT,
  anExecutionInput,
  steppingClock,
} from '@starter/testing';
import {
  ExecutionInputError,
  PROCESSING_WORKFLOW,
  executionNameFor,
  type ProcessingExecutionInput,
} from '@starter/workflow-processing';
import { describe, expect, it, vi } from 'vitest';
import {
  LOCAL_SIMULATION_WARNING,
  LocalWorkflowSimulator,
} from '../../src/workflow/local-simulator.js';
import { StepFunctionsWorkflow, executionArnFor } from '../../src/workflow/step-functions.js';
import { capturingLogger } from './fakes.js';

const SM_ARN = 'arn:aws:states:ap-southeast-1:123456789012:stateMachine:job-processing';

describe('StepFunctionsWorkflow', () => {
  const workflowWith = (send: (command: StartExecutionCommand) => Promise<unknown>) =>
    new StepFunctionsWorkflow({
      client: { send: send as never },
      stateMachineArn: SM_ARN,
      logger: capturingLogger().logger,
    });

  it('starts an execution named after the job with the canonical minimal input', async () => {
    const send = vi.fn(async (command: StartExecutionCommand) => ({
      executionArn: executionArnFor(SM_ARN, command.input.name ?? ''),
      startDate: new Date(),
      $metadata: {},
    }));
    const input = anExecutionInput();
    const result = await workflowWith(send).start(input);
    const command = send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(StartExecutionCommand);
    expect(command.input).toEqual({
      stateMachineArn: SM_ARN,
      name: executionNameFor(input.jobId),
      input: JSON.stringify({
        jobId: input.jobId,
        contractVersion: input.contractVersion,
        submittedAt: input.submittedAt,
      }),
    });
    expect(result).toEqual({
      executionArn: `arn:aws:states:ap-southeast-1:123456789012:execution:job-processing:job-${input.jobId}`,
      alreadyStarted: false,
    });
  });

  it('refuses (before any call) an input with a reintroduced payload or idempotency key', async () => {
    const send = vi.fn();
    const workflow = workflowWith(send);
    const input = anExecutionInput();
    for (const extra of [{ payload: { content: 'x' } }, { idempotencyKey: 'derived:v1:abc' }]) {
      await expect(
        workflow.start({ ...input, ...extra } as ProcessingExecutionInput),
      ).rejects.toBeInstanceOf(ExecutionInputError);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('treats ExecutionAlreadyExists as an idempotent start', async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error('exists'), { name: 'ExecutionAlreadyExists' });
    });
    const input = anExecutionInput();
    await expect(workflowWith(send).start(input)).resolves.toEqual({
      executionArn: executionArnFor(SM_ARN, executionNameFor(input.jobId)),
      alreadyStarted: true,
    });
  });

  it('propagates other errors (e.g. AccessDenied)', async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    });
    await expect(workflowWith(send).start(anExecutionInput())).rejects.toThrow('denied');
  });

  it('still refuses inputs above the 256 KiB Step Functions limit', async () => {
    const send = vi.fn();
    const huge = anExecutionInput({ jobId: 'x'.repeat(270_000) });
    await expect(workflowWith(send).start(huge)).rejects.toThrow(/exceeds 262144 bytes/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('LocalWorkflowSimulator (LOCAL SIMULATION — not Step Functions)', () => {
  async function setup(
    options: Partial<ConstructorParameters<typeof LocalWorkflowSimulator>[0]> = {},
  ) {
    const store = new InMemoryJobStateStore();
    const documents = new InMemoryDocumentSource();
    const { logger, lines } = capturingLogger();
    const delays: number[] = [];
    const simulator = new LocalWorkflowSimulator({
      store,
      documents,
      logger,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 1,
      now: steppingClock('2026-10-13T10:00:01.000Z'),
      ...options,
    });
    const run = async (
      input: ProcessingExecutionInput = anExecutionInput(),
      content = VALID_DOCUMENT,
    ) => {
      documents.put(input.jobId, { title: 'Migration notes', content, options: { topTerms: 10 } });
      await store.createInitial(input.jobId, '2026-10-13T10:00:00.000Z');
      await simulator.start(input);
      await simulator.waitFor(input.jobId);
      return { input, state: await store.get(input.jobId) };
    };
    return { store, documents, simulator, lines, delays, run };
  }

  it('announces itself as a simulation', async () => {
    const { lines, run } = await setup();
    await run();
    expect(
      lines.filter((l) => String(l.msg).startsWith(LOCAL_SIMULATION_WARNING)).length,
    ).toBeGreaterThanOrEqual(2);
    const executionLines = lines.filter((l) => /execution/.test(String(l.msg)));
    expect(executionLines.length).toBeGreaterThanOrEqual(2);
    expect(
      executionLines.every((l) => l.simulation === true && l.workflow === 'job-processing'),
    ).toBe(true);
  });

  it('runs validate → process (stores the result) → RecordSuccess with the real step code', async () => {
    const { store, run } = await setup();
    const { input, state } = await run();
    expect(state).toMatchObject({ status: 'SUCCEEDED' });
    expect(JSON.parse(state!.resultJson!)).toEqual(
      analyzeDocument(VALID_DOCUMENT, { topTerms: 10 }),
    );
    expect((await store.listSteps(input.jobId)).map((s) => s.state)).toEqual([
      'ValidateJob',
      'ProcessJob',
    ]);
  });

  it('passes the steps exactly the task event (execution input + executionArn)', async () => {
    const events: unknown[] = [];
    const { validateStep } = await import('@starter/fn-validator');
    const { run, simulator } = await setup({
      steps: {
        validate: async (raw, deps) => {
          events.push(raw);
          return validateStep(raw, deps);
        },
      },
    });
    const { input } = await run();
    expect(events).toEqual([{ ...input, executionArn: simulator.executionArnFor(input.jobId) }]);
  });

  it('refuses to start with a reintroduced payload', async () => {
    const { simulator } = await setup();
    const input = { ...anExecutionInput(), payload: { content: 'x' } };
    await expect(simulator.start(input as ProcessingExecutionInput)).rejects.toBeInstanceOf(
      ExecutionInputError,
    );
    expect(simulator.running).toBe(0);
  });

  it('routes a business-rule rejection to RecordFailure without retrying', async () => {
    const validate = vi.fn(async () => {
      throw new JobValidationError('Document rejected: too short');
    });
    const { run, delays } = await setup({ steps: { validate } });
    const { state } = await run();
    expect(state).toMatchObject({ status: 'FAILED', errorName: 'JobValidationError' });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('fails a real too-short document with JobValidationError', async () => {
    const { run } = await setup();
    const { state } = await run(anExecutionInput(), TOO_SHORT_DOCUMENT);
    expect(state).toMatchObject({ status: 'FAILED', errorName: 'JobValidationError' });
    expect(state?.errorMessage).toMatch(/at least 10 are required/);
  });

  it('fails permanently (no retry) when the document is unavailable', async () => {
    const { run, documents, delays } = await setup();
    const input = anExecutionInput();
    const finished = run(input);
    documents.purge(input.jobId); // purged between submission and validation
    const { state } = await finished;
    expect(state).toMatchObject({ status: 'FAILED', errorName: 'DocumentUnavailableError' });
    expect(delays).toEqual([]);
  });

  it('retries a document-store outage with the spec back-off, then succeeds', async () => {
    const { run, documents, delays } = await setup();
    documents.failNext(Object.assign(new Error('terminating connection'), { code: '57P01' }), 2);
    const { state } = await run();
    const policy = PROCESSING_WORKFLOW.tasks.validate.retry[0]!;
    expect(delays).toEqual([
      policy.intervalSeconds * 1000,
      policy.intervalSeconds * policy.backoffRate * 1000,
    ]);
    expect(state?.status).toBe('SUCCEEDED');
  });

  it('retries transient errors with the spec back-off, then succeeds', async () => {
    let calls = 0;
    const { validateStep } = await import('@starter/fn-validator');
    const { run, delays } = await setup({
      steps: {
        validate: async (raw, deps) => {
          calls += 1;
          if (calls <= 2) throw new TransientDependencyError('throttled');
          return validateStep(raw, deps);
        },
      },
    });
    const { state } = await run();
    const policy = PROCESSING_WORKFLOW.tasks.validate.retry[0]!;
    // random() = 1 → FULL jitter yields the capped exponential delay itself.
    expect(delays).toEqual([
      policy.intervalSeconds * 1000,
      policy.intervalSeconds * policy.backoffRate * 1000,
    ]);
    expect(calls).toBe(3);
    expect(state?.status).toBe('SUCCEEDED');
  });

  it('gives up after MaxAttempts retries and records the transient error', async () => {
    let calls = 0;
    const { run } = await setup({
      steps: {
        validate: async () => {
          calls += 1;
          throw new TransientDependencyError('still throttled');
        },
      },
    });
    const { state } = await run();
    const maxAttempts = PROCESSING_WORKFLOW.tasks.validate.retry[0]!.maxAttempts;
    expect(calls).toBe(1 + maxAttempts);
    expect(state).toMatchObject({ status: 'FAILED', errorName: 'TransientDependencyError' });
  });

  it('applies TimeoutSeconds: validate timeouts fail, process timeouts are retried', async () => {
    let processCalls = 0;
    const { run } = await setup({
      timeScale: 0.001,
      steps: {
        process: async (raw, deps) => {
          processCalls += 1;
          if (processCalls === 1) return new Promise(() => {}); // hangs → States.Timeout
          const { processStep } = await import('@starter/fn-processor');
          return processStep(raw, deps);
        },
      },
    });
    const { state } = await run();
    expect(processCalls).toBe(2);
    expect(state?.status).toBe('SUCCEEDED');

    const hanging = await setup({
      timeScale: 0.001,
      steps: { validate: () => new Promise(() => {}) },
    });
    const failed = await hanging.run();
    expect(failed.state).toMatchObject({ status: 'FAILED', errorName: 'States.Timeout' });
  });

  it('does not start twice for the same job and drains in-flight work', async () => {
    const { store, documents, simulator } = await setup();
    const input = anExecutionInput();
    documents.put(input.jobId, { title: 't', content: VALID_DOCUMENT });
    await store.createInitial(input.jobId, '2026-10-13T10:00:00.000Z');
    const first = await simulator.start(input);
    const second = await simulator.start(input);
    expect(first.alreadyStarted).toBe(false);
    expect(second).toEqual({ executionArn: first.executionArn, alreadyStarted: true });
    expect(first.executionArn).toMatch(/^local-simulation:/);
    expect(simulator.describe(input.jobId)).toBe('RUNNING');
    await simulator.drain(5_000);
    expect(simulator.running).toBe(0);
    expect((await store.get(input.jobId))?.status).toBe('SUCCEEDED');
    expect((await simulator.start(input)).alreadyStarted).toBe(true);
  });

  it('describes executions of this process only (for the local reconciler)', async () => {
    const { run, simulator, store } = await setup({ outcomeMemory: 1 });
    const ok = await run();
    expect(simulator.describe(ok.input.jobId)).toBe('SUCCEEDED');
    const bad = await run(anExecutionInput(), TOO_SHORT_DOCUMENT);
    expect(simulator.describe(bad.input.jobId)).toBe('FAILED');
    // Bounded memory: the oldest outcome is forgotten.
    expect(simulator.describe(ok.input.jobId)).toBe('NOT_FOUND');
    expect(simulator.describe(anExecutionInput().jobId)).toBe('NOT_FOUND');
    expect(store.calls.get('recordSuccess')).toBe(1);
  });

  it('leaves the job in flight (for the reconciler) when RecordFailure cannot be written', async () => {
    const { run, store, lines } = await setup({
      steps: {
        validate: async () => {
          throw new JobValidationError('Document rejected: too short');
        },
      },
    });
    store.failNext('recordFailure', new Error('dynamodb down'), 3);
    const { state, input } = await run();
    expect(state?.status).toBe('PENDING');
    expect(
      lines.some((l) => l.msg === 'RecordFailure could not be written; job left in-flight'),
    ).toBe(true);
    expect(input.jobId).toBeDefined();
  });
});
