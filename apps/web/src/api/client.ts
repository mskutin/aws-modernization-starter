/**
 * Typed client for the Jobs API v1. Every response is validated against the
 * `@starter/contracts` schemas at this boundary, so components only ever see data
 * that matches the contract.
 */
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  JobListSchema,
  JobSchema,
  ProblemSchema,
  type CreateJobRequest,
  type Job,
  type JobList,
} from '@starter/contracts';
import { apiBaseFromEnv } from './base-url';
import { ApiError, isAbortError } from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** Base URL ending in `/v1` (see `resolveApiBase`). Defaults to `VITE_API_BASE_URL` or `/v1`. */
  baseUrl?: string;
  /** Injected for tests; defaults to the global `fetch` (resolved at call time). */
  fetch?: FetchLike;
  /** Bearer access token of the signed-in user (kept in memory by the auth layer). */
  getAccessToken?: () => string | undefined;
  /** Called on every 401 (expired or revoked session) before the error is thrown. */
  onUnauthorized?: (error: ApiError) => void;
}

export interface CreateJobResult {
  job: Job;
  /** True when the server replayed an earlier request with the same Idempotency-Key. */
  replayed: boolean;
}

export interface ListJobsParams {
  limit?: number;
  cursor?: string | null;
}

export interface ApiClient {
  readonly baseUrl: string;
  createJob(
    request: CreateJobRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CreateJobResult>;
  getJob(jobId: string, signal?: AbortSignal): Promise<Job>;
  listJobs(params?: ListJobsParams, signal?: AbortSignal): Promise<JobList>;
}

const ACCEPT = 'application/json, application/problem+json';

/** Structural view of a zod schema (keeps `zod` an implementation detail of the contracts). */
interface ResponseSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown };
}

function isProblemResponse(response: Response): boolean {
  const type = response.headers.get('content-type') ?? '';
  return type.toLowerCase().includes('application/problem+json');
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? apiBaseFromEnv();
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  /** Throws `error`, notifying the auth layer first when the session is no longer valid. */
  function fail(error: ApiError): never {
    if (error.status === 401) options.onUnauthorized?.(error);
    throw error;
  }

  async function request<T>(
    path: string,
    schema: ResponseSchema<T>,
    init: RequestInit,
  ): Promise<{ data: T; response: Response }> {
    let response: Response;
    let body: unknown;
    const token = options.getAccessToken?.();
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: ACCEPT,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
      });
      body = await readBody(response);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ApiError(
        'Could not reach the API. Check your connection and try again.',
        'network',
        null,
        null,
        {
          cause: error,
        },
      );
    }

    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
      if (isProblemResponse(response)) {
        const problem = ProblemSchema.safeParse(body);
        if (problem.success) {
          fail(
            new ApiError(
              problem.data.detail ?? problem.data.title,
              'problem',
              response.status,
              problem.data,
              { retryAfterSeconds },
            ),
          );
        }
      }
      fail(
        new ApiError(
          `The API responded with HTTP ${response.status}.`,
          'http',
          response.status,
          null,
          {
            retryAfterSeconds,
          },
        ),
      );
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        'The API returned a response that does not match the expected contract.',
        'invalid-response',
        response.status,
        null,
        { cause: parsed.error },
      );
    }
    return { data: parsed.data, response };
  }

  return {
    baseUrl,

    async createJob(payload, idempotencyKey, signal) {
      const { data, response } = await request('/jobs', JobSchema, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
        },
        body: JSON.stringify(payload),
        signal: signal ?? null,
      });
      return { job: data, replayed: response.headers.get(IDEMPOTENT_REPLAYED_HEADER) === 'true' };
    },

    async getJob(jobId, signal) {
      const { data } = await request(`/jobs/${encodeURIComponent(jobId)}`, JobSchema, {
        method: 'GET',
        signal: signal ?? null,
      });
      return data;
    },

    async listJobs(params = {}, signal) {
      const query = new URLSearchParams();
      if (params.limit !== undefined) query.set('limit', String(params.limit));
      if (params.cursor) query.set('cursor', params.cursor);
      const search = query.toString();
      const suffix = search === '' ? '' : `?${search}`;
      const { data } = await request(`/jobs${suffix}`, JobListSchema, {
        method: 'GET',
        signal: signal ?? null,
      });
      return data;
    },
  };
}
