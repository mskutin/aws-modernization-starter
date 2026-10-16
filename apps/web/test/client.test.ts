import { describe, expect, it, vi } from 'vitest';
import { apiBaseFromEnv, resolveApiBase } from '../src/api/base-url';
import { createApiClient } from '../src/api/client';
import { ApiError } from '../src/api/errors';
import {
  JOB_ID,
  aJob,
  aSummary,
  clientWith,
  hangingFetch,
  jsonResponse,
  problemResponse,
  requestHeaders,
  requestUrl,
  sequenceFetch,
} from './helpers';

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('resolveApiBase', () => {
  it.each([
    [undefined, '/v1'],
    ['', '/v1'],
    ['   ', '/v1'],
    ['https://api.example.com', 'https://api.example.com/v1'],
    ['https://api.example.com/', 'https://api.example.com/v1'],
    ['https://api.example.com/v1', 'https://api.example.com/v1'],
    ['http://127.0.0.1:8080/v1/', 'http://127.0.0.1:8080/v1'],
    ['/api', '/api/v1'],
  ])('resolves %j to %s', (configured, expected) => {
    expect(resolveApiBase(configured)).toBe(expected);
  });

  it.each(['ftp://example.com', 'api.example.com', '//evil.example.com', 'javascript:alert(1)'])(
    'falls back to /v1 and warns for invalid value %s',
    (configured) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(resolveApiBase(configured)).toBe('/v1');
      expect(warn).toHaveBeenCalledOnce();
    },
  );

  it('reads VITE_API_BASE_URL from the Vite environment', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com');
    expect(apiBaseFromEnv()).toBe('https://api.example.com/v1');

    const fetchMock = sequenceFetch(jsonResponse(aJob()));
    const client = createApiClient({ fetch: fetchMock });
    expect(client.baseUrl).toBe('https://api.example.com/v1');
    await client.getJob(JOB_ID);
    expect(requestUrl(fetchMock)).toBe(`https://api.example.com/v1/jobs/${JOB_ID}`);
  });
});

