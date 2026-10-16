/**
 * Rate limits.
 *  - Per principal (reads and writes): request N+1 of a window gets 429 with Retry-After and
 *    RateLimit-* headers; another principal is unaffected.
 *  - Failed authentications per client address: exhausting the budget gets 429, and rotating
 *    X-Forwarded-For (directly and through the proxies) does NOT open a new budget; valid tokens
 *    from the same address are never throttled by it (shared organization egress IPs).
 * Limits are read from the RateLimit-* headers, so the same tests run against any configuration;
 * a limit above SECTEST_MAX_EXHAUST (default 300) is not exhausted (skipped with the reason).
 */
import { randomUUID } from 'node:crypto';
import { RATE_LIMIT_HEADERS } from '@starter/contracts';
import { describe, expect, it } from 'vitest';
import { context, type Target } from '../context.js';
import { call, describeRes, pollUntil, type Res } from '../http.js';
import { documentBody, expectProblem, precondition, ProblemType, submit } from '../support.js';
import { mintToken, principal } from '../tokens.js';

const ctx = context();
const SUITE = 'rl';
const MAX_EXHAUST = Number(process.env['SECTEST_MAX_EXHAUST'] ?? 300);
/** Counting must finish inside one fixed window: start with at least this much of it left. */
// Windows are clock-aligned; a sequential burst of 121 reads through CloudFront took 28 s on AWS
// (live validation), so the count must start with most of the window left.
const HEADROOM_SECONDS = 45;
const targets: Target[] = ctx.rateLimit?.targets ?? ctx.targets;

const header = (r: Res, name: string): number => Number(r.headers.get(name) ?? Number.NaN);
const limitOf = (r: Res) => header(r, RATE_LIMIT_HEADERS.limit);
const remainingOf = (r: Res) => header(r, RATE_LIMIT_HEADERS.remaining);
const resetOf = (r: Res) => header(r, RATE_LIMIT_HEADERS.reset);

/** The first response of a window with enough time left (polls across a window boundary). */
const startOfCount = (probe: () => Promise<Res>): Promise<Res> =>
  pollUntil(
    `a rate-limit window with >= ${HEADROOM_SECONDS}s left`,
    async () => {
      const r = await probe();
      return resetOf(r) >= HEADROOM_SECONDS ? r : undefined;
    },
    (HEADROOM_SECONDS + 15) * 1000,
    1_000,
  );

/**
 * Sends exactly `count` requests in small concurrent batches and checks each response. Windows are
 * clock-aligned: a sequential burst through CloudFront took 28 s (121 reads) and 49 s (251 failed
 * authentications) on AWS (live validation), long enough to straddle a window boundary.
 */
async function burst(
  count: number,
  send: () => Promise<Res>,
  check: (r: Res) => void,
): Promise<void> {
  const BATCH = 10;
  for (let done = 0; done < count; done += BATCH) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(BATCH, count - done) }, () => send()),
    );
    batch.forEach(check);
  }
}

function expectTooMany(r: Res): void {
  expectProblem(r, 429, ProblemType.TooManyRequests);
  const retryAfter = Number(r.headers.get('retry-after'));
  expect(
    Number.isInteger(retryAfter) && retryAfter >= 1,
    `Retry-After ${r.headers.get('retry-after')}`,
  ).toBe(true);
  expect(remainingOf(r)).toBe(0);
  expect(limitOf(r)).toBeGreaterThan(0);
}

describe.each(targets)('rate limits — $name: $description', (target) => {
  const fresh = (name: string) =>
    mintToken(ctx.tokenEndpoint, {
      sub: principal(ctx.runId, SUITE, `${name}-${target.name}-${randomUUID().slice(0, 8)}`),
    });

  it('per-principal read limit: request N+1 → 429 + Retry-After; another principal unaffected', async (t) => {
    const token = await fresh('reader');
    const read = () => call(target, 'GET', '/v1/jobs?limit=1', { token });
    const first = await startOfCount(read);
    expect(first.status, describeRes(first)).toBe(200);
    precondition(
      t,
      ctx,
      limitOf(first) <= MAX_EXHAUST,
      `read limit ${limitOf(first)} > ${MAX_EXHAUST}`,
    );
    await burst(remainingOf(first), read, (r) => expect(r.status, describeRes(r)).toBe(200));
    expectTooMany(await read());
    const other = await call(target, 'GET', '/v1/jobs?limit=1', {
      token: await fresh('other-reader'),
    });
    expect(other.status, describeRes(other)).toBe(200);
  });

  it('per-principal write limit: request N+1 → 429; another principal can still write', async (t) => {
    const token = await fresh('writer');
    const write = () => submit(target, token, documentBody(`rl ${ctx.runId}`, randomUUID()));
    const first = await startOfCount(write);
    expect([200, 202], describeRes(first)).toContain(first.status);
    precondition(
      t,
      ctx,
      limitOf(first) <= MAX_EXHAUST,
      `write limit ${limitOf(first)} > ${MAX_EXHAUST}`,
    );
    await burst(remainingOf(first), write, (r) =>
      expect([200, 202], describeRes(r)).toContain(r.status),
    );
    expectTooMany(await write());
    const other = await submit(
      target,
      await fresh('other-writer'),
      documentBody(`rl ${ctx.runId}`, randomUUID()),
    );
    expect([200, 202], describeRes(other)).toContain(other.status);
  });

  it('failed authentications: per-address budget, X-Forwarded-For rotation does not bypass it', async (t) => {
    const forged = await mintToken(ctx.tokenEndpoint, {
      sub: principal(ctx.runId, SUITE, 'forger'),
      options: { foreignKey: true },
    });
    let n = 0;
    const attempt = () =>
      call(target, 'GET', '/v1/jobs', {
        token: forged,
        // A new spoofed client address on every request (TEST-NET-3).
        headers: { 'x-forwarded-for': `203.0.113.${(n++ % 250) + 1}` },
      });
    const first = await startOfCount(attempt);
    expect([401, 429], describeRes(first)).toContain(first.status);
    precondition(
      t,
      ctx,
      limitOf(first) <= MAX_EXHAUST,
      `failed-auth limit ${limitOf(first)} > ${MAX_EXHAUST}`,
    );
    expect(first.status, describeRes(first)).toBe(401);
    await burst(remainingOf(first), attempt, (r) =>
      expect(
        r.status,
        `spoofed X-Forwarded-For must not open a new budget: ${describeRes(r)}`,
      ).toBe(401),
    );
    expectTooMany(await attempt());
    // Valid tokens from the same address are not throttled by other callers' failures.
    const valid = await call(target, 'GET', '/v1/jobs', { token: await fresh('innocent') });
    expect(valid.status, describeRes(valid)).toBe(200);
  });
});
