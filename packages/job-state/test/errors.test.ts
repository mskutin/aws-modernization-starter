import { TransientDependencyError } from '@starter/domain';
import { describe, expect, it } from 'vitest';
import {
  CorruptItemError,
  asWorkflowError,
  isConditionalCheckFailed,
  isTransientAwsError,
  toJobState,
} from '../src/index.js';

const awsError = (name: string, status?: number) =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

describe('error classification', () => {
  it.each([
    awsError('ProvisionedThroughputExceededException', 400),
    awsError('ThrottlingException', 400),
    awsError('InternalServerError', 500),
    awsError('SomethingNew', 503),
    awsError('TooMany', 429),
    Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('x'), { $retryable: { throttling: true } }),
  ])('treats %s as transient', (error) => {
    expect(isTransientAwsError(error)).toBe(true);
    const wrapped = asWorkflowError(error, 'GetItem');
    expect(wrapped).toBeInstanceOf(TransientDependencyError);
    expect((wrapped as Error).name).toBe('TransientDependencyError');
    expect((wrapped as Error).cause).toBe(error);
  });

  it.each([
    awsError('ValidationException', 400),
    awsError('AccessDeniedException', 400),
    awsError('ResourceNotFoundException', 400),
    new Error('plain'),
    'string',
    null,
  ])('treats %s as permanent', (error) => {
    expect(isTransientAwsError(error)).toBe(false);
    expect(asWorkflowError(error, 'op')).toBe(error);
  });

  it('detects conditional check failures', () => {
    expect(isConditionalCheckFailed(awsError('ConditionalCheckFailedException', 400))).toBe(true);
    expect(isConditionalCheckFailed(new Error('x'))).toBe(false);
  });
});

describe('item boundary validation', () => {
  it('rejects corrupt state items', () => {
    expect(() =>
      toJobState({
        pk: 'JOB#1',
        sk: 'STATE',
        jobId: '1',
        status: 'DONE',
        version: 1,
        updatedAt: 'x',
      }),
    ).toThrow(CorruptItemError);
    expect(() => toJobState(undefined)).toThrow(CorruptItemError);
  });

  it('accepts items written by the state machine without createdAt', () => {
    expect(
      toJobState({
        pk: 'JOB#1',
        sk: 'STATE',
        jobId: '1',
        status: 'SUCCEEDED',
        version: 4,
        updatedAt: 't',
      }),
    ).toMatchObject({ createdAt: 't' });
  });
});
