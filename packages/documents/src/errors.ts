/**
 * Errors of the document source. Names are matched by Step Functions Retry/Catch rules
 * (`WorkflowError` in the spec) and by the API's `publicJobError` (which shows only
 * `JobValidationError` messages to clients). Messages are built from the job id and error
 * codes only: the raw driver message (which may name hosts, roles or SQL) is never copied.
 */
import { classifyDbError } from '@starter/db';
import { TransientDependencyError } from '@starter/domain';
import { WorkflowError } from '@starter/workflow-processing';

/**
 * - `no-document`: the store returned nothing — missing, purged or outside the processing window
 *   (the PostgreSQL function does not say which, by design);
 * - `purged`: a record came back with its purge marker set or its content/title removed;
 * - `integrity`: the content no longer hashes to the SHA-256 stored at submission.
 */
export type DocumentUnavailableReason = 'no-document' | 'purged' | 'integrity';

/** The document cannot be served: permanent for this job, never retried. */
export class DocumentUnavailableError extends Error {
  override readonly name = WorkflowError.DocumentUnavailable;
  constructor(
    readonly jobId: string,
    readonly reason: DocumentUnavailableReason,
  ) {
    super(`document for job ${jobId} is unavailable (${reason})`);
  }
}

/** Non-transient failure of the store (permissions, schema, TLS, malformed row). Not retried. */
export class DocumentSourceError extends Error {
  override readonly name = 'DocumentSourceError';
  constructor(
    message: string,
    readonly code?: string | undefined,
  ) {
    super(message);
  }
}

/** AWS SDK errors worth retrying (the mini-stack's TEST document table on DynamoDB). */
const TRANSIENT_AWS_NAMES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'RequestTimeout',
  'TimeoutError',
  'ServiceUnavailable',
  'InternalFailure',
  'InternalServerError',
]);

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  $retryable?: unknown;
  $metadata?: { httpStatusCode?: unknown };
}

function codeOf(error: ErrorLike): string | undefined {
  return typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/i.test(error.code)
    ? error.code
    : undefined;
}

/** A safe label for logs and messages: the error code or class name, never the message. */
export function errorLabel(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const e = error as ErrorLike;
  const code = codeOf(e);
  if (code) return code;
  return typeof e.name === 'string' && /^[A-Za-z0-9_.]{1,64}$/.test(e.name) ? e.name : 'Error';
}

/**
 * PostgreSQL, pool and IAM-token errors are classified by the shared `@starter/db` classifier
 * (class 08, 53300, 57P01-57P03, socket errors, connect/read timeouts and
 * credential-service hiccups are transient; SQL, permission, authentication and TLS errors are
 * permanent). AWS SDK errors of the TEST document table are transient on throttling/5xx.
 */
export function isTransientSourceError(error: unknown): boolean {
  if (classifyDbError(error) === 'transient') return true;
  if (typeof error !== 'object' || error === null) return false;
  const e = error as ErrorLike;
  if (typeof e.name === 'string' && TRANSIENT_AWS_NAMES.has(e.name)) return true;
  if (e.$retryable) return true;
  const status = e.$metadata?.httpStatusCode;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

/** Maps a driver/store failure to the workflow error that Step Functions retries or not. */
export function classifySourceError(error: unknown, jobId: string): Error {
  if (error instanceof DocumentUnavailableError || error instanceof DocumentSourceError) {
    return error;
  }
  if (error instanceof TransientDependencyError) return error;
  const label = errorLabel(error);
  if (isTransientSourceError(error)) {
    return new TransientDependencyError(
      `document source temporarily unavailable for job ${jobId} (${label})`,
    );
  }
  return new DocumentSourceError(`document source failed for job ${jobId} (${label})`, label);
}
