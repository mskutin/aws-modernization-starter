import { describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION,
  CreateJobRequestSchema,
  IdempotencyKeySchema,
  JobListSchema,
  JobSchema,
  ListJobsQuerySchema,
  ProblemSchema,
  ProblemType,
  isTerminalJobStatus,
  toProblemFieldErrors,
  v1,
} from '../src/index.js';

const validJob = {
  jobId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  title: 'Doc',
  status: 'SUCCEEDED',
  contractVersion: '1.0.0',
  options: { topTerms: 10 },
  contentLength: 12,
  contentSha256: 'a'.repeat(64),
  createdAt: '2026-10-13T10:00:00.000Z',
  updatedAt: '2026-10-13T10:00:01.000Z',
  result: null,
  error: null,
};

describe('CreateJobRequestSchema', () => {
  it('applies defaults and trims the title', () => {
    const parsed = CreateJobRequestSchema.parse({ title: '  Report  ', content: 'Some text' });
    expect(parsed).toEqual({ title: 'Report', content: 'Some text', options: { topTerms: 10 } });
  });

  it('accepts explicit options within bounds', () => {
    const parsed = CreateJobRequestSchema.parse({
      title: 't',
      content: 'c',
      options: { topTerms: 25 },
    });
    expect(parsed.options.topTerms).toBe(25);
  });

  it.each([
    ['missing title', { content: 'x' }, 'title'],
    ['blank title', { title: '   ', content: 'x' }, 'title'],
    ['title too long', { title: 'x'.repeat(201), content: 'x' }, 'title'],
    ['missing content', { title: 't' }, 'content'],
    ['whitespace-only content', { title: 't', content: ' \n\t ' }, 'content'],
    ['content too long', { title: 't', content: 'x'.repeat(40_001) }, 'content'],
    ['topTerms too small', { title: 't', content: 'x', options: { topTerms: 0 } }, 'options'],
    ['topTerms too large', { title: 't', content: 'x', options: { topTerms: 26 } }, 'options'],
    [
      'topTerms not an integer',
      { title: 't', content: 'x', options: { topTerms: 1.5 } },
      'options',
    ],
    ['unknown top-level field', { title: 't', content: 'x', extra: true }, ''],
    ['unknown option', { title: 't', content: 'x', options: { colour: 'red' } }, 'options'],
    ['wrong type', { title: 1, content: 'x' }, 'title'],
  ])('rejects %s', (_name, input, field) => {
    const result = CreateJobRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = toProblemFieldErrors(result.error, 'body').map((e) => e.path);
      expect(paths.some((p) => p.startsWith(field ? `body.${field}` : 'body'))).toBe(true);
    }
  });
});

describe('response schemas', () => {
  it('parses a job and strips unknown (additive) fields', () => {
    const parsed = JobSchema.parse({ ...validJob, futureField: 'ignored' });
    expect(parsed).toEqual(validJob);
  });

  it('rejects an unknown status', () => {
    expect(JobSchema.safeParse({ ...validJob, status: 'RUNNING' }).success).toBe(false);
  });

  it('rejects a non-ISO timestamp', () => {
    expect(JobSchema.safeParse({ ...validJob, createdAt: '13/10/2026' }).success).toBe(false);
  });

  it('parses a job list page', () => {
    const page = JobListSchema.parse({
      items: [
        {
          jobId: validJob.jobId,
          title: 't',
          status: 'PENDING',
          createdAt: validJob.createdAt,
          updatedAt: validJob.updatedAt,
        },
      ],
      nextCursor: null,
    });
    expect(page.items).toHaveLength(1);
  });

  it('parses an RFC 9457 problem with field errors', () => {
    const problem = ProblemSchema.parse({
      type: 'urn:starter:problem:validation-error',
      title: 'Bad Request',
      status: 400,
      errors: [{ path: 'body.title', message: 'Required' }],
    });
    expect(problem.errors?.[0]?.path).toBe('body.title');
  });
});

describe('ListJobsQuerySchema', () => {
  it('coerces and defaults the limit', () => {
    expect(ListJobsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(ListJobsQuerySchema.parse({ limit: '5', cursor: 'abc' })).toEqual({
      limit: 5,
      cursor: 'abc',
    });
  });

  it.each([{ limit: '0' }, { limit: '101' }, { limit: 'ten' }, { cursor: '' }, { other: '1' }])(
    'rejects %o',
    (query) => {
      expect(ListJobsQuerySchema.safeParse(query).success).toBe(false);
    },
  );
});

describe('IdempotencyKeySchema', () => {
  it.each(['0f8fad5b-d9cb-469f-a165-70867728950e', 'abcdefgh', 'A_b-1234'])('accepts %s', (k) => {
    expect(IdempotencyKeySchema.safeParse(k).success).toBe(true);
  });
  it.each(['short', 'has space1', 'derived:abcdef0123', 'x'.repeat(129), ''])('rejects %s', (k) => {
    expect(IdempotencyKeySchema.safeParse(k).success).toBe(false);
  });
});

describe('versioning', () => {
  it('exposes the v1 namespace identical to the top-level exports', () => {
    expect(v1.CONTRACT_VERSION).toBe(CONTRACT_VERSION);
    expect(v1.JobSchema).toBe(JobSchema);
  });

  it('is minor version 1.1 (authentication is additive to the v1 shapes)', () => {
    expect(CONTRACT_VERSION).toBe('1.1.0');
  });

  it('defines distinct, stable URNs for the identity problem types', () => {
    expect(ProblemType).toMatchObject({
      Unauthorized: 'urn:starter:problem:unauthorized',
      Forbidden: 'urn:starter:problem:forbidden',
      TooManyRequests: 'urn:starter:problem:too-many-requests',
    });
    const values = Object.values(ProblemType);
    expect(new Set(values).size).toBe(values.length);
  });

  it('classifies terminal statuses', () => {
    expect(isTerminalJobStatus('SUCCEEDED')).toBe(true);
    expect(isTerminalJobStatus('FAILED')).toBe(true);
    expect(isTerminalJobStatus('PROCESSING')).toBe(false);
  });
});
