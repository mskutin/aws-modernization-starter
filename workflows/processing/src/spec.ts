/**
 * Processing workflow specification — the single source of truth shared by
 *   1. the AWS Step Functions definition (CDK, `src/cdk/`), and
 *   2. the API's LOCAL workflow adapter (an in-process simulation used for
 *      local development only; it does NOT prove Step Functions behaviour).
 *
 * This module must stay free of `aws-cdk-lib` imports so runtime code
 * (API, Lambda handlers) can depend on it without pulling in the CDK.
 */

/**
 * 2.0.0 (ADR 0230): the execution input is a job reference plus non-sensitive
 * metadata only; handlers load the document from the system of record (claim check) and the
 * processor stores the result on the job-state item itself, so neither the document nor anything
 * derived from it passes through Step Functions (input, state data, output or history).
 */
export const WORKFLOW_SPEC_VERSION = '2.0.0' as const;

/** Ordered, named states of the processing workflow. */
export const ProcessingState = {
  Validate: 'ValidateJob',
  Process: 'ProcessJob',
  RecordSuccess: 'RecordSuccess',
  /** Pass: default `{ Error, Cause }` (Step Functions does not always report a `Cause`). */
  FailureDefaults: 'FailureDefaults',
  /** Pass: merges the caught error over the defaults, so RecordFailure never reads a missing path. */
  NormalizeError: 'NormalizeError',
  RecordFailure: 'RecordFailure',
  Succeeded: 'JobSucceeded',
  Failed: 'JobFailed',
  /** Terminal Fail when RecordFailure itself fails: the job may stay non-terminal (alarmed). */
  RecordingFailed: 'RecordingFailed',
} as const;
export type ProcessingStateName = (typeof ProcessingState)[keyof typeof ProcessingState];

/** Workflow-level status written to DynamoDB and surfaced through the API. */
export const WorkflowStatus = {
  Pending: 'PENDING',
  Validating: 'VALIDATING',
  Processing: 'PROCESSING',
  Succeeded: 'SUCCEEDED',
  Failed: 'FAILED',
} as const;
export type WorkflowStatus = (typeof WorkflowStatus)[keyof typeof WorkflowStatus];

export const TERMINAL_STATUSES: ReadonlySet<WorkflowStatus> = new Set([
  WorkflowStatus.Succeeded,
  WorkflowStatus.Failed,
]);

/**
 * Error names thrown by handlers. Step Functions matches on `Error` names, so
 * handlers MUST throw errors whose `name` equals one of these values.
 */
export const WorkflowError = {
  /** Input is permanently invalid; never retried. */
  Validation: 'JobValidationError',
  /** Transient dependency failure (throttling, timeouts); retried. */
  Transient: 'TransientDependencyError',
  /** Duplicate delivery detected via idempotency record; treated as success. */
  Duplicate: 'DuplicateExecutionError',
  /**
   * The job's document cannot be loaded from the system of record: missing, purged by retention,
   * or its stored SHA-256 does not match. Permanent; never retried (no retry policy lists it).
   */
  DocumentUnavailable: 'DocumentUnavailableError',
} as const;
export type WorkflowErrorName = (typeof WorkflowError)[keyof typeof WorkflowError];

export interface RetryPolicy {
  /** Error names the policy applies to (Step Functions `ErrorEquals`). */
  errors: readonly string[];
  intervalSeconds: number;
  maxAttempts: number;
  backoffRate: number;
  /** Cap on the delay between attempts (Step Functions `MaxDelaySeconds`). */
  maxDelaySeconds: number;
  jitter: 'FULL' | 'NONE';
}

export interface TaskSpec {
  state: ProcessingStateName;
  /** Status recorded while this task is running. */
  status: WorkflowStatus;
  timeoutSeconds: number;
  retry: readonly RetryPolicy[];
  /** Errors routed to the failure path instead of failing the execution. */
  catch: readonly string[];
}

const LAMBDA_SERVICE_ERRORS = [
  'Lambda.ServiceException',
  'Lambda.AWSLambdaException',
  'Lambda.SdkClientException',
  'Lambda.TooManyRequestsException',
] as const;

