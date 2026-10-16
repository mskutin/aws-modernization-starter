/**
 * Boundary validation of the event the Lambda steps (and the local simulator)
 * receive: the spec 2.0.0 execution input plus the execution ARN. The schema is
 * STRICT — any other key (a reintroduced `payload`, a title, an idempotency key)
 * is rejected, so document data can never silently ride along again. Anything
 * malformed is a permanent `JobValidationError`: retrying cannot fix it.
 *
 * Error messages name fields and constraints only, never input values.
 */
import { CONTRACT_MAJOR } from '@starter/contracts';
import type { ProcessingExecutionInput } from '@starter/workflow-processing';
import { z } from 'zod';
import { JobValidationError } from './errors.js';

/** A task event: the execution input plus the ARN of the execution delivering it. */
export interface ParsedExecutionInput extends ProcessingExecutionInput {
  /** `$$.Execution.Id` (Step Functions) or the simulator's synthetic ARN; absent in direct calls. */
  executionArn?: string | undefined;
}

const TaskEventSchema = z.strictObject({
  jobId: z.uuid(),
  contractVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .refine((v) => Number(v.split('.')[0]) === CONTRACT_MAJOR, {
      message: `unsupported contract major version (expected ${CONTRACT_MAJOR}.x.x)`,
    }),
  submittedAt: z.iso.datetime(),
  executionArn: z.string().min(1).max(2048).optional(),
});

export function parseExecutionInput(raw: unknown): ParsedExecutionInput {
  const result = TaskEventSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new JobValidationError(`Invalid execution input: ${details}`);
  }
  return result.data;
}

/** Extracts a job id for log correlation without trusting the rest of the event. */
export function peekJobId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = (raw as { jobId?: unknown }).jobId;
  return typeof value === 'string' ? value : undefined;
}
