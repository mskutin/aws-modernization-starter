/**
 * GET /v1/jobs keyset pagination: newest first, no duplicates/gaps across pages, cursor
 * stability while other tests insert concurrently, and limit/cursor validation.
 */
import { describe, expect, it } from 'vitest';
import { JobListSchema, LIMITS, ProblemType, type JobSummary } from '@starter/contracts';
import {
  describeResponse,
  expectJobResponse,
  expectProblem,
  request,
  submitJob,
} from '../support/api.js';
import { validDocument } from '../support/fixtures.js';

async function listPage(query: string) {
  const r = await request('GET', `/v1/jobs${query}`);
  expect(r.status, describeResponse(r)).toBe(200);
  return JobListSchema.parse(r.body);
}

/** Newest first: each item was created no later than the one before it. */
const notAfter = (a: JobSummary, b: JobSummary) =>
  Date.parse(a.createdAt) >= Date.parse(b.createdAt);

describe('list jobs', () => {
  it('pages newest-first with an opaque cursor until all of our jobs are seen', async () => {
    const mine: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      // sequential so createdAt order is well defined
      mine.push(expectJobResponse(await submitJob(validDocument(`page-${i}`))).jobId);
    }
    const seen: JobSummary[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listPage(
        `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && !mine.every((id) => seen.some((s) => s.jobId === id)) && pages < 500);

    const ids = seen.map((s) => s.jobId);
    expect(new Set(ids).size, 'no job appears on two pages').toBe(ids.length);
    for (let i = 1; i < seen.length; i += 1) {
      expect(
        notAfter(seen[i - 1]!, seen[i]!),
        `ordering broken at ${i}: ${seen[i - 1]!.createdAt} then ${seen[i]!.createdAt}`,
      ).toBe(true);
    }
    // ours appear in reverse submission order (newest first)
    const positions = mine.map((id) => ids.indexOf(id));
    expect(
      positions.every((p) => p >= 0),
      `missing jobs; positions ${positions.join(',')}`,
    ).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => b - a));
  });

  it('defaults to the documented page size and caps at the maximum', async () => {
    const page = await listPage('');
    expect(page.items.length).toBeLessThanOrEqual(LIMITS.listLimitDefault);
    const max = await listPage(`?limit=${LIMITS.listLimitMax}`);
    expect(max.items.length).toBeLessThanOrEqual(LIMITS.listLimitMax);
  });

  it.each([
    ['limit=0', `?limit=${LIMITS.listLimitMin - 1}`],
    ['limit above max', `?limit=${LIMITS.listLimitMax + 1}`],
    ['non-numeric limit', '?limit=ten'],
    ['garbage cursor', '?cursor=%25%25not-a-cursor%25%25'],
    ['unknown query parameter', '?limit=5&sort=asc'],
  ])('rejects %s with 400 problem+json', async (_label, query) => {
    const r = await request('GET', `/v1/jobs${query}`);
    expectProblem(r, 400, ProblemType.Validation);
  });
});
