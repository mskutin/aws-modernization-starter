/**
 * Claim-check proof at the API boundary: what the API hands to the workflow port (and therefore to
 * StartExecution) is exactly `{ jobId, contractVersion, submittedAt }` — no document, title,
 * options, idempotency key or anything derived from them. Fails if a field is reintroduced.
 */
import { EXECUTION_INPUT_KEYS } from '@starter/workflow-processing';
import { findLeaks, leakCanary } from '@starter/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp } from './fakes.js';

describe('API → workflow input (capturing port)', () => {
  let h: Awaited<ReturnType<typeof buildTestApp>>;
  afterEach(async () => {
    await h.app.close();
  });

  it.each([
    ['without an Idempotency-Key (derived key = content hash)', {}],
    ['with an Idempotency-Key', { 'idempotency-key': 'replay01' }],
  ])('carries exactly the job reference %s', async (_name, headers) => {
    h = await buildTestApp();
    const canary = leakCanary();
    const response = await h.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { 'content-type': 'application/json', ...headers },
      payload: JSON.stringify({
        title: canary.title,
        content: canary.content,
        options: { topTerms: 3 },
      }),
    });
    expect(response.statusCode).toBe(202);
    expect(h.workflow.started).toHaveLength(1);
    const input = h.workflow.started[0]!;
    expect(Object.keys(input).sort()).toEqual([...EXECUTION_INPUT_KEYS].sort());
    const serialised = JSON.stringify(input);
    expect(findLeaks(serialised, canary)).toEqual([]);
    expect(serialised).not.toMatch(/derived:|replay01|topTerms|title|content|payload/);
    expect(input.jobId).toBe(response.json<{ jobId: string }>().jobId);
  });
});
