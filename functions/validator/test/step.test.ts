import {
  JobStateConflictError,
  JobValidationError,
  TransientDependencyError,
} from '@starter/domain';
import { DocumentUnavailableError, InMemoryDocumentSource } from '@starter/documents';
import { InMemoryJobStateStore } from '@starter/job-state';
import {
  CONTROL_CHARACTER_DOCUMENT,
  TOO_SHORT_DOCUMENT,
  anExecutionInput,
  findLeaks,
  leakCanary,
  rejectedLeakCanary,
  steppingClock,
} from '@starter/testing';
import { WorkflowError } from '@starter/workflow-processing';
import { beforeEach, describe, expect, it } from 'vitest';
import { validateStep } from '../src/index.js';
import { capturingLogger, seedJob } from './helpers.js';

const T0 = '2026-10-13T10:00:00.000Z';

describe('validateStep', () => {
  let store: InMemoryJobStateStore;
  let documents: InMemoryDocumentSource;
  const { logger, lines, raw } = capturingLogger();
  const deps = () => ({
    store,
    documents,
    logger,
    now: steppingClock('2026-10-13T10:00:01.000Z'),
  });

  beforeEach(() => {
    store = new InMemoryJobStateStore();
    documents = new InMemoryDocumentSource();
    lines.length = 0;
    raw.length = 0;
  });

  it('loads the document by job id, moves the job to VALIDATING and returns metadata only', async () => {
    const input = await seedJob(store, documents);
    const summary = await validateStep(input, deps());
    expect(summary).toEqual({
      jobId: input.jobId,
      valid: true,
      rulesVersion: '1.0.0',
      duplicate: false,
    });
    expect(documents.loads).toBe(1);
    expect(await store.get(input.jobId)).toMatchObject({ status: 'VALIDATING', version: 2 });
    expect(await store.listSteps(input.jobId)).toMatchObject([
      { state: 'ValidateJob', outcome: 'succeeded' },
    ]);
  });

  it.each([
    ['too few words', TOO_SHORT_DOCUMENT, 'min-word-count'],
    ['control characters', CONTROL_CHARACTER_DOCUMENT, 'forbidden-control-characters'],
  ])('rejects %s with JobValidationError (never retried)', async (_n, content, rule) => {
    const input = await seedJob(store, documents, { content });
    const error = await validateStep(input, deps()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobValidationError);
    expect((error as Error).name).toBe(WorkflowError.Validation);
    expect((error as JobValidationError).violations.map((v) => v.rule)).toContain(rule);
    expect(await store.listSteps(input.jobId)).toMatchObject([{ outcome: 'failed', detail: rule }]);
    // The document content never reaches the logs.
    expect(raw.join('\n')).not.toContain(content.slice(0, 12));
  });

  it('keeps every trace of a canary document out of logs, output, error and job state', async () => {
    const accepted = leakCanary();
    const ok = await seedJob(store, documents, {
      title: accepted.title,
      content: accepted.content,
    });
    const summary = await validateStep(ok, deps());

    const rejected = rejectedLeakCanary();
    const bad = await seedJob(store, documents, {
      title: rejected.title,
      content: rejected.content,
    });
    const error = await validateStep(bad, deps()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobValidationError);

    for (const canary of [accepted, rejected]) {
      expect(findLeaks(raw, canary)).toEqual([]);
      expect(findLeaks(summary, canary)).toEqual([]);
      expect(findLeaks((error as Error).message, canary)).toEqual([]);
      expect(findLeaks(store.items(), canary)).toEqual([]);
    }
    // No derived metrics either (word count / size are partial disclosure).
    expect(Object.keys(summary).sort()).toEqual(['duplicate', 'jobId', 'rulesVersion', 'valid']);
    expect(raw.join('\n')).not.toMatch(/wordCount|byteLength/);
  });

  it('rejects malformed execution input before touching the store or the documents', async () => {
    const error = await validateStep({ jobId: 'nope' }, deps()).catch((e: unknown) => e);
    expect((error as Error).name).toBe(WorkflowError.Validation);
    expect(store.calls.get('transition')).toBeUndefined();
    expect(documents.loads).toBe(0);
  });

  it('rejects a reintroduced payload (spec 2.0.0 strict input)', async () => {
    const input = await seedJob(store, documents);
    const withPayload = { ...input, payload: { title: 'x', content: 'y' } };
    const error = await validateStep(withPayload, deps()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobValidationError);
    expect((error as Error).message).toContain('Unrecognized key: "payload"');
    expect(documents.loads).toBe(0);
  });

  it('is idempotent for duplicate deliveries', async () => {
    const input = await seedJob(store, documents);
    await validateStep(input, deps());
    const again = await validateStep(input, deps());
    expect(again.duplicate).toBe(true);
    expect((await store.get(input.jobId))?.version).toBe(2);
  });

  it('treats a late duplicate after processing started as already validated (no document read)', async () => {
    const input = await seedJob(store, documents);
    await store.transition(input.jobId, 'VALIDATING', T0);
    await store.transition(input.jobId, 'PROCESSING', T0);
    const summary = await validateStep(input, deps());
    expect(summary.duplicate).toBe(true);
    expect(documents.loads).toBe(0);
    expect((await store.get(input.jobId))?.status).toBe('PROCESSING');
  });

  it.each([
    ['missing state', false],
    ['already failed', true],
  ])('throws JobStateConflictError when the job state is %s', async (_n, create) => {
    const input = anExecutionInput();
    if (create) {
      await store.createInitial(input.jobId, T0);
      await store.recordFailure(input.jobId, { name: 'X', message: 'y' }, T0);
    }
    await expect(validateStep(input, deps())).rejects.toBeInstanceOf(JobStateConflictError);
  });

  it.each([
    ['missing', 'no-document'],
    ['purged by retention', 'purged'],
    ['tampered with', 'integrity'],
  ] as const)(
    'fails permanently (DocumentUnavailableError, never retried) when the document is %s',
    async (_n, reason) => {
      const input = await seedJob(store, documents);
      if (reason === 'no-document') documents = new InMemoryDocumentSource();
      if (reason === 'purged') documents.purge(input.jobId);
      if (reason === 'integrity') documents.tamper(input.jobId, 'altered');
      const error = await validateStep(input, deps()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DocumentUnavailableError);
      expect((error as Error).name).toBe(WorkflowError.DocumentUnavailable);
      expect((error as DocumentUnavailableError).reason).toBe(reason);
    },
  );

  it('maps a document-store outage to TransientDependencyError so the spec retry applies', async () => {
    const input = await seedJob(store, documents);
    documents.failNext(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const error = await validateStep(input, deps()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientDependencyError);
    expect((error as Error).name).toBe(WorkflowError.Transient);
    // The retry re-enters VALIDATING as a no-op and completes.
    await expect(validateStep(input, deps())).resolves.toMatchObject({ valid: true });
  });

  it('maps throttling from DynamoDB to TransientDependencyError so the spec retry applies', async () => {
    const input = await seedJob(store, documents);
    store.failNext(
      'transition',
      Object.assign(new Error('slow down'), {
        name: 'ProvisionedThroughputExceededException',
        $metadata: { httpStatusCode: 400 },
      }),
    );
    const error = await validateStep(input, deps()).catch((e: unknown) => e);
    expect((error as Error).name).toBe(WorkflowError.Transient);
    // A retry succeeds.
    await expect(validateStep(input, deps())).resolves.toMatchObject({ valid: true });
  });

  it('does not fail the step when the audit write fails', async () => {
    const input = await seedJob(store, documents);
    store.failNext('appendStep', new Error('audit down'));
    await expect(validateStep(input, deps())).resolves.toMatchObject({ valid: true });
    expect(lines.some((l) => l.msg === 'step audit write failed (non-fatal)')).toBe(true);
  });
});
