import { InMemoryDocumentSource } from '@starter/documents';
import { InMemoryJobStateStore } from '@starter/job-state';
import { anExecutionInput } from '@starter/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandler } from '../src/index.js';
import { capturingLogger, seedJob } from './helpers.js';

const context = { awsRequestId: 'req-9', functionName: 'starter-processor' };
const EXECUTION_ARN = 'arn:aws:states:ap-southeast-1:123456789012:execution:sm:job-x';

describe('processor Lambda handler', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('stores the result and returns only metadata, logging with correlation fields', async () => {
    const store = new InMemoryJobStateStore();
    const documents = new InMemoryDocumentSource();
    const { logger, lines } = capturingLogger();
    const input = await seedJob(store, documents);
    await store.transition(input.jobId, 'VALIDATING', '2026-10-13T10:00:00.000Z');
    const output = await createHandler(() => ({ store, documents, logger }))(
      { ...input, executionArn: EXECUTION_ARN },
      context,
    );
    expect(output).toEqual({
      jobId: input.jobId,
      resultStored: true,
      algorithmVersion: '1.0.0',
      duplicate: false,
    });
    expect((await store.get(input.jobId))?.resultJson).toEqual(expect.any(String));
    expect(lines.find((l) => l.msg === 'document processed; result stored')).toMatchObject({
      requestId: 'req-9',
      jobId: input.jobId,
    });
  });

  it('logs and rethrows failures with their workflow error name', async () => {
    const store = new InMemoryJobStateStore();
    const documents = new InMemoryDocumentSource();
    const { logger, lines } = capturingLogger();
    const handler = createHandler(() => ({ store, documents, logger }));
    await expect(handler(anExecutionInput(), context)).rejects.toMatchObject({
      name: 'JobStateConflictError',
    });
    expect(lines.find((l) => l.msg === 'ProcessJob failed')).toMatchObject({ level: 'error' });
  });

  it('fails fast with ConfigError when AWS_REGION is invalid', async () => {
    vi.stubEnv('JOBS_TABLE_NAME', 'starter-jobs');
    vi.stubEnv('AWS_REGION', 'mars');
    const { handler } = await import('../src/handler.js');
    await expect(handler(anExecutionInput(), context)).rejects.toMatchObject({
      name: 'ConfigError',
    });
  });
});
