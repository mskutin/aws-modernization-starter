import { RECONCILER_METRICS } from '@starter/workflow-processing';
import { describe, expect, it } from 'vitest';
import { emfRecord, type ReconcileSummary } from '../src/index.js';

const summary: ReconcileSummary = {
  dryRun: false,
  staleCandidates: 4,
  examined: 4,
  skippedRunning: 1,
  skippedNotStale: 0,
  markedFailed: 2,
  completed: 1,
  conflicts: 0,
  anomalies: 1,
  dependencyErrors: 0,
  dryRunDecisions: 0,
  aborted: false,
  outOfTime: false,
  durationMs: 123,
};

describe('Embedded Metric Format record', () => {
  const record = emfRecord(summary, 'dev', new Date('2026-10-14T01:00:00.000Z'));
  const meta = (record._aws as { Timestamp: number; CloudWatchMetrics: Record<string, unknown>[] })
    .CloudWatchMetrics[0] as {
    Namespace: string;
    Dimensions: string[][];
    Metrics: { Name: string; Unit: string }[];
  };

  it('declares the namespace, the Environment dimension and a millisecond timestamp', () => {
    expect((record._aws as { Timestamp: number }).Timestamp).toBe(
      Date.parse('2026-10-14T01:00:00.000Z'),
    );
    expect(meta.Namespace).toBe(RECONCILER_METRICS.namespace);
    expect(meta.Dimensions).toEqual([['Environment']]);
    expect(record.Environment).toBe('dev');
  });

  it('emits every spec metric as a top-level number with a unit', () => {
    const names = Object.values(RECONCILER_METRICS.names);
    expect(meta.Metrics.map((m) => m.Name).sort()).toEqual([...names].sort());
    for (const { Name, Unit } of meta.Metrics) {
      expect(typeof record[Name]).toBe('number');
      expect(Unit).toBe(Name === 'DurationMs' ? 'Milliseconds' : 'Count');
    }
    expect(record).toMatchObject({
      MarkedFailed: 2,
      Completed: 1,
      DependencyErrors: 0,
      DurationMs: 123,
    });
  });
});
