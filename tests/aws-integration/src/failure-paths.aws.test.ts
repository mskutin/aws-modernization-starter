/**
 * REAL AWS (opt-in, see aws-gate.ts): the failure behaviour of the deployed workflow — the retry
 * and catch paths of the spec (workflows/processing/src/spec.ts) observed in real execution
 * histories, with the attempts of every state counted from the history.
 *
 *   - transient processor failure that heals on retry (TEST fault: TransientDependencyError)
 *   - non-retryable processing failure from PRODUCTION code (stored result does not match the
 *     document → JobStateConflictError): one attempt, caught into RecordFailure
 *   - task timeout: ValidateJob outlasts its 20 s timeout (TEST fault: delay) → NOT retried,
 *     caught into RecordFailure — unlike an execution timeout (execution-timeout.aws.test.ts)
 *   - RecordFailure itself fails (non-conditional DynamoDB error on a deliberately malformed test
 *     item) → the explicit, alarmed RecordingFailed Fail state; the item is removed after
 *   - Lambda service errors: the processor throttled (reserved concurrency 0) → retried
 *     1 + maxAttempts times, then caught into RecordFailure (reverted in `finally`)
 *
 * TEST faults are written on the synthetic document of ONE job (`@starter/documents/test-faults`);
 * the mini-stack arms them with TEST_FAULT_INJECTION=enabled; stages never do.
 * Evidence (written BEFORE the assertions, so a failing run still leaves it):
 * reports/aws-integration/evidence/failure-*.json.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DeleteFunctionConcurrencyCommand,
  GetFunctionConcurrencyCommand,
  PutFunctionConcurrencyCommand,
} from '@aws-sdk/client-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { FAULT_ATTEMPTS_ATTRIBUTE, faultAttemptKey } from '@starter/documents/test-faults';
import {
  JobStateTable,
  PROCESSING_WORKFLOW,
  ProcessingState,
  WorkflowError,
  WorkflowStatus,
} from '@starter/workflow-processing';
import { VALID_DOCUMENT, aJobResult, anExecutionInput } from '@starter/testing';
import { resolveAwsGate } from './aws-gate.js';
import {
  LiveHarness,
  attemptsByState,
  unlessEmulatorGap,
  emulatorNotApplicable,
  lambdaTaskScheduled,
  titled,
  enteredStates,
  executionSummary,
  failedOnceWithoutRetry,
  historyOutline,
  recordEvidence,
  suiteTitle,
} from './live-harness.js';

const gate = await resolveAwsGate(process.env);
const title = gate.enabled
  ? suiteTitle('failure paths')
  : `${suiteTitle('failure paths')} [SKIPPED: ${gate.reason}]`;

describe.skipIf(!gate.enabled)(title, () => {
  let h: LiveHarness;
  const a = JobStateTable.attributes;
  const now = () => new Date().toISOString();
  const processRetry = PROCESSING_WORKFLOW.tasks.process.retry[0]!;
  const validateTimeout = PROCESSING_WORKFLOW.tasks.validate.timeoutSeconds;

  beforeAll(async () => {
    if (!gate.enabled) return;
    h = await LiveHarness.create(gate);
  });
  afterAll(() => {
    h?.destroy();
  });

  it.skipIf(emulatorNotApplicable('localExecutorErrorNames') !== undefined)(
    titled(
      'retry: a transient processor failure is retried with backoff and the job SUCCEEDS',
      'localExecutorErrorNames',
    ),
    async () => {
      const failures = 2;
      const fault = { kind: 'transient', step: ProcessingState.Process, failures } as const;
      const input = anExecutionInput({ submittedAt: now() });
      await h.seed(input, { title: 'transient retry', content: VALID_DOCUMENT }, { fault });
      const executionArn = await h.start(input);
      const done = await h.waitForCompletion(executionArn);
      const events = await h.history(executionArn);
      const attempts = attemptsByState(events);
      const scheduled = lambdaTaskScheduled(events).map((e) => e.timestamp?.getTime() ?? 0);
      // Gaps between consecutive ProcessJob attempts (scheduled[0] is ValidateJob).
      const gaps = scheduled.slice(2).map((t, i) => (t - scheduled[i + 1]!) / 1000);
      const counter = await h.ddb.send(
        new GetCommand({
          TableName: h.outputs.tableName,
          Key: faultAttemptKey(input.jobId, ProcessingState.Process),
          ConsistentRead: true,
        }),
      );
      const item = await h.stateItem(input.jobId);
      recordEvidence('failure-transient-retry', {
        jobId: input.jobId,
        fault,
        execution: executionSummary(done),
        attempts,
        secondsBetweenProcessAttempts: gaps,
        faultCounter: counter.Item?.[FAULT_ATTEMPTS_ATTRIBUTE],
        retryPolicy: processRetry,
        history: historyOutline(events),
        jobItem: { status: item?.[a.status], version: item?.[a.version] },
      });

      expect(done.status, done.cause ?? '').toBe('SUCCEEDED');
      expect(attempts[ProcessingState.Process]).toEqual({
        attempts: failures + 1,
        succeeded: 1,
        errors: Array<string>(failures).fill(WorkflowError.Transient),
      });
      expect(processRetry.errors).toContain(WorkflowError.Transient);
      // Retrying does not re-enter the state: one ProcessJob entry, one RecordSuccess.
      expect(enteredStates(events)).toEqual([
        ProcessingState.Validate,
        ProcessingState.Process,
        ProcessingState.RecordSuccess,
        ProcessingState.Succeeded,
      ]);
      expect(gaps).toHaveLength(failures);
      // The waits between attempts stay inside the spec's capped, jittered backoff (+ run time).
      unlessEmulatorGap(
        'retryJitterMaxDelay',
        'waits between attempts within MaxDelaySeconds',
        () => {
          for (const gap of gaps) expect(gap).toBeLessThanOrEqual(processRetry.maxDelaySeconds + 5);
        },
      );
      expect(counter.Item?.[FAULT_ATTEMPTS_ATTRIBUTE]).toBe(failures + 1);
      expect(item?.[a.status]).toBe(WorkflowStatus.Succeeded);
      expect(item?.[a.result]).toEqual(expect.any(String));
    },
  );

  it('processing failure (production code): a stored result that does not match the document fails ProcessJob once, caught into RecordFailure', async () => {
    const input = anExecutionInput({ submittedAt: now() });
    await h.seed(
      input,
      { title: 'integrity', content: VALID_DOCUMENT },
      // A result left on the item for ANOTHER document (checksum mismatch).
      { jobExtra: { [a.result]: JSON.stringify(aJobResult({ checksumSha256: '0'.repeat(64) })) } },
    );
    const executionArn = await h.start(input);
    const done = await h.waitForCompletion(executionArn);
    const events = await h.history(executionArn);
    const attempts = attemptsByState(events);
    const item = await h.stateItem(input.jobId);
    recordEvidence('failure-processing-nonretryable', {
      jobId: input.jobId,
      execution: executionSummary(done),
      attempts,
      enteredStates: enteredStates(events),
      jobItem: {
        status: item?.[a.status],
        errorName: item?.[a.errorName],
        resultRemoved: item?.[a.result] === undefined,
      },
    });

    expect(done.status).toBe('FAILED');
    unlessEmulatorGap(
      'failStatePaths',
      'execution error = JobStateConflictError and a Cause',
      () => {
        expect(done.error).toBe('JobStateConflictError');
        expect(done.cause ?? '').not.toBe('');
      },
    );
    const processError = attempts[ProcessingState.Process]?.errors.at(-1) ?? '';
    expect(failedOnceWithoutRetry(attempts[ProcessingState.Process], processError)).toBe(true);
    unlessEmulatorGap(
      'localExecutorErrorNames',
      'ProcessJob failed with JobStateConflictError',
      () => {
        expect(processError).toBe('JobStateConflictError');
      },
    );
    expect(processRetry.errors).not.toContain('JobStateConflictError');
    expect(enteredStates(events)).toEqual([
      ProcessingState.Validate,
      ProcessingState.Process,
      ProcessingState.FailureDefaults,
      ProcessingState.NormalizeError,
      ProcessingState.RecordFailure,
      ProcessingState.Failed,
    ]);
    expect(item?.[a.status]).toBe(WorkflowStatus.Failed);
    expect(item?.[a.errorName]).toBe(processError);
    // RecordFailure removes any derived data from a failed job.
    expect(item?.[a.result]).toBeUndefined();
  });

  it(`task timeout: ValidateJob outlasting its ${validateTimeout} s timeout is NOT retried and is caught into RecordFailure (execution FAILED, not TIMED_OUT)`, async () => {
    const fault = {
      kind: 'delay',
      step: ProcessingState.Validate,
      seconds: validateTimeout + 5,
    } as const;
    const input = anExecutionInput({ submittedAt: now() });
    await h.seed(input, { title: 'slow validation', content: VALID_DOCUMENT }, { fault });
    const executionArn = await h.start(input);
    const done = await h.waitForCompletion(executionArn);
    const events = await h.history(executionArn);
    const attempts = attemptsByState(events);
    const item = await h.stateItem(input.jobId);
    recordEvidence('failure-task-timeout', {
      jobId: input.jobId,
      fault,
      taskTimeoutSeconds: validateTimeout,
      execution: executionSummary(done),
      attempts,
      history: historyOutline(events),
      jobItem: { status: item?.[a.status], errorName: item?.[a.errorName] },
    });

    expect(done.status).toBe('FAILED');
    const validate = attempts[ProcessingState.Validate];
    const timeoutError = validate?.errors.at(-1) ?? '';
    // Step Functions' task timer (States.Timeout) normally fires first; the Lambda's own
    // timeout (equal to the task timeout, Sandbox.Timedout) is the other possible report.
    expect(timeoutError).toMatch(/^(States\.Timeout|Sandbox\.Timedout)$/);
    expect(failedOnceWithoutRetry(validate, timeoutError)).toBe(true);
    expect(PROCESSING_WORKFLOW.tasks.validate.retry[0]!.errors).not.toContain('States.Timeout');
    const states = enteredStates(events);
    expect(states).not.toContain(ProcessingState.Process);
    expect(states).toContain(ProcessingState.RecordFailure);
    unlessEmulatorGap('failStatePaths', 'execution error = the task timeout error', () => {
      expect(done.error).toBe(timeoutError);
    });
    expect(done.stopDate!.getTime() - done.startDate!.getTime()).toBeGreaterThanOrEqual(
      validateTimeout * 1000,
    );
    expect(item?.[a.status]).toBe(WorkflowStatus.Failed);
    expect(item?.[a.errorName]).toBe(timeoutError);
  });

  it.skipIf(emulatorNotApplicable('ddbUpdateTypeCheck') !== undefined)(
    titled(
      'RecordingFailed: when RecordFailure itself fails, the execution ends in the explicit Fail state and the job stays non-terminal',
      'ddbUpdateTypeCheck',
    ),
    async () => {
      const input = anExecutionInput({ submittedAt: now() });
      // A malformed item (non-numeric version): every `version + 1` update fails with a
      // non-conditional DynamoDB error — first in ValidateJob, then in RecordFailure.
      await h.seed(
        input,
        { title: 'malformed item', content: VALID_DOCUMENT },
        { jobExtra: { [a.version]: 'not-a-number' } },
      );
      try {
        const executionArn = await h.start(input);
        const done = await h.waitForCompletion(executionArn);
        const events = await h.history(executionArn);
        const attempts = attemptsByState(events);
        const states = enteredStates(events);
        const item = await h.stateItem(input.jobId);
        recordEvidence('failure-recording-failed', {
          jobId: input.jobId,
          execution: executionSummary(done),
          attempts,
          enteredStates: states,
          jobItemStatusAfter: item?.[a.status],
          note: 'malformed test item (version not a number) removed after the test',
        });

        expect(done.status).toBe('FAILED');
        expect(done.error).toBe('RecordFailureFailed');
        const record = attempts[ProcessingState.RecordFailure];
        expect(record?.succeeded).toBe(0);
        expect(record?.errors.length).toBeGreaterThan(0);
        expect(record?.errors).not.toContain('DynamoDB.ConditionalCheckFailedException');
        expect(states).toContain(ProcessingState.RecordingFailed);
        expect(states).not.toContain(ProcessingState.Failed);
        // Non-terminal: the reconciler (or an operator, alarmed) closes such a job later.
        expect(item?.[a.status]).toBe(WorkflowStatus.Pending);
      } finally {
        await h.deleteJob(input.jobId);
      }
    },
  );

  it.skipIf(emulatorNotApplicable('lambdaThrottle') !== undefined)(
    titled(
      'Lambda service errors: a throttled processor is retried 1 + maxAttempts times, then caught into RecordFailure',
      'lambdaThrottle',
    ),
    async () => {
      const functionName = h.assertRunTarget(h.output('processorFunctionName'), 'processor');
      const input = anExecutionInput({ submittedAt: now() });
      await h.seed(input, { title: 'throttled', content: VALID_DOCUMENT });
      let reverted = false;
      await h.lambda.send(
        new PutFunctionConcurrencyCommand({
          FunctionName: functionName,
          ReservedConcurrentExecutions: 0,
        }),
      );
      try {
        const executionArn = await h.start(input);
        const done = await h.waitForCompletion(executionArn);
        await h.lambda.send(new DeleteFunctionConcurrencyCommand({ FunctionName: functionName }));
        reverted = true;
        const after = await h.lambda.send(
          new GetFunctionConcurrencyCommand({ FunctionName: functionName }),
        );
        const events = await h.history(executionArn);
        const attempts = attemptsByState(events);
        const item = await h.stateItem(input.jobId);
        recordEvidence('failure-lambda-throttle', {
          jobId: input.jobId,
          injected: 'PutFunctionConcurrency(ReservedConcurrentExecutions=0) on the processor',
          reverted: `DeleteFunctionConcurrency; reservation after revert: ${String(after.ReservedConcurrentExecutions ?? 'none')}`,
          execution: executionSummary(done),
          attempts,
          retryPolicy: processRetry,
          history: historyOutline(events),
          jobItem: { status: item?.[a.status], errorName: item?.[a.errorName] },
        });

        expect(after.ReservedConcurrentExecutions).toBeUndefined();
        expect(done.status).toBe('FAILED');
        const processAttempts = attempts[ProcessingState.Process];
        expect(processAttempts?.attempts).toBe(1 + processRetry.maxAttempts);
        expect(processAttempts?.succeeded).toBe(0);
        const errors = new Set(processAttempts?.errors);
        expect(errors.size).toBe(1);
        const throttle = [...errors][0]!;
        expect(throttle).toMatch(/^Lambda\./);
        expect(processRetry.errors).toContain(throttle);
        expect(enteredStates(events)).toContain(ProcessingState.RecordFailure);
        expect(done.error).toBe(throttle);
        expect(item?.[a.status]).toBe(WorkflowStatus.Failed);
        expect(item?.[a.errorName]).toBe(throttle);
      } finally {
        if (!reverted) {
          await h.lambda.send(new DeleteFunctionConcurrencyCommand({ FunctionName: functionName }));
        }
      }
    },
  );
});