/** Transient errors of the native DynamoDB service integration used by the record states. */
const DYNAMODB_TRANSIENT_ERRORS = [
  'DynamoDB.ProvisionedThroughputExceededException',
  'DynamoDB.RequestLimitExceededException',
  'DynamoDB.ThrottlingException',
  'DynamoDB.InternalServerErrorException',
] as const;

export const PROCESSING_WORKFLOW = {
  name: 'job-processing',
  version: WORKFLOW_SPEC_VERSION,
  /**
   * Hard ceiling for a whole execution (Step Functions `TimeoutSeconds`). An execution-level
   * timeout cannot be caught, so it must exceed the worst-case path through every task's
   * timeouts and retries (`worstCaseExecutionSeconds`, asserted by the spec tests); otherwise a
   * job could end without RecordFailure and stay non-terminal.
   */
  executionTimeoutSeconds: 600,
  /** RecordSuccess / RecordFailure: native DynamoDB UpdateItem tasks. */
  recordStates: {
    timeoutSeconds: 10,
    retry: [
      {
        errors: [...DYNAMODB_TRANSIENT_ERRORS],
        intervalSeconds: 1,
        maxAttempts: 3,
        backoffRate: 2,
        maxDelaySeconds: 8,
        jitter: 'FULL',
      },
    ],
  },
  tasks: {
    validate: {
      state: ProcessingState.Validate,
      status: WorkflowStatus.Validating,
      // 2.0.0: 20 s (was 15) — the attempt now includes a PostgreSQL connect + document query.
      timeoutSeconds: 20,
      retry: [
        {
          errors: [...LAMBDA_SERVICE_ERRORS, WorkflowError.Transient],
          intervalSeconds: 1,
          maxAttempts: 3,
          backoffRate: 2,
          maxDelaySeconds: 8,
          jitter: 'FULL',
        },
      ],
      catch: ['States.ALL'],
    },
    process: {
      state: ProcessingState.Process,
      status: WorkflowStatus.Processing,
      timeoutSeconds: 60,
      retry: [
        {
          errors: [...LAMBDA_SERVICE_ERRORS, WorkflowError.Transient, 'States.Timeout'],
          intervalSeconds: 2,
          maxAttempts: 4,
          backoffRate: 2,
          maxDelaySeconds: 20,
          jitter: 'FULL',
        },
      ],
      catch: ['States.ALL'],
    },
  },
} as const satisfies {
  name: string;
  version: string;
  executionTimeoutSeconds: number;
  recordStates: { timeoutSeconds: number; retry: readonly RetryPolicy[] };
  tasks: Record<'validate' | 'process', TaskSpec>;
};

/** Upper bound of the total wait a retry policy adds (full jitter never exceeds it). */
export function maxRetryDelaySeconds(policy: RetryPolicy): number {
  let total = 0;
  for (let retry = 0; retry < policy.maxAttempts; retry += 1) {
    total += Math.min(policy.intervalSeconds * policy.backoffRate ** retry, policy.maxDelaySeconds);
  }
  return total;
}

/**
 * Worst-case wall time of one task: every attempt runs into the task timeout and every retrier
 * is exhausted (an over-approximation when retriers cover different errors).
 */
export function worstCaseTaskSeconds(task: {
  timeoutSeconds: number;
  retry: readonly RetryPolicy[];
}): number {
  const retries = task.retry.reduce((sum, policy) => sum + policy.maxAttempts, 0);
  const delays = task.retry.reduce((sum, policy) => sum + maxRetryDelaySeconds(policy), 0);
  return (retries + 1) * task.timeoutSeconds + delays;
}

/**
 * Worst-case path of an execution: ValidateJob → ProcessJob → RecordSuccess fails → (Pass
 * states) → RecordFailure. Pass states take no measurable time.
 */
export function worstCaseExecutionSeconds(
  workflow: Pick<typeof PROCESSING_WORKFLOW, 'tasks' | 'recordStates'> = PROCESSING_WORKFLOW,
): number {
  return (
    worstCaseTaskSeconds(workflow.tasks.validate) +
    worstCaseTaskSeconds(workflow.tasks.process) +
    2 * worstCaseTaskSeconds(workflow.recordStates)
  );
}

