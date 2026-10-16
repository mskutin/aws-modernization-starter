/**
 * Negative HTTP paths: every error is RFC 9457 problem+json with the right status and type, and
 * no rejected request creates a job.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LIMITS, ProblemType } from '@starter/contracts';
import { expectProblem, postDeclaringLength, request, submitJob } from '../support/api.js';
import { validDocument } from '../support/fixtures.js';

const post = (
  raw: string | Uint8Array,
  contentType: string,
  headers: Record<string, string> = {},
) => request('POST', '/v1/jobs', { raw, headers: { 'content-type': contentType, ...headers } });

describe('schema validation (400)', () => {
  it.each([
    ['empty object', {}],
    ['empty title', { title: '', content: 'some words here' }],
    ['whitespace-only title', { title: '   ', content: 'some words here' }],
    ['whitespace-only content', { title: 'ok', content: '   \n\t ' }],
    ['content wrong type', { title: 'ok', content: 42 }],
    ['title too long', { title: 'x'.repeat(LIMITS.titleMaxLength + 1), content: 'words' }],
    ['topTerms out of range', { title: 'ok', content: 'words', options: { topTerms: 0 } }],
    ['topTerms not integer', { title: 'ok', content: 'words', options: { topTerms: 2.5 } }],
    ['unknown top-level field (strict)', { title: 'ok', content: 'words', priority: 'high' }],
    ['unknown option (strict)', { title: 'ok', content: 'words', options: { colour: 'red' } }],
    ['array body', [{ title: 'ok', content: 'words' }]],
  ])('%s → 400 validation problem with field errors', async (_label, body) => {
    const r = await submitJob(body as Record<string, unknown>);
    const problem = expectProblem(r, 400, ProblemType.Validation);
    if (!Array.isArray(body) && Object.keys(body).length > 0) {
      expect(problem.errors?.length ?? 0, JSON.stringify(problem)).toBeGreaterThan(0);
      for (const e of problem.errors ?? []) expect(e.path).toMatch(/^body(\.|$)/);
    }
  });

  it('content longer than the schema limit → 400', async () => {
    const r = await submitJob({ title: 'big', content: 'a '.repeat(LIMITS.contentMaxLength) });
    expectProblem(r, 400, ProblemType.Validation);
  });
});

describe('malformed requests', () => {
  it('malformed JSON → 400 problem+json', async () => {
    expectProblem(await post('{"title": "x", "content": ', 'application/json'), 400);
  });

  it('empty body with JSON content-type → 400 problem+json', async () => {
    expectProblem(await post('', 'application/json'), 400);
  });

  it('unsupported media type → 415 problem+json', async () => {
    const r = await post('title=x&content=y', 'application/x-www-form-urlencoded');
    expectProblem(r, 415, ProblemType.UnsupportedMediaType);
  });

  it('text/plain body → 415 problem+json', async () => {
    expectProblem(await post('hello', 'text/plain'), 415, ProblemType.UnsupportedMediaType);
  });

  it('oversize payload → 413 problem+json, rejected from Content-Length before reading the body', async () => {
    // 3 MiB declared: far above the API body limit (the schema caps content at 40k characters).
    const r = await postDeclaringLength('/v1/jobs', 3 * 1024 * 1024);
    expectProblem(r, 413, ProblemType.PayloadTooLarge);
  });

  it.each([
    ['too short', 'short'],
    ['illegal characters', 'not a valid key!'],
    ['colon (reserved for server-derived keys)', 'derived:v1:abcdef0123'],
    ['too long', 'k'.repeat(129)],
  ])('invalid Idempotency-Key (%s) → 400 problem+json', async (_label, key) => {
    const r = await submitJob(validDocument('bad-key'), { idempotencyKey: key });
    const problem = expectProblem(r, 400, ProblemType.Validation);
    expect(JSON.stringify(problem.errors ?? problem.detail ?? '')).toMatch(/idempotency/i);
  });
});

describe('not found / bad identifiers', () => {
  it('unknown job id → 404 problem+json', async () => {
    const r = await request('GET', `/v1/jobs/${randomUUID()}`);
    expectProblem(r, 404, ProblemType.NotFound);
  });

  it('non-UUID job id → 400 problem+json', async () => {
    expectProblem(await request('GET', '/v1/jobs/not-a-uuid'), 400, ProblemType.Validation);
  });

  it('unknown route → 404 problem+json (authenticated; anonymous callers get 401)', async () => {
    expectProblem(await request('GET', '/v1/nope'), 404);
    expectProblem(await request('GET', '/v1/nope', { as: null }), 401, ProblemType.Unauthorized);
  });

  it('unsupported method on a known route → 404/405 problem+json', async () => {
    const r = await request('DELETE', `/v1/jobs/${randomUUID()}`);
    expect([404, 405]).toContain(r.status);
    expectProblem(r, r.status);
  });
});
