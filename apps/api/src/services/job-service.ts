/**
 * Job use cases, always on behalf of an authenticated principal (ADR 0211): jobs are
 * created with `owner_id = sub`, read and listed only through owner-filtered queries, and
 * idempotency keys are scoped to the principal before they reach DynamoDB or PostgreSQL.
 *
 * Creation is idempotent end to end: every step is keyed by the
 * job id or the idempotency key, so a client retry after any partial failure
 * resumes the same job instead of creating a duplicate.
 *
 *   1. claim idempotency key (DynamoDB, conditional put, TTL)
 *   2. insert business record (PostgreSQL, ON CONFLICT DO NOTHING)
 *   3. create PENDING state (DynamoDB, conditional put)
 *   4. start workflow (deterministic execution name) and attach its ARN
 */
import { randomUUID } from 'node:crypto';
import {
  CONTRACT_VERSION,
  JobResultSchema,
  type CreateJobRequest,
  type Job,
  type JobList,
  type JobResult,
} from '@starter/contracts';
import { expiresAtEpochSeconds, resolveIdempotencyKey, sha256Hex } from '@starter/domain';
import type { JobState, JobStateStore } from '@starter/job-state';
import type { Logger } from '@starter/observability';
import { WorkflowError, WorkflowStatus } from '@starter/workflow-processing';
import { decodeCursor, encodeCursor } from '../cursor.js';
import type { Principal } from '../auth/principal.js';
import type { JobOwner, JobRecord, JobRecordRepository } from '../persistence/job-repository.js';
import { idempotencyMismatchProblem } from '../problem.js';
import type { WorkflowPort } from '../workflow/port.js';

/** Issuer-bound owner key of the principal's jobs. */
const ownerOf = (principal: Principal): JobOwner => ({
  issuer: principal.issuer,
  subject: principal.subject,
});

export interface JobServiceDeps {
  jobs: JobRecordRepository;
  state: JobStateStore;
  workflow: WorkflowPort;
  logger: Logger;
  clock?: () => Date;
  newId?: () => string;
}

export interface CreateOutcome {
  job: Job;
  replayed: boolean;
}

/**
 * Step Functions' RecordFailure may store the Lambda `Cause` (a JSON document
 * with errorType/errorMessage/trace). Surface only the message, never traces.
 */
export function normalizeErrorMessage(raw: string | undefined): string {
  if (!raw) return 'The job failed.';
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && 'errorMessage' in parsed) {
        const message = (parsed as { errorMessage: unknown }).errorMessage;
        if (typeof message === 'string') return message;
      }
    } catch {
      // not JSON — fall through
    }
  }
  return trimmed;
}

/** Shown for every failure that is not a business-rule rejection. */
export const GENERIC_FAILURE = {
  name: 'ProcessingError',
  message: 'The job could not be processed. Retry later, or contact support with the job ID.',
} as const;

/**
 * The failure as shown to (anonymous) API clients. Business-rule rejections are meant for the
 * submitter and are shown verbatim (message only). Anything else — AWS service errors,
 * timeouts, recording failures — can name accounts, roles or tables, so clients get a generic
 * error; operators read the raw cause in the job-state item and the execution history.
 */
export function publicJobError(
  name: string | undefined,
  rawMessage: string | undefined,
): { name: string; message: string } {
  if (name === WorkflowError.Validation)
    return { name, message: normalizeErrorMessage(rawMessage) };
  return { ...GENERIC_FAILURE };
}

