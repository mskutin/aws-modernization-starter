/**
 * Request / correlation id helpers shared by Fastify and Lambda.
 *
 * - HTTP: an incoming `X-Request-Id` is reused only if it is well-formed
 *   (prevents log injection); otherwise a UUID is generated. The API echoes it.
 * - Workflow: the job id is the correlation id across API → Step Functions →
 *   Lambda, so one `jobId` query in CloudWatch Logs Insights shows the chain.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';

export const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

type HeaderValue = string | string[] | undefined;

export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

/** Returns a safe incoming request id or a fresh UUID. */
export function requestIdFrom(headers: Record<string, HeaderValue>): string {
  const raw = headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  return isSafeId(candidate) ? candidate : randomUUID();
}

/** Minimal shape of the Lambda context we rely on (keeps aws-lambda types optional). */
export interface LambdaContextLike {
  awsRequestId: string;
  functionName: string;
  functionVersion?: string;
}

export interface CorrelationFields {
  requestId: string;
  jobId?: string;
  functionName?: string;
  functionVersion?: string;
  executionArn?: string;
}

export function lambdaCorrelation(
  context: LambdaContextLike,
  ids: { jobId?: string | undefined; executionArn?: string | undefined } = {},
): CorrelationFields {
  const fields: CorrelationFields = {
    requestId: context.awsRequestId,
    functionName: context.functionName,
  };
  if (context.functionVersion) fields.functionVersion = context.functionVersion;
  if (isSafeId(ids.jobId)) fields.jobId = ids.jobId;
  if (ids.executionArn) fields.executionArn = ids.executionArn;
  return fields;
}

/** Child logger bound to correlation fields. */
export function withCorrelation(logger: Logger, fields: Partial<CorrelationFields>): Logger {
  return logger.child(fields);
}
