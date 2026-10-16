import { InMemoryDocumentSource } from '@starter/documents';
import { InMemoryJobStateStore } from '@starter/job-state';
import { TOO_SHORT_DOCUMENT, anExecutionInput } from '@starter/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandler } from '../src/index.js';
import { capturingLogger, seedJob } from './helpers.js';

const context = {
  awsRequestId: 'req-123',
  functionName: 'starter-validator',
  functionVersion: '7',
};
const EXECUTION_ARN = 'arn:aws:states:ap-southeast-1:123456789012:execution:sm:job-x';

describe('validator Lambda handler', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('accepts the ASL task event (input + executionArn) and binds Lambda correlation fields', async () => {
    const store = new InMemoryJobStateStore();
    const documents = new InMemoryDocumentSource();
    const { logger, lines } = capturingLogger();
    const input = await seedJob(store, documents);
    const handler = createHandler(() => ({ store, documents, logger }));
    await expect(
      handler({ ...input, executionArn: EXECUTION_ARN }, context),
    ).resolves.toMatchObject({ valid: true });
    expect(lines.find((l) => l.msg === 'document validated')).toMatchObject({
      requestId: 'req-123',
      functionName: 'starter-validator',
      jobId: input.jobId,
    });
  });

  it('rethrows business rejections with the spec error name and logs them at info', async () => {
    const store = new InMemoryJobStateStore();
    const documents = new InMemoryDocumentSource();
    const { logger, lines } = capturingLogger();
    const input = await seedJob(store, documents, { content: TOO_SHORT_DOCUMENT });
    const handler = createHandler(() => ({ store, documents, logger }));
    await expect(handler(input, context)).rejects.toMatchObject({ name: 'JobValidationError' });
    expect(lines.find((l) => l.msg === 'ValidateJob failed')).toMatchObject({
      level: 'info',
      errorName: 'JobValidationError',
    });
  });

  it('logs a missing document at error level with the non-sensitive reason', async () => {
    const store = new InMemoryJobStateStore();
    const documents = new InMemoryDocumentSource();
    const { logger, lines } = capturingLogger();
    const input = anExecutionInput();
    await store.createInitial(input.jobId, '2026-10-13T10:00:00.000Z');
    const handler = createHandler(() => ({ store, documents, logger }));
    await expect(handler(input, context)).rejects.toMatchObject({
      name: 'DocumentUnavailableError',
    });
    expect(lines.find((l) => l.msg === 'ValidateJob failed')).toMatchObject({
      level: 'error',
      errorName: 'DocumentUnavailableError',
      errorMessage: `document for job ${input.jobId} is unavailable (no-document)`,
    });
  });

  it('fails fast with ConfigError when the environment is incomplete', async () => {
    vi.stubEnv('JOBS_TABLE_NAME', '');
    vi.stubEnv('AWS_REGION', 'ap-southeast-1');
    const { handler } = await import('../src/handler.js');
    await expect(handler(anExecutionInput(), context)).rejects.toMatchObject({
      name: 'ConfigError',
      message: expect.stringContaining('JOBS_TABLE_NAME: is required'),
    });
  });

  it('rejects an invalid audit retention (JOB_AUDIT_TTL_DAYS) at start-up', async () => {
    vi.stubEnv('JOBS_TABLE_NAME', 'starter-jobs');
    vi.stubEnv('AWS_REGION', 'ap-southeast-1');
    vi.stubEnv('JOB_AUDIT_TTL_DAYS', '0');
    const { handler } = await import('../src/handler.js');
    await expect(handler(anExecutionInput(), context)).rejects.toMatchObject({
      name: 'ConfigError',
      message: expect.stringContaining('JOB_AUDIT_TTL_DAYS'),
    });
  });
});
