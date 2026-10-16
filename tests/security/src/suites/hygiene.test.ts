/**
 * Response hygiene on every target: errors are RFC 9457 problem+json without stack traces, SQL,
 * ARNs, internal host names, secrets or tokens; every /v1 response carries `nosniff` and
 * `no-store`; CORS never grants a foreign origin.
 */
import { randomUUID } from 'node:crypto';
import { INSUFFICIENT_SCOPE } from '@starter/testing/auth';
import { beforeAll, describe, expect, it } from 'vitest';
import { context } from '../context.js';
import { call, describeRes, type Res } from '../http.js';
import {
  documentBody,
  expectCleanBody,
  expectProblem,
  expectSecurityHeaders,
  ProblemType,
} from '../support.js';
import { mintToken, principal } from '../tokens.js';

const ctx = context();
const SUITE = 'hyg';
const FOREIGN_ORIGIN = 'https://evil.example';

describe.each(ctx.targets)('response hygiene — $name: $description', (target) => {
  let token: string;
  beforeAll(async () => {
    token = await mintToken(ctx.tokenEndpoint, { sub: principal(ctx.runId, SUITE, target.name) });
  });

  const errorCases = (): [string, number, string, () => Promise<Res>][] => [
    ['anonymous', 401, ProblemType.Unauthorized, () => call(target, 'GET', '/v1/jobs')],
    [
      'forged token',
      401,
      ProblemType.Unauthorized,
      async () =>
        call(target, 'GET', '/v1/jobs', {
          token: await mintToken(ctx.tokenEndpoint, {
            sub: principal(ctx.runId, SUITE, 'forged'),
            options: { hs256WithPublicKey: true },
          }),
        }),
    ],
    [
      'insufficient scope',
      403,
      ProblemType.Forbidden,
      async () =>
        call(target, 'GET', '/v1/jobs', {
          token: await mintToken(ctx.tokenEndpoint, {
            sub: principal(ctx.runId, SUITE, 'noscope'),
            options: INSUFFICIENT_SCOPE,
          }),
        }),
    ],
    [
      'unknown job',
      404,
      ProblemType.NotFound,
      () => call(target, 'GET', `/v1/jobs/${randomUUID()}`, { token }),
    ],
    [
      'malformed job id',
      400,
      ProblemType.Validation,
      () => call(target, 'GET', "/v1/jobs/1'%20OR%20'1'='1", { token }),
    ],
    [
      'invalid JSON',
      400,
      ProblemType.Validation,
      () =>
        call(target, 'POST', '/v1/jobs', {
          token,
          body: '{"title": "unterminated',
          headers: { 'content-type': 'application/json', 'idempotency-key': `hyg-${randomUUID()}` },
        }),
    ],
    [
      'SQL-ish payload in a field',
      400,
      ProblemType.Validation,
      () =>
        call(target, 'POST', '/v1/jobs', {
          token,
          json: {
            title: "x'); DROP TABLE jobs; --",
            content: '',
            options: { topTerms: 'SELECT 1' },
          },
          headers: { 'idempotency-key': `hyg-${randomUUID()}` },
        }),
    ],
    [
      'wrong media type',
      415,
      ProblemType.UnsupportedMediaType,
      () =>
        call(target, 'POST', '/v1/jobs', {
          token,
          body: 'title=x',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'idempotency-key': `hyg-${randomUUID()}`,
          },
        }),
    ],
    [
      'invalid cursor',
      400,
      ProblemType.Validation,
      () => call(target, 'GET', `/v1/jobs?cursor=${'%27'.repeat(10)}AAAA`, { token }),
    ],
  ];

  it('every error is problem+json without internals, and carries nosniff and no-store', async () => {
    for (const [name, status, type, send] of errorCases()) {
      const r = await send();
      expectProblem(r, status, type);
      expectCleanBody(r, ctx, name);
      expectSecurityHeaders(r);
    }
  });

  it('successful /v1 responses carry nosniff and no-store, and no internals', async () => {
    const created = await call(target, 'POST', '/v1/jobs', {
      token,
      json: documentBody(`hygiene ${ctx.runId}`, randomUUID()),
      headers: { 'idempotency-key': `hyg-${randomUUID()}` },
    });
    expect([200, 202], describeRes(created)).toContain(created.status);
    for (const r of [created, await call(target, 'GET', '/v1/jobs', { token })]) {
      expectSecurityHeaders(r);
      expectCleanBody(r, ctx, 'success');
    }
  });

  it('CORS: a foreign origin is never granted (simple request and preflight)', async () => {
    const simple = await call(target, 'GET', '/v1/jobs', {
      token,
      headers: { origin: FOREIGN_ORIGIN },
    });
    const preflight = await call(target, 'OPTIONS', '/v1/jobs', {
      headers: {
        origin: FOREIGN_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    for (const r of [simple, preflight]) {
      const allowed = r.headers.get('access-control-allow-origin');
      expect(allowed === FOREIGN_ORIGIN || allowed === '*', `ACAO ${String(allowed)}`).toBe(false);
      expect(r.headers.get('access-control-allow-credentials')).not.toBe('true');
    }
  });

  it('CORS positive control: the configured origin is granted', async (t) => {
    if (!ctx.allowedOrigin) return t.skip();
    const r = await call(target, 'OPTIONS', '/v1/jobs', {
      headers: { origin: ctx.allowedOrigin, 'access-control-request-method': 'GET' },
    });
    expect(r.headers.get('access-control-allow-origin'), describeRes(r)).toBe(ctx.allowedOrigin);
  });
});
