/**
 * DynamoDB item shapes (validated at the boundary) and key helpers. Attribute
 * names come from `JobStateTable` in the shared spec so the Step Functions
 * RecordSuccess/RecordFailure states write identical items.
 */
import { ProcessingState, WorkflowStatus } from '@starter/workflow-processing';
import { z } from 'zod';
import type { IdempotencyRecord, JobState, StaleJobCandidate, StepAuditEntry } from './types.js';

const statuses = Object.values(WorkflowStatus) as [WorkflowStatus, ...WorkflowStatus[]];
const states = Object.values(ProcessingState) as [
  (typeof ProcessingState)[keyof typeof ProcessingState],
  ...(typeof ProcessingState)[keyof typeof ProcessingState][],
];

export const JobStateItemSchema = z.object({
  pk: z.string().startsWith('JOB#'),
  sk: z.literal('STATE'),
  jobId: z.string().min(1),
  status: z.enum(statuses),
  version: z.number().int().nonnegative(),
  createdAt: z.string().optional(),
  updatedAt: z.string(),
  resultJson: z.string().optional(),
  errorName: z.string().optional(),
  errorMessage: z.string().optional(),
  executionArn: z.string().optional(),
});

export const IdempotencyItemSchema = z.object({
  pk: z.string().startsWith('IDEMPOTENCY#'),
  sk: z.literal('IDEMPOTENCY'),
  key: z.string().min(1),
  fingerprint: z.string().min(1),
  jobId: z.string().min(1),
  createdAt: z.string(),
  expiresAt: z.number().int(),
  resultJson: z.string().optional(),
});

export const StepItemSchema = z.object({
  pk: z.string().startsWith('JOB#'),
  sk: z.string().startsWith('STEP#'),
  jobId: z.string(),
  state: z.enum(states),
  at: z.string(),
  outcome: z.enum(['succeeded', 'failed', 'duplicate']),
  detail: z.string().optional(),
});

/** Item failed boundary validation — indicates a writer bug or manual tampering. */
export class CorruptItemError extends Error {
  override readonly name = 'CorruptItemError';
}

function parse<T>(schema: z.ZodType<T>, item: unknown, what: string): T {
  const result = schema.safeParse(item);
  if (!result.success) {
    throw new CorruptItemError(
      `Invalid ${what} item: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return result.data;
}

export function toJobState(item: unknown): JobState {
  const parsed = parse(JobStateItemSchema, item, 'job state');
  return {
    jobId: parsed.jobId,
    status: parsed.status,
    version: parsed.version,
    // Items written by the state machine might lack createdAt; fall back to updatedAt.
    createdAt: parsed.createdAt ?? parsed.updatedAt,
    updatedAt: parsed.updatedAt,
    resultJson: parsed.resultJson,
    errorName: parsed.errorName,
    errorMessage: parsed.errorMessage,
    executionArn: parsed.executionArn,
  };
}

export const StaleCandidateSchema = z.object({
  jobId: z.string().min(1),
  status: z.enum(statuses),
  updatedAt: z.string(),
});

export function toStaleCandidate(item: unknown): StaleJobCandidate {
  const parsed = parse(StaleCandidateSchema, item, 'status index');
  return { jobId: parsed.jobId, status: parsed.status, updatedAt: parsed.updatedAt };
}

/**
 * `expiresAt` (epoch seconds) of a STEP# audit item, or undefined when no audit retention is
 * configured (`JOB_AUDIT_TTL_DAYS` unset — the default: audit items are kept).
 */
export function auditExpiresAt(at: string, ttlDays: number | undefined): number | undefined {
  if (ttlDays === undefined) return undefined;
  const t = Date.parse(at);
  return Math.floor((Number.isNaN(t) ? Date.now() : t) / 1000) + ttlDays * 86_400;
}

export function validateAuditTtlDays(ttlDays: number | undefined): number | undefined {
  if (ttlDays === undefined) return undefined;
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 3650) {
    throw new RangeError('auditTtlDays must be an integer between 1 and 3650');
  }
  return ttlDays;
}

export function toIdempotencyRecord(item: unknown): IdempotencyRecord {
  const parsed = parse(IdempotencyItemSchema, item, 'idempotency');
  return {
    key: parsed.key,
    fingerprint: parsed.fingerprint,
    jobId: parsed.jobId,
    createdAt: parsed.createdAt,
    expiresAt: parsed.expiresAt,
    resultJson: parsed.resultJson,
  };
}

export function toStepEntry(item: unknown): StepAuditEntry {
  const parsed = parse(StepItemSchema, item, 'step audit');
  return {
    jobId: parsed.jobId,
    state: parsed.state,
    at: parsed.at,
    outcome: parsed.outcome,
    detail: parsed.detail,
  };
}

export const epochSeconds = (now: Date) => Math.floor(now.getTime() / 1000);
