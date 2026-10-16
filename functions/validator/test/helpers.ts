import { Writable } from 'node:stream';
import type { InMemoryDocumentSource } from '@starter/documents';
import type { JobStateStore } from '@starter/job-state';
import { WORKFLOW_REDACT_PATHS, createLogger, type Logger } from '@starter/observability';
import { VALID_DOCUMENT, anExecutionInput } from '@starter/testing';
import type { ProcessingExecutionInput } from '@starter/workflow-processing';

export function capturingLogger(): {
  logger: Logger;
  lines: Record<string, unknown>[];
  raw: string[];
} {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        raw.push(line);
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      cb();
    },
  });
  return {
    logger: createLogger({
      service: 'test',
      level: 'debug',
      destination: stream,
      redact: WORKFLOW_REDACT_PATHS,
    }),
    lines,
    raw,
  };
}

/** Stores the document (as the API would in PostgreSQL) and creates the PENDING job state. */
export async function seedJob(
  store: JobStateStore,
  documents: InMemoryDocumentSource,
  doc: { title?: string; content?: string; topTerms?: number } = {},
  overrides: Partial<ProcessingExecutionInput> = {},
): Promise<ProcessingExecutionInput> {
  const input = anExecutionInput(overrides);
  documents.put(input.jobId, {
    title: doc.title ?? 'Migration notes',
    content: doc.content ?? VALID_DOCUMENT,
    options: { topTerms: doc.topTerms ?? 10 },
  });
  await store.createInitial(input.jobId, '2026-10-13T10:00:00.000Z');
  return input;
}
