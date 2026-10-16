/**
 * LOCAL SIMULATION — NOT AWS Step Functions.
 *
 * Runs the processing workflow in-process for local development: the same
 * ValidateJob / ProcessJob step code the Lambdas run, the retry, timeout and
 * catch numbers from the shared spec, and RecordSuccess / RecordFailure writes
 * with the same DynamoDB attributes. It does NOT reproduce Step Functions
 * semantics such as exactly-once state transitions, durable history, Lambda
 * service errors, payload limits or IAM. Passing local runs is not evidence
 * that the deployed state machine behaves correctly.
 *
 * Spec 2.0.0 (ADR 0230): the execution input is `{ jobId, contractVersion,
 * submittedAt }` only (anything else is refused); the steps load the document
 * through `documents` — a `starter_processor` source, never the API's own pool —
 * and the processor stores the result on the job-state item itself, so
 * RecordSuccess only completes the transition.
 *
 * Executions live in this process: they are lost when it stops, and `describe`
 * knows only this process's executions (the reconciler loop built on it is
 * correct for a single API process only).
 */
import { describeError, findRetryPolicy, retryDelayMs, STATES_TIMEOUT } from '@starter/domain';
import type { DocumentSource } from '@starter/documents';
import { processStep } from '@starter/fn-processor';
import { validateStep } from '@starter/fn-validator';
import type { JobStateStore } from '@starter/job-state';
import { WORKFLOW_REDACT_PATHS, childWithRedaction, type Logger } from '@starter/observability';
import {
  PROCESSING_WORKFLOW,
  ProcessingState,
  WorkflowError,
  assertExecutionInput,
  executionNameFor,
  serializeExecutionInput,
  type ProcessingExecutionInput,
  type RetryPolicy,
  type TaskSpec,
} from '@starter/workflow-processing';
import { MAX_EXECUTION_INPUT_BYTES, type StartResult, type WorkflowPort } from './port.js';

export const LOCAL_SIMULATION_WARNING = 'LOCAL SIMULATION — not AWS Step Functions';

/** What this process knows about one simulated execution (mirrors DescribeExecution statuses). */
export type SimulatedExecutionStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'NOT_FOUND';

export interface LocalWorkflowSimulatorOptions {
  store: JobStateStore;
  /** Document source of the steps: PostgreSQL as `starter_processor` (or an in-memory twin in tests). */
  documents: DocumentSource;
  logger: Logger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Multiplier for spec delays/timeouts (tests use a small value). Default 1. */
  timeScale?: number;
  /** Outcomes of finished executions remembered for `describe` (oldest dropped). Default 1000. */
  outcomeMemory?: number;
  /** Test hook: replace step implementations. */
  steps?: {
    validate?: typeof validateStep;
    process?: typeof processStep;
  };
}

