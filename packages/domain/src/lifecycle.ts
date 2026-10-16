/**
 * Job lifecycle state machine. Statuses come from the shared workflow spec so
 * the API, the Lambda handlers and the Step Functions definition agree.
 *
 *   PENDING ──► VALIDATING ──► PROCESSING ──► SUCCEEDED
 *      │            │               │
 *      └────────────┴───────────────┴──────► FAILED
 */
import { TERMINAL_STATUSES, WorkflowStatus } from '@starter/workflow-processing';

export type JobStatus = WorkflowStatus;

export const ALL_STATUSES: readonly JobStatus[] = Object.values(WorkflowStatus);

const NEXT: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  [WorkflowStatus.Pending]: [WorkflowStatus.Validating, WorkflowStatus.Failed],
  [WorkflowStatus.Validating]: [WorkflowStatus.Processing, WorkflowStatus.Failed],
  [WorkflowStatus.Processing]: [WorkflowStatus.Succeeded, WorkflowStatus.Failed],
  [WorkflowStatus.Succeeded]: [],
  [WorkflowStatus.Failed]: [],
};

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (ALL_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function allowedNextStatuses(from: JobStatus): readonly JobStatus[] {
  return NEXT[from];
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return NEXT[from].includes(to);
}

/** Statuses from which `to` may be entered (used to build conditional writes). */
export function allowedPredecessors(to: JobStatus): JobStatus[] {
  return ALL_STATUSES.filter((from) => canTransition(from, to));
}

/**
 * - `apply`: a legal forward transition.
 * - `noop`: already in the target status (duplicate delivery / retry) — safe to ignore.
 * - `reject`: illegal (e.g. leaving a terminal status, skipping a stage, going back).
 */
export type TransitionDecision = 'apply' | 'noop' | 'reject';

export function decideTransition(from: JobStatus, to: JobStatus): TransitionDecision {
  if (from === to) return 'noop';
  return canTransition(from, to) ? 'apply' : 'reject';
}

export class InvalidTransitionError extends Error {
  override readonly name = 'InvalidTransitionError';
  constructor(
    readonly from: JobStatus | null,
    readonly to: JobStatus,
  ) {
    super(`Illegal job status transition ${from ?? '(missing)'} → ${to}`);
  }
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (decideTransition(from, to) === 'reject') throw new InvalidTransitionError(from, to);
}