/**
 * Client-side time budgets of the dependencies one task attempt uses. Handlers configure
 * their clients with exactly these values (`STEP_CLIENT_SETTINGS`), so a slow dependency fails
 * the attempt with a classified, retryable `TransientDependencyError` well before the task
 * timeout — a `States.Timeout` of ValidateJob is not retried and would fail the job.
 */
export const STEP_CLIENT_SETTINGS = {
  /** PostgreSQL (`@starter/db` pool, one connection per Lambda environment). */
  db: {
    poolMax: 1,
    /** TCP + TLS (verify-full) + IAM token signing for one NEW connection. */
    connectionTimeoutMs: 4_000,
    /** Server-side statement_timeout of the document query. */
    statementTimeoutMs: 2_000,
    /** Client-side query timeout (statement timeout + 1 s). */
    queryTimeoutMs: 3_000,
  },
  /** DynamoDB (job-state store). One call ≤ maxAttempts × (request + connection timeout) + backoff. */
  dynamodb: { maxAttempts: 2, requestTimeoutMs: 1_000, connectionTimeoutMs: 500 },
  /** Cold start: module initialisation, configuration, first credentials. */
  initSeconds: 3,
} as const;

/** Upper bound of one DynamoDB call with SDK retries (backoff of the standard retry strategy ≤ 0.5 s). */
export function dynamoDbCallBudgetSeconds(
  settings: {
    maxAttempts: number;
    requestTimeoutMs: number;
    connectionTimeoutMs: number;
  } = STEP_CLIENT_SETTINGS.dynamodb,
): number {
  return (
    (settings.maxAttempts * (settings.requestTimeoutMs + settings.connectionTimeoutMs)) / 1000 + 0.5
  );
}

/** Dependency calls one attempt of each task makes in the worst case. */
export const STEP_DEPENDENCY_CALLS = {
  /** transition → load document → audit step. */
  validate: { documentLoads: 1, dynamoDbCalls: 2 },
  /** transition → load document → store result → audit step. */
  process: { documentLoads: 1, dynamoDbCalls: 3 },
} as const satisfies Record<
  'validate' | 'process',
  { documentLoads: number; dynamoDbCalls: number }
>;

/**
 * Worst-case duration of ONE attempt of a task when every dependency call runs into its client
 * timeout (cold start included). Must stay below the task timeout (asserted by the spec tests).
 */
export function attemptBudgetSeconds(calls: {
  documentLoads: number;
  dynamoDbCalls: number;
}): number {
  const { db, initSeconds } = STEP_CLIENT_SETTINGS;
  return (
    initSeconds +
    calls.documentLoads * ((db.connectionTimeoutMs + db.queryTimeoutMs) / 1000) +
    calls.dynamoDbCalls * dynamoDbCallBudgetSeconds()
  );
}

/**
 * Input accepted by the state machine (`StartExecution.input`) — spec 2.0.0.
 *
 * A job reference plus non-sensitive metadata ONLY. Workflow and reconciler transitions are
 * attributed to the submitter through `jobId` → `owner_id` in PostgreSQL; the input
 * carries no principal. Future changes follow expand/contract: handlers accept the old
 * and the new shape for one release before the old one is dropped. Never add the document, its title, its
 * options, the idempotency key (a derived key is a hash of the content) or anything else derived
 * from the submission: Step Functions keeps execution input and history for 90 days, outside the
 * retention controls of the data stores, and logs it when execution-data logging is on.
 */
export interface ProcessingExecutionInput {
  jobId: string;
  /** Contract version (`@starter/contracts`) the submitting API spoke; handlers check the major. */
  contractVersion: string;
  /** ISO-8601 time the job was accepted (equals the job-state item's `createdAt`). */
  submittedAt: string;
}

/** The exact key set of `ProcessingExecutionInput` (order = canonical serialisation order). */
export const EXECUTION_INPUT_KEYS = ['jobId', 'contractVersion', 'submittedAt'] as const;

