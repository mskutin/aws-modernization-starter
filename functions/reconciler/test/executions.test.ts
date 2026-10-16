import { type DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import { describe, expect, it, vi } from 'vitest';
import {
  StepFunctionsExecutions,
  UnknownExecutionStatusError,
  safeErrorName,
} from '../src/index.js';

const SM = 'arn:aws:states:ap-southeast-1:123456789012:stateMachine:starter-dev-job-processing';
const OWN =
  'arn:aws:states:ap-southeast-1:123456789012:execution:starter-dev-job-processing:job-j1';
const JOB = 'j1';

function adapter(answer: (command: DescribeExecutionCommand) => Promise<unknown>) {
  const send = vi.fn(answer);
  return {
    send,
    executions: new StepFunctionsExecutions({
      client: { send: send as never },
      stateMachineArn: SM,
    }),
  };
}

describe('StepFunctionsExecutions', () => {
  it('describes the recorded execution with METADATA_ONLY (no input/output, no kms:Decrypt)', async () => {
    const { send, executions } = adapter(async () => ({ status: 'RUNNING', $metadata: {} }));
    await expect(executions.describe({ jobId: JOB, executionArn: OWN })).resolves.toEqual({
      status: 'RUNNING',
      error: undefined,
    });
    expect(send.mock.calls[0]![0].input).toEqual({
      executionArn: OWN,
      includedData: 'METADATA_ONLY',
    });
  });

  it('falls back to the deterministic execution name when no ARN was recorded', async () => {
    const { send, executions } = adapter(async () => ({ status: 'SUCCEEDED', $metadata: {} }));
    await executions.describe({ jobId: JOB });
    expect(send.mock.calls[0]![0].input.executionArn).toBe(OWN);
  });

  it('ignores an ARN of another state machine (anomaly) and uses the deterministic name', async () => {
    const { send, executions } = adapter(async () => {
      throw Object.assign(new Error('nope'), { name: 'ExecutionDoesNotExist' });
    });
    const foreign = 'arn:aws:states:ap-southeast-1:123456789012:execution:other-machine:job-j1';
    await expect(executions.describe({ jobId: JOB, executionArn: foreign })).resolves.toEqual({
      status: 'NOT_FOUND',
      foreignArn: true,
    });
    expect(send.mock.calls[0]![0].input.executionArn).toBe(OWN);
  });

  it('reports a missing execution as NOT_FOUND', async () => {
    const { executions } = adapter(async () => {
      throw Object.assign(new Error('missing'), { name: 'ExecutionDoesNotExist' });
    });
    await expect(executions.describe({ jobId: JOB })).resolves.toEqual({ status: 'NOT_FOUND' });
  });

  it.each([
    ['throttling', Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })],
    ['access denied', Object.assign(new Error('denied'), { name: 'AccessDeniedException' })],
    ['a 5xx', Object.assign(new Error('boom'), { name: 'InternalServerError' })],
  ])('rethrows %s (the reconciler must not act on it)', async (_n, failure) => {
    const { executions } = adapter(async () => {
      throw failure;
    });
    await expect(executions.describe({ jobId: JOB })).rejects.toBe(failure);
  });

  it('refuses statuses it does not know', async () => {
    const { executions } = adapter(async () => ({ status: 'PAUSED', $metadata: {} }));
    await expect(executions.describe({ jobId: JOB })).rejects.toBeInstanceOf(
      UnknownExecutionStatusError,
    );
  });

  it('keeps only identifier-like execution error names', async () => {
    expect(safeErrorName('States.Timeout')).toBe('States.Timeout');
    expect(safeErrorName('RecordFailureFailed')).toBe('RecordFailureFailed');
    expect(safeErrorName('Some error: with text')).toBeUndefined();
    expect(safeErrorName(undefined)).toBeUndefined();
    const { executions } = adapter(async () => ({
      status: 'FAILED',
      error: 'free text that could quote data',
      $metadata: {},
    }));
    await expect(executions.describe({ jobId: JOB })).resolves.toEqual({
      status: 'FAILED',
      error: undefined,
    });
  });
});
