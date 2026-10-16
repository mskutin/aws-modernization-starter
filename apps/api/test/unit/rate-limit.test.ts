/**
 * FixedWindowRateLimiter (bounded memory, aligned windows) and client-address keys.
 */
import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter, clientAddressKey } from '../../src/auth/rate-limit.js';

describe('FixedWindowRateLimiter', () => {
  it('allows max requests per key and window, then denies until the window resets', () => {
    let now = 120_500; // 0.5 s into the window [120 s, 180 s)
    const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, max: 2, now: () => now });
    expect(limiter.consume('a')).toEqual({
      allowed: true,
      limit: 2,
      remaining: 1,
      resetSeconds: 60,
    });
    expect(limiter.consume('a')).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume('a')).toMatchObject({ allowed: false, remaining: 0, resetSeconds: 60 });
    expect(limiter.consume('b').allowed).toBe(true);
    now = 179_100;
    expect(limiter.consume('a')).toMatchObject({ allowed: false, resetSeconds: 1 });
    now = 180_000;
    expect(limiter.consume('a')).toMatchObject({ allowed: true, remaining: 1, resetSeconds: 60 });
  });

  it('forgets every key when the window ends (memory bounded by one window)', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({ windowMs: 1_000, max: 5, now: () => now });
    for (let i = 0; i < 1_000; i += 1) limiter.consume(`key-${i}`);
    expect(limiter.size).toBe(1_000);
    now = 1_000;
    limiter.consume('fresh');
    expect(limiter.size).toBe(1);
  });

  it('never tracks more than maxKeys keys; the rest share one overflow bucket', () => {
    const limiter = new FixedWindowRateLimiter({
      windowMs: 60_000,
      max: 3,
      maxKeys: 10,
      now: () => 0,
    });
    for (let i = 0; i < 10; i += 1) expect(limiter.consume(`ip-${i}`).allowed).toBe(true);
    expect(limiter.takeOverflowNotice()).toBe(false);
    const spill = Array.from({ length: 100_000 }, (_, i) => limiter.consume(`spoofed-${i}`));
    expect(limiter.size).toBe(11);
    expect(spill.slice(0, 3).every((d) => d.allowed)).toBe(true);
    expect(spill.slice(3).every((d) => !d.allowed)).toBe(true);
    // Keys tracked before the overflow keep their own budget.
    expect(limiter.consume('ip-0').allowed).toBe(true);
    expect(limiter.takeOverflowNotice()).toBe(true);
    expect(limiter.takeOverflowNotice()).toBe(false); // logged once per window
  });

  it('rejects nonsensical settings', () => {
    expect(() => new FixedWindowRateLimiter({ windowMs: 0, max: 1 })).toThrow(RangeError);
    expect(() => new FixedWindowRateLimiter({ windowMs: 1_000, max: 0 })).toThrow(RangeError);
  });
});

describe('clientAddressKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:0db8:0001:0002::/64'],
    ['2001:db8:1:2::9', '2001:0db8:0001:0002::/64'],
    ['2001:DB8:1:2:ffff:ffff:ffff:ffff', '2001:0db8:0001:0002::/64'],
    ['::1', '0000:0000:0000:0000::/64'],
    ['fe80::1%eth0', 'fe80:0000:0000:0000::/64'],
    ['64:ff9b::192.0.2.33', '0064:ff9b:0000:0000::/64'],
    ['not-an-ip', 'unknown'],
    [undefined, 'unknown'],
  ])('%s → %s', (ip, key) => {
    expect(clientAddressKey(ip)).toBe(key);
  });

  it('puts every address of one IPv6 /64 into the same bucket', () => {
    const keys = new Set(
      Array.from({ length: 50 }, (_, i) => clientAddressKey(`2001:db8:aa:bb:${i.toString(16)}::1`)),
    );
    expect(keys.size).toBe(1);
  });
});
