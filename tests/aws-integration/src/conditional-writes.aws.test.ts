/**
 * REAL AWS (opt-in, see aws-gate.ts): DynamoDB conditional writes and idempotent re-delivery on
 * the real (CMK-encrypted) job table — DynamoDB Local is not DynamoDB.
 *
 *   1. A second completion is rejected by RecordSuccess's condition (native Step Functions
 *      UpdateItem, `status IN (PROCESSING) AND attribute_exists(resultJson)`): a re-delivered
 *      execution of a SUCCEEDED job ends SUCCEEDED via the ConditionalCheckFailed catch, the
 *      handlers absorb it as a duplicate (STEP# audit `duplicate`), the job item is unchanged.
 *   2. A stale failure on a terminal job is rejected by RecordFailure's condition: a re-delivered
 *      execution of a FAILED job ends in JobFailed via the catch; the item keeps its first error.
 *   3. The production store (`@starter/job-state` DynamoDbJobStateStore) against the real table:
 *      optimistic concurrency (expected status + version), illegal transitions and replays are
 *      rejected without a write.
 * Evidence: reports/aws-integration/evidence/conditional-*.json.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDbJobStateStore } from '@starter/job-state';
import {
  JobStateTable,
  ProcessingState,
  WorkflowError,
  WorkflowStatus,
  executionNameFor,
  jobStateKey,
} from '@starter/workflow-processing';
import { VALID_DOCUMENT, anExecutionInput, rejectedLeakCanary } from '@starter/testing';
import { resolveAwsGate } from './aws-gate.js';
import {
  LiveHarness,
  unlessEmulatorGap,
  attemptsByState,
  enteredStates,
  executionSummary,
  recordEvidence,
  onAws,
  suiteTitle,
} from './live-harness.js';

const gate = await resolveAwsGate(process.env);
const title = gate.enabled
  ? suiteTitle('conditional writes')
  : `${suiteTitle('conditional writes')} [SKIPPED: ${gate.reason}]`;

const CONDITIONAL_CHECK_FAILED = 'DynamoDB.ConditionalCheckFailedException';

describe.skipIf(!gate.enabled)(title, () => {
  let h: LiveHarness;
  const a = JobStateTable.attributes;
  const now = () => new Date().toISOString();
  /** A second delivery of the same job under another execution name (e.g. a manual redrive). */
  const redeliveryName = (jobId: string) => `${executionNameFor(jobId)}-redelivery`;

  beforeAll(async () => {
    if (!gate.enabled) return;
    h = await LiveHarness.create(gate);
  });
  afterAll(() => {
    h?.destroy();
  });

  /** STEP# audit outcomes of a job, per state. */
  async function auditOutcomes(jobId: string): Promise<Record<string, string[]>> {
    const out = await h.ddb.send(
      new QueryCommand({
        TableName: h.outputs.tableName,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :step)',
        ExpressionAttributeNames: {
          '#pk': JobStateTable.partitionKey,
          '#sk': JobStateTable.sortKey,
        },
        ExpressionAttributeValues: { ':pk': jobStateKey(jobId).pk, ':step': 'STEP#' },
        ConsistentRead: true,
      }),
    );
    const byState: Record<string, string[]> = {};
    for (const item of out.Items ?? []) {
      (byState[String(item.state)] ??= []).push(String(item.outcome));
    }
    return byState;
  }

  const snapshot = (item: Record<string, unknown> | undefined) => ({
    status: item?.[a.status],
    version: item?.[a.version],
    updatedAt: item?.[a.updatedAt],
    errorName: item?.[a.errorName],
    resultJson: item?.[a.result],
  });

  it('a second completion of a SUCCEEDED job is rejected by the RecordSuccess condition; the item is unchanged', async () => {
    const input = anExecutionInput({ submittedAt: now() });
    await h.seed(input, { title: 'second completion', content: VALID_DOCUMENT });
    const first = await h.waitForCompletion(await h.start(input));
    const before = snapshot(await h.stateItem(input.jobId));

    const secondArn = await h.start(input, { name: redeliveryName(input.jobId) });
    const second = await h.waitForCompletion(secondArn);
    const events = await h.history(secondArn);
    const attempts = attemptsByState(events);
    const after = snapshot(await h.stateItem(input.jobId));
    const audit = await auditOutcomes(input.jobId);
    recordEvidence('conditional-second-completion', {
      jobId: input.jobId,
      first: executionSummary(first),
      redelivery: executionSummary(second),
      redeliveryAttempts: attempts,
      redeliveryStates: enteredStates(events),
      itemBefore: { ...before, resultJson: before.resultJson ? 'stored' : undefined },
      itemAfter: { ...after, resultJson: after.resultJson ? 'stored' : undefined },
      auditOutcomes: audit,
    });

    expect(first.status).toBe('SUCCEEDED');
    expect(before.status).toBe(WorkflowStatus.Succeeded);
    expect(second.status).toBe('SUCCEEDED');
    expect(attempts[ProcessingState.RecordSuccess]?.errors).toEqual([CONDITIONAL_CHECK_FAILED]);
    expect(enteredStates(events).at(-1)).toBe(ProcessingState.Succeeded);
    // The conditional write did not apply: nothing on the item moved.
    expect(after).toEqual(before);
    // The handlers absorbed the re-delivery as a duplicate (audit trail, not the state item).
    expect(audit[ProcessingState.Validate]).toContain('duplicate');
    expect(audit[ProcessingState.Process]).toContain('duplicate');
  });

  it('a stale failure on a FAILED job is rejected by the RecordFailure condition; the first error is kept', async () => {
    const canary = rejectedLeakCanary();
    const input = anExecutionInput({ submittedAt: now() });
    await h.seed(input, { title: canary.title, content: canary.content });
    const first = await h.waitForCompletion(await h.start(input));
    const before = snapshot(await h.stateItem(input.jobId));

    const secondArn = await h.start(input, { name: redeliveryName(input.jobId) });
    const second = await h.waitForCompletion(secondArn);
    const events = await h.history(secondArn);
    const attempts = attemptsByState(events);
    const after = snapshot(await h.stateItem(input.jobId));
    recordEvidence('conditional-stale-failure', {
      jobId: input.jobId,
      first: executionSummary(first),
      redelivery: executionSummary(second),
      redeliveryAttempts: attempts,
      redeliveryStates: enteredStates(events),
      itemBefore: before,
      itemAfter: after,
    });

    expect(first.status).toBe('FAILED');
    expect(before.status).toBe(WorkflowStatus.Failed);
    expect(before.errorName).toEqual(expect.any(String));
    unlessEmulatorGap('localExecutorErrorNames', 'first error = JobValidationError', () => {
      expect(before.errorName).toBe(WorkflowError.Validation);
    });
    // ValidateJob refuses a terminal job (JobStateConflictError) → RecordFailure is rejected by
    // its condition (FAILED is no predecessor of FAILED) → JobFailed reports the new error.
    expect(second.status).toBe('FAILED');
    unlessEmulatorGap('failStatePaths', 'execution error = JobStateConflictError', () => {
      expect(second.error).toBe('JobStateConflictError');
    });
    expect(attempts[ProcessingState.RecordFailure]?.errors).toEqual([CONDITIONAL_CHECK_FAILED]);
    expect(enteredStates(events).at(-1)).toBe(ProcessingState.Failed);
    expect(after).toEqual(before);
  });

  it(`production store on the ${onAws('real', 'deployed')} table: stale status/version, illegal transitions and replays never write`, async () => {
    const input = anExecutionInput({ submittedAt: now() });
    await h.seed(input, { title: 'optimistic concurrency', content: VALID_DOCUMENT });
    const store = new DynamoDbJobStateStore({
      client: h.ddb,
      tableName: h.assertRunTarget(h.outputs.tableName),
    });
    const id = input.jobId;
    const at = now();
    const failure = { name: 'ConcurrencyProbe', message: 'conditional-write probe (test)' };

    const toValidating = await store.transition(id, WorkflowStatus.Validating, at, {
      expectedVersion: 1,
      expectedStatus: WorkflowStatus.Pending,
    });
    const staleStatus = await store.recordFailure(id, failure, at, {
      expectedVersion: 1,
      expectedStatus: WorkflowStatus.Pending,
    });
    const staleVersion = await store.recordFailure(id, failure, at, {
      expectedVersion: 1,
      expectedStatus: WorkflowStatus.Validating,
    });
    const afterStale = snapshot(await h.stateItem(id));
    const applied = await store.recordFailure(id, failure, at, {
      expectedVersion: 2,
      expectedStatus: WorkflowStatus.Validating,
    });
    const replay = await store.recordFailure(id, failure, at, {
      expectedVersion: 2,
      expectedStatus: WorkflowStatus.Validating,
    });
    const illegal = await store.transition(id, WorkflowStatus.Processing, now());
    const lateResult = await store.storeResult(id, '{"late":true}');
    const final = snapshot(await h.stateItem(id));
    const outcome = (o: { kind: string; reason?: string }) => ({ kind: o.kind, reason: o.reason });
    recordEvidence('conditional-store-optimistic-concurrency', {
      jobId: id,
      steps: {
        toValidating: outcome(toValidating),
        staleStatus: outcome(staleStatus),
        staleVersion: outcome(staleVersion),
        applied: outcome(applied),
        replay: outcome(replay),
        illegalFailedToProcessing: outcome(illegal),
        lateStoreResult: outcome(lateResult),
      },
      itemAfterStaleWrites: afterStale,
      finalItem: final,
    });

    expect(toValidating.kind).toBe('applied');
    expect(staleStatus).toMatchObject({
      kind: 'rejected',
      reason: expect.stringMatching(/status conflict/),
    });
    expect(staleVersion).toMatchObject({
      kind: 'rejected',
      reason: expect.stringMatching(/version conflict/),
    });
    expect(afterStale).toMatchObject({ status: WorkflowStatus.Validating, version: 2 });
    expect(applied.kind).toBe('applied');
    expect(replay.kind).not.toBe('applied');
    expect(illegal).toMatchObject({ kind: 'rejected', reason: expect.stringMatching(/illegal/) });
    expect(lateResult.kind).toBe('rejected');
    expect(final).toMatchObject({
      status: WorkflowStatus.Failed,
      version: 3,
      errorName: failure.name,
    });
    expect(final.resultJson).toBeUndefined();
  });
});
