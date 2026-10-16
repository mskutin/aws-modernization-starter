/**
 * Follows a CloudWatch Logs group into a local JSON-lines file while the security suite runs, so
 * its log assertions (audit trail, no token/secret/canary in the API logs) read the REAL API logs
 * (SECTEST_LOG_FILES). Read-only: polls `aws logs filter-log-events` through the AWS CLI (the
 * profile- and region-pinned command line comes from SBX_AWS), with a look-back window and
 * de-duplication by eventId because CloudWatch delivers events out of order. Each event's message
 * (the API's own JSON line) is appended unchanged, one per line.
 */
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface LogEvent {
  eventId: string;
  timestamp: number;
  message: string;
}

export function parseEvents(stdout: string): LogEvent[] {
  const json = JSON.parse(stdout) as { events?: unknown[] };
  return (json.events ?? [])
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({
      eventId: String(e.eventId ?? ''),
      timestamp: Number(e.timestamp ?? 0),
      message: String(e.message ?? ''),
    }))
    .filter((e) => e.eventId !== '');
}

export interface FollowState {
  seen: Set<string>;
  /** Largest event timestamp seen (ms). */
  high: number;
}

/** New events in timestamp order; updates the state. */
export function newEvents(state: FollowState, events: readonly LogEvent[]): LogEvent[] {
  const fresh = events
    .filter((e) => !state.seen.has(e.eventId))
    .sort((a, b) => a.timestamp - b.timestamp);
  for (const e of fresh) {
    state.seen.add(e.eventId);
    state.high = Math.max(state.high, e.timestamp);
  }
  return fresh;
}

export interface FollowOptions {
  aws: string[];
  group: string;
  out: string;
  startMs: number;
  intervalMs: number;
  lookbackMs: number;
  signal: AbortSignal;
  onError?: (message: string) => void;
}

export async function follow(opts: FollowOptions): Promise<number> {
  const state: FollowState = { seen: new Set(), high: opts.startMs };
  const [cmd, ...pre] = opts.aws;
  if (!cmd) throw new Error('empty AWS command');
  let written = 0;
  while (!opts.signal.aborted) {
    const start = Math.max(opts.startMs, state.high - opts.lookbackMs);
    try {
      const { stdout } = await run(
        cmd,
        [
          ...pre,
          'logs',
          'filter-log-events',
          '--log-group-name',
          opts.group,
          '--start-time',
          String(start),
          '--output',
          'json',
        ],
        { maxBuffer: 256 * 1024 * 1024 },
      );
      const fresh = newEvents(state, parseEvents(stdout));
      if (fresh.length > 0) {
        appendFileSync(opts.out, fresh.map((e) => `${e.message.replace(/\n+$/, '')}\n`).join(''));
        written += fresh.length;
      }
    } catch (err) {
      opts.onError?.(err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err));
    }
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        opts.signal.removeEventListener('abort', onAbort);
        resolve();
      }, opts.intervalMs);
      opts.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  return written;
}
