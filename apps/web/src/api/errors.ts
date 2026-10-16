import type { Problem, ProblemFieldError } from '@starter/contracts';

/**
 * - `problem`: the API answered with RFC 9457 problem details.
 * - `http`: a non-2xx response without a usable problem body (e.g. a proxy error page).
 * - `invalid-response`: a 2xx response that does not match the contract.
 * - `network`: the request never produced a response (offline, DNS, CORS, ...).
 */
export type ApiErrorKind = 'problem' | 'http' | 'invalid-response' | 'network';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  /** From `Retry-After` (429/503), when the server sent one. */
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    readonly kind: ApiErrorKind,
    readonly status: number | null,
    readonly problem: Problem | null = null,
    options?: { cause?: unknown; retryAfterSeconds?: number | null },
  ) {
    super(message, options);
    this.retryAfterSeconds = options?.retryAfterSeconds ?? null;
  }

  get fieldErrors(): readonly ProblemFieldError[] {
    return this.problem?.errors ?? [];
  }

  /** Retrying may help (network trouble, throttling, server or gateway errors). */
  get isTransient(): boolean {
    if (this.kind === 'network') return true;
    if (this.status === null) return false;
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/** Aborted fetches (navigation/unmount) are expected and must be ignored, not shown. */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: unknown }).name === 'AbortError'
  );
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError('Unexpected error while talking to the API', 'network', null, null, {
    cause: error,
  });
}
