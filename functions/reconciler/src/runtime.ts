/**
 * Lambda wiring kept separate from the entry module so it can be unit tested with injected
 * dependencies. The scheduled event's content is ignored (nothing in it is trusted).
 */
import type { ReconcilerSettings } from '@starter/config';
import { lambdaCorrelation, type LambdaContextLike } from '@starter/observability';
import { emitMetrics } from './metrics.js';
import { reconcileStaleJobs, type ReconcileSummary, type ReconcilerDeps } from './reconcile.js';

export interface ReconcilerHandlerDeps extends ReconcilerDeps {
  settings: ReconcilerSettings;
  /** `Environment` metric dimension (APP_ENVIRONMENT). */
  environment: string;
}

export interface ReconcilerContext extends LambdaContextLike {
  getRemainingTimeInMillis?: () => number;
}

/** Time kept back from the Lambda timeout for the summary, metrics and the final flush. */
export const SAFETY_MARGIN_MS = 5_000;

export type ReconcilerHandler = (
  event: unknown,
  context: ReconcilerContext,
) => Promise<ReconcileSummary>;

export function createHandler(getDeps: () => ReconcilerHandlerDeps): ReconcilerHandler {
  return async (_event, context) => {
    const deps = getDeps();
    const logger = deps.logger.child(lambdaCorrelation(context));
    const remaining = context.getRemainingTimeInMillis?.() ?? Number.POSITIVE_INFINITY;
    const maxRuntimeMs = Math.max(
      1_000,
      Math.min(deps.settings.maxRuntimeSeconds * 1_000, remaining - SAFETY_MARGIN_MS),
    );
    const summary = await reconcileStaleJobs(
      { ...deps, logger },
      {
        staleAfterSeconds: deps.settings.staleAfterSeconds,
        batchSize: deps.settings.batchSize,
        dryRun: deps.settings.dryRun,
        maxRuntimeMs,
      },
    );
    emitMetrics(logger, summary, deps.environment, (deps.now ?? (() => new Date()))());
    return summary;
  };
}
