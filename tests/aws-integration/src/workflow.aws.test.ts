/**
 * REAL AWS: drives the deployed integration mini-stack (Step Functions + Lambda + DynamoDB)
 * directly — no API, no local simulation. Proves what the local suites cannot: the ASL
 * definition, IAM permissions, Lambda packaging, retries/catches and the native DynamoDB
 * service integration behave as specified in workflows/processing/src/spec.ts.
 *
 * Spec 2.0.0 (ADR 0230): executions start with `{ jobId, contractVersion, submittedAt }` only;
 * the handlers load the document by job id. The mini-stack has no PostgreSQL, so its handler
 * entries read SYNTHETIC documents from a dedicated test table that this suite seeds (ADR 0232).
 * RDS document retrieval (IAM auth, TLS verify-full, `load_job_document`) is therefore NOT
 * exercised here; it is first exercised by a sandbox stage deployment.
 *
 * History minimisation has a POSITIVE CONTROL: a marker deliberately placed in an
 * execution input must be found by the same scanner in the real history (ExecutionStarted) and
 * nowhere else, so a zero-hit scan of the canary runs means something.
 *
 * Opt-in: see aws-gate.ts. Never runs (and never reports passed) without credentials.
 * Evidence: reports/aws-integration/evidence/workflow-*.json (sanitized, see live-harness.ts).
 */
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExecutionAlreadyExists, type HistoryEvent } from '@aws-sdk/client-sfn';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  EXECUTION_INPUT_KEYS,
  JobStateTable,
  ProcessingState,
  WorkflowError,
  WorkflowStatus,
  serializeExecutionInput,
} from '@starter/workflow-processing';
import {
  VALID_DOCUMENT,
  anExecutionInput,
  leakCanary,
  rejectedLeakCanary,
  type LeakCanary,
} from '@starter/testing';
import { resolveAwsGate } from './aws-gate.js';
import { findHistoryLeaks, hasMinimalExecutionInput } from './history-leaks.js';
import {
  LiveHarness,
  attemptsByState,
  unlessEmulatorGap,
  emulatorNotApplicable,
  enteredStates,
  executionSummary,
  failedOnceWithoutRetry,
  historyOutline,
  recordEvidence,
  titled,
  onAws,
  suiteTitle,
} from './live-harness.js';

const gate = await resolveAwsGate(process.env);

if (!gate.enabled) {
  console.warn(`[aws-integration] SKIPPED: ${gate.reason}`);
}

/** Required-but-unavailable must FAIL, otherwise skip with the reason in the suite name. */
if (!gate.enabled && gate.required) {
  describe(suiteTitle('required'), () => {
    it('is required (AWS_INTEGRATION_REQUIRED=true) but cannot run', () => {
      throw new Error(`AWS integration required but unavailable: ${gate.reason}`);
    });
  });
}

/** Keys every Lambda task receives (spec TASK_EVENT_KEYS). */
const TASK_EVENT_KEYS = [...EXECUTION_INPUT_KEYS, 'executionArn'].sort();

