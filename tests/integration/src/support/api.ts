/**
 * Thin black-box HTTP client for the Jobs API. Validates every typed response against the
 * @starter/contracts zod schemas so contract drift fails loudly. Requests carry a bearer token of
 * this run's default principal unless `as` names another principal or `null` (anonymous).
 */
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { expect } from 'vitest';
import {
  JobSchema,
  ProblemSchema,
  TERMINAL_JOB_STATUSES,
  type CreateJobRequestInput,
  type Job,
  type Problem,
} from '@starter/contracts';
import { DEFAULT_PRINCIPAL, tokenFor } from './auth.js';
import { config } from './env.js';
import { pollUntil } from './poll.js';

export interface ApiResponse {
  status: number;
  headers: Headers;
  text: string;
  body: unknown;
}

export interface RequestOptions {
  json?: unknown;
  /** raw body (sent as-is); combine with an explicit content-type header */
  raw?: string | Uint8Array;
  headers?: Record<string, string>;
  baseUrl?: string;
  /** Principal (`sub`) whose token is sent; `null` = anonymous. Default: this run's principal. */
  as?: string | null;
}

/** `Authorization` for `as` unless the caller set one (or asked for an anonymous request). */
async function withAuth(
  path: string,
  headers: Record<string, string>,
  as: string | null | undefined,
): Promise<Record<string, string>> {
  if (!path.startsWith('/v1') || as === null || headers.authorization !== undefined) return headers;
  return { ...headers, authorization: `Bearer ${await tokenFor(as ?? DEFAULT_PRINCIPAL)}` };
}

export async function request(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  path: string,
  opts: RequestOptions = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = await withAuth(
    path,
    { accept: 'application/json', ...opts.headers },
    opts.as,
  );
  let body: string | Uint8Array | undefined;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['content-type'] ??= 'application/json';
  } else if (opts.raw !== undefined) {
    body = opts.raw;
  }
  const res = await fetch(new URL(path, opts.baseUrl ?? config.apiBaseUrl), {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: parseJson(text) };
}

const parseJson = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * POST that DECLARES `declaredBytes` via Content-Length but only sends a few bytes, then waits for
 * the server's early answer. Deterministic test of "reject oversize bodies before reading them":
 * uploading the whole body races the server's early 413 + connection close (EPIPE/ECONNRESET on
 * the client in ~7% of attempts, measured), so it is not used.
 */
export async function postDeclaringLength(
  path: string,
  declaredBytes: number,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  const authenticated = await withAuth(path, headers, undefined);
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(path, config.apiBaseUrl), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': String(declaredBytes),
        ...authenticated,
      },
    });
    const timer = setTimeout(
      () =>
        req.destroy(new Error(`no early response within 10s for declared ${declaredBytes} bytes`)),
      10_000,
    );
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => {
        clearTimeout(timer);
        req.destroy();
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          for (const item of Array.isArray(v) ? v : [v]) h.append(k, item);
        }
        resolve({ status: res.statusCode ?? 0, headers: h, text, body: parseJson(text) });
      });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.write('{"title":"huge","content":"');
  });
}

export const describeResponse = (r: ApiResponse) =>
  `HTTP ${r.status} [${r.headers.get('content-type')}] x-request-id=${r.headers.get('x-request-id')} ${r.text.slice(0, 500)}`;

/** Unique, valid-pattern Idempotency-Key. */
export const newKey = (prefix = 'it') => `${prefix}-${randomUUID()}`;

export async function submitJob(
  payload: CreateJobRequestInput | Record<string, unknown>,
  opts: {
    idempotencyKey?: string | null;
    headers?: Record<string, string>;
    as?: string | null;
    baseUrl?: string;
  } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.idempotencyKey !== null) headers['idempotency-key'] = opts.idempotencyKey ?? newKey();
  return request('POST', '/v1/jobs', {
    json: payload,
    headers,
    ...(opts.as !== undefined ? { as: opts.as } : {}),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
  });
}

/** Asserts a 202 (or replay 200) job response and returns the contract-validated Job. */
export function expectJobResponse(r: ApiResponse, status: 200 | 202 = 202): Job {
  expect(r.status, describeResponse(r)).toBe(status);
  expect(r.headers.get('content-type')).toMatch(/^application\/json/);
  const job = JobSchema.parse(r.body);
  expect(r.headers.get('location')).toMatch(new RegExp(`/v1/jobs/${job.jobId}$`));
  return job;
}

export async function getJob(jobId: string): Promise<Job> {
  const r = await request('GET', `/v1/jobs/${jobId}`);
  expect(r.status, describeResponse(r)).toBe(200);
  return JobSchema.parse(r.body);
}

/** Polls GET /v1/jobs/{id} until terminal; returns the final job and the statuses observed. */
export async function waitForTerminal(
  jobId: string,
  deadlineMs = config.jobDeadlineMs,
): Promise<{ job: Job; observed: string[] }> {
  const observed: string[] = [];
  const job = await pollUntil(
    `job ${jobId} to reach ${TERMINAL_JOB_STATUSES.join('/')}`,
    async () => {
      const j = await getJob(jobId);
      if (observed.at(-1) !== j.status) observed.push(j.status);
      return (TERMINAL_JOB_STATUSES as readonly string[]).includes(j.status) ? j : undefined;
    },
    { deadlineMs },
  );
  return { job, observed };
}

/** Asserts an RFC 9457 problem response and returns the contract-validated body. */
export function expectProblem(r: ApiResponse, status: number, type?: string): Problem {
  expect(r.status, describeResponse(r)).toBe(status);
  expect(r.headers.get('content-type'), describeResponse(r)).toMatch(/^application\/problem\+json/);
  const problem = ProblemSchema.parse(r.body);
  expect(problem.status).toBe(status);
  expect(problem.title.length).toBeGreaterThan(0);
  if (type) expect(problem.type).toBe(type);
  const requestId = r.headers.get('x-request-id');
  expect(requestId, 'problem responses carry X-Request-Id').toBeTruthy();
  if (problem.requestId !== undefined) expect(problem.requestId).toBe(requestId);
  return problem;
}
