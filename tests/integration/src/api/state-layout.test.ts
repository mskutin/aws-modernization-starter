/**
 * DynamoDB items written for a job match the single-table layout in
 * workflows/processing/src/spec.ts (keys, GSI1, TTL, step audit trail).
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  JobStateTable,
  ProcessingState,
  WorkflowStatus,
  type ProcessingStateName,
} from '@starter/workflow-processing';
import { expectJobResponse, newKey, submitJob, waitForTerminal } from '../support/api.js';
import { storedKey } from '../support/auth.js';
import { validDocument } from '../support/fixtures.js';
import { pollUntil } from '../support/poll.js';
import {
  closeStores,
  dynamoSkipReason,
  getIdempotencyItem,
  getStepItems,
  statusIndexContains,
} from '../support/stores.js';

afterAll(closeStores);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const STATES = new Set<string>(Object.values(ProcessingState));

describe.skipIf(dynamoSkipReason)(
  `DynamoDB state layout${dynamoSkipReason ? ` [SKIPPED: ${dynamoSkipReason}]` : ''}`,
  () => {
    it('idempotency record: pk/sk per spec, points at the job, TTL ~24h in epoch seconds', async () => {
      const key = newKey('layout');
      const before = Math.floor(Date.now() / 1000);
      const created = expectJobResponse(
        await submitJob(validDocument('layout'), { idempotencyKey: key }),
      );
      const stored = await storedKey(key);
      const rec = await getIdempotencyItem(stored);
      expect(rec).toBeDefined();
      expect(rec?.pk).toBe(`IDEMPOTENCY#${stored}`);
      expect(stored).toMatch(/^p:[a-f0-9]{64}:h:/);
      expect(rec?.sk).toBe('IDEMPOTENCY');
      expect(rec?.jobId).toBe(created.jobId);
      expect(typeof rec?.fingerprint).toBe('string');
      const ttl = rec?.[JobStateTable.ttlAttribute];
      expect(typeof ttl, 'TTL attribute must be a Number (epoch seconds)').toBe('number');
      // 24h TTL (allow generous skew; must not be milliseconds)
      expect(Number(ttl)).toBeGreaterThan(before + 23 * 3600);
      expect(Number(ttl)).toBeLessThan(before + 25 * 3600);
    });

    it('step audit trail: STEP#<iso>#<state> items in order, ending with a terminal record', async () => {
      const created = expectJobResponse(await submitJob(validDocument('steps')));
      const { job } = await waitForTerminal(created.jobId);
      const steps = await getStepItems(job.jobId);
      expect(steps.length).toBeGreaterThanOrEqual(2);
      const seen: ProcessingStateName[] = [];
      for (const s of steps) {
        const m = /^STEP#(.+)#([A-Za-z]+)$/.exec(String(s.sk));
        expect(m, `bad step sk ${String(s.sk)}`).not.toBeNull();
        expect(m?.[1]).toMatch(ISO);
        expect(STATES.has(m?.[2] ?? ''), `unknown state ${m?.[2]}`).toBe(true);
        expect(s.pk).toBe(`JOB#${job.jobId}`);
        expect(s.state).toBe(m?.[2]);
        seen.push(m?.[2] as ProcessingStateName);
      }
      expect(seen.indexOf(ProcessingState.Validate)).toBeGreaterThanOrEqual(0);
      expect(seen.indexOf(ProcessingState.Process)).toBeGreaterThan(
        seen.indexOf(ProcessingState.Validate),
      );
    });

    it('gsi1 lists the job under STATUS#SUCCEEDED (eventually consistent → polled)', async () => {
      const created = expectJobResponse(await submitJob(validDocument('gsi')));
      const { job } = await waitForTerminal(created.jobId);
      expect(job.status).toBe('SUCCEEDED');
      await pollUntil(
        `gsi1 STATUS#SUCCEEDED to contain ${job.jobId}`,
        async () =>
          (await statusIndexContains(WorkflowStatus.Succeeded, job.jobId)) ? true : undefined,
        { deadlineMs: 10_000 },
      );
      // ...and no longer under a non-terminal status
      expect(await statusIndexContains(WorkflowStatus.Pending, job.jobId)).toBe(false);
    });
  },
);
