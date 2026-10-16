/**
 * The reconciler's decision table. Pure: given the job state read with a consistent read
 * and the authoritative execution state, decide what to write. One test per rule.
 *
 *   execution RUNNING / PENDING_REDRIVE           → leave alone (never touch an active job)
 *   execution FAILED / TIMED_OUT / ABORTED        → FAILED (ExecutionFailed/TimedOut/Aborted)
 *   no execution, PENDING, no recorded ARN        → FAILED WorkflowNotStarted (no restart)
 *   no execution otherwise                        → FAILED ExecutionNotFound
 *   execution SUCCEEDED, PROCESSING + result      → complete SUCCEEDED (what RecordSuccess does)
 *   execution SUCCEEDED otherwise                 → FAILED ExecutionStateMismatch (anomaly)
 *
 * Messages are fixed templates: no document data, no execution input/output or cause.
 */
import type { JobState } from '@starter/job-state';
import {
  ReconciliationError,
  WorkflowStatus,
  type ReconciliationErrorName,
} from '@starter/workflow-processing';
import type { ExecutionLookup } from './executions.js';

export type Decision =
  | { action: 'none'; reason: 'execution-running' }
  | { action: 'complete'; reason: 'execution-succeeded'; anomaly: true }
  | {
      action: 'fail';
      reason: string;
      errorName: ReconciliationErrorName;
      message: string;
      anomaly: boolean;
    };

const SUFFIX = 'closed by the stale-job reconciler.';

const fail = (
  reason: string,
  errorName: ReconciliationErrorName,
  message: string,
  anomaly = false,
): Decision => ({ action: 'fail', reason, errorName, message: `${message}; ${SUFFIX}`, anomaly });

export function decide(state: JobState, lookup: ExecutionLookup): Decision {
  switch (lookup.status) {
    case 'RUNNING':
    case 'PENDING_REDRIVE':
      return { action: 'none', reason: 'execution-running' };
    case 'FAILED':
      return fail(
        'execution-failed',
        ReconciliationError.ExecutionFailed,
        `The workflow execution ended FAILED${lookup.error ? ` (${lookup.error})` : ''} without recording the job outcome`,
      );
    case 'TIMED_OUT':
      return fail(
        'execution-timed-out',
        ReconciliationError.ExecutionTimedOut,
        'The workflow execution timed out without recording the job outcome',
      );
    case 'ABORTED':
      return fail(
        'execution-aborted',
        ReconciliationError.ExecutionAborted,
        'The workflow execution was aborted without recording the job outcome',
      );
    case 'NOT_FOUND':
      if (state.status === WorkflowStatus.Pending && state.executionArn === undefined) {
        return fail(
          'workflow-not-started',
          ReconciliationError.WorkflowNotStarted,
          'The workflow was never started for this job (it is not restarted)',
        );
      }
      return fail(
        'execution-not-found',
        ReconciliationError.ExecutionNotFound,
        'No workflow execution exists for this job (expired from the execution history or lost with a local simulation)',
        lookup.foreignArn === true,
      );
    case 'SUCCEEDED':
      if (state.status === WorkflowStatus.Processing && state.resultJson !== undefined) {
        return { action: 'complete', reason: 'execution-succeeded', anomaly: true };
      }
      return fail(
        'execution-succeeded-without-result',
        ReconciliationError.StateMismatch,
        'The workflow execution succeeded but the job has no stored result',
        true,
      );
  }
}
