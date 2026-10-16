/**
 * One bounded reconciliation run (ADR 0231).
 *
 *   1. Candidates: non-terminal jobs whose last transition is older than the threshold, oldest
 *      first, from the status index (`gsi1`) — eventually consistent, so ONLY a candidate list.
 *   2. Per candidate, until the batch or the time budget is used up:
 *        consistent GetItem → still non-terminal and stale? → authoritative execution state →
 *        decision (decide.ts) → write conditioned on the observed status AND version.
 *   3. Any DynamoDB / Step Functions error or throttle stops the run: no further reads, no
 *      transition for that job, a `DependencyErrors` metric and an error log. The next scheduled
 *      run retries; nothing is ever marked FAILED because a dependency is unavailable.
 *
 * Writes are idempotent and safe under concurrency: a second run (or a racing workflow) finds
 * the status/version changed and the conditional write is rejected (counted as a conflict).
 * Every transition is logged with `actor: "system:reconciler"`; jobs correlate to their owner
 * through `jobId` → `owner_id` in PostgreSQL. Logs carry no document data.
 */
import type { JobState, JobStateStore, TransitionOutcome } from '@starter/job-state';
import type { Logger } from '@starter/observability';
import { RECONCILIATION, TERMINAL_STATUSES, WorkflowStatus } from '@starter/workflow-processing';
import { decide, type Decision } from './decide.js';
import type { ExecutionLookup, ExecutionStateSource } from './executions.js';

export const RECONCILER_ACTOR = 'system:reconciler';

export type ReconcilerStore = Pick<
  JobStateStore,
  'listStale' | 'get' | 'recordFailure' | 'recordSuccess'
>;

export interface ReconcileOptions {
  staleAfterSeconds: number;
  /** Jobs examined per run, across all non-terminal statuses (1..100). */
  batchSize: number;
  dryRun: boolean;
  /** Wall-clock budget of the run; no new job is examined after it. */
  maxRuntimeMs: number;
}

export interface ReconcilerDeps {
  store: ReconcilerStore;
  executions: ExecutionStateSource;
  logger: Logger;
  now?: () => Date;
}

export interface ReconcileSummary {
  dryRun: boolean;
  staleCandidates: number;
  examined: number;
  skippedRunning: number;
  skippedNotStale: number;
  markedFailed: number;
  completed: number;
  conflicts: number;
  anomalies: number;
  dependencyErrors: number;
  dryRunDecisions: number;
  /** The run stopped early on a dependency error. */
  aborted: boolean;
  /** The time budget ran out before every candidate was examined. */
  outOfTime: boolean;
  durationMs: number;
}

class DependencyFailure extends Error {
  override readonly name = 'DependencyFailure';
  constructor(
    readonly operation: string,
    readonly causeName: string,
  ) {
    super(`${operation} failed (${causeName})`);
  }
}

async function dependency<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const name =
      error instanceof Error && /^[A-Za-z0-9_.]{1,64}$/.test(error.name) ? error.name : 'Error';
    throw new DependencyFailure(operation, name);
  }
}

export function validateOptions(options: ReconcileOptions): void {
  if (options.staleAfterSeconds < RECONCILIATION.minimumStaleAfterSeconds) {
    throw new RangeError(
      `staleAfterSeconds must be at least ${RECONCILIATION.minimumStaleAfterSeconds} (execution timeout + grace)`,
    );
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 100) {
    throw new RangeError('batchSize must be an integer between 1 and 100');
  }
}