/**
 * Keys of the event every Lambda task receives (ASL `Parameters`): the execution input plus the
 * execution ARN (`$$.Execution.Id`). Handlers reject any other key.
 */
export const TASK_EVENT_KEYS = [...EXECUTION_INPUT_KEYS, 'executionArn'] as const;

/** An execution input that is not exactly `ProcessingExecutionInput` (programming error). */
export class ExecutionInputError extends Error {
  override readonly name = 'ExecutionInputError';
}

/**
 * Throws unless `value` has exactly the keys of `ProcessingExecutionInput`, each a non-empty
 * string. Used by every adapter before starting an execution, so a reintroduced `payload` (or
 * any other extra field) fails loudly instead of leaking into execution history. Messages name
 * keys only, never values.
 */
export function assertExecutionInput(value: unknown): asserts value is ProcessingExecutionInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ExecutionInputError('execution input must be a JSON object');
  }
  const allowed: readonly string[] = EXECUTION_INPUT_KEYS;
  const keys = Object.keys(value);
  const unexpected = keys.filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !keys.includes(key));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new ExecutionInputError(
      `execution input must contain exactly ${allowed.join(', ')}` +
        ` (unexpected: ${unexpected.sort().join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})`,
    );
  }
  for (const key of allowed) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field !== 'string' || field.length === 0) {
      throw new ExecutionInputError(`execution input field ${key} must be a non-empty string`);
    }
  }
}

/**
 * Canonical JSON of an execution input (fixed key order). StartExecution is idempotent only for
 * a byte-identical input under the same name, so every starter (API, reconciler) uses this.
 */
export function serializeExecutionInput(input: ProcessingExecutionInput): string {
  assertExecutionInput(input);
  return JSON.stringify({
    jobId: input.jobId,
    contractVersion: input.contractVersion,
    submittedAt: input.submittedAt,
  });
}

/**
 * DynamoDB single-table layout for workflow/idempotency state. Shared because
 * the Step Functions `RecordSuccess`/`RecordFailure` states write these items
 * through the native DynamoDB service integration (no Lambda), while handlers
 * and the API read/write them through the AWS SDK.
 *
 *   Execution state : pk = JOB#<jobId>        sk = STATE
 *   Step audit trail: pk = JOB#<jobId>        sk = STEP#<isoTimestamp>#<state>
 *                     (TTL expiresAt only when JOB_AUDIT_TTL_DAYS is configured; default none)
 *   Idempotency     : pk = IDEMPOTENCY#<key>  sk = IDEMPOTENCY   (TTL: expiresAt)
 *   GSI1 (by status): gsi1pk = STATUS#<status>  gsi1sk = <updatedAt>#<jobId>
 *
 * Items never hold the document title or content. The STATE item holds the processor's result
 * (`resultJson`, written by ProcessJob itself — spec 2.0.0), which RecordSuccess requires.
 */
export const JobStateTable = {
  partitionKey: 'pk',
  sortKey: 'sk',
  ttlAttribute: 'expiresAt',
  statusIndex: { name: 'gsi1', partitionKey: 'gsi1pk', sortKey: 'gsi1sk' },
  attributes: {
    jobId: 'jobId',
    status: 'status',
    /** ISO-8601 timestamp of the last transition. */
    updatedAt: 'updatedAt',
    /**
     * JSON-encoded processor result. Written by ProcessJob onto the PROCESSING item (never passed
     * through Step Functions); RecordSuccess completes the transition only when it is present;
     * every FAILED transition removes it.
     */
    result: 'resultJson',
    errorName: 'errorName',
    errorMessage: 'errorMessage',
    executionArn: 'executionArn',
    /** Monotonic counter used for optimistic-concurrency conditional writes. */
    version: 'version',
  },
} as const;

export const jobStateKey = (jobId: string) => ({ pk: `JOB#${jobId}`, sk: 'STATE' }) as const;
export const jobStepKey = (jobId: string, at: string, state: ProcessingStateName) =>
  ({ pk: `JOB#${jobId}`, sk: `STEP#${at}#${state}` }) as const;
