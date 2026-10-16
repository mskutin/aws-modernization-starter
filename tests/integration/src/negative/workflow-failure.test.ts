/**
 * Workflow failure path: requests that pass the API schema (202) but violate a business rule
 * fail inside the workflow with JobValidationError — recorded, not retried, never processed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  JobStateTable,
  ProcessingState,
  WorkflowError,
  WorkflowStatus,
} from '@starter/workflow-processing';
import { expectJobResponse, submitJob, waitForTerminal } from '../support/api.js';
import {
  VALID_DOCUMENT,
  businessInvalidDocument,
  controlCharacterDocument,
} from '../support/fixtures.js';
import { closeStores, dynamoSkipReason, getStateItem, getStepItems } from '../support/stores.js';

afterAll(closeStores);

describe('workflow failure path', () => {
  it.each([
    ['too few words', businessInvalidDocument('few-words')],
    ['title without letters or digits', { title: '--- !!! ---', content: VALID_DOCUMENT }],
    ['forbidden control characters', controlCharacterDocument()],
  ])('%s → 202 then FAILED with JobValidationError and no result', async (_label, doc) => {
    const created = expectJobResponse(await submitJob(doc));
    const { job, observed } = await waitForTerminal(created.jobId);
    expect(job.status).toBe('FAILED');
    expect(observed).not.toContain('SUCCEEDED');
    expect(observed).not.toContain('PROCESSING');
    expect(job.result).toBeNull();
    expect(job.error?.name).toBe(WorkflowError.Validation);
    expect(job.error?.message.length).toBeGreaterThan(0);
    // business-rule messages must not echo document content (may contain personal data)
    expect(job.error?.message).not.toContain('Cloud migration is a journey');
  });

  it.skipIf(dynamoSkipReason)(
    `failure recorded in DynamoDB per spec; ProcessJob never ran${dynamoSkipReason ? ` [SKIPPED: ${dynamoSkipReason}]` : ''}`,
    async () => {
      const created = expectJobResponse(await submitJob(businessInvalidDocument('ddb-failure')));
      const { job } = await waitForTerminal(created.jobId);
      const item = await getStateItem(job.jobId);
      const a = JobStateTable.attributes;
      expect(item?.[a.status]).toBe(WorkflowStatus.Failed);
      expect(item?.[a.errorName]).toBe(WorkflowError.Validation);
      expect(String(item?.[a.errorMessage] ?? '')).not.toBe('');
      expect(item?.[a.result]).toBeUndefined();
      expect(item?.gsi1pk).toBe(`STATUS#${WorkflowStatus.Failed}`);

      const steps = await getStepItems(job.jobId);
      const states = steps.map((s) => s.state);
      expect(states).not.toContain(ProcessingState.Process);
      // validation failure is permanent: exactly one ValidateJob attempt recorded as failed
      const validates = steps.filter((s) => s.state === ProcessingState.Validate);
      expect(validates, JSON.stringify(steps)).toHaveLength(1);
      expect(validates[0]?.outcome).toBe('failed');
    },
  );
});