export async function reconcileStaleJobs(
  deps: ReconcilerDeps,
  options: ReconcileOptions,
): Promise<ReconcileSummary> {
  validateOptions(options);
  const now = deps.now ?? (() => new Date());
  const started = now().getTime();
  const deadline = started + options.maxRuntimeMs;
  const cutoff = new Date(started - options.staleAfterSeconds * 1000).toISOString();
  const log = deps.logger.child({ actor: RECONCILER_ACTOR, dryRun: options.dryRun });
  const summary: ReconcileSummary = {
    dryRun: options.dryRun,
    staleCandidates: 0,
    examined: 0,
    skippedRunning: 0,
    skippedNotStale: 0,
    markedFailed: 0,
    completed: 0,
    conflicts: 0,
    anomalies: 0,
    dependencyErrors: 0,
    dryRunDecisions: 0,
    aborted: false,
    outOfTime: false,
    durationMs: 0,
  };

  try {
    // 1. Candidates (bounded by the batch size across statuses, oldest first per status).
    const candidates: string[] = [];
    for (const status of RECONCILIATION.statuses) {
      const remaining = options.batchSize - candidates.length;
      if (remaining <= 0) break;
      const page = await dependency('listStale', () =>
        deps.store.listStale(status, cutoff, remaining),
      );
      candidates.push(...page.map((c) => c.jobId));
    }
    summary.staleCandidates = candidates.length;

    // 2. Each candidate: consistent read → authoritative state → conditional write.
    for (const jobId of candidates) {
      if (now().getTime() >= deadline) {
        summary.outOfTime = true;
        break;
      }
      summary.examined += 1;
      const state = await dependency('getItem', () => deps.store.get(jobId));
      if (!state || TERMINAL_STATUSES.has(state.status) || state.updatedAt >= cutoff) {
        summary.skippedNotStale += 1;
        continue;
      }
      const lookup = await dependency('describeExecution', () =>
        deps.executions.describe({ jobId, executionArn: state.executionArn }),
      );
      const decision = decide(state, lookup);
      await apply(deps, log, options, summary, state, lookup, decision, now);
    }
  } catch (error) {
    if (!(error instanceof DependencyFailure)) throw error;
    summary.dependencyErrors += 1;
    summary.aborted = true;
    log.error(
      { operation: error.operation, errorName: error.causeName },
      'reconciler dependency failure; run stopped without a transition',
    );
  }

  summary.durationMs = now().getTime() - started;
  log.info({ summary }, 'reconciler run finished');
  return summary;
}

async function apply(
  deps: ReconcilerDeps,
  log: Logger,
  options: ReconcileOptions,
  summary: ReconcileSummary,
  state: JobState,
  lookup: ExecutionLookup,
  decision: Decision,
  now: () => Date,
): Promise<void> {
  const context = {
    jobId: state.jobId,
    observedStatus: state.status,
    observedVersion: state.version,
    executionStatus: lookup.status,
    ...(lookup.error ? { executionError: lookup.error } : {}),
    ...(lookup.foreignArn ? { foreignExecutionArn: true } : {}),
    action: decision.action,
    reason: decision.reason,
  };
  if (decision.action === 'none') {
    summary.skippedRunning += 1;
    log.debug(context, 'reconciler: execution still running; job left alone');
    return;
  }
  if (decision.anomaly) summary.anomalies += 1;
  const errorName = decision.action === 'fail' ? decision.errorName : undefined;
  if (options.dryRun) {
    summary.dryRunDecisions += 1;
    log.warn({ ...context, errorName, outcome: 'dry-run' }, 'reconciler decision (dry run)');
    return;
  }
  const conditions = { expectedStatus: state.status, expectedVersion: state.version };
  const at = now().toISOString();
  const outcome: TransitionOutcome =
    decision.action === 'fail'
      ? await dependency('updateItem', () =>
          deps.store.recordFailure(
            state.jobId,
            { name: decision.errorName, message: decision.message },
            at,
            conditions,
          ),
        )
      : await dependency('updateItem', () =>
          deps.store.recordSuccess(state.jobId, at, {
            ...conditions,
            expectedStatus: WorkflowStatus.Processing,
          }),
        );
  if (outcome.kind === 'applied') {
    if (decision.action === 'fail') summary.markedFailed += 1;
    else summary.completed += 1;
    log.warn(
      { ...context, errorName, outcome: 'applied', newStatus: outcome.state.status },
      'reconciler transition',
    );
  } else {
    summary.conflicts += 1;
    log.info(
      { ...context, errorName, outcome: outcome.kind },
      'reconciler write not applied (job changed concurrently)',
    );
  }
}
