/**
 * Step Functions Retry/Catch semantics, used by the API's LOCAL workflow
 * simulator so local runs follow the same policy numbers as the real state
 * machine. This mirrors documented behaviour; it does not prove it.
 */
import type { RetryPolicy } from '@starter/workflow-processing';

export const STATES_ALL = 'States.ALL';
export const STATES_TASK_FAILED = 'States.TaskFailed';
export const STATES_TIMEOUT = 'States.Timeout';

/** `ErrorEquals` matching: States.ALL matches anything; States.TaskFailed anything but a timeout. */
export function errorMatches(patterns: readonly string[], errorName: string): boolean {
  return patterns.some(
    (pattern) =>
      pattern === STATES_ALL ||
      pattern === errorName ||
      (pattern === STATES_TASK_FAILED && errorName !== STATES_TIMEOUT),
  );
}

export function findRetryPolicy(
  policies: readonly RetryPolicy[],
  errorName: string,
): RetryPolicy | undefined {
  return policies.find((policy) => errorMatches(policy.errors, errorName));
}

/**
 * Delay before retry number `retry` (1-based):
 * `min(interval × backoffRate^(retry-1), maxDelay)`; FULL jitter picks
 * uniformly in [0, delay).
 */
export function retryDelayMs(
  policy: RetryPolicy,
  retry: number,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(retry) || retry < 1) throw new RangeError('retry must be an integer >= 1');
  const base = Math.min(
    policy.intervalSeconds * policy.backoffRate ** (retry - 1),
    policy.maxDelaySeconds,
  );
  const seconds = policy.jitter === 'FULL' ? base * random() : base;
  return Math.round(seconds * 1000);
}

/** `MaxAttempts` counts retries after the first attempt (0 = never retry). */
export function canRetry(policy: RetryPolicy, retriesSoFar: number): boolean {
  return retriesSoFar < policy.maxAttempts;
}
