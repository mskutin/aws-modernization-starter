/**
 * Errors whose `name` is matched by Step Functions Retry/Catch rules. The
 * names come from `WorkflowError` in the shared spec — never hard-code them.
 */
import { WorkflowError, type WorkflowErrorName } from '@starter/workflow-processing';
import type { RuleViolation } from './rules.js';

/** Permanently invalid input — never retried; routes the workflow to FAILED. */
export class JobValidationError extends Error {
  override readonly name = WorkflowError.Validation;
  constructor(
    message: string,
    readonly violations: readonly RuleViolation[] = [],
  ) {
    super(message);
  }
}

/** Transient dependency failure (throttling, timeouts) — retried per spec. */
export class TransientDependencyError extends Error {
  override readonly name = WorkflowError.Transient;
}

/** Duplicate delivery detected via an idempotency record — treated as success. */
export class DuplicateExecutionError extends Error {
  override readonly name = WorkflowError.Duplicate;
}

const NAMES: readonly string[] = Object.values(WorkflowError);

export function isWorkflowErrorName(name: unknown): name is WorkflowErrorName {
  return typeof name === 'string' && NAMES.includes(name);
}

/** Best-effort `{ name, message }` from any thrown value (never includes stacks). */
export function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name || 'Error', message: error.message };
  return { name: 'Error', message: typeof error === 'string' ? error : 'Unknown error' };
}

/**
 * The stored job state does not allow this step (missing state, already
 * failed, idempotency fingerprint mismatch). Not retried; the workflow's
 * catch-all routes it to RecordFailure.
 */
export class JobStateConflictError extends Error {
  override readonly name = 'JobStateConflictError';
}
