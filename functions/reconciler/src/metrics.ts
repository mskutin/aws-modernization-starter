/**
 * CloudWatch Embedded Metric Format (EMF) record of one reconciler run. Written as ONE JSON log
 * line to stdout (pino); CloudWatch Logs extracts the metrics from Lambda logs. Not validated on
 * AWS (format follows the EMF specification; asserted by unit tests).
 */
import type { Logger } from '@starter/observability';
import { RECONCILER_METRICS } from '@starter/workflow-processing';
import type { ReconcileSummary } from './reconcile.js';

const N = RECONCILER_METRICS.names;

export function emfRecord(
  summary: ReconcileSummary,
  environment: string,
  timestamp: Date,
): Record<string, unknown> {
  const values: Record<string, number> = {
    [N.staleCandidates]: summary.staleCandidates,
    [N.skippedRunning]: summary.skippedRunning,
    [N.skippedNotStale]: summary.skippedNotStale,
    [N.markedFailed]: summary.markedFailed,
    [N.completed]: summary.completed,
    [N.conflicts]: summary.conflicts,
    [N.anomalies]: summary.anomalies,
    [N.dependencyErrors]: summary.dependencyErrors,
    [N.dryRunDecisions]: summary.dryRunDecisions,
    [N.durationMs]: summary.durationMs,
  };
  return {
    _aws: {
      Timestamp: timestamp.getTime(),
      CloudWatchMetrics: [
        {
          Namespace: RECONCILER_METRICS.namespace,
          Dimensions: [[RECONCILER_METRICS.dimension]],
          Metrics: Object.keys(values).map((name) => ({
            Name: name,
            Unit: name === N.durationMs ? 'Milliseconds' : 'Count',
          })),
        },
      ],
    },
    [RECONCILER_METRICS.dimension]: environment,
    ...values,
  };
}

export function emitMetrics(
  logger: Logger,
  summary: ReconcileSummary,
  environment: string,
  timestamp: Date,
): void {
  logger.info(emfRecord(summary, environment, timestamp), 'reconciler metrics');
}
