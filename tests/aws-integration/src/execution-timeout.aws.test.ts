/**
 * REAL AWS (opt-in, see aws-gate.ts): EXECUTION timeout behaviour.
 *
 * The mini-stack deploys its state machine with a shortened execution timeout (default 45 s,
 * `-c executionTimeoutSeconds`; the stages keep the spec's 600 s). A TEST fault delays the
 * processor's document load beyond it. Step Functions cannot catch an execution timeout, so:
 *
 *   1. the execution ends TIMED_OUT with no RecordFailure — the job stays non-terminal
 *      (PROCESSING), exactly the gap the stale-job reconciler exists for (ADR 0231);
 *   2. while the execution is still RUNNING, the reconciler (job made to look stale) leaves the
 *      job alone (`SkippedRunning`) — it never fails a job whose execution is running (ADR 0231);
 *   3. the Lambda is NOT stopped by the timeout: it finishes later and stores its result on the
 *      still-PROCESSING item (observed, not assumed);
 *   4. the reconciler then describes the TIMED_OUT execution (METADATA_ONLY) and closes the job
 *      FAILED / ExecutionTimedOut, removing the late result; a re-run changes nothing.
 *
 * Staleness (900 s) is simulated by back-dating `updatedAt` without touching status or version.
 * Evidence: reports/aws-integration/evidence/execution-timeout.json.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DescribeStateMachineCommand } from '@aws-sdk/client-sfn';
import { MAX_FAULT_DELAY_SECONDS } from '@starter/documents/test-faults';
import {
  JobStateTable,
  PROCESSING_WORKFLOW,
  ProcessingState,
  ReconciliationError,
  WorkflowStatus,
} from '@starter/workflow-processing';
import { VALID_DOCUMENT, anExecutionInput } from '@starter/testing';
import { resolveAwsGate } from './aws-gate.js';
import {
  LiveHarness,
  attemptsByState,
  enteredStates,
  executionSummary,
  historyOutline,
  recordEvidence,
  type ReconcileSummaryLike,
  emulatorNotApplicable,
  suiteTitle,
} from './live-harness.js';

const gate = await resolveAwsGate(process.env);
const title = gate.enabled
  ? suiteTitle('execution timeout')
  : `${suiteTitle('execution timeout')} [SKIPPED: ${gate.reason}]`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const notApplicable = emulatorNotApplicable('executionTimeout');

describe.skipIf(!gate.enabled || notApplicable !== undefined)(
  notApplicable ? `${title} [${notApplicable}]` : title,
  () => {
    let h: LiveHarness;
    const a = JobStateTable.attributes;

    beforeAll(async () => {
      if (!gate.enabled) return;
      h = await LiveHarness.create(gate);
    });
    afterAll(() => {
      h?.destroy();
    });

    it('TIMED_OUT leaves the job non-terminal; the reconciler skips it while RUNNING and closes it after', async () => {
      const machine = await h.sfn.send(
        new DescribeStateMachineCommand({ stateMachineArn: h.outputs.stateMachineArn }),
      );
      const timeoutSeconds = (JSON.parse(machine.definition ?? '{}') as { TimeoutSeconds?: number })
        .TimeoutSeconds;
      const delaySeconds = Math.min((timeoutSeconds ?? 0) + 8, MAX_FAULT_DELAY_SECONDS);
      if (timeoutSeconds === undefined || timeoutSeconds + 5 > delaySeconds) {
        throw new Error(
          `the deployed execution timeout is ${String(timeoutSeconds)} s: this test needs ` +
            `<= ${MAX_FAULT_DELAY_SECONDS - 8} s (deploy the mini-stack with the default ` +
            `-c executionTimeoutSeconds=45; the spec's ${PROCESSING_WORKFLOW.executionTimeoutSeconds} s would take 10 minutes)`,
        );
      }
      expect(String(timeoutSeconds)).toBe(h.output('executionTimeoutSeconds'));

      const fault = {
        kind: 'delay',
        step: ProcessingState.Process,
        seconds: delaySeconds,
      } as const;
      const input = anExecutionInput({ submittedAt: new Date().toISOString() });
      await h.seed(input, { title: 'slow processing', content: VALID_DOCUMENT }, { fault });
      const t0 = Date.now();
      const executionArn = await h.start(input);
      const timeline: Record<string, number> = {};
      const mark = (event: string) => {
        timeline[event] = Math.round((Date.now() - t0) / 100) / 10;
      };

      // 1. ProcessJob has entered PROCESSING and is now inside the slow load.
      const processing = await h.waitForItem(
        input.jobId,
        (i) => i?.[a.status] === WorkflowStatus.Processing,
        30_000,
      );
      mark('jobProcessing');
      const version = Number(processing?.[a.version]);
      const backdatedAt = await h.backdate(input.jobId, {
        status: WorkflowStatus.Processing,
        version,
      });
      mark('backdated');

      // 2. While RUNNING the reconciler must leave the job alone.
      const whileRunning: ReconcileSummaryLike[] = [];
      let stillRunningAfterRun: boolean;
      for (;;) {
        const summary = await h.invokeReconciler();
        whileRunning.push(summary);
        stillRunningAfterRun = (await h.describe(executionArn)).status === 'RUNNING';
        if (!stillRunningAfterRun || summary.skippedRunning >= 1) break;
        if (Date.now() - t0 > (timeoutSeconds - 5) * 1000) break;
        await sleep(1_500);
      }
      mark('reconciledWhileRunning');
      const untouched = await h.stateItem(input.jobId);

      // 3. The execution times out (uncatchable): no RecordFailure, the job stays PROCESSING.
      const done = await h.waitForCompletion(executionArn);
      mark('executionClosed');
      const atTimeout = await h.stateItem(input.jobId);
      const events = await h.history(executionArn);

      // 4. The Lambda keeps running after the timeout and stores its result late.
      let late: Record<string, unknown> | undefined;
      let lateError: string | undefined;
      try {
        late = await h.waitForItem(
          input.jobId,
          (i) => typeof i?.[a.result] === 'string',
          (delaySeconds - timeoutSeconds + 30) * 1000,
        );
        mark('lateResultStored');
      } catch (error) {
        lateError = String(error);
      }

      // 5. The reconciler closes the job against the TIMED_OUT execution.
      const afterTimeout: ReconcileSummaryLike[] = [];
      let closed: Record<string, unknown> | undefined;
      const deadline = Date.now() + 60_000;
      for (;;) {
        afterTimeout.push(await h.invokeReconciler());
        closed = await h.stateItem(input.jobId);
        if (closed?.[a.status] === WorkflowStatus.Failed || Date.now() > deadline) break;
        await sleep(2_000);
      }
      mark('jobClosed');
      const rerun = await h.invokeReconciler();
      const final = await h.stateItem(input.jobId);

      const snap = (i: Record<string, unknown> | undefined) => ({
        status: i?.[a.status],
        version: i?.[a.version],
        updatedAt: i?.[a.updatedAt],
        errorName: i?.[a.errorName],
        resultStored: typeof i?.[a.result] === 'string',
      });
      recordEvidence('execution-timeout', {
        jobId: input.jobId,
        executionTimeoutSeconds: timeoutSeconds,
        specExecutionTimeoutSeconds: PROCESSING_WORKFLOW.executionTimeoutSeconds,
        fault,
        secondsSinceStart: timeline,
        execution: executionSummary(done),
        enteredStates: enteredStates(events),
        attempts: attemptsByState(events),
        history: historyOutline(events),
        reconcilerWhileRunning: whileRunning,
        executionStillRunningAfterThoseRuns: stillRunningAfterRun,
        reconcilerAfterTimeout: afterTimeout,
        idempotentRerun: rerun,
        items: {
          processing: snap(processing),
          afterReconcileWhileRunning: snap(untouched),
          atTimeout: snap(atTimeout),
          afterLateCompletion: late ? snap(late) : `not observed: ${lateError ?? ''}`,
          closed: snap(closed),
          final: snap(final),
        },
      });

      // (2) never touch a RUNNING execution's job
      expect(stillRunningAfterRun).toBe(true);
      expect(whileRunning.at(-1)?.skippedRunning).toBeGreaterThanOrEqual(1);
      expect(whileRunning.every((s) => s.dependencyErrors === 0)).toBe(true);
      expect(snap(untouched)).toEqual({
        status: WorkflowStatus.Processing,
        version,
        updatedAt: backdatedAt,
        errorName: undefined,
        resultStored: false,
      });
      // (1) TIMED_OUT, uncatchable: no failure path ran, the job is non-terminal
      expect(done.status).toBe('TIMED_OUT');
      expect(events.at(-1)?.type).toBe('ExecutionTimedOut');
      expect(enteredStates(events)).toEqual([ProcessingState.Validate, ProcessingState.Process]);
      expect(done.stopDate!.getTime() - done.startDate!.getTime()).toBeGreaterThanOrEqual(
        timeoutSeconds * 1000,
      );
      expect(atTimeout?.[a.status]).toBe(WorkflowStatus.Processing);
      // (3) the late Lambda completed after the execution had ended
      expect(lateError).toBeUndefined();
      expect(snap(late)).toMatchObject({
        status: WorkflowStatus.Processing,
        version: version + 1,
        resultStored: true,
      });
      // (4) closed as ExecutionTimedOut (late result removed), conditionally and once
      expect(snap(closed)).toMatchObject({
        status: WorkflowStatus.Failed,
        errorName: ReconciliationError.ExecutionTimedOut,
        version: version + 2,
        resultStored: false,
      });
      expect(afterTimeout.every((s) => s.dependencyErrors === 0)).toBe(true);
      expect(snap(final)).toEqual(snap(closed));
    });
  },
);
