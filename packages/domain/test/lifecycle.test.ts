import { JOB_STATUSES } from '@starter/contracts';
import { WorkflowStatus } from '@starter/workflow-processing';
import { describe, expect, it } from 'vitest';
import {
  ALL_STATUSES,
  InvalidTransitionError,
  allowedNextStatuses,
  allowedPredecessors,
  assertTransition,
  canTransition,
  decideTransition,
  isJobStatus,
  isTerminal,
  type JobStatus,
} from '../src/index.js';

describe('job lifecycle', () => {
  it('uses exactly the statuses published in the API contract', () => {
    expect([...ALL_STATUSES].sort()).toEqual([...JOB_STATUSES].sort());
  });

  it.each<[JobStatus, JobStatus]>([
    ['PENDING', 'VALIDATING'],
    ['VALIDATING', 'PROCESSING'],
    ['PROCESSING', 'SUCCEEDED'],
    ['PENDING', 'FAILED'],
    ['VALIDATING', 'FAILED'],
    ['PROCESSING', 'FAILED'],
  ])('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(decideTransition(from, to)).toBe('apply');
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each<[JobStatus, JobStatus]>([
    ['PENDING', 'PROCESSING'],
    ['PENDING', 'SUCCEEDED'],
    ['VALIDATING', 'SUCCEEDED'],
    ['PROCESSING', 'VALIDATING'],
    ['VALIDATING', 'PENDING'],
    ['SUCCEEDED', 'FAILED'],
    ['FAILED', 'SUCCEEDED'],
    ['SUCCEEDED', 'PENDING'],
    ['FAILED', 'VALIDATING'],
  ])('rejects %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(decideTransition(from, to)).toBe('reject');
    expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it('treats re-entering the same status as an idempotent no-op', () => {
    for (const status of ALL_STATUSES) expect(decideTransition(status, status)).toBe('noop');
  });

  it('has no exits from terminal statuses', () => {
    expect(isTerminal(WorkflowStatus.Succeeded)).toBe(true);
    expect(isTerminal(WorkflowStatus.Failed)).toBe(true);
    expect(isTerminal(WorkflowStatus.Pending)).toBe(false);
    expect(allowedNextStatuses('SUCCEEDED')).toEqual([]);
    expect(allowedNextStatuses('FAILED')).toEqual([]);
  });

  it('computes predecessors for conditional writes', () => {
    expect(allowedPredecessors('FAILED').sort()).toEqual(['PENDING', 'PROCESSING', 'VALIDATING']);
    expect(allowedPredecessors('SUCCEEDED')).toEqual(['PROCESSING']);
    expect(allowedPredecessors('PENDING')).toEqual([]);
  });

  it('guards unknown status values', () => {
    expect(isJobStatus('PENDING')).toBe(true);
    expect(isJobStatus('RUNNING')).toBe(false);
    expect(isJobStatus(undefined)).toBe(false);
  });

  it('describes illegal transitions in the error message', () => {
    expect(new InvalidTransitionError(null, 'VALIDATING').message).toContain(
      '(missing) → VALIDATING',
    );
  });
});
