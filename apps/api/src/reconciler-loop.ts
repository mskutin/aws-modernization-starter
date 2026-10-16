/**
 * LOCAL SIMULATION ONLY: the stale-job reconciler running inside the API process.
 *
 * Enabled only with `WORKFLOW_MODE=local`, `RECONCILER_LOCAL_INTERVAL_SECONDS` > 0 and
 * `APP_RUNTIME` local/ci (`loadLocalReconcilerConfig` rejects anything else). The authoritative
 * execution state is the in-process simulator, which knows only THIS process's executions, so the
 * loop is correct for a single API process only. On AWS the one scheduled reconciler
 * Lambda is the only reconciler and the API task has no reconciler permissions.
 */
import type { LocalReconcilerConfig } from '@starter/config';
import {
  emitMetrics,
  reconcileStaleJobs,
  type ExecutionStateSource,
  type ReconcileSummary,
  type ReconcilerStore,
} from '@starter/fn-reconciler';
import type { Logger } from '@starter/observability';
import type { LocalWorkflowSimulator } from './workflow/local-simulator.js';

/** The simulator as the reconciler's execution-state source (this process's executions). */
export function simulatorExecutions(
  simulator: Pick<LocalWorkflowSimulator, 'describe'>,
): ExecutionStateSource {
  return { describe: async ({ jobId }) => ({ status: simulator.describe(jobId) }) };
}

export interface LocalReconcilerLoopOptions {
  store: ReconcilerStore;
  simulator: Pick<LocalWorkflowSimulator, 'describe'>;
  logger: Logger;
  config: LocalReconcilerConfig;
  /** `Environment` dimension of the (local) metric records. */
  environment: string;
  now?: () => Date;
}

export class LocalReconcilerLoop {
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<unknown> | undefined;
  private stopped = false;
  private readonly logger: Logger;

  constructor(private readonly options: LocalReconcilerLoopOptions) {
    this.logger = options.logger.child({ simulation: true, component: 'reconciler-loop' });
  }

  /** One bounded pass (the loop's unit of work; also used by tests). */
  async runOnce(): Promise<ReconcileSummary> {
    const { config } = this.options;
    const now = this.options.now ?? (() => new Date());
    const summary = await reconcileStaleJobs(
      {
        store: this.options.store,
        executions: simulatorExecutions(this.options.simulator),
        logger: this.logger,
        now,
      },
      {
        staleAfterSeconds: config.staleAfterSeconds,
        batchSize: config.batchSize,
        dryRun: config.dryRun,
        maxRuntimeMs: config.maxRuntimeSeconds * 1_000,
      },
    );
    emitMetrics(this.logger, summary, this.options.environment, now());
    return summary;
  }

  /** Starts the interval (no overlap: the next pass is scheduled after the previous one ends). */
  start(): void {
    if (this.options.config.intervalSeconds === 0 || this.timer || this.stopped) return;
    this.logger.warn(
      { intervalSeconds: this.options.config.intervalSeconds },
      'LOCAL SIMULATION: in-process stale-job reconciler started (single API process only)',
    );
    this.schedule();
  }

  /** Stops scheduling and waits for a pass in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.current;
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.current = this.runOnce()
        .catch((error: unknown) => {
          this.logger.error({ err: error }, 'local reconciler pass failed');
        })
        .finally(() => {
          this.current = undefined;
          if (!this.stopped) this.schedule();
        });
    }, this.options.config.intervalSeconds * 1_000);
    this.timer.unref();
  }
}
