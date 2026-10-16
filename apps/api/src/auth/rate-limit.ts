/**
 * In-process fixed-window rate limiting (ADR 0212).
 *
 * Windows are aligned to the wall clock (`floor(now / window)`), so the whole table is dropped
 * when a window ends and memory is bounded by the keys seen in ONE window. At most `maxKeys`
 * distinct keys are tracked per window; further keys share a single overflow bucket (fails
 * towards throttling, never towards unbounded memory). Limits are PER API TASK: N tasks allow
 * up to N x the configured rate; the WAF rate-based rule at CloudFront remains the edge control.
 */
import { isIPv4, isIPv6 } from 'node:net';

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets (>= 1): RateLimit-Reset and Retry-After. */
  resetSeconds: number;
}

export interface FixedWindowOptions {
  windowMs: number;
  max: number;
  /** Distinct keys tracked per window before the shared overflow bucket is used. */
  maxKeys?: number;
  now?: () => number;
}

export const DEFAULT_MAX_TRACKED_KEYS = 50_000;
const OVERFLOW_KEY = '\u0000overflow';

export class FixedWindowRateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private window = Number.NaN;
  private readonly counts = new Map<string, number>();
  private overflowed = false;
  private overflowReported = false;

  constructor(options: FixedWindowOptions) {
    if (!(options.windowMs > 0) || !(options.max >= 1)) {
      throw new RangeError('rate limiter needs windowMs > 0 and max >= 1');
    }
    this.windowMs = options.windowMs;
    this.max = Math.floor(options.max);
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_TRACKED_KEYS;
    this.now = options.now ?? Date.now;
  }

  /** Counts one request for `key` (rejected requests count too) and decides. */
  consume(key: string): RateLimitDecision {
    const now = this.now();
    const window = Math.floor(now / this.windowMs);
    if (window !== this.window) {
      this.window = window;
      this.counts.clear();
      this.overflowed = false;
      this.overflowReported = false;
    }
    let bucket = key;
    if (!this.counts.has(key) && this.counts.size >= this.maxKeys) {
      bucket = OVERFLOW_KEY;
      this.overflowed = true;
    }
    const count = (this.counts.get(bucket) ?? 0) + 1;
    this.counts.set(bucket, count);
    const resetAt = (window + 1) * this.windowMs;
    return {
      allowed: count <= this.max,
      limit: this.max,
      remaining: Math.max(0, this.max - count),
      resetSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }

  /** True once per window after the key table spilled into the overflow bucket (for logging). */
  takeOverflowNotice(): boolean {
    if (!this.overflowed || this.overflowReported) return false;
    this.overflowReported = true;
    return true;
  }

  /** Keys tracked in the current window (memory bound: maxKeys + 1). */
  get size(): number {
    return this.counts.size;
  }
}

/** Expands an IPv6 address into its eight 16-bit groups (no zone id). */
function ipv6Groups(address: string): string[] {
  let ip = address.split('%')[0] ?? '';
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (embedded?.[1]) {
    const octets = embedded[1].split('.').map(Number);
    const high = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16);
    const low = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16);
    ip = `${ip.slice(0, -embedded[1].length)}${high}:${low}`;
  }
  const [head = '', tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right].map((g) =>
    g.toLowerCase().padStart(4, '0'),
  );
}

/**
 * Rate-limit key of a client address: IPv4 as is (also when IPv4-mapped), IPv6 by /64 (one
 * subscriber typically owns a whole /64, so per-address keys would be trivially evaded).
 */
export function clientAddressKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (isIPv4(ip)) return ip;
  if (isIPv6(ip.split('%')[0] ?? '')) return `${ipv6Groups(ip).slice(0, 4).join(':')}::/64`;
  return 'unknown';
}
