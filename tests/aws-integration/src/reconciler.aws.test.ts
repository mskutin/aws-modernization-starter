/**
 * REAL AWS (opt-in, see aws-gate.ts): invokes the mini-stack's reconciler Lambda directly against
 * stale job items in its DynamoDB table, and checks the decisions with consistent reads.
 *
 *   1. Jobs WITHOUT an execution (seeded stale): WorkflowNotStarted / ExecutionNotFound —
 *      Query on gsi1, consistent GetItem, conditional UpdateItem on JOB#, DescribeExecution of a
 *      name that does not exist.
 *   2. A job whose REAL execution ended FAILED but which was left non-terminal:
 *      the reconciler describes an existing CMK-encrypted execution with METADATA_ONLY — its role
 *      holds no direct kms:Decrypt (only via DynamoDB; see iam-kms.aws.test.ts) — and closes the
 *      job as ExecutionFailed.
 * The execution-timeout case (TIMED_OUT, and "never touch a RUNNING execution") is in
 * execution-timeout.aws.test.ts.
 *
 * The 15-minute staleness threshold is simulated by back-dating `updatedAt` (and the index key);
 * status and version are never changed by that, and every write is conditional.
 * Evidence: reports/aws-integration/evidence/reconciler-*.json.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  JobStateTable,
  ReconciliationError,
  WorkflowError,
  WorkflowStatus,
  jobStateKey,
  statusIndexKey,
} from '@starter/workflow-processing';
import { anExecutionInput, rejectedLeakCanary } from '@starter/testing';
import { resolveAwsGate } from './aws-gate.js';
import {
  LiveHarness,
  unlessEmulatorGap,
  executionSummary,
  recordEvidence,
  type ReconcileSummaryLike,
  onAws,
  suiteTitle,
} from './live-harness.js';

const gate = await resolveAwsGate(process.env);
const reconcilerName = gate.enabled ? gate.outputs.reconcilerFunctionName : undefined;
const skip = !gate.enabled || reconcilerName === undefined;
const reason = !gate.enabled
  ? gate.reason
  : 'the integration stack has no ReconcilerFunctionName output (older stack)';

describe.skipIf(skip)(
  skip ? `${suiteTitle('reconciler')} [SKIPPED: ${reason}]` : suiteTitle('reconciler'),
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

    /** A job item last written two hours ago (well past the 900 s threshold). */
    async function seedStale(status: WorkflowStatus): Promise<string> {
      const jobId = randomUUID();
      const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
      await h.ddb.send(
        new PutCommand({
          TableName: h.assertRunTarget(h.outputs.tableName),
          Item: {
            ...jobStateKey(jobId),
            [a.jobId]: jobId,
            [a.status]: status,
            [a.version]: 1,
            createdAt: at,
            [a.updatedAt]: at,
            ...statusIndexKey(status, at, jobId),
          },
          ConditionExpression: 'attribute_not_exists(#pk)',
          ExpressionAttributeNames: { '#pk': JobStateTable.partitionKey },
        }),
      );
      return jobId;
    }

    /** The status index is eventually consistent: invoke until `done` (deadline 60 s). */
    async function reconcileUntil(done: () => Promise<boolean>): Promise<ReconcileSummaryLike[]> {
      const runs: ReconcileSummaryLike[] = [];
      const deadline = Date.now() + 60_000;
      for (;;) {
        const summary = await h.invokeReconciler();
        runs.push(summary);
        expect(summary.dependencyErrors).toBe(0);
        if (await done()) return runs;
        if (Date.now() > deadline) throw new Error('reconciler did not close the jobs in 60 s');
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }

    it('closes never-started and execution-less stale jobs, conditionally and once', async () => {
      const notStarted = await seedStale(WorkflowStatus.Pending);
      const lost = await seedStale(WorkflowStatus.Validating);
      const runs = await reconcileUntil(
        async () =>
          (await h.stateItem(notStarted))?.[a.status] === WorkflowStatus.Failed &&
          (await h.stateItem(lost))?.[a.status] === WorkflowStatus.Failed,
      );
      expect(await h.stateItem(notStarted)).toMatchObject({
        [a.errorName]: ReconciliationError.WorkflowNotStarted,
        [a.version]: 2,
      });
      expect(await h.stateItem(lost)).toMatchObject({
        [a.errorName]: ReconciliationError.ExecutionNotFound,
        [a.version]: 2,
      });
      // A further run changes nothing (idempotent).
      const again = await h.invokeReconciler();
      expect((await h.stateItem(notStarted))?.[a.version]).toBe(2);
      expect((await h.stateItem(lost))?.[a.version]).toBe(2);
      recordEvidence('reconciler-no-execution', {
        jobs: { notStarted, lost },
        decisions: {
          notStarted: ReconciliationError.WorkflowNotStarted,
          lost: ReconciliationError.ExecutionNotFound,
        },
        runs,
        idempotentRerun: again,
      });
    });

    it(`describes a ${onAws('real CMK-encrypted ')}FAILED execution (METADATA_ONLY) and closes the job it left non-terminal`, async () => {
      const canary = rejectedLeakCanary();
      const input = anExecutionInput({ submittedAt: new Date().toISOString() });
      await h.seed(input, { title: canary.title, content: canary.content });
      const executionArn = await h.start(input);
      const done = await h.waitForCompletion(executionArn);
      expect(done.status).toBe('FAILED');
      unlessEmulatorGap('failStatePaths', 'execution error = JobValidationError', () => {
        expect(done.error).toBe(WorkflowError.Validation);
      });
      const failed = await h.stateItem(input.jobId);
      expect(failed?.[a.status]).toBe(WorkflowStatus.Failed);
      const version = Number(failed?.[a.version]);

      // Leave the job non-terminal as if the outcome had never been recorded: back to
      // PROCESSING two hours ago, conditional on what was just read.
      const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
      await h.ddb.send(
        new UpdateCommand({
          TableName: h.assertRunTarget(h.outputs.tableName),
          Key: jobStateKey(input.jobId),
          UpdateExpression:
            'SET #status = :processing, #updatedAt = :at, #gsi1pk = :gsi1pk, #gsi1sk = :gsi1sk, #version = #version + :one REMOVE #errorName, #errorMessage',
          ConditionExpression: '#status = :failed AND #version = :version',
          ExpressionAttributeNames: {
            '#status': a.status,
            '#updatedAt': a.updatedAt,
            '#version': a.version,
            '#errorName': a.errorName,
            '#errorMessage': a.errorMessage,
            '#gsi1pk': JobStateTable.statusIndex.partitionKey,
            '#gsi1sk': JobStateTable.statusIndex.sortKey,
          },
          ExpressionAttributeValues: {
            ':processing': WorkflowStatus.Processing,
            ':failed': WorkflowStatus.Failed,
            ':at': at,
            ':one': 1,
            ':version': version,
            ...Object.fromEntries(
              Object.entries(statusIndexKey(WorkflowStatus.Processing, at, input.jobId)).map(
                ([k, v]) => [`:${k}`, v],
              ),
            ),
          },
        }),
      );

      const runs = await reconcileUntil(
        async () => (await h.stateItem(input.jobId))?.[a.status] === WorkflowStatus.Failed,
      );
      const closed = await h.stateItem(input.jobId);
      expect(closed).toMatchObject({
        [a.status]: WorkflowStatus.Failed,
        [a.errorName]: ReconciliationError.ExecutionFailed,
        [a.version]: version + 2,
      });
      // Fixed template + the execution's error NAME only: no document text, no cause.
      const message = String(closed?.[a.errorMessage]);
      unlessEmulatorGap('failStatePaths', 'reconciler message names the execution error', () => {
        expect(message).toContain(WorkflowError.Validation);
      });
      for (const marker of canary.markers) expect(message).not.toContain(marker);
      expect(runs.some((r) => r.markedFailed >= 1)).toBe(true);

      const again = await h.invokeReconciler();
      expect((await h.stateItem(input.jobId))?.[a.version]).toBe(version + 2);
      recordEvidence('reconciler-failed-execution', {
        jobId: input.jobId,
        execution: executionSummary(done),
        resetTo: { status: WorkflowStatus.Processing, version: version + 1, updatedAt: at },
        closed: {
          status: closed?.[a.status],
          errorName: closed?.[a.errorName],
          version: closed?.[a.version],
        },
        runs,
        idempotentRerun: again,
      });
    });
  },
);
