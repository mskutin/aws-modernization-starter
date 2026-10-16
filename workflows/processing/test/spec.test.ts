import { describe, expect, it } from 'vitest';
import {
  EXECUTION_INPUT_KEYS,
  STEP_CLIENT_SETTINGS,
  STEP_DEPENDENCY_CALLS,
  attemptBudgetSeconds,
  dynamoDbCallBudgetSeconds,
  ExecutionInputError,
  PROCESSING_WORKFLOW,
  ProcessingState,
  RECONCILIATION,
  ReconciliationError,
  TASK_EVENT_KEYS,
  TERMINAL_STATUSES,
  WORKFLOW_SPEC_VERSION,
  WorkflowError,
  WorkflowStatus,
  assertExecutionInput,
  RECONCILER_METRICS,
  executionArnFor,
  executionNameFor,
  idempotencyKey,
  jobStateKey,
  jobStepKey,
  maxRetryDelaySeconds,
  serializeExecutionInput,
  statusIndexKey,
  worstCaseExecutionSeconds,
  worstCaseTaskSeconds,
  type ProcessingExecutionInput,
  type RetryPolicy,
} from '../src/spec.js';

describe('execution timeout budget', () => {
  it('exceeds the worst-case path through every timeout and retry (execution timeouts cannot be caught)', () => {
    expect(PROCESSING_WORKFLOW.executionTimeoutSeconds).toBeGreaterThan(
      worstCaseExecutionSeconds(),
    );
  });

  it('would not have been covered by the previous 300 s ceiling (regression guard)', () => {
    expect(worstCaseExecutionSeconds()).toBeGreaterThan(300);
  });

  it.each(['validate', 'process'] as const)(
    'fits one %s attempt (cold start + PostgreSQL connect/query + DynamoDB calls at their client timeouts) inside the task timeout',
    (task) => {
      // A dependency that hangs must surface as a classified TransientDependencyError (retried),
      // not as States.Timeout (ValidateJob does not retry timeouts: the job would fail).
      expect(attemptBudgetSeconds(STEP_DEPENDENCY_CALLS[task])).toBeLessThan(
        PROCESSING_WORKFLOW.tasks[task].timeoutSeconds,
      );
    },
  );

  it('keeps the execution timeout above the worst case with the DB-inclusive task timeouts', () => {
    expect(PROCESSING_WORKFLOW.tasks.validate.timeoutSeconds).toBe(20);
    expect(worstCaseExecutionSeconds()).toBe(511);
    expect(
      PROCESSING_WORKFLOW.executionTimeoutSeconds - worstCaseExecutionSeconds(),
    ).toBeGreaterThanOrEqual(60);
  });

  it('bounds the Lambda clients: one PostgreSQL connection, short DynamoDB retries', () => {
    expect(STEP_CLIENT_SETTINGS.db.poolMax).toBe(1);
    expect(STEP_CLIENT_SETTINGS.db.queryTimeoutMs).toBeGreaterThan(
      STEP_CLIENT_SETTINGS.db.statementTimeoutMs,
    );
    expect(dynamoDbCallBudgetSeconds()).toBe(3.5);
    expect(
      dynamoDbCallBudgetSeconds({
        maxAttempts: 3,
        requestTimeoutMs: 3_000,
        connectionTimeoutMs: 1_000,
      }),
    ).toBe(12.5);
  });

  it('computes the worst case from task timeouts, retries and capped backoff', () => {
    const policy: RetryPolicy = {
      errors: ['E'],
      intervalSeconds: 2,
      maxAttempts: 4,
      backoffRate: 2,
      maxDelaySeconds: 10,
      jitter: 'FULL',
    };
    expect(maxRetryDelaySeconds(policy)).toBe(2 + 4 + 8 + 10);
    expect(worstCaseTaskSeconds({ timeoutSeconds: 60, retry: [policy] })).toBe(5 * 60 + 24);
    expect(worstCaseTaskSeconds({ timeoutSeconds: 15, retry: [] })).toBe(15);
  });
});

