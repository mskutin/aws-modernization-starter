/**
 * Polls GET /v1/jobs/{id} until the job reaches a terminal status.
 *
 * - First request immediately; then every 1 s, backing off ×1.5 (max 10 s)
 *   while the status is unchanged or requests fail transiently.
 * - Stops for good on SUCCEEDED/FAILED or on a permanent error (404, 400,
 *   contract mismatch).
 * - Unmount (or a new jobId) cancels the timer and aborts the in-flight request.
 */
import { isTerminalJobStatus, type Job, type JobStatus } from '@starter/contracts';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import { isAbortError, toApiError, type ApiError } from '../api/errors';
import { POLL_INITIAL_DELAY_MS, nextPollDelay } from '../lib/backoff';

export interface JobPollingState {
  job: Job | null;
  /** Most recent error; cleared by the next successful response. */
  error: ApiError | null;
  /** True while more polls will follow. */
  polling: boolean;
}

export function useJobPolling(client: ApiClient, jobId: string): JobPollingState {
  const [state, setState] = useState<JobPollingState>({ job: null, error: null, polling: true });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let delay = POLL_INITIAL_DELAY_MS;
    let lastStatus: JobStatus | null = null;

    async function poll(): Promise<void> {
      controller = new AbortController();
      try {
        const job = await client.getJob(jobId, controller.signal);
        if (cancelled) return;
        const terminal = isTerminalJobStatus(job.status);
        setState({ job, error: null, polling: !terminal });
        if (terminal) return;
        delay = job.status === lastStatus ? nextPollDelay(delay) : POLL_INITIAL_DELAY_MS;
        lastStatus = job.status;
      } catch (caught) {
        if (cancelled || isAbortError(caught)) return;
        const error = toApiError(caught);
        if (!error.isTransient) {
          setState((previous) => ({ ...previous, error, polling: false }));
          return;
        }
        setState((previous) => ({ ...previous, error }));
        delay = nextPollDelay(delay);
      }
      timer = setTimeout(() => void poll(), delay);
    }

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [client, jobId]);

  return state;
}
