import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/errors';
import { describeApiError } from '../src/components/ApiErrorMessage';

describe('describeApiError (identity)', () => {
  const problem = (status: number, retryAfterSeconds: number | null = null) =>
    new ApiError('x', 'problem', status, { type: 't', title: 'T', status }, { retryAfterSeconds });

  it('asks to sign in again on 401', () => {
    expect(describeApiError(problem(401))).toMatch(/sign in again/);
  });

  it('explains a missing permission on 403', () => {
    expect(describeApiError(problem(403))).toMatch(/not permitted/);
  });

  it('says how long to wait on 429', () => {
    expect(describeApiError(problem(429, 1))).toBe(
      'Too many requests. Please wait 1 second and try again.',
    );
    expect(describeApiError(problem(429, 30))).toContain('30 seconds');
    expect(describeApiError(problem(429))).toContain('a moment');
  });
});
