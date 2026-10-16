/**
 * Test helpers: contract-valid fixtures and a fetch mock at the network
 * boundary (the real ApiClient runs on top of it).
 */
import type { Job, JobResult, JobSummary, Problem } from '@starter/contracts';
import { vi, type Mock } from 'vitest';
import { createApiClient, type ApiClient, type FetchLike } from '../src/api/client';

export const JOB_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
export const OTHER_JOB_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

export function aResult(overrides: Partial<JobResult> = {}): JobResult {
  return {
    algorithmVersion: '1.0.0',
    wordCount: 30,
    uniqueWordCount: 26,
    sentenceCount: 5,
    paragraphCount: 2,
    characterCount: 211,
    averageWordLength: 5.6,
    averageSentenceLength: 6,
    lexicalDiversity: 0.8667,
    readingTimeSeconds: 9,
    topTerms: [
      { term: 'cloud', count: 3 },
      { term: 'migration', count: 3 },
      { term: 'applications', count: 1 },
    ],
    checksumSha256: 'ab'.repeat(32),
    ...overrides,
  };
}

export function aJob(overrides: Partial<Job> = {}): Job {
  return {
    jobId: JOB_ID,
    title: 'Migration notes',
    status: 'PENDING',
    contractVersion: '1.0.0',
    options: { topTerms: 10 },
    contentLength: 211,
    contentSha256: 'ab'.repeat(32),
    createdAt: '2026-10-13T10:00:00.000Z',
    updatedAt: '2026-10-13T10:00:00.000Z',
    result: null,
    error: null,
    ...overrides,
  };
}

export function aSummary(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    jobId: JOB_ID,
    title: 'Migration notes',
    status: 'SUCCEEDED',
    createdAt: '2026-10-13T10:00:00.000Z',
    updatedAt: '2026-10-13T10:00:05.000Z',
    ...overrides,
  };
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

export function problemResponse(problem: Partial<Problem> & { status: number }): Response {
  const body: Problem = {
    type: 'urn:starter:problem:test',
    title: 'Problem',
    requestId: 'req-123',
    ...problem,
  };
  return new Response(JSON.stringify(body), {
    status: problem.status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

export type FetchMock = Mock<FetchLike>;

type Reply = Response | Error | (() => Response | Promise<Response>);

/** Replies in order; fails the test loudly on an unexpected extra request. */
export function sequenceFetch(...replies: Reply[]): FetchMock {
  const queue = [...replies];
  return vi.fn<FetchLike>(async (url) => {
    const next = queue.shift();
    if (next === undefined) throw new Error(`Unexpected request: ${url}`);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  });
}

/** Never resolves; rejects with an AbortError when the request is aborted. */
export function hangingFetch(): FetchMock {
  return vi.fn<FetchLike>(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      }),
  );
}

export interface Route {
  method?: string;
  url: RegExp;
  reply: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

/** Routes requests by method + URL pattern (for whole-app tests). */
export function routedFetch(routes: Route[]): FetchMock {
  return vi.fn<FetchLike>(async (url, init) => {
    const method = init?.method ?? 'GET';
    const route = routes.find((r) => (r.method ?? 'GET') === method && r.url.test(url));
    if (!route) throw new Error(`Unexpected request: ${method} ${url}`);
    return route.reply(url, init);
  });
}

export function clientWith(fetchMock: FetchMock): ApiClient {
  return createApiClient({ baseUrl: '/v1', fetch: fetchMock });
}

export function requestHeaders(fetchMock: FetchMock, call = 0): Headers {
  return new Headers(fetchMock.mock.calls[call]?.[1]?.headers);
}

export function requestUrl(fetchMock: FetchMock, call = 0): string | undefined {
  return fetchMock.mock.calls[call]?.[0];
}
