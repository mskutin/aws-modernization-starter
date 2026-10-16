import type { JobStatus } from '@starter/domain';
import type { ProcessingStateName } from '@starter/workflow-processing';

/** Workflow/execution state of one job (DynamoDB item `JOB#<id>` / `STATE`). */
export interface JobState {
  jobId: string;
  status: JobStatus;
  /** Monotonic counter incremented by every write (optimistic concurrency). */
  version: number;
  createdAt: string;
  updatedAt: string;
  resultJson?: string | undefined;
  errorName?: string | undefined;
  errorMessage?: string | undefined;
  executionArn?: string | undefined;
}

export type TransitionOutcome =
  | { kind: 'applied'; state: JobState }
  /** Already in the target status — duplicate delivery or retry; nothing written. */
  | { kind: 'noop'; state: JobState }
  | { kind: 'rejected'; state: JobState | null; reason: string };

export interface TransitionOptions {
  /** Only apply when the stored version equals this value. */
  expectedVersion?: number | undefined;
  /**
   * Only apply when the stored status equals this value (the reconciler conditions its writes on
   * the status AND version it observed with a consistent read).
   */
  expectedStatus?: JobStatus | undefined;
}

export type StoreResultOutcome =
  | { kind: 'stored'; state: JobState }
  /** A result is already stored (duplicate delivery); the stored one is kept unchanged. */
  | { kind: 'exists'; state: JobState }
  | { kind: 'rejected'; state: JobState | null; reason: string };

/** A non-terminal job found through the status index (only non-sensitive attributes). */
export interface StaleJobCandidate {
  jobId: string;
  status: JobStatus;
  updatedAt: string;
}

export interface IdempotencyRecord {
  key: string;
  /** SHA-256 of the canonical request/payload the key was first used with. */
  fingerprint: string;
  jobId: string;
  createdAt: string;
  /** Epoch seconds (DynamoDB TTL attribute). Expired records are treated as absent. */
  expiresAt: number;
  /** Optional cached result (step-level idempotency). */
  resultJson?: string | undefined;
}

export type ClaimOutcome =
  { claimed: true; record: IdempotencyRecord } | { claimed: false; existing: IdempotencyRecord };

export type StepOutcome = 'succeeded' | 'failed' | 'duplicate';

export interface StepAuditEntry {
  jobId: string;
  state: ProcessingStateName;
  at: string;
  outcome: StepOutcome;
  detail?: string | undefined;
}

/**
 * Port used by the API, the Lambda steps and the local workflow simulator.
 * Two implementations: DynamoDB (production/integration) and in-memory (unit
 * tests). Both are verified by the same contract test suite.
 */
export interface JobStateStore {
  /** Creates the PENDING state if absent; returns the existing state otherwise. */
  createInitial(jobId: string, at: string): Promise<{ created: boolean; state: JobState }>;
  get(jobId: string): Promise<JobState | null>;
  getMany(jobIds: readonly string[]): Promise<Map<string, JobState>>;
  /** Moves the job to VALIDATING/PROCESSING if the lifecycle allows it. */
  transition(
    jobId: string,
    to: 'VALIDATING' | 'PROCESSING',
    at: string,
    options?: TransitionOptions,
  ): Promise<TransitionOutcome>;
  /**
   * ProcessJob (spec 2.0.0): stores the analysis result on the PROCESSING item, at most once.
   * The result never travels through the workflow; RecordSuccess requires it to be present.
   */
  storeResult(jobId: string, resultJson: string): Promise<StoreResultOutcome>;
  /** RecordSuccess: PROCESSING with a stored result → SUCCEEDED. */
  recordSuccess(jobId: string, at: string, options?: TransitionOptions): Promise<TransitionOutcome>;
  /** RecordFailure: any non-terminal → FAILED with the error; removes a stored result. */
  recordFailure(
    jobId: string,
    error: { name: string; message: string },
    at: string,
    options?: TransitionOptions,
  ): Promise<TransitionOutcome>;
  /**
   * Reconciler: up to `limit` jobs in `status` whose last transition is older than `olderThan`
   * (ISO-8601), oldest first, from the status index (eventually consistent — re-read before
   * acting).
   */
  listStale(status: JobStatus, olderThan: string, limit: number): Promise<StaleJobCandidate[]>;
  /** Stores the execution ARN once; returns false if a different ARN is already set. */
  attachExecution(jobId: string, executionArn: string): Promise<boolean>;
  appendStep(entry: StepAuditEntry): Promise<void>;
  listSteps(jobId: string): Promise<StepAuditEntry[]>;
  /** Atomically claims an idempotency key; returns the live existing record if taken. */
  claimIdempotency(record: IdempotencyRecord, now: Date): Promise<ClaimOutcome>;
  getIdempotency(key: string, now: Date): Promise<IdempotencyRecord | null>;
  /** Re-points an idempotency key (repair after the record expired). */
  putIdempotency(record: IdempotencyRecord): Promise<void>;
  /** Cheap reachability check for readiness probes. */
  ping(): Promise<void>;
}
