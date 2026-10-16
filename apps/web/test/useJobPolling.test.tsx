import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useJobPolling } from '../src/hooks/useJobPolling';
import {
  JOB_ID,
  aJob,
  aResult,
  clientWith,
  hangingFetch,
  jsonResponse,
  problemResponse,
  sequenceFetch,
  type FetchMock,
} from './helpers';
import type { Job } from '@starter/contracts';

/** Advances fake time and lets resolved fetches/state updates settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function pollWith(fetchMock: FetchMock) {
  const client = clientWith(fetchMock);
  return renderHook(() => useJobPolling(client, JOB_ID));
}

const reply = (job: Job) => () => jsonResponse(job);

describe('useJobPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls until the job is terminal, then stops', async () => {
    const fetchMock = sequenceFetch(
      reply(aJob({ status: 'PENDING' })),
      reply(aJob({ status: 'PROCESSING' })),
      reply(aJob({ status: 'SUCCEEDED', result: aResult() })),
    );
    const { result } = pollWith(fetchMock);

    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({
      job: { status: 'PENDING' },
      polling: true,
      error: null,
    });

    await advance(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.job?.status).toBe('PROCESSING');

    // Status changed, so the delay resets to 1 s.
    await advance(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current).toMatchObject({ job: { status: 'SUCCEEDED' }, polling: false });

    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('backs off ×1.5 while the status does not change', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(aJob({ status: 'VALIDATING' })));
    pollWith(fetchMock);

    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2); // t = 1000
    await advance(1_499);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(3); // t = 2500
    await advance(2_249);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(4); // t = 4750
  });

  it('backs off on transient errors, keeps polling and recovers', async () => {
    const fetchMock = sequenceFetch(
      new TypeError('Failed to fetch'),
      problemResponse({
        status: 503,
        title: 'Service Unavailable',
        detail: 'Database unavailable',
      }),
      reply(aJob({ status: 'SUCCEEDED', result: aResult() })),
    );
    const { result } = pollWith(fetchMock);

    await advance(0);
    expect(result.current).toMatchObject({ job: null, polling: true, error: { kind: 'network' } });

    await advance(1_499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.error).toMatchObject({ kind: 'problem', status: 503 });

    await advance(2_250);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current).toMatchObject({
      job: { status: 'SUCCEEDED' },
      error: null,
      polling: false,
    });
  });

  it('stops on a permanent error such as 404', async () => {
    const fetchMock = sequenceFetch(
      problemResponse({ status: 404, title: 'Not Found', detail: `Job ${JOB_ID} not found` }),
    );
    const { result } = pollWith(fetchMock);
    await advance(0);
    expect(result.current).toMatchObject({ job: null, polling: false, error: { status: 404 } });
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts the in-flight request on unmount', async () => {
    const fetchMock = hangingFetch();
    const { unmount } = pollWith(fetchMock);
    await advance(0);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels the scheduled poll on unmount', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(aJob({ status: 'PENDING' })));
    const { unmount } = pollWith(fetchMock);
    await advance(0);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
