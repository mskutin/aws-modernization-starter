/**
 * In-memory twin of `PgDocumentSource` for unit tests and the API's fakes. Applies the same
 * purge and SHA-256 verification (`toVerifiedDocument`) and supports failure injection.
 */
import { sha256Hex } from '@starter/domain';
import type { JobOptions } from '@starter/contracts';
import { DocumentUnavailableError, classifySourceError } from './errors.js';
import type { DocumentSource, StoredDocument } from './types.js';
import { toVerifiedDocument, type DocumentRecord } from './verify.js';

export interface DocumentInput {
  title: string;
  content: string;
  options?: JobOptions | undefined;
  contractVersion?: string | undefined;
}

export class InMemoryDocumentSource implements DocumentSource {
  private readonly records = new Map<string, DocumentRecord>();
  private readonly failures: unknown[] = [];
  /** Number of `load` calls (asserts that a step did, or did not, read the document). */
  loads = 0;

  /** Stores a document as the API would (content hash computed from the content). */
  put(jobId: string, doc: DocumentInput): StoredDocument {
    const record: DocumentRecord = {
      title: doc.title,
      content: doc.content,
      options: doc.options ?? { topTerms: 10 },
      contentSha256: sha256Hex(doc.content),
      contractVersion: doc.contractVersion ?? '1.0.0',
      purgedAt: null,
    };
    this.records.set(jobId, record);
    return toVerifiedDocument(jobId, record);
  }

  /** Simulates the retention job: content gone, marker set. */
  purge(jobId: string, at = new Date()): void {
    const record = this.records.get(jobId);
    if (record) this.records.set(jobId, { ...record, content: null, purgedAt: at });
  }

  /** Simulates tampering: content changed without updating the stored hash. */
  tamper(jobId: string, content: string): void {
    const record = this.records.get(jobId);
    if (record) this.records.set(jobId, { ...record, content });
  }

  /** Makes the next `times` loads reject with `error` (raw driver-like errors get classified). */
  failNext(error: unknown, times = 1): void {
    for (let i = 0; i < times; i += 1) this.failures.push(error);
  }

  async load(jobId: string): Promise<StoredDocument> {
    this.loads += 1;
    await Promise.resolve();
    const failure = this.failures.shift();
    if (failure !== undefined) throw classifySourceError(failure, jobId);
    const record = this.records.get(jobId);
    if (!record) throw new DocumentUnavailableError(jobId, 'no-document');
    return toVerifiedDocument(jobId, structuredClone(record));
  }
}
