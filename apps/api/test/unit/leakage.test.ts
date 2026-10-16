/**
 * Document-data leakage end to end in-process (in-memory stores): a canary document submitted through the
 * HTTP API and run by the LOCAL SIMULATION (not Step Functions) leaves no raw document text
 * (sentence, non-term token, title) in any captured log line (API + step logs), in the workflow
 * input, or in any job-state item. The analysis result legitimately lives in the job item
 * only; the canary markers are chosen so they can never be part of it.
 */
import { InMemoryDocumentSource } from '@starter/documents';
import { InMemoryJobStateStore } from '@starter/job-state';
import { findLeaks, leakCanary, rejectedLeakCanary } from '@starter/testing';
import { describe, expect, it } from 'vitest';
import { LocalWorkflowSimulator } from '../../src/workflow/local-simulator.js';
import { buildTestApp, capturingLogger } from './fakes.js';

describe('canary leakage through API + local simulation', () => {
  it.each([
    ['an accepted document', leakCanary, 'SUCCEEDED'],
    ['a rejected document', rejectedLeakCanary, 'FAILED'],
  ] as const)('%s leaves no raw text outside the document store', async (_n, make, status) => {
    const canary = make();
    const state = new InMemoryJobStateStore();
    const documents = new InMemoryDocumentSource();
    const { logger, raw } = capturingLogger();
    const simulator = new LocalWorkflowSimulator({
      store: state,
      documents,
      logger,
      timeScale: 0.001,
    });
    // The simulator reads the document the API stored (PostgreSQL in production).
    const h = await buildTestApp({ state, workflow: simulator, logger });
    const originalInsert = h.jobs.insert.bind(h.jobs);
    h.jobs.insert = async (record) => {
      documents.put(record.id, {
        title: record.title,
        content: record.content,
        options: record.options,
      });
      return originalInsert(record);
    };
    try {
      const response = await h.inject({
        method: 'POST',
        url: '/v1/jobs',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ title: canary.title, content: canary.content }),
      });
      expect(response.statusCode).toBe(202);
      const { jobId } = response.json<{ jobId: string }>();
      await simulator.waitFor(jobId);
      expect((await state.get(jobId))?.status).toBe(status);

      expect(findLeaks(raw, canary)).toEqual([]);
      expect(findLeaks(state.items(), canary)).toEqual([]);
      expect(documents.loads).toBeGreaterThan(0);
    } finally {
      await h.app.close();
    }
  });
});
