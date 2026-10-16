/**
 * Assertions and fixtures shared by the security suites. Every assertion that inspects a body
 * for leaked material reports only redacted findings, never the leaked value itself, so JUnit
 * reports and CI logs stay publishable (and the artifact scanner stays green on them).
 */
import { randomUUID } from 'node:crypto';
import {
  IDEMPOTENCY_KEY_HEADER,
  JobListSchema,
  JobSchema,
  ProblemSchema,
  ProblemType,
  type Job,
  type JobList,
  type Problem,
} from '@starter/contracts';
import { expect, type TestContext } from 'vitest';
import type { SecTestContext } from './context.js';
import { call, describeRes, pollUntil, type Res } from './http.js';
import { findLeaks } from './leaks.js';

export { ProblemType };

/** A valid document (≥ 10 words) unique per call, so identical bodies are deliberate. */
export const documentBody = (title: string, extra = ''): { title: string; content: string } => ({
  title,
  content: [
    'Teams assess workloads and plan the migration waves carefully before moving anything.',
    `Operations staff review dashboards before every weekly release ${extra}.`,
  ].join('\n\n'),
});

export const newKey = (prefix = 'sec') => `${prefix}-${randomUUID()}`;

/** RFC 9457 problem with the contract's media type, a request id and the given type. */
export function expectProblem(r: Res, status: number, type?: string): Problem {
  expect(r.status, describeRes(r)).toBe(status);
  expect(r.headers.get('content-type') ?? '', describeRes(r)).toMatch(
    /^application\/problem\+json/,
  );
  const problem = ProblemSchema.parse(r.json);
  expect(problem.status).toBe(status);
  if (type) expect(problem.type).toBe(type);
  expect(r.headers.get('x-request-id'), 'problem responses carry X-Request-Id').toBeTruthy();
  return problem;
}

/** 401: problem+json and an RFC 6750 challenge. */
export function expectUnauthorized(r: Res, tokenPresented: boolean): Problem {
  const problem = expectProblem(r, 401, ProblemType.Unauthorized);
  const challenge = r.headers.get('www-authenticate') ?? '';
  expect(challenge, 'WWW-Authenticate challenge').toMatch(/^Bearer realm="starter-api"/);
  if (tokenPresented) expect(challenge).toContain('error="invalid_token"');
  return problem;
}

export async function submit(
  target: { baseUrl: string },
  token: string,
  body: unknown,
  key: string | null = newKey(),
): Promise<Res> {
  return call(target.baseUrl, 'POST', '/v1/jobs', {
    token,
    json: body,
    ...(key === null ? {} : { headers: { [IDEMPOTENCY_KEY_HEADER]: key } }),
  });
}

export function expectAccepted(r: Res): Job {
  expect([200, 202], describeRes(r)).toContain(r.status);
  return JobSchema.parse(r.json);
}

export async function getJob(
  target: { baseUrl: string },
  token: string,
  jobId: string,
): Promise<Res> {
  return call(target.baseUrl, 'GET', `/v1/jobs/${jobId}`, { token });
}

export async function listJobs(
  target: { baseUrl: string },
  token: string,
  query = '',
): Promise<{ res: Res; list: JobList | undefined }> {
  const res = await call(target.baseUrl, 'GET', `/v1/jobs${query}`, { token });
  return { res, list: res.status === 200 ? JobListSchema.parse(res.json) : undefined };
}

/** Polls the job (as its owner) until SUCCEEDED or FAILED. */
export async function waitTerminal(
  target: { baseUrl: string },
  token: string,
  jobId: string,
): Promise<Job> {
  return pollUntil(`job ${jobId} to finish`, async () => {
    const r = await getJob(target, token, jobId);
    if (r.status !== 200) return undefined;
    const job = JobSchema.parse(r.json);
    return job.status === 'SUCCEEDED' || job.status === 'FAILED' ? job : undefined;
  });
}

/** Material that must never be in a response body: stack traces, SQL, ARNs, hosts, tokens. */
export const RESPONSE_LEAK_PATTERNS: readonly { id: string; regex: RegExp }[] = [
  {
    id: 'stack-trace',
    regex: /\n\s+at\s+[\w.<>]+\s*\(|\bat\s+(?:async\s+)?[\w.]+\s+\(\/|node:internal/,
  },
  { id: 'source-path', regex: /\/(?:src|dist|node_modules)\/[\w./-]+\.(?:ts|js|mjs)(?::\d+)?/ },
  {
    id: 'sql',
    regex:
      /\b(?:SELECT\s+[\w*,\s]+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|syntax error at or near|relation "\w+")/i,
  },
  { id: 'arn', regex: /\barn:aws[\w-]*:/ },
  { id: 'aws-host', regex: /\.amazonaws\.com\b/ },
  {
    id: 'internal-host',
    regex: /\b(?:postgres|dynamodb(?:-local)?|localhost|127\.0\.0\.1)(?::\d+)?\b/i,
  },
  {
    id: 'exception-name',
    regex: /\b(?:TypeError|ReferenceError|SyntaxError|DatabaseError|ECONNREFUSED)\b/,
  },
];

/** Asserts a response body leaks none of the above, nor known secrets / tokens. */
export function expectCleanBody(r: Res, ctx: SecTestContext, label: string): void {
  const hits = RESPONSE_LEAK_PATTERNS.filter((p) => p.regex.test(r.text)).map((p) => p.id);
  const leaks = findLeaks(r.text, {
    secrets: ctx.knownSecrets.map((value, i) => ({ label: `secret-${i}`, value })),
  });
  expect({ label, patterns: hits, leaks }).toEqual({ label, patterns: [], leaks: [] });
}

/** Security headers on every API response (problem or success). */
export function expectSecurityHeaders(r: Res): void {
  expect(r.headers.get('x-content-type-options'), 'X-Content-Type-Options').toBe('nosniff');
  expect(r.headers.get('cache-control') ?? '', 'Cache-Control').toMatch(/no-store/);
}

/**
 * Skips the test with `reason` (visible in the report) when `ok` is false — or, with
 * SECTEST_REQUIRE_ALL=1, fails it instead, so CI cannot go green by skipping.
 */
export function precondition(
  t: TestContext,
  ctx: SecTestContext,
  ok: boolean,
  reason: string,
): asserts ok {
  if (ok) return;
  if (ctx.requireAll) throw new Error(`SECTEST_REQUIRE_ALL=1 but this check cannot run: ${reason}`);
  t.skip(reason);
}
