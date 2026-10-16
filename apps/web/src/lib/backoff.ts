/** Polling cadence for job status: start fast, back off while nothing changes. */
export const POLL_INITIAL_DELAY_MS = 1_000;
export const POLL_BACKOFF_FACTOR = 1.5;
export const POLL_MAX_DELAY_MS = 10_000;

/** Next delay after an unchanged status or an error: ×1.5, capped at 10 s. */
export function nextPollDelay(previousMs: number): number {
  const next = Math.round(previousMs * POLL_BACKOFF_FACTOR);
  return Math.min(Math.max(next, POLL_INITIAL_DELAY_MS), POLL_MAX_DELAY_MS);
}