describe.skipIf(!gate.enabled)(
  gate.enabled ? suiteTitle('workflow') : `${suiteTitle('workflow')} [SKIPPED: ${gate.reason}]`,
  () => {
    let h: LiveHarness;

    beforeAll(async () => {
      if (!gate.enabled) return;
      h = await LiveHarness.create(gate);
    });
    afterAll(() => {
      h?.destroy();
    });

    const a = JobStateTable.attributes;
    const now = () => new Date().toISOString();

    function expectNoLeaks(events: HistoryEvent[], canary: Pick<LeakCanary, 'markers'>) {
      expect(hasMinimalExecutionInput(events)).toBe(true);
      expect(findHistoryLeaks(events, canary.markers)).toEqual([]);
    }

    it('happy path: SUCCEEDED, result stored by the processor, nothing of the document in history', async () => {
      const canary = leakCanary();
      const input = anExecutionInput({ submittedAt: now() });
      await h.seed(input, { title: canary.title, content: canary.content });
      const executionArn = await h.start(input);
      const done = await h.waitForCompletion(executionArn);
      expect(done.status, done.cause ?? '').toBe('SUCCEEDED');

      const events = await h.history(executionArn);
      expect(enteredStates(events)).toEqual([
        ProcessingState.Validate,
        ProcessingState.Process,
        ProcessingState.RecordSuccess,
        ProcessingState.Succeeded,
      ]);
      // Built-in control: the scan below covers a complete, real history.
      expect(events.length).toBeGreaterThan(10);
      expectNoLeaks(events, canary);

      const item = await h.stateItem(input.jobId);
      expect(item?.[a.status]).toBe(WorkflowStatus.Succeeded);
      expect(item?.[JobStateTable.statusIndex.partitionKey]).toBe(
        `STATUS#${WorkflowStatus.Succeeded}`,
      );
      expect(String(item?.[JobStateTable.statusIndex.sortKey])).toMatch(
        new RegExp(`#${input.jobId}$`),
      );
      expect(item?.[a.errorName]).toBeUndefined();
      const result = JSON.parse(String(item?.[a.result])) as Record<string, unknown>;
      expect(result).toMatchObject({ wordCount: expect.any(Number), topTerms: expect.any(Array) });
      // The job item holds the analysis (AS2), never the raw document (AS1).
      expect(JSON.stringify(item)).not.toContain(canary.markers[0]!);

      // GSI1 eventually reflects the job (GSIs are eventually consistent: poll with a deadline).
      const deadline = Date.now() + 30_000;
      for (;;) {
        const q = await h.ddb.send(
          new QueryCommand({
            TableName: h.outputs.tableName,
            IndexName: JobStateTable.statusIndex.name,
            KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
            ExpressionAttributeNames: {
              '#pk': JobStateTable.statusIndex.partitionKey,
              '#sk': JobStateTable.statusIndex.sortKey,
            },
            ExpressionAttributeValues: {
              ':pk': `STATUS#${WorkflowStatus.Succeeded}`,
              ':prefix': String(item?.[JobStateTable.statusIndex.sortKey]).split('#')[0],
            },
          }),
        );
        if (q.Items?.some((i) => i.jobId === input.jobId || i.pk === `JOB#${input.jobId}`)) break;
        if (Date.now() > deadline) throw new Error('job not visible in gsi1 within 30s');
        await new Promise((r) => setTimeout(r, 1_000));
      }
      recordEvidence('workflow-happy-path', {
        jobId: input.jobId,
        execution: executionSummary(done),
        enteredStates: enteredStates(events),
        attempts: attemptsByState(events),
        historyEvents: events.length,
        canaryMarkerHitsInHistory: 0,
        minimalExecutionInput: true,
        jobItem: { status: item?.[a.status], version: item?.[a.version], resultStored: true },
      });
    });

    it('business-rule failure: FAILED with JobValidationError, no retries, a Cause, no text in history', async () => {
      const canary = rejectedLeakCanary();
      const input = anExecutionInput({ submittedAt: now() });
      await h.seed(input, { title: canary.title, content: canary.content });
      const executionArn = await h.start(input);
      const done = await h.waitForCompletion(executionArn);
      const events = await h.history(executionArn);
      const states = enteredStates(events);
      const item = await h.stateItem(input.jobId);
      recordEvidence('workflow-validation-failure', {
        jobId: input.jobId,
        execution: executionSummary(done),
        enteredStates: states,
        attempts: attemptsByState(events),
        history: historyOutline(events),
        jobItem: { status: item?.[a.status], errorName: item?.[a.errorName] },
      });

      expect(done.status).toBe('FAILED');
      unlessEmulatorGap(
        'failStatePaths',
        'execution error = JobValidationError and a Cause',
        () => {
          expect(done.error).toBe(WorkflowError.Validation);
          // The Fail state reports a Cause (NormalizeError guarantees one), without document text.
          expect(done.cause ?? '').not.toBe('');
          for (const marker of canary.markers) expect(done.cause).not.toContain(marker);
        },
      );
      // JobValidationError is permanent: ValidateJob is attempted once, ProcessJob never entered.
      const validate = attemptsByState(events)[ProcessingState.Validate];
      const validateError = validate?.errors.at(-1) ?? '';
      expect(failedOnceWithoutRetry(validate, validateError)).toBe(true);
      unlessEmulatorGap(
        'localExecutorErrorNames',
        'ValidateJob failed with JobValidationError',
        () => {
          expect(validateError).toBe(WorkflowError.Validation);
        },
      );
      expect(states).not.toContain(ProcessingState.Process);
      expect(states).toEqual(
        expect.arrayContaining([
          ProcessingState.FailureDefaults,
          ProcessingState.NormalizeError,
          ProcessingState.RecordFailure,
          ProcessingState.Failed,
        ]),
      );
      expectNoLeaks(events, canary);
      expect(item?.[a.status]).toBe(WorkflowStatus.Failed);
      // RecordFailure stores the error the task failed with (name-independent), …
      expect(item?.[a.errorName]).toBe(validateError);
      // … which is JobValidationError where handler error names survive.
      unlessEmulatorGap(
        'localExecutorErrorNames',
        'job item errorName = JobValidationError',
        () => {
          expect(item?.[a.errorName]).toBe(WorkflowError.Validation);
        },
      );
      expect(String(item?.[a.errorMessage] ?? '')).not.toBe('');
      expect(item?.[a.result]).toBeUndefined();
    });

    it('missing document: FAILED with DocumentUnavailableError, never retried', async () => {
      const input = anExecutionInput({ submittedAt: now() });
      // Simulate a purge before validation: the item marks the document as purged.
      await h.seed(
        input,
        { title: 'about to vanish', content: VALID_DOCUMENT },
        { documentExtra: { purgedAt: now() } },
      );
      const executionArn = await h.start(input);
      const done = await h.waitForCompletion(executionArn);
      const events = await h.history(executionArn);
      const item = await h.stateItem(input.jobId);
      recordEvidence('workflow-missing-document', {
        jobId: input.jobId,
        execution: executionSummary(done),
        attempts: attemptsByState(events),
        jobItem: { status: item?.[a.status], errorName: item?.[a.errorName] },
      });

      expect(done.status).toBe('FAILED');
      unlessEmulatorGap(
        'failStatePaths',
        'execution error = DocumentUnavailableError and a Cause',
        () => {
          expect(done.error).toBe(WorkflowError.DocumentUnavailable);
          expect(done.cause ?? '').not.toBe('');
        },
      );
      const validate = attemptsByState(events)[ProcessingState.Validate];
      const validateError = validate?.errors.at(-1) ?? '';
      expect(failedOnceWithoutRetry(validate, validateError)).toBe(true);
      expect(enteredStates(events)).not.toContain(ProcessingState.Process);
      expect(item?.[a.status]).toBe(WorkflowStatus.Failed);
      expect(item?.[a.errorName]).toBe(validateError);
      unlessEmulatorGap(
        'localExecutorErrorNames',
        'ValidateJob and the job item report DocumentUnavailableError',
        () => {
          expect(validateError).toBe(WorkflowError.DocumentUnavailable);
          expect(item?.[a.errorName]).toBe(WorkflowError.DocumentUnavailable);
        },
      );
    });

    /** One execution whose input carries an extra `payload` field holding a fresh marker. */
    async function runWithPayloadMarker() {
      const marker = `Positive control ${Array.from({ length: 16 }, () => randomInt(10)).join('')}`;
      const input = anExecutionInput({ submittedAt: now() });
      await h.seed(input, { title: 'strict input', content: VALID_DOCUMENT });
      const raw = JSON.stringify({
        ...JSON.parse(serializeExecutionInput(input)),
        payload: { title: marker },
      });
      const executionArn = await h.start(input, { rawInput: raw });
      const done = await h.waitForCompletion(executionArn);
      return { marker, input, done, events: await h.history(executionArn) };
    }

    it(`positive control: a marker placed in the input IS found by the scanner in the ${onAws('real ', 'emulated ')}history`, async () => {
      const { marker, input, done, events } = await runWithPayloadMarker();
      // The scanner finds the marker where it really is: the execution input (ExecutionStarted)
      // and the state data that carries it from state to state — in the real, JSON-escaped
      // history format — and never in an event that schedules a task.
      const leaks = findHistoryLeaks(events, [marker]);
      const hitTypes = [...new Set(leaks.map((l) => l.type))];
      recordEvidence('workflow-history-positive-control', {
        jobId: input.jobId,
        execution: executionSummary(done),
        markerFoundInEventTypes: hitTypes,
        markerHits: leaks.length,
      });

      // The ASL forwards only the spec fields: the strict handlers never see `payload`.
      expect(done.status).toBe('SUCCEEDED');
      expect(hitTypes).toContain('ExecutionStarted');
      expect(hitTypes).not.toContain('LambdaFunctionScheduled');
      expect(hitTypes).not.toContain('TaskScheduled');
      expect(hasMinimalExecutionInput(events)).toBe(false);
    });

    it.skipIf(emulatorNotApplicable('taskInputNotInHistory') !== undefined)(
      titled(
        'the ASL forwards only the spec fields: no task input in the history carries the extra field',
        'taskInputNotInHistory',
      ),
      async () => {
        const { input, done, events } = await runWithPayloadMarker();
        // Every task input: the Lambda tasks (legacy Lambda resource → LambdaFunctionScheduled)
        // and the native DynamoDB task (TaskScheduled).
        const lambdaInputs = events.filter((e) => e.type === 'LambdaFunctionScheduled');
        const taskParameters = events.filter((e) => e.type === 'TaskScheduled');
        recordEvidence('workflow-task-inputs', {
          jobId: input.jobId,
          execution: executionSummary(done),
          lambdaTaskInputs: lambdaInputs.length,
          serviceTaskParameters: taskParameters.length,
          lambdaTaskInputKeys: lambdaInputs.map((e) =>
            Object.keys(
              JSON.parse(e.lambdaFunctionScheduledEventDetails?.input ?? '{}') as object,
            ).sort(),
          ),
        });

        expect(done.status).toBe('SUCCEEDED');
        expect(lambdaInputs.length).toBeGreaterThanOrEqual(2);
        expect(taskParameters.length).toBeGreaterThanOrEqual(1);
        for (const e of lambdaInputs) {
          const forwarded = JSON.parse(
            e.lambdaFunctionScheduledEventDetails?.input ?? '{}',
          ) as object;
          expect(Object.keys(forwarded).sort()).toEqual(TASK_EVENT_KEYS);
        }
        for (const e of [...lambdaInputs, ...taskParameters]) {
          expect(JSON.stringify(e)).not.toContain('payload');
        }
      },
    );

    it('idempotency: re-starting the same job never creates a second execution', async () => {
      const input = anExecutionInput({ submittedAt: now() });
      await h.seed(input, { title: 'idempotency', content: `${VALID_DOCUMENT} Idempotency run.` });
      const first = await h.start(input);
      // Same name + same input while RUNNING returns the same execution; after it closed, the
      // name is reserved and StartExecution fails with ExecutionAlreadyExists. Both prove that a
      // duplicate delivery cannot double-process the job.
      let secondArn: string | undefined;
      let secondOutcome = 'same-execution';
      try {
        secondArn = await h.start(input);
      } catch (err) {
        expect(err).toBeInstanceOf(ExecutionAlreadyExists);
        secondOutcome = 'ExecutionAlreadyExists';
      }
      if (secondArn) expect(secondArn).toBe(first);

      const done = await h.waitForCompletion(first);
      expect(done.status).toBe('SUCCEEDED');

      // A different input under the same execution name is always rejected.
      await expect(
        h.start({ ...input, submittedAt: new Date(Date.now() + 1_000).toISOString() }),
      ).rejects.toBeInstanceOf(ExecutionAlreadyExists);

      const item = await h.stateItem(input.jobId);
      expect(item?.[a.status]).toBe(WorkflowStatus.Succeeded);
      recordEvidence('workflow-idempotency', {
        jobId: input.jobId,
        execution: executionSummary(done),
        sameNameSameInputWhileRunning: secondOutcome,
        sameNameDifferentInput: 'ExecutionAlreadyExists',
        jobItem: { status: item?.[a.status], version: item?.[a.version] },
      });
    });
  },
);
