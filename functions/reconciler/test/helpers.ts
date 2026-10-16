import { Writable } from 'node:stream';
import type { JobState } from '@starter/job-state';
import { createLogger, type Logger, WORKFLOW_REDACT_PATHS } from '@starter/observability';
import type { ExecutionLookup, ExecutionStateSource } from '../src/index.js';

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

/** Execution states by job id; unknown jobs have no execution. Records every lookup. */
export class FakeExecutions implements ExecutionStateSource {
  readonly lookups: { jobId: string; executionArn?: string | undefined }[] = [];
  readonly states = new Map<string, ExecutionLookup>();
  private readonly failures: unknown[] = [];

  failNext(error: unknown): void {
    this.failures.push(error);
  }

  async describe(job: { jobId: string; executionArn?: string | undefined }) {
    this.lookups.push(job);
    await Promise.resolve();
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    return this.states.get(job.jobId) ?? { status: 'NOT_FOUND' as const };
  }
}

export const throttling = () =>
  Object.assign(new Error('Rate exceeded'), {
    name: 'ThrottlingException',
    $metadata: { httpStatusCode: 400 },
  });

export const job = (overrides: Partial<JobState> = {}): JobState => ({
  jobId: '4194b63d-9c1e-4c8a-9f43-1a2b3c4d5e6f',
  status: 'PENDING',
  version: 1,
  createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z',
  ...overrides,
});