export const idempotencyKey = (key: string) =>
  ({ pk: `IDEMPOTENCY#${key}`, sk: 'IDEMPOTENCY' }) as const;
export const statusIndexKey = (status: WorkflowStatus, updatedAt: string, jobId: string) =>
  ({ gsi1pk: `STATUS#${status}`, gsi1sk: `${updatedAt}#${jobId}` }) as const;

/** Deterministic execution name so StartExecution is idempotent per job. */
export function executionNameFor(jobId: string): string {
  const safe = jobId.replace(/[^A-Za-z0-9_-]/g, '-');
  return `job-${safe}`.slice(0, 80);
}

/** ARN of the execution named `executionName` of the state machine `stateMachineArn`. */
export function executionArnFor(stateMachineArn: string, executionName: string): string {
  return `${stateMachineArn.replace(':stateMachine:', ':execution:')}:${executionName}`;
}

/**
 * Stale-job reconciliation (ADR 0231). A job is stale when its status is non-terminal and its
 * last transition is older than the configured threshold, which must exceed the execution
 * timeout plus a grace period: Step Functions ends every execution within
 * `executionTimeoutSeconds`, so a job older than that is never in the middle of a healthy run.
 */
export const RECONCILIATION = {
  /** Statuses the reconciler examines (non-terminal). */
  statuses: [WorkflowStatus.Pending, WorkflowStatus.Validating, WorkflowStatus.Processing],
  /** Margin over the execution timeout before a non-terminal job counts as stale. */
  graceSeconds: 60,
  /** Lower bound for `RECONCILER_STALE_AFTER_SECONDS`. */
  minimumStaleAfterSeconds: PROCESSING_WORKFLOW.executionTimeoutSeconds + 60,
} as const;

/**
 * `errorName` values the reconciler writes when it closes a stale job as FAILED. Non-sensitive by
 * construction (fixed names; the matching `errorMessage` is a fixed template). The reconciler
 * never (re)starts a workflow: a job that never started is closed as FAILED.
 */
export const ReconciliationError = {
  /** The execution ended FAILED without recording a terminal job status (e.g. RecordingFailed). */
  ExecutionFailed: 'ExecutionFailed',
  ExecutionTimedOut: 'ExecutionTimedOut',
  ExecutionAborted: 'ExecutionAborted',
  /** PENDING, no execution ARN, and no execution under the deterministic name. */
  WorkflowNotStarted: 'WorkflowNotStarted',
  /** An execution was referenced (or the job left PENDING) but it does not exist. */
  ExecutionNotFound: 'ExecutionNotFound',
  /** The execution SUCCEEDED but the job item is non-terminal without a stored result. */
  StateMismatch: 'ExecutionStateMismatch',
} as const;
export type ReconciliationErrorName =
  (typeof ReconciliationError)[keyof typeof ReconciliationError];

/**
 * CloudWatch metrics the reconciler emits (Embedded Metric Format, one record per run) and the
 * alarms are built on. Dimension: `Environment`.
 */
export const RECONCILER_METRICS = {
  namespace: 'Workload/Reconciler',
  dimension: 'Environment',
  names: {
    /** Non-terminal jobs older than the threshold, read from the status index. */
    staleCandidates: 'StaleCandidates',
    /** Left alone: the execution is still running. */
    skippedRunning: 'SkippedRunning',
    /** Left alone: the consistent read shows the job moved on (or vanished). */
    skippedNotStale: 'SkippedNotStale',
    markedFailed: 'MarkedFailed',
    /** SUCCEEDED execution + stored result: transition completed to SUCCEEDED. */
    completed: 'Completed',
    /** A conditional write lost against a concurrent writer (nothing changed). */
    conflicts: 'Conflicts',
    /** Inconsistent states worth investigating (succeeded without result, foreign ARN). */
    anomalies: 'Anomalies',
    /** DynamoDB / Step Functions errors or throttles: the run stopped without a transition. */
    dependencyErrors: 'DependencyErrors',
    /** Decisions that would have written something (dry-run only). */
    dryRunDecisions: 'DryRunDecisions',
    durationMs: 'DurationMs',
  },
} as const;