describe('task policies', () => {
  const tasks = Object.values(PROCESSING_WORKFLOW.tasks);

  it.each([WorkflowError.Validation, WorkflowError.DocumentUnavailable])(
    'never retry the permanent error %s',
    (permanent) => {
      for (const task of tasks) {
        expect(task.retry.flatMap((policy) => policy.errors)).not.toContain(permanent);
        expect(task.retry.flatMap((policy) => policy.errors)).not.toContain('States.ALL');
      }
    },
  );

  it('route every remaining error to the failure path', () => {
    for (const task of tasks) expect(task.catch).toEqual(['States.ALL']);
  });

  it('retry the record states on transient DynamoDB errors only', () => {
    const errors = PROCESSING_WORKFLOW.recordStates.retry.flatMap((policy) => policy.errors);
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) expect(error).toMatch(/^DynamoDB\./);
  });

  it('has unique state names', () => {
    const names = Object.values(ProcessingState);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('identifiers and key layout', () => {
  it('derives a deterministic, sanitised execution name within the 80-character limit', () => {
    expect(executionNameFor('4194b63d-9c1e-4c8a-9f43-1a2b3c4d5e6f')).toBe(
      'job-4194b63d-9c1e-4c8a-9f43-1a2b3c4d5e6f',
    );
    expect(executionNameFor('a/b c')).toBe('job-a-b-c');
    expect(executionNameFor('x'.repeat(200))).toHaveLength(80);
  });

  it('derives the execution ARN from the state machine ARN and the execution name', () => {
    expect(
      executionArnFor(
        'arn:aws:states:ap-southeast-1:123456789012:stateMachine:starter-dev-job-processing',
        executionNameFor('j1'),
      ),
    ).toBe(
      'arn:aws:states:ap-southeast-1:123456789012:execution:starter-dev-job-processing:job-j1',
    );
  });

  it('names the reconciler metrics uniquely', () => {
    const names = Object.values(RECONCILER_METRICS.names);
    expect(new Set(names).size).toBe(names.length);
    expect(RECONCILER_METRICS.names.dependencyErrors).toBe('DependencyErrors');
  });

  it('builds the single-table keys of the spec', () => {
    expect(jobStateKey('j1')).toEqual({ pk: 'JOB#j1', sk: 'STATE' });
    expect(jobStepKey('j1', '2026-10-14T00:00:00.000Z', ProcessingState.Validate)).toEqual({
      pk: 'JOB#j1',
      sk: 'STEP#2026-10-14T00:00:00.000Z#ValidateJob',
    });
    expect(idempotencyKey('k1')).toEqual({ pk: 'IDEMPOTENCY#k1', sk: 'IDEMPOTENCY' });
    expect(statusIndexKey(WorkflowStatus.Failed, '2026-10-14T00:00:00.000Z', 'j1')).toEqual({
      gsi1pk: 'STATUS#FAILED',
      gsi1sk: '2026-10-14T00:00:00.000Z#j1',
    });
  });

  it('treats exactly SUCCEEDED and FAILED as terminal', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual([
      WorkflowStatus.Failed,
      WorkflowStatus.Succeeded,
    ]);
  });
});

describe('execution input (spec 2.0.0: job reference + non-sensitive metadata only)', () => {
  const input: ProcessingExecutionInput = {
    jobId: '4194b63d-9c1e-4c8a-9f43-1a2b3c4d5e6f',
    contractVersion: '1.0.0',
    submittedAt: '2026-10-14T00:00:00.000Z',
  };
  const CANARY = 'CANARY-7f3a document text that must never leave PostgreSQL';

  it('is a major version bump of the 1.x payload-carrying contract', () => {
    expect(WORKFLOW_SPEC_VERSION).toBe('2.0.0');
    expect(PROCESSING_WORKFLOW.version).toBe(WORKFLOW_SPEC_VERSION);
  });

  it('has exactly jobId, contractVersion and submittedAt; tasks additionally get executionArn', () => {
    expect([...EXECUTION_INPUT_KEYS]).toEqual(['jobId', 'contractVersion', 'submittedAt']);
    expect([...TASK_EVENT_KEYS]).toEqual([...EXECUTION_INPUT_KEYS, 'executionArn']);
    expect(() => assertExecutionInput(input)).not.toThrow();
  });

  it.each([
    ['a reintroduced payload', { ...input, payload: { title: 't', content: CANARY } }, /payload/],
    ['the idempotency key (a content hash)', { ...input, idempotencyKey: 'derived:v1:ab' }, /idem/],
    ['a title', { ...input, title: CANARY }, /unexpected: title/],
    ['a missing field', { jobId: input.jobId, contractVersion: '1.0.0' }, /missing: submittedAt/],
    ['an empty field', { ...input, jobId: '' }, /jobId must be a non-empty string/],
    ['a non-string field', { ...input, submittedAt: 7 }, /submittedAt/],
    ['an array', [input], /JSON object/],
    ['null', null, /JSON object/],
  ])('rejects %s without echoing any value', (_name, value, message) => {
    let caught: unknown;
    try {
      assertExecutionInput(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecutionInputError);
    expect((caught as Error).message).toMatch(message);
    expect((caught as Error).message).not.toContain(CANARY);
    expect((caught as Error).message).not.toContain('derived:v1');
  });

  it('serialises canonically (same bytes whatever the key order) for idempotent StartExecution', () => {
    const reordered = {
      submittedAt: input.submittedAt,
      jobId: input.jobId,
      contractVersion: input.contractVersion,
    };
    expect(serializeExecutionInput(reordered)).toBe(serializeExecutionInput(input));
    expect(JSON.parse(serializeExecutionInput(input))).toEqual(input);
    expect(Object.keys(JSON.parse(serializeExecutionInput(input)) as object)).toEqual([
      ...EXECUTION_INPUT_KEYS,
    ]);
    expect(() =>
      serializeExecutionInput({ ...input, payload: CANARY } as ProcessingExecutionInput),
    ).toThrow(ExecutionInputError);
  });
});

describe('reconciliation constants', () => {
  it('only treats a job as stale after the execution timeout plus a grace period', () => {
    expect(RECONCILIATION.minimumStaleAfterSeconds).toBe(
      PROCESSING_WORKFLOW.executionTimeoutSeconds + RECONCILIATION.graceSeconds,
    );
    expect(RECONCILIATION.graceSeconds).toBeGreaterThan(0);
  });

  it('examines exactly the non-terminal statuses', () => {
    const nonTerminal = Object.values(WorkflowStatus).filter((s) => !TERMINAL_STATUSES.has(s));
    expect([...RECONCILIATION.statuses].sort()).toEqual(nonTerminal.sort());
  });

  it('closes never-started jobs with a distinct reason (no restart)', () => {
    expect(ReconciliationError.WorkflowNotStarted).toBe('WorkflowNotStarted');
    expect(Object.keys(ReconciliationError)).not.toContain('StartFailed');
  });

  it('uses unique failure names that are never shown to clients verbatim', () => {
    const names = Object.values(ReconciliationError);
    expect(new Set(names).size).toBe(names.length);
    // The API shows only JobValidationError messages verbatim (publicJobError).
    expect(names).not.toContain(WorkflowError.Validation);
    for (const name of names) expect(name).toMatch(/^[A-Za-z]+$/);
  });
});
