import { anExecutionInput } from '@starter/testing';
import { WorkflowError } from '@starter/workflow-processing';
import { describe, expect, it } from 'vitest';
import { JobValidationError, parseExecutionInput, peekJobId } from '../src/index.js';

const CANARY = 'zzcanary-document-text';

function rejection(raw: unknown): Error {
  let caught: unknown;
  try {
    parseExecutionInput(raw);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(JobValidationError);
  expect((caught as Error).name).toBe(WorkflowError.Validation);
  expect((caught as Error).message).toMatch(/^Invalid execution input: /);
  return caught as Error;
}

describe('parseExecutionInput (spec 2.0.0 task event)', () => {
  it('accepts the minimal execution input, with or without the execution ARN', () => {
    const input = anExecutionInput();
    expect(parseExecutionInput(input)).toEqual(input);
    const arn = 'arn:aws:states:ap-southeast-1:123456789012:execution:sm:job-1';
    expect(parseExecutionInput({ ...input, executionArn: arn })).toEqual({
      ...input,
      executionArn: arn,
    });
  });

  it.each([
    ['non-object', 'nope'],
    ['missing jobId', { ...anExecutionInput(), jobId: undefined }],
    ['non-uuid jobId', { ...anExecutionInput(), jobId: 'job-1' }],
    ['unsupported contract major', { ...anExecutionInput(), contractVersion: '2.0.0' }],
    ['bad timestamp', { ...anExecutionInput(), submittedAt: 'yesterday' }],
    ['empty execution ARN', { ...anExecutionInput(), executionArn: '' }],
  ])('rejects %s with JobValidationError', (_name, raw) => {
    rejection(raw);
  });

  it.each([
    ['payload', { payload: { title: CANARY, content: CANARY, options: { topTerms: 3 } } }],
    ['idempotencyKey', { idempotencyKey: `derived:v1:${CANARY}` }],
    ['title', { title: CANARY }],
    ['content', { content: CANARY }],
    ['validation', { validation: { wordCount: 3 } }],
  ])('rejects a reintroduced %s (strict schema) without echoing its value', (key, extra) => {
    const error = rejection({ ...anExecutionInput(), ...extra });
    expect(error.message).toContain(`Unrecognized key: "${key}"`);
    expect(error.message).not.toContain(CANARY);
  });

  it('peeks the job id defensively', () => {
    expect(peekJobId({ jobId: 'x' })).toBe('x');
    expect(peekJobId({ jobId: 5 })).toBeUndefined();
    expect(peekJobId(null)).toBeUndefined();
  });
});
