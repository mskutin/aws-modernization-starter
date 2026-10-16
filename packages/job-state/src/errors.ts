import { TransientDependencyError } from '@starter/domain';

const TRANSIENT_NAMES = new Set([
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'RequestLimitExceeded',
  'InternalServerError',
  'InternalFailure',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'TransactionConflictException',
  'LimitExceededException',
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
  'AbortError',
]);
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
]);

interface AwsLikeError {
  name?: unknown;
  code?: unknown;
  $retryable?: unknown;
  $metadata?: { httpStatusCode?: number };
}

/** Throttling, 5xx, timeouts and network failures — worth retrying. */
export function isTransientAwsError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as AwsLikeError;
  if (typeof e.name === 'string' && TRANSIENT_NAMES.has(e.name)) return true;
  if (typeof e.code === 'string' && TRANSIENT_CODES.has(e.code)) return true;
  if (e.$retryable) return true;
  const status = e.$metadata?.httpStatusCode;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

export function isConditionalCheckFailed(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

/** Wraps transient dependency failures so Step Functions retries them per spec. */
export function asWorkflowError(error: unknown, operation: string): unknown {
  if (error instanceof TransientDependencyError) return error;
  if (isTransientAwsError(error)) {
    const name = error instanceof Error ? error.name : 'Error';
    return new TransientDependencyError(`${operation} failed transiently (${name})`, {
      cause: error,
    });
  }
  return error;
}
