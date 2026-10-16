/**
 * Full job lifecycle through the public API, plus the persisted state behind it.
 * NOTE: against WORKFLOW_MODE=local this exercises the API's in-process workflow simulation,
 * not Step Functions — the AWS mini-stack suite covers the real state machine.
 */
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, JOB_STATUSES } from '@starter/contracts';
import { JobStateTable, WorkflowStatus } from '@starter/workflow-processing';
import { expectJobResponse, newKey, submitJob, waitForTerminal } from '../support/api.js';
import { DEFAULT_PRINCIPAL, issuerOf, storedKey, tokenFor } from '../support/auth.js';
import { validDocument } from '../support/fixtures.js';
import {
  closeStores,
  dynamoSkipReason,
  getJobRow,
  getStateItem,
  pgSkipReason,
} from '../support/stores.js';

afterAll(closeStores);

/** Allowed forward transitions (spec: PENDING → VALIDATING → PROCESSING → SUCCEEDED | FAILED). */
const ORDER = JOB_STATUSES.indexOf.bind(JOB_STATUSES);

describe('job lifecycle', () => {
  it('POST 202 → status progresses monotonically → SUCCEEDED with contract-valid results', async () => {
    const doc = validDocument('lifecycle');
    const created = expectJobResponse(await submitJob(doc));

    expect(created.title).toBe(doc.title);
    expect(created.contractVersion).toBe(CONTRACT_VERSION);
    expect(created.options).toEqual({ topTerms: 5 });
    expect(created.contentLength).toBe(doc.content.length);
    expect(created.contentSha256).toBe(createHash('sha256').update(doc.content).digest('hex'));
    expect(['PENDING', 'VALIDATING', 'PROCESSING', 'SUCCEEDED']).toContain(created.status);
    expect(created.result).toBeNull();
    expect(created.error).toBeNull();

    const { job, observed } = await waitForTerminal(created.jobId);
    expect(job.status).toBe('SUCCEEDED');
    // never moves backwards and never visits FAILED on the way
    const idx = observed.map((s) => ORDER(s as (typeof JOB_STATUSES)[number]));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(observed).not.toContain('FAILED');

    expect(job.error).toBeNull();
    expect(job.result).not.toBeNull();
    const result = job.result!;
    expect(result.checksumSha256).toBe(created.contentSha256);
    expect(result.wordCount).toBeGreaterThanOrEqual(10);
    expect(result.paragraphCount).toBe(2);
    expect(result.uniqueWordCount).toBeLessThanOrEqual(result.wordCount);
    expect(result.topTerms.length).toBeGreaterThan(0);
    expect(result.topTerms.length).toBeLessThanOrEqual(5);
    // topTerms ordered by descending count
    const counts = result.topTerms.map((t) => t.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(Date.parse(job.updatedAt)).toBeGreaterThanOrEqual(Date.parse(job.createdAt));
  });

  it.skipIf(dynamoSkipReason)(
    `DynamoDB STATE item mirrors the terminal status${dynamoSkipReason ? ` [SKIPPED: ${dynamoSkipReason}]` : ''}`,
    async () => {
      const created = expectJobResponse(await submitJob(validDocument('ddb-state')));
      const { job } = await waitForTerminal(created.jobId);
      const item = await getStateItem(job.jobId);
      const a = JobStateTable.attributes;
      expect(item).toBeDefined();
      expect(item?.pk).toBe(`JOB#${job.jobId}`);
      expect(item?.sk).toBe('STATE');
      expect(item?.[a.jobId]).toBe(job.jobId);
      expect(item?.[a.status]).toBe(WorkflowStatus.Succeeded);
      expect(typeof item?.[a.version]).toBe('number');
      expect(item?.[a.errorName]).toBeUndefined();
      // resultJson is the JSON-encoded processor result; same analysis the API returns
      const stored = JSON.parse(String(item?.[a.result])) as Record<string, unknown>;
      expect(stored.checksumSha256).toBe(job.result?.checksumSha256);
      expect(stored.wordCount).toBe(job.result?.wordCount);
      expect(item?.gsi1pk).toBe(`STATUS#${WorkflowStatus.Succeeded}`);
      expect(item?.gsi1sk).toBe(`${String(item?.[a.updatedAt])}#${job.jobId}`);
    },
  );

  it.skipIf(pgSkipReason)(
    `PostgreSQL row is the business record of the submission${pgSkipReason ? ` [SKIPPED: ${pgSkipReason}]` : ''}`,
    async () => {
      const doc = validDocument('pg-row');
      const key = newKey('pg-row');
      const created = expectJobResponse(await submitJob(doc, { idempotencyKey: key }));
      // persist-then-start: the row exists as soon as the API has answered 202
      const row = await getJobRow(created.jobId);
      expect(row, `no jobs row for ${created.jobId}`).toBeDefined();
      expect(row?.title).toBe(doc.title);
      // starter_app cannot read `content`: the stored hash proves what was persisted.
      expect(created.contentSha256).toBe(
        createHash('sha256').update(doc.content, 'utf8').digest('hex'),
      );
      expect(row?.content_sha256).toBe(created.contentSha256);
      expect(Number(row?.content_length)).toBe(doc.content.length);
      expect(row?.idempotency_key).toBe(await storedKey(key));
      // Issuer-bound owner: the token's `iss` and `sub`.
      expect(row?.owner_issuer).toBe(issuerOf(await tokenFor()));
      expect(row?.owner_subject).toBe(DEFAULT_PRINCIPAL);
      expect(row).not.toHaveProperty('owner_id');
      expect(row?.contract_version).toBe(CONTRACT_VERSION);
      expect(row?.options).toEqual({ topTerms: 5 });
      expect(row?.created_at).toBeInstanceOf(Date);
      expect((row?.created_at as Date).toISOString()).toBe(created.createdAt);
    },
  );
});
