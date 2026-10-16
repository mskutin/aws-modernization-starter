/** The decision table, one test per rule. */
import { ReconciliationError } from '@starter/workflow-processing';
import { describe, expect, it } from 'vitest';
import { decide } from '../src/index.js';
import { job } from './helpers.js';

const ARN = 'arn:aws:states:ap-southeast-1:123456789012:execution:sm:job-x';

describe('decide', () => {
  it.each(['RUNNING', 'PENDING_REDRIVE'] as const)(
    'never touches a job whose execution is %s',
    (status) => {
      for (const state of ['PENDING', 'VALIDATING', 'PROCESSING'] as const) {
        expect(decide(job({ status: state }), { status })).toEqual({
          action: 'none',
          reason: 'execution-running',
        });
      }
    },
  );

  it.each([
    ['FAILED', ReconciliationError.ExecutionFailed],
    ['TIMED_OUT', ReconciliationError.ExecutionTimedOut],
    ['ABORTED', ReconciliationError.ExecutionAborted],
  ] as const)('marks the job FAILED when the execution ended %s', (status, errorName) => {
    const decision = decide(job({ status: 'PROCESSING', executionArn: ARN }), { status });
    expect(decision).toMatchObject({ action: 'fail', errorName, anomaly: false });
  });

  it('names the execution error (an identifier, never the cause) in the message', () => {
    const decision = decide(job({ status: 'VALIDATING' }), {
      status: 'FAILED',
      error: 'RecordFailureFailed',
    });
    expect(decision.action === 'fail' && decision.message).toBe(
      'The workflow execution ended FAILED (RecordFailureFailed) without recording the job outcome; closed by the stale-job reconciler.',
    );
  });

  it('closes a PENDING job that never started as WorkflowNotStarted — no restart', () => {
    const decision = decide(job({ status: 'PENDING' }), { status: 'NOT_FOUND' });
    expect(decision).toMatchObject({
      action: 'fail',
      errorName: ReconciliationError.WorkflowNotStarted,
      reason: 'workflow-not-started',
    });
    expect(['none', 'fail', 'complete']).toContain(decision.action);
  });

  it.each([
    ['a PENDING job with a recorded execution', job({ status: 'PENDING', executionArn: ARN })],
    ['a VALIDATING job', job({ status: 'VALIDATING' })],
    ['a PROCESSING job', job({ status: 'PROCESSING', executionArn: ARN })],
  ])('closes %s whose execution does not exist as ExecutionNotFound', (_name, state) => {
    expect(decide(state, { status: 'NOT_FOUND' })).toMatchObject({
      action: 'fail',
      errorName: ReconciliationError.ExecutionNotFound,
      anomaly: false,
    });
  });

  it('flags a foreign execution ARN as an anomaly', () => {
    expect(
      decide(job({ status: 'PROCESSING', executionArn: ARN }), {
        status: 'NOT_FOUND',
        foreignArn: true,
      }),
    ).toMatchObject({ errorName: ReconciliationError.ExecutionNotFound, anomaly: true });
  });

  it('completes a PROCESSING job with a stored result whose execution SUCCEEDED (anomaly)', () => {
    expect(
      decide(job({ status: 'PROCESSING', resultJson: '{}' }), { status: 'SUCCEEDED' }),
    ).toEqual({ action: 'complete', reason: 'execution-succeeded', anomaly: true });
  });

  it.each([
    ['PROCESSING without a stored result', job({ status: 'PROCESSING' })],
    ['VALIDATING', job({ status: 'VALIDATING' })],
    ['PENDING', job({ status: 'PENDING' })],
  ])('marks a SUCCEEDED execution with a %s job as ExecutionStateMismatch', (_name, state) => {
    expect(decide(state, { status: 'SUCCEEDED' })).toMatchObject({
      action: 'fail',
      errorName: ReconciliationError.StateMismatch,
      anomaly: true,
    });
  });
});