describe('ApiClient', () => {
  it('creates a job with JSON body, Idempotency-Key and Accept headers', async () => {
    const job = aJob();
    const fetchMock = sequenceFetch(jsonResponse(job, { status: 202 }));
    const result = await clientWith(fetchMock).createJob(
      { title: 'T', content: 'Body text', options: { topTerms: 5 } },
      'key-12345678',
    );

    expect(result).toEqual({ job, replayed: false });
    expect(requestUrl(fetchMock)).toBe('/v1/jobs');
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      title: 'T',
      content: 'Body text',
      options: { topTerms: 5 },
    });
    const headers = requestHeaders(fetchMock);
    expect(headers.get('Idempotency-Key')).toBe('key-12345678');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Accept')).toContain('application/problem+json');
  });

  it('reports idempotent replays', async () => {
    const fetchMock = sequenceFetch(
      jsonResponse(aJob(), { status: 200, headers: { 'Idempotent-Replayed': 'true' } }),
    );
    const result = await clientWith(fetchMock).createJob(
      { title: 'T', content: 'x', options: { topTerms: 10 } },
      'key-12345678',
    );
    expect(result.replayed).toBe(true);
  });

  it('gets a job by id (URL-encoded) and strips unknown fields', async () => {
    const fetchMock = sequenceFetch(jsonResponse({ ...aJob(), futureField: 1 }));
    const job = await clientWith(fetchMock).getJob(JOB_ID);
    expect(job).toEqual(aJob());
    expect(requestUrl(fetchMock)).toBe(`/v1/jobs/${JOB_ID}`);

    const encoded = sequenceFetch(jsonResponse(aJob()));
    await clientWith(encoded).getJob('a/b?c');
    expect(requestUrl(encoded)).toBe('/v1/jobs/a%2Fb%3Fc');
  });

  it('lists jobs with limit and cursor query parameters', async () => {
    const page = { items: [aSummary()], nextCursor: 'next==' };
    const fetchMock = sequenceFetch(jsonResponse(page), jsonResponse(page));
    const client = clientWith(fetchMock);
    expect(await client.listJobs({ limit: 5, cursor: 'abc=' })).toEqual(page);
    expect(requestUrl(fetchMock)).toBe('/v1/jobs?limit=5&cursor=abc%3D');
    await client.listJobs();
    expect(requestUrl(fetchMock, 1)).toBe('/v1/jobs');
  });

  it('turns problem+json responses into typed errors with field errors', async () => {
    const fetchMock = sequenceFetch(
      problemResponse({
        status: 400,
        title: 'Bad Request',
        detail: 'Request validation failed',
        errors: [{ path: 'body.title', message: 'Too small' }],
      }),
    );
    const error = await caught(
      clientWith(fetchMock).createJob(
        { title: 'T', content: 'x', options: { topTerms: 10 } },
        'key-12345678',
      ),
    );
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError).toMatchObject({
      kind: 'problem',
      status: 400,
      message: 'Request validation failed',
    });
    expect(apiError.fieldErrors).toEqual([{ path: 'body.title', message: 'Too small' }]);
    expect(apiError.problem?.requestId).toBe('req-123');
    expect(apiError.isTransient).toBe(false);
  });

  it('classifies non-problem error responses as http errors', async () => {
    const fetchMock = sequenceFetch(
      new Response('<html>Bad gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const error = (await caught(clientWith(fetchMock).getJob(JOB_ID))) as ApiError;
    expect(error).toMatchObject({ kind: 'http', status: 502, isTransient: true });
  });

  it('treats a malformed problem body as a plain http error', async () => {
    const fetchMock = sequenceFetch(
      new Response('{"oops":true}', {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      }),
    );
    const error = (await caught(clientWith(fetchMock).getJob(JOB_ID))) as ApiError;
    expect(error).toMatchObject({ kind: 'http', status: 404, problem: null });
  });

  it.each([
    ['a body that violates the contract', jsonResponse({ ...aJob(), status: 'RUNNING' })],
    ['a non-JSON body', new Response('not json', { status: 200 })],
    ['an empty body', new Response('', { status: 200 })],
  ])('rejects %s on success responses', async (_name, response) => {
    const error = (await caught(clientWith(sequenceFetch(response)).getJob(JOB_ID))) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'invalid-response', status: 200, isTransient: false });
  });

  it('wraps network failures', async () => {
    const fetchMock = sequenceFetch(new TypeError('Failed to fetch'));
    const error = (await caught(clientWith(fetchMock).getJob(JOB_ID))) as ApiError;
    expect(error).toMatchObject({ kind: 'network', status: null, isTransient: true });
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it('lets aborts propagate unwrapped so callers can ignore them', async () => {
    const controller = new AbortController();
    const pending = clientWith(hangingFetch()).getJob(JOB_ID, controller.signal);
    controller.abort();
    const error = await caught(pending);
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as Error).name).toBe('AbortError');
  });

  it('uses the global fetch by default (resolved at call time)', async () => {
    const fetchMock = sequenceFetch(jsonResponse(aJob()));
    vi.stubGlobal('fetch', fetchMock);
    await createApiClient({ baseUrl: '/v1' }).getJob(JOB_ID);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('authentication (identity)', () => {
  it('sends the bearer token of the signed-in user', async () => {
    const fetchMock = sequenceFetch(jsonResponse({ items: [], nextCursor: null }));
    const client = createApiClient({
      baseUrl: '/v1',
      fetch: fetchMock,
      getAccessToken: () => 'tok',
    });
    await client.listJobs();
    expect(requestHeaders(fetchMock).get('authorization')).toBe('Bearer tok');
  });

  it('sends no Authorization header without a session', async () => {
    const fetchMock = sequenceFetch(jsonResponse({ items: [], nextCursor: null }));
    await clientWith(fetchMock).listJobs();
    expect(requestHeaders(fetchMock).get('authorization')).toBeNull();
  });

  it('reports a 401 to the auth layer before throwing', async () => {
    const onUnauthorized = vi.fn();
    const fetchMock = sequenceFetch(problemResponse({ status: 401, title: 'Unauthorized' }));
    const client = createApiClient({ baseUrl: '/v1', fetch: fetchMock, onUnauthorized });
    const error = await caught(client.listJobs());
    expect(error).toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('does not treat 403 or 429 as a lost session, and keeps Retry-After', async () => {
    const onUnauthorized = vi.fn();
    const fetchMock = sequenceFetch(
      problemResponse({ status: 403, title: 'Forbidden' }),
      new Response(
        JSON.stringify({
          type: 'urn:starter:problem:too-many-requests',
          title: 'Too Many Requests',
          status: 429,
        }),
        {
          status: 429,
          headers: { 'content-type': 'application/problem+json', 'retry-after': '17' },
        },
      ),
    );
    const client = createApiClient({ baseUrl: '/v1', fetch: fetchMock, onUnauthorized });
    expect(((await caught(client.listJobs())) as ApiError).status).toBe(403);
    const limited = (await caught(client.listJobs())) as ApiError;
    expect(limited.status).toBe(429);
    expect(limited.retryAfterSeconds).toBe(17);
    expect(limited.isTransient).toBe(true);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
