/**
 * RFC 9457 problem details. Every error response is `application/problem+json`;
 * internal details are logged, never returned.
 */
import {
  AUTH_REALM,
  ProblemType,
  RATE_LIMIT_HEADERS,
  type Problem,
  type ProblemFieldError,
} from '@starter/contracts';
import { isTransientAwsError } from '@starter/job-state';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export class ProblemError extends Error {
  override readonly name = 'ProblemError';
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    readonly detail?: string,
    readonly errors?: ProblemFieldError[],
    readonly headers: Record<string, string> = {},
  ) {
    super(detail ?? title);
  }

  toProblem(instance: string, requestId: string): Problem {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      ...(this.detail ? { detail: this.detail } : {}),
      instance,
      requestId,
      ...(this.errors?.length ? { errors: this.errors } : {}),
    };
  }
}

export const validationProblem = (
  errors: ProblemFieldError[],
  detail = 'The request is invalid.',
) => new ProblemError(400, ProblemType.Validation, 'Bad Request', detail, errors);

export const notFoundProblem = (detail: string) =>
  new ProblemError(404, ProblemType.NotFound, 'Not Found', detail);

export const idempotencyMismatchProblem = () =>
  new ProblemError(
    422,
    ProblemType.IdempotencyMismatch,
    'Unprocessable Content',
    'This Idempotency-Key was already used with a different request body.',
  );

/** RateLimit-* response headers for a limiter decision. */
export function rateLimitHeaders(decision: {
  limit: number;
  remaining: number;
  resetSeconds: number;
}): Record<string, string> {
  return {
    [RATE_LIMIT_HEADERS.limit]: String(decision.limit),
    [RATE_LIMIT_HEADERS.remaining]: String(decision.remaining),
    [RATE_LIMIT_HEADERS.reset]: String(decision.resetSeconds),
  };
}

/**
 * 401. One body for every failure (missing token, bad signature, expired, wrong iss/aud, ...):
 * the reason is logged, never returned. RFC 6750 §3: `error="invalid_token"` only when a token
 * was presented.
 */
export const unauthorizedProblem = (
  tokenPresented: boolean,
  headers: Record<string, string> = {},
) =>
  new ProblemError(
    401,
    ProblemType.Unauthorized,
    'Unauthorized',
    'A valid bearer access token is required.',
    undefined,
    {
      'www-authenticate': tokenPresented
        ? `Bearer realm="${AUTH_REALM}", error="invalid_token"`
        : `Bearer realm="${AUTH_REALM}"`,
      ...headers,
    },
  );

/** 403: authenticated, but the token lacks the operation's scope (a scope token: no quotes). */
export const forbiddenProblem = (scope: string) =>
  new ProblemError(
    403,
    ProblemType.Forbidden,
    'Forbidden',
    'The access token does not grant the scope this operation requires.',
    undefined,
    {
      'www-authenticate': `Bearer realm="${AUTH_REALM}", error="insufficient_scope", scope="${scope}"`,
    },
  );

export const tooManyRequestsProblem = (decision: {
  limit: number;
  remaining: number;
  resetSeconds: number;
}) =>
  new ProblemError(
    429,
    ProblemType.TooManyRequests,
    'Too Many Requests',
    `Rate limit exceeded. Retry after ${decision.resetSeconds} seconds.`,
    undefined,
    { 'retry-after': String(decision.resetSeconds), ...rateLimitHeaders(decision) },
  );

export const serviceUnavailableProblem = (detail: string) =>
  new ProblemError(503, ProblemType.ServiceUnavailable, 'Service Unavailable', detail, undefined, {
    'retry-after': '1',
  });

export const internalProblem = () =>
  new ProblemError(
    500,
    ProblemType.Internal,
    'Internal Server Error',
    'An unexpected error occurred.',
  );

// PostgreSQL SQLSTATE classes/codes that indicate an unavailable database.
const PG_UNAVAILABLE = /^(08|53|57P0[1-3])/;
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

/** True when the error means a dependency is (temporarily) unavailable → 503. */
export function isDependencyUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && (NETWORK_CODES.has(code) || PG_UNAVAILABLE.test(code))) {
    return true;
  }
  if (
    typeof message === 'string' &&
    /timeout exceeded when trying to connect|Connection terminated/i.test(message)
  ) {
    return true;
  }
  if (error instanceof AggregateError) return error.errors.some(isDependencyUnavailable);
  return isTransientAwsError(error);
}