class TaskTimeoutError extends Error {
  override readonly name = STATES_TIMEOUT;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class LocalWorkflowSimulator implements WorkflowPort {
  readonly kind = 'local' as const;
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly outcomes = new Map<string, 'SUCCEEDED' | 'FAILED'>();
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly timeScale: number;
  private readonly outcomeMemory: number;

  constructor(private readonly options: LocalWorkflowSimulatorOptions) {
    this.logger = childWithRedaction(
      options.logger,
      { workflow: PROCESSING_WORKFLOW.name, simulation: true },
      WORKFLOW_REDACT_PATHS,
    );
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.timeScale = options.timeScale ?? 1;
    this.outcomeMemory = options.outcomeMemory ?? 1_000;
    this.logger.warn(
      `${LOCAL_SIMULATION_WARNING}: WORKFLOW_MODE=local runs the workflow in-process for development only`,
    );
  }

  /** Number of executions currently running (for tests/diagnostics). */
  get running(): number {
    return this.inflight.size;
  }

  /** Deterministic synthetic execution ARN of a job (same name rule as Step Functions). */
  executionArnFor(jobId: string): string {
    return `local-simulation:${PROCESSING_WORKFLOW.name}:${executionNameFor(jobId)}`;
  }

  async start(input: ProcessingExecutionInput): Promise<StartResult> {
    // Same guard as the Step Functions adapter: exactly the spec 2.0.0 fields.
    assertExecutionInput(input);
    const executionArn = this.executionArnFor(input.jobId);
    if (Buffer.byteLength(serializeExecutionInput(input), 'utf8') > MAX_EXECUTION_INPUT_BYTES) {
      throw new Error(`execution input exceeds ${MAX_EXECUTION_INPUT_BYTES} bytes`);
    }
    if (this.inflight.has(input.jobId)) return { executionArn, alreadyStarted: true };
    const current = await this.options.store.get(input.jobId);
    if (current && current.status !== 'PENDING') return { executionArn, alreadyStarted: true };

    const run = this.execute(input, executionArn).finally(() => this.inflight.delete(input.jobId));
    this.inflight.set(input.jobId, run);
    return { executionArn, alreadyStarted: false };
  }

  /**
   * The simulator's answer to DescribeExecution, for the local reconciler: RUNNING while the
   * execution is in flight in THIS process, the outcome of a remembered finished execution,
   * NOT_FOUND otherwise (never started here, lost with a previous process, or forgotten).
   */
  describe(jobId: string): SimulatedExecutionStatus {
    if (this.inflight.has(jobId)) return 'RUNNING';
    return this.outcomes.get(jobId) ?? 'NOT_FOUND';
  }

  /** Waits for in-flight executions, at most `timeoutMs`. */
  async drain(timeoutMs: number): Promise<void> {
    if (this.inflight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.inflight.values()]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** Resolves when the given job's simulated execution has finished. */
  async waitFor(jobId: string): Promise<void> {
    await this.inflight.get(jobId);
  }

  private remember(jobId: string, outcome: 'SUCCEEDED' | 'FAILED'): void {
    this.outcomes.delete(jobId);
    this.outcomes.set(jobId, outcome);
    while (this.outcomes.size > this.outcomeMemory) {
      const oldest = this.outcomes.keys().next().value;
      if (oldest === undefined) break;
      this.outcomes.delete(oldest);
    }
  }

  private async execute(input: ProcessingExecutionInput, executionArn: string): Promise<void> {
    const log = this.logger.child({ jobId: input.jobId, executionArn });
    const stepDeps = {
      store: this.options.store,
      documents: this.options.documents,
      logger: log,
      now: this.now,
    };
    // The ASL task event: exactly the execution input plus the execution ARN.
    const event = { ...input, executionArn };
    const validate = this.options.steps?.validate ?? validateStep;
    const processFn = this.options.steps?.process ?? processStep;
    log.warn(`${LOCAL_SIMULATION_WARNING}: execution started`);
    const deadline =
      this.now().getTime() + PROCESSING_WORKFLOW.executionTimeoutSeconds * 1000 * this.timeScale;

    try {
      await this.runTask(PROCESSING_WORKFLOW.tasks.validate, log, deadline, () =>
        validate(event, stepDeps),
      );
      await this.runTask(PROCESSING_WORKFLOW.tasks.process, log, deadline, () =>
        processFn(event, stepDeps),
      );
      // RecordSuccess: completes the transition; the processor already stored the result.
      const recorded = await this.record(log, ProcessingState.RecordSuccess, () =>
        this.options.store.recordSuccess(input.jobId, this.now().toISOString()),
      );
      if (recorded.kind === 'rejected') {
        // Same as the ASL catch of ConditionalCheckFailed → JobSucceeded.
        log.warn({ reason: recorded.reason }, 'RecordSuccess not applied (already recorded?)');
      }
      log.info({ state: ProcessingState.Succeeded }, 'simulated execution succeeded');
      this.remember(input.jobId, 'SUCCEEDED');
    } catch (error) {
      const { name, message } = describeError(error);
      if (name === WorkflowError.Duplicate) {
        log.info('duplicate execution detected; treated as success');
        this.remember(input.jobId, 'SUCCEEDED');
        return;
      }
      // Catch [States.ALL] → RecordFailure
      log.info(
        { errorName: name, state: ProcessingState.RecordFailure },
        'simulated execution failed',
      );
      await this.record(log, ProcessingState.RecordFailure, () =>
        this.options.store.recordFailure(input.jobId, { name, message }, this.now().toISOString()),
      ).catch((recordError: unknown) => {
        // RecordingFailed: the job stays non-terminal until the reconciler closes it.
        log.error({ err: recordError }, 'RecordFailure could not be written; job left in-flight');
      });
      this.remember(input.jobId, 'FAILED');
    }
  }

  /** Runs one Task state with the spec's TimeoutSeconds and Retry policies. */
  private async runTask<T>(
    task: TaskSpec,
    log: Logger,
    deadline: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const retries = new Map<RetryPolicy, number>();
    for (;;) {
      try {
        return await this.withTimeout(fn(), task.timeoutSeconds * 1000 * this.timeScale);
      } catch (error) {
        const { name } = describeError(error);
        const policy = findRetryPolicy(task.retry, name);
        const used = policy ? (retries.get(policy) ?? 0) : 0;
        if (!policy || used >= policy.maxAttempts) throw error;
        retries.set(policy, used + 1);
        const delay = retryDelayMs(policy, used + 1, this.random) * this.timeScale;
        if (this.now().getTime() + delay > deadline) throw error;
        log.warn(
          { state: task.state, errorName: name, retry: used + 1, delayMs: delay },
          'retrying task',
        );
        await this.sleep(delay);
      }
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new TaskTimeoutError(`task timed out after ${ms} ms`)),
            ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** RecordSuccess/RecordFailure: a few attempts against transient store failures. */
  private async record<T>(log: Logger, state: string, write: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await write();
      } catch (error) {
        if (attempt >= 3) throw error;
        log.warn({ state, attempt, err: error }, 'state write failed; retrying');
        await this.sleep(200 * attempt * this.timeScale);
      }
    }
  }
}
