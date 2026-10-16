import { PROCESSING_WORKFLOW, WorkflowError, type RetryPolicy } from '@starter/workflow-processing';
import { describe, expect, it } from 'vitest';
import {
  STATES_TIMEOUT,
  canRetry,
  errorMatches,
  findRetryPolicy,
  retryDelayMs,
} from '../src/index.js';

const validateRetry = PROCESSING_WORKFLOW.tasks.validate.retry[0] as RetryPolicy;
const processRetry = PROCESSING_WORKFLOW.tasks.process.retry[0] as RetryPolicy;

describe('errorMatches', () => {
  it('matches exact names, States.ALL and States.TaskFailed (except timeouts)', () => {
    expect(errorMatches(['A'], 'A')).toBe(true);
    expect(errorMatches(['A'], 'B')).toBe(false);
    expect(errorMatches(['States.ALL'], STATES_TIMEOUT)).toBe(true);
    expect(errorMatches(['States.TaskFailed'], 'Anything')).toBe(true);
    expect(errorMatches(['States.TaskFailed'], STATES_TIMEOUT)).toBe(false);
  });
});

describe('spec retry policies', () => {
  it('retry transient errors but never validation errors', () => {
    expect(findRetryPolicy([validateRetry], WorkflowError.Transient)).toBe(validateRetry);
    expect(findRetryPolicy([validateRetry], WorkflowError.Validation)).toBeUndefined();
    expect(findRetryPolicy([processRetry], STATES_TIMEOUT)).toBe(processRetry);
    expect(findRetryPolicy([validateRetry], STATES_TIMEOUT)).toBeUndefined();
  });

  it('computes exponential back-off capped at MaxDelaySeconds (no jitter)', () => {
    const policy: RetryPolicy = { ...processRetry, jitter: 'NONE' };
    expect([1, 2, 3, 4, 5].map((n) => retryDelayMs(policy, n))).toEqual([
      2000, 4000, 8000, 16000, 20000,
    ]);
  });

  it('applies FULL jitter as a uniform fraction of the capped delay', () => {
    expect(retryDelayMs(validateRetry, 3, () => 0.5)).toBe(2000);
    expect(retryDelayMs(validateRetry, 10, () => 0.999)).toBeLessThanOrEqual(8000);
    expect(retryDelayMs(validateRetry, 1, () => 0)).toBe(0);
  });

  it('rejects invalid retry numbers', () => {
    expect(() => retryDelayMs(validateRetry, 0)).toThrow(RangeError);
    expect(() => retryDelayMs(validateRetry, 1.5)).toThrow(RangeError);
  });

  it('allows MaxAttempts retries after the first attempt', () => {
    expect(canRetry(validateRetry, 0)).toBe(true);
    expect(canRetry(validateRetry, validateRetry.maxAttempts - 1)).toBe(true);
    expect(canRetry(validateRetry, validateRetry.maxAttempts)).toBe(false);
  });
});
