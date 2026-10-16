/**
 * Issuer key handling, against an API with its own TEST-ONLY issuer (self mode).
 *  - A JWKS outage answers 503 + Retry-After for tokens whose key the API does not have, while
 *    tokens signed with an already-cached key keep working.
 *  - After the outage, a newly published key is accepted; a key removed from the JWKS is not.
 * Header-supplied keys (jku/x5u/jwk/x5c) and unknown `crit` are covered for every target in
 * authentication.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { context } from '../context.js';
import { call, describeRes, pollUntil } from '../http.js';
import { expectProblem, precondition, ProblemType } from '../support.js';
import { mintToken, postControl, principal } from '../tokens.js';

const ctx = context();
const jwks = ctx.jwks;

describe('JWKS rotation and IdP outage (self-started API with its own issuer)', () => {
  it(`cached keys keep working during an outage; unknown keys get 503 + Retry-After; recovery picks up the new key${jwks ? '' : ' [skipped: self-started harness only]'}`, async (t) => {
    precondition(t, ctx, jwks !== undefined, 'needs the self-started harness (SECTEST_MODE=self)');
    const sub = principal(ctx.runId, 'jwks', 'alice');
    const get = (token: string) => call(jwks.target, 'GET', '/v1/jobs', { token });

    // 1. Warm: a token signed with the current key; the API caches the JWKS.
    const oldToken = await mintToken(jwks.tokenEndpoint, { sub });
    expect((await get(oldToken)).status).toBe(200);

    // 2. Rotate: the old key leaves the published JWKS; then the IdP becomes unreachable.
    await postControl(jwks.rotateEndpoint, { retainPrevious: false });
    const newToken = await mintToken(jwks.tokenEndpoint, { sub });
    await postControl(jwks.outageEndpoint, { mode: 'error' });
    try {
      // 3. The cached key still verifies (stale-while-error)...
      const cached = await get(oldToken);
      expect(cached.status, describeRes(cached)).toBe(200);
      // ...while the new key cannot be fetched: 503 + Retry-After once the global refetch
      // cooldown allows an attempt (401 while cooling down is the documented behaviour).
      const seen = new Set<number>();
      const unavailable = await pollUntil(
        'a 503 for a token whose key cannot be fetched',
        async () => {
          const r = await get(newToken);
          seen.add(r.status);
          return r.status === 401 ? undefined : r;
        },
        60_000,
        1_000,
      );
      expect(
        [...seen].filter((s) => s !== 401 && s !== 503),
        describeRes(unavailable),
      ).toEqual([]);
      expectProblem(unavailable, 503, ProblemType.ServiceUnavailable);
      expect(Number(unavailable.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    } finally {
      await postControl(jwks.outageEndpoint, { mode: 'none' });
    }

    // 4. Recovery: the new key is fetched and accepted (after the cooldown)...
    await pollUntil(
      'the new key to be accepted after the outage',
      async () => ((await get(newToken)).status === 200 ? true : undefined),
      60_000,
      1_000,
    );
    // ...and the rotated-out key is no longer accepted once the set was refreshed.
    const stale = await get(oldToken);
    expect(stale.status, describeRes(stale)).toBe(401);
  });
});
