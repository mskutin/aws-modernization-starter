/**
 * Leakage assertions over a Step Functions execution history (`GetExecutionHistory`) — the
 * 90-day store that history minimisation protects. Pure functions over the SDK's `HistoryEvent` shape, so they
 * are unit-tested with fixtures here and applied to real histories by the opt-in AWS suite.
 */
import { EXECUTION_INPUT_KEYS } from '@starter/workflow-processing';

export interface HistoryLeak {
  eventId: number | undefined;
  type: string | undefined;
  /** The synthetic canary marker found (test data, safe to print). */
  marker: string;
}

interface HistoryEventLike {
  id?: number;
  type?: string;
  executionStartedEventDetails?: { input?: string };
}

/** Every canary marker found in any event (inputs, outputs, parameters, errors, causes). */
export function findHistoryLeaks(
  events: readonly unknown[],
  markers: readonly string[],
): HistoryLeak[] {
  const leaks: HistoryLeak[] = [];
  for (const event of events) {
    const text = JSON.stringify(event);
    const { id, type } = (event ?? {}) as HistoryEventLike;
    for (const marker of markers) {
      if (text.includes(marker) || text.includes(JSON.stringify(marker).slice(1, -1))) {
        leaks.push({ eventId: id, type, marker });
      }
    }
  }
  return leaks;
}

/** Keys of the execution input as recorded in `ExecutionStarted` (undefined if absent/unparseable). */
export function executionStartedInputKeys(events: readonly unknown[]): string[] | undefined {
  for (const event of events as readonly HistoryEventLike[]) {
    if (event.type !== 'ExecutionStarted') continue;
    const input = event.executionStartedEventDetails?.input;
    if (typeof input !== 'string') return undefined;
    try {
      const parsed: unknown = JSON.parse(input);
      return parsed && typeof parsed === 'object' ? Object.keys(parsed).sort() : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** True when the recorded input is exactly the spec 2.0.0 job reference. */
export function hasMinimalExecutionInput(events: readonly unknown[]): boolean {
  const keys = executionStartedInputKeys(events);
  return keys !== undefined && keys.join(',') === [...EXECUTION_INPUT_KEYS].sort().join(',');
}
