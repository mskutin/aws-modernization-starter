import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_KEY_PATTERN } from '@starter/contracts';
import { POLL_INITIAL_DELAY_MS, POLL_MAX_DELAY_MS, nextPollDelay } from '../src/lib/backoff';
import { elapsedSeconds, formatDuration, formatPercent, formatTurnaround } from '../src/lib/format';
import { newIdempotencyKey } from '../src/lib/idempotency';
import { HOME_HREF, jobHref, parseRoute, routeKey } from '../src/routing';
import { JOB_ID } from './helpers';

describe('nextPollDelay', () => {
  it('grows by 1.5× and is capped at 10 s', () => {
    const delays = [POLL_INITIAL_DELAY_MS];
    for (let i = 0; i < 8; i += 1) delays.push(nextPollDelay(delays.at(-1)!));
    expect(delays).toEqual([1000, 1500, 2250, 3375, 5063, 7595, 10000, 10000, 10000]);
    expect(Math.max(...delays)).toBe(POLL_MAX_DELAY_MS);
  });

  it('never goes below the initial delay', () => {
    expect(nextPollDelay(0)).toBe(POLL_INITIAL_DELAY_MS);
  });
});

describe('routing', () => {
  it.each([
    ['', { name: 'home' }],
    ['#', { name: 'home' }],
    ['#/', { name: 'home' }],
    [`#/jobs/${JOB_ID}`, { name: 'job', jobId: JOB_ID }],
    [`#/jobs/${JOB_ID}/`, { name: 'job', jobId: JOB_ID }],
    ['#/jobs/not-a-uuid', { name: 'not-found', path: '/jobs/not-a-uuid' }],
    ['#/jobs/%E0%A4%A', { name: 'not-found', path: '/jobs/%E0%A4%A' }],
    ['#/settings', { name: 'not-found', path: '/settings' }],
  ])('parses %j', (hash, expected) => {
    expect(parseRoute(hash)).toEqual(expected);
  });

  it('builds hrefs that round-trip', () => {
    expect(HOME_HREF).toBe('#/');
    expect(parseRoute(jobHref(JOB_ID))).toEqual({ name: 'job', jobId: JOB_ID });
    expect(routeKey(parseRoute(jobHref(JOB_ID)))).toBe(`job:${JOB_ID}`);
  });
});

describe('formatting', () => {
  it.each([
    [0, '0 s'],
    [9, '9 s'],
    [60, '1 min'],
    [90, '1 min 30 s'],
    [3601, '60 min 1 s'],
  ])('formats %d seconds as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it('formats ratios as percentages', () => {
    expect(formatPercent(0.8667)).toBe('86.7%');
  });

  it('computes elapsed seconds between ISO timestamps', () => {
    expect(elapsedSeconds('2026-10-13T10:00:00.000Z', '2026-10-13T10:00:05.250Z')).toBe(5.25);
    expect(elapsedSeconds('2026-10-13T10:00:00.000Z', '2026-10-13T10:00:00.000Z')).toBe(0);
  });

  it('rejects invalid or negative intervals instead of rendering nonsense', () => {
    expect(elapsedSeconds('not-a-date', '2026-10-13T10:00:05.000Z')).toBeNull();
    expect(elapsedSeconds('2026-10-13T10:00:05.000Z', '2026-10-13T10:00:00.000Z')).toBeNull();
  });

  it.each([
    [0, 'under 1 s'],
    [0.4, 'under 1 s'],
    [5, '5 s'],
    [90, '1 min 30 s'],
  ])('formats a turnaround of %d seconds as %s', (seconds, expected) => {
    expect(formatTurnaround(seconds)).toBe(expected);
  });
});

describe('newIdempotencyKey', () => {
  it('produces keys accepted by the API contract', () => {
    const key = newIdempotencyKey();
    expect(key).toMatch(IDEMPOTENCY_KEY_PATTERN);
    expect(newIdempotencyKey()).not.toBe(key);
  });

  it('falls back to getRandomValues without randomUUID (insecure contexts)', () => {
    const key = newIdempotencyKey({
      getRandomValues: <T extends ArrayBufferView | null>(array: T) => {
        if (array instanceof Uint8Array) array.fill(0xff);
        return array;
      },
    });
    expect(key).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(key).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });
});
