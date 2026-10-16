/**
 * Behaviour every DocumentSource must share (in-memory twin, PostgreSQL, test table): verified
 * loads, permanent "unavailable" errors for missing / purged / tampered documents, and error
 * messages that never contain document data.
 */
import { randomUUID } from 'node:crypto';
import { WorkflowError } from '@starter/workflow-processing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentUnavailableError, type DocumentSource } from '../src/index.js';

export interface SourceHarness {
  source: DocumentSource;
  /** Stores a document the way the API does (hash of the content). */
  seed(jobId: string, doc: { title: string; content: string; topTerms: number }): Promise<void>;
  purge(jobId: string): Promise<void>;
  tamper(jobId: string, content: string): Promise<void>;
  cleanup?: () => Promise<void>;
}

const CANARY_TITLE = 'Canary title 51f0';
const CANARY_CONTENT = 'zzcanary51f0 secret body text that must stay in the store';

async function unavailable(
  source: DocumentSource,
  jobId: string,
): Promise<DocumentUnavailableError> {
  const error = await source.load(jobId).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DocumentUnavailableError);
  const e = error as DocumentUnavailableError;
  expect(e.name).toBe(WorkflowError.DocumentUnavailable);
  expect(e.message).not.toContain(CANARY_CONTENT);
  expect(e.message).not.toContain(CANARY_TITLE);
  return e;
}

export function describeDocumentSourceContract(
  label: string,
  setup: () => Promise<SourceHarness>,
): void {
  describe(`DocumentSource contract: ${label}`, () => {
    let h: SourceHarness;
    beforeAll(async () => {
      h = await setup();
    });
    afterAll(async () => {
      await h?.cleanup?.();
    });

    it('loads the stored document and verifies its SHA-256', async () => {
      const jobId = randomUUID();
      await h.seed(jobId, { title: CANARY_TITLE, content: CANARY_CONTENT, topTerms: 4 });
      const doc = await h.source.load(jobId);
      expect(doc).toEqual({
        jobId,
        title: CANARY_TITLE,
        content: CANARY_CONTENT,
        options: { topTerms: 4 },
        contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        contractVersion: '1.0.0',
      });
    });

    it('reports an unknown job as no-document', async () => {
      expect((await unavailable(h.source, randomUUID())).reason).toBe('no-document');
    });

    it('never serves a purged document (no row, or a row marked purged)', async () => {
      const jobId = randomUUID();
      await h.seed(jobId, { title: CANARY_TITLE, content: CANARY_CONTENT, topTerms: 3 });
      await h.purge(jobId);
      expect(['no-document', 'purged']).toContain((await unavailable(h.source, jobId)).reason);
    });

    it('reports content that no longer matches the stored hash as an integrity failure', async () => {
      const jobId = randomUUID();
      await h.seed(jobId, { title: CANARY_TITLE, content: CANARY_CONTENT, topTerms: 3 });
      await h.tamper(jobId, `${CANARY_CONTENT} (altered)`);
      expect((await unavailable(h.source, jobId)).reason).toBe('integrity');
    });
  });
}
