import { JobResultSchema } from '@starter/contracts';
import { JobStateConflictError, TransientDependencyError, analyzeDocument } from '@starter/domain';
import { DocumentUnavailableError, InMemoryDocumentSource } from '@starter/documents';
import { InMemoryJobStateStore } from '@starter/job-state';
import {
  VALID_DOCUMENT,
  aJobResult,
  anExecutionInput,
  findLeaks,
  leakCanary,
  steppingClock,
} from '@starter/testing';
import { WorkflowError, type ProcessingExecutionInput } from '@starter/workflow-processing';
import { beforeEach, describe, expect, it } from 'vitest';
import { processStep } from '../src/index.js';
import { capturingLogger, seedJob } from './helpers.js';

const T0 = '2026-10-13T10:00:00.000Z';

describe('processStep', () => {
  let store: InMemoryJobStateStore;
  let documents: InMemoryDocumentSource;
  const { logger, raw } = capturingLogger();
  const deps = () => ({
    store,
    documents,
    logger,
    now: steppingClock('2026-10-13T10:00:02.000Z'),
  });

  async function validatedJob(doc: { title?: string; content?: string; topTerms?: number } = {}) {
    const input = await seedJob(store, documents, doc);
    await store.transition(input.jobId, 'VALIDATING', T0);
    return input;
  }

  beforeEach(() => {
    store = new InMemoryJobStateStore();
    documents = new InMemoryDocumentSource();
    raw.length = 0;
  });

  it('stores the deterministic result on the job-state item and returns metadata only', async () => {
    const input = await validatedJob({ topTerms: 2 });
    const output = await processStep(input, deps());
    expect(output).toEqual({
      jobId: input.jobId,
      resultStored: true,
      algorithmVersion: '1.0.0',
      duplicate: false,
    });
    const expected = analyzeDocument(VALID_DOCUMENT, { topTerms: 2 });
    const state = await store.get(input.jobId);
    expect(state).toMatchObject({ status: 'PROCESSING' });
    expect(JobResultSchema.parse(JSON.parse(state!.resultJson!))).toEqual(expected);
    expect(await store.listSteps(input.jobId)).toMatchObject([
      { state: 'ProcessJob', outcome: 'succeeded' },
    ]);
    // Spec 2.0.0: no step-level idempotency record (no second copy of the result).
    expect(store.items().filter((i) => String(i.pk).startsWith('IDEMPOTENCY#'))).toEqual([]);
  });

  it('keeps the canary document out of the output, the logs and every non-result item', async () => {
    const canary = leakCanary();
    const input = await validatedJob({ title: canary.title, content: canary.content, topTerms: 5 });
    const output = await processStep(input, deps());
    expect(findLeaks(output, canary)).toEqual([]);
    expect(findLeaks(raw, canary)).toEqual([]);
    // The stored analysis is the product (word counts, top terms) — never the text itself.
    expect(findLeaks(store.items(), canary)).toEqual([]);
    expect(raw.join('\n')).not.toMatch(/wordCount|topTerms/);
  });

  it('absorbs a duplicate delivery after the result was stored, without recomputing it', async () => {
    const input = await validatedJob();
    await processStep(input, deps());
    const stored = (await store.get(input.jobId))?.resultJson;
    const second = await processStep(input, deps());
    expect(second).toMatchObject({ duplicate: true, resultStored: true });
    expect((await store.get(input.jobId))?.resultJson).toBe(stored);
    expect(store.calls.get('storeResult')).toBe(1);
  });

  it('reports a delivery after the job already SUCCEEDED as a duplicate without reading the document', async () => {
    const input = await validatedJob();
    await processStep(input, deps());
    await store.recordSuccess(input.jobId, T0);
    const loadsBefore = documents.loads;
    await expect(processStep(input, deps())).resolves.toMatchObject({ duplicate: true });
    expect(documents.loads).toBe(loadsBefore);
  });

  it('refuses a stored result that belongs to a different document (integrity)', async () => {
    const input = await validatedJob();
    await store.transition(input.jobId, 'PROCESSING', T0);
    await store.storeResult(
      input.jobId,
      JSON.stringify(aJobResult({ checksumSha256: 'b'.repeat(64) })),
    );
    const error = await processStep(input, deps()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobStateConflictError);
    expect((error as Error).message).toMatch(/does not match its document/);
  });

  it('refuses to process a job that has not been validated', async () => {
    const input = await seedJob(store, documents);
    const error = await processStep(input, deps()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobStateConflictError);
    expect((error as Error).message).toContain('illegal transition PENDING → PROCESSING');
  });

  it('fails permanently when the document is unavailable (DocumentUnavailableError)', async () => {
    const input = await validatedJob();
    documents.purge(input.jobId);
    const error = await processStep(input, deps()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentUnavailableError);
    expect((error as Error).name).toBe(WorkflowError.DocumentUnavailable);
    expect((await store.get(input.jobId))?.resultJson).toBeUndefined();
  });

  it('wraps transient store and document-source failures as TransientDependencyError', async () => {
    const input = await validatedJob();
    store.failNext(
      'storeResult',
      Object.assign(new Error('503'), {
        name: 'ServiceUnavailable',
        $metadata: { httpStatusCode: 503 },
      }),
    );
    const first = await processStep(input, deps()).catch((e: unknown) => e);
    expect((first as Error).name).toBe(WorkflowError.Transient);
    documents.failNext(Object.assign(new Error('terminating connection'), { code: '57P01' }));
    const second = await processStep(input, deps()).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(TransientDependencyError);
    // The retry re-enters PROCESSING as a no-op and completes.
    await expect(processStep(input, deps())).resolves.toMatchObject({ duplicate: false });
  });

  it('rejects invalid input and a reintroduced payload with JobValidationError', async () => {
    const error = await processStep({ jobId: 'x' }, deps()).catch((e: unknown) => e);
    expect((error as Error).name).toBe(WorkflowError.Validation);
    const input = await validatedJob();
    const withPayload = {
      ...input,
      payload: { content: VALID_DOCUMENT },
    } as ProcessingExecutionInput;
    const strict = await processStep(withPayload, deps()).catch((e: unknown) => e);
    expect((strict as Error).name).toBe(WorkflowError.Validation);
    expect(documents.loads).toBe(0);
  });

  it('never stores a result for an unknown job', async () => {
    await expect(processStep(anExecutionInput(), deps())).rejects.toBeInstanceOf(
      JobStateConflictError,
    );
  });
});