export class JobService {
  private readonly clock: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: JobServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  /**
   * `log` should be the request-scoped logger so lines carry the request id. `onRecorded` is
   * called with the job id as soon as the job row exists (also for a replay), i.e. before the
   * workflow starts, so the audit event names the job even if a later step fails.
   */
  async create(
    principal: Principal,
    request: CreateJobRequest,
    headerKey: string | undefined,
    log: Pick<Logger, 'info'> = this.deps.logger,
    onRecorded?: (jobId: string) => void,
  ): Promise<CreateOutcome> {
    const { jobs, state } = this.deps;
    const logger = log;
    const now = this.clock();
    // Scoped to the caller: the same key or body from another principal is another job.
    const resolved = resolveIdempotencyKey(headerKey, request, principal.key);

    // 1. Idempotency claim.
    const claim = await state.claimIdempotency(
      {
        key: resolved.key,
        fingerprint: resolved.fingerprint,
        jobId: this.newId(),
        createdAt: now.toISOString(),
        expiresAt: expiresAtEpochSeconds(now),
      },
      now,
    );
    let replayed = !claim.claimed;
    const claimed = claim.claimed ? claim.record : claim.existing;
    if (claimed.fingerprint !== resolved.fingerprint) throw idempotencyMismatchProblem();

    // 2. Business record.
    const inserted = await jobs.insert({
      id: claimed.jobId,
      owner: ownerOf(principal),
      title: request.title,
      content: request.content,
      contentSha256: sha256Hex(request.content),
      contentLength: request.content.length,
      options: request.options,
      idempotencyKey: resolved.key,
      requestFingerprint: resolved.fingerprint,
      contractVersion: CONTRACT_VERSION,
      createdAt: now,
    });
    let record = inserted.record;
    if (inserted.status === 'key-conflict') {
      // The DynamoDB record expired but PostgreSQL still knows the key.
      if (record.requestFingerprint !== resolved.fingerprint) throw idempotencyMismatchProblem();
      replayed = true;
      await state.putIdempotency({ ...claimed, jobId: record.id });
    } else if (inserted.status === 'exists') {
      record = inserted.record;
    }
    onRecorded?.(record.id);

    // 3 + 4. Workflow state and start (both idempotent).
    const { state: jobState } = await state.createInitial(
      record.id,
      record.createdAt.toISOString(),
    );
    if (jobState.status === WorkflowStatus.Pending && !jobState.executionArn) {
      const started = await this.deps.workflow.start({
        jobId: record.id,
        contractVersion: CONTRACT_VERSION,
        submittedAt: record.createdAt.toISOString(),
      });
      await state.attachExecution(record.id, started.executionArn);
      logger.info(
        {
          jobId: record.id,
          principal: principal.id,
          executionArn: started.executionArn,
          idempotencySource: resolved.source,
          replayed,
        },
        started.alreadyStarted ? 'workflow already started' : 'job accepted; workflow started',
      );
    } else {
      logger.info(
        { jobId: record.id, principal: principal.id, status: jobState.status },
        'idempotent replay of existing job',
      );
    }

    const job = await this.get(principal, record.id);
    if (!job) throw new Error(`job ${record.id} vanished after creation`);
    return { job, replayed };
  }

  /** The job if the principal owns it; null for unknown AND foreign ids (same code path). */
  async get(principal: Principal, jobId: string): Promise<Job | null> {
    const record = await this.deps.jobs.findOwned(jobId, ownerOf(principal));
    if (!record) return null;
    const jobState = await this.deps.state.get(jobId);
    return this.toJob(record, jobState);
  }

  /** The principal's jobs only, newest first. */
  async list(principal: Principal, limit: number, cursor: string | undefined): Promise<JobList> {
    const after = cursor ? decodeCursor(cursor) : undefined;
    const page = await this.deps.jobs.listOwned(ownerOf(principal), limit + 1, after);
    const items = page.slice(0, limit);
    const states = await this.deps.state.getMany(items.map((r) => r.id));
    const last = items.at(-1);
    return {
      items: items.map((r) => {
        const s = states.get(r.id);
        return {
          jobId: r.id,
          title: r.title,
          status: s?.status ?? WorkflowStatus.Pending,
          createdAt: r.createdAt.toISOString(),
          updatedAt: s?.updatedAt ?? r.createdAt.toISOString(),
        };
      }),
      nextCursor:
        page.length > limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  private toJob(record: JobRecord, jobState: JobState | null): Job {
    const status = jobState?.status ?? WorkflowStatus.Pending;
    return {
      jobId: record.id,
      title: record.title,
      status,
      contractVersion: record.contractVersion,
      options: record.options,
      contentLength: record.contentLength,
      contentSha256: record.contentSha256,
      createdAt: record.createdAt.toISOString(),
      updatedAt: jobState?.updatedAt ?? record.createdAt.toISOString(),
      result:
        status === WorkflowStatus.Succeeded && jobState?.resultJson
          ? this.parseResult(record.id, jobState.resultJson)
          : null,
      error:
        status === WorkflowStatus.Failed
          ? publicJobError(jobState?.errorName, jobState?.errorMessage)
          : null,
    };
  }

  private parseResult(jobId: string, resultJson: string): JobResult {
    const parsed = JobResultSchema.safeParse(JSON.parse(resultJson));
    if (!parsed.success) {
      this.deps.logger.error(
        { jobId, issues: parsed.error.issues.length },
        'stored result is invalid',
      );
      throw new Error(`stored result for job ${jobId} does not match the contract`);
    }
    return parsed.data;
  }
}
