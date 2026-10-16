/**
 * RemoteJwksSource with an injected fetch and clock: bounded fetching under a flood of unknown
 * `kid`s, rotation, stale-while-error, max staleness, discovery checks and transport limits.
 */
import { createTestIssuer, type TestIssuer } from '@starter/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AuthUnavailableError,
  RemoteJwksSource,
  discoveryUrl,
  filterSigningKeys,
  type FetchLike,
} from '../../src/auth/key-source.js';
import { TokenVerifier } from '../../src/auth/verifier.js';

const ISSUER = 'https://idp.example.com/tenant';
const JWKS_URI = 'https://idp.example.com/tenant/keys';
const silent = { info: () => undefined, warn: () => undefined };

interface FakeIdp {
  fetch: FetchLike;
  calls: { url: string; init: RequestInit }[];
  mode: 'ok' | 'error' | 'timeout';
  /** Overrides the JSON served for a URL. */
  bodies: Map<string, unknown>;
}

function fakeIdp(issuer: TestIssuer): FakeIdp {
  const idp: FakeIdp = {
    calls: [],
    mode: 'ok',
    bodies: new Map(),
    fetch: async (url, init) => {
      idp.calls.push({ url, init });
      if (idp.mode === 'timeout') {
        throw Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
        });
      }
      if (idp.mode === 'error') return new Response('down', { status: 503 });
      const body =
        idp.bodies.get(url) ??
        (url === discoveryUrl(ISSUER)
          ? { issuer: ISSUER, jwks_uri: JWKS_URI }
          : url === JWKS_URI
            ? issuer.jwks()
            : undefined);
      if (body === undefined) return new Response('nope', { status: 404 });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  return idp;
}

let issuer: TestIssuer;
let idp: FakeIdp;
let now: number;

function source(extra: Partial<ConstructorParameters<typeof RemoteJwksSource>[0]> = {}) {
  return new RemoteJwksSource({
    issuer: ISSUER,
    allowInsecure: false,
    algorithms: ['RS256', 'ES256'],
    logger: silent,
    fetch: idp.fetch,
    now: () => now,
    ...extra,
  });
}

function verifierFor(keys: RemoteJwksSource) {
  return new TokenVerifier({
    issuer: ISSUER,
    audience: 'starter-jobs-api',
    algorithms: ['RS256', 'ES256'],
    clockToleranceSeconds: 30,
    keys,
  });
}

beforeEach(async () => {
  issuer = await createTestIssuer({ issuer: ISSUER, audience: 'starter-jobs-api' });
  idp = fakeIdp(issuer);
  now = 1_000_000;
});

describe('RemoteJwksSource', () => {
  it('discovers the JWKS URL, then caches the key set', async () => {
    const keys = source();
    const verifier = verifierFor(keys);
    expect((await verifier.verifyToken(await issuer.mint())).ok).toBe(true);
    expect((await verifier.verifyToken(await issuer.mint())).ok).toBe(true);
    expect(idp.calls.map((c) => c.url)).toEqual([discoveryUrl(ISSUER), JWKS_URI]);
    expect(keys.stats).toEqual({ attempts: 1, failures: 0 });
    // Strict transport on every request.
    for (const { init } of idp.calls) {
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('uses AUTH_JWKS_URI without discovery when configured', async () => {
    const keys = source({ jwksUri: JWKS_URI });
    expect((await verifierFor(keys).verifyToken(await issuer.mint())).ok).toBe(true);
    expect(idp.calls.map((c) => c.url)).toEqual([JWKS_URI]);
  });

  it('a flood of random kids causes at most one refetch per cooldown', async () => {
    const keys = source({ cooldownMs: 30_000 });
    const verifier = verifierFor(keys);
    await verifier.verifyToken(await issuer.mint()); // initial load (2 requests)
    idp.calls.length = 0;
    now += 31_000; // cooldown since the initial load has passed

    const results = await Promise.all(
      Array.from({ length: 200 }, async (_, i) =>
        verifier.verifyToken(await issuer.mintWith({ kid: `random-${i}` })),
      ),
    );
    expect(results.every((r) => !r.ok && r.reason === 'unknown_key')).toBe(true);
    expect(idp.calls.filter((c) => c.url === JWKS_URI)).toHaveLength(1);

    // Still within the cooldown: more random kids cause no fetch at all.
    for (let i = 0; i < 50; i += 1) {
      await verifier.verifyToken(await issuer.mintWith({ kid: `again-${i}` }));
    }
    expect(idp.calls.filter((c) => c.url === JWKS_URI)).toHaveLength(1);

    now += 30_000; // next cooldown window: exactly one more
    for (let i = 0; i < 50; i += 1) {
      await verifier.verifyToken(await issuer.mintWith({ kid: `later-${i}` }));
    }
    expect(idp.calls.filter((c) => c.url === JWKS_URI)).toHaveLength(2);
  });

  it('accepts a rotated key after the refetch and rejects the removed key afterwards', async () => {
    const keys = source({ cooldownMs: 30_000 });
    const verifier = verifierFor(keys);
    const oldToken = await issuer.mint();
    expect((await verifier.verifyToken(oldToken)).ok).toBe(true);

    await issuer.rotate(); // old key no longer published
    now += 31_000;
    const newToken = await issuer.mint();
    expect((await verifier.verifyToken(newToken)).ok).toBe(true); // unknown kid → refetch
    expect(await verifier.verifyToken(oldToken)).toMatchObject({
      ok: false,
      reason: 'unknown_key',
    });
  });

  it('within the cooldown a new kid is rejected (401), and accepted once the cooldown passed', async () => {
    const keys = source({ cooldownMs: 30_000 });
    const verifier = verifierFor(keys);
    await verifier.verifyToken(await issuer.mint());
    await issuer.rotate({ retainPrevious: true });
    const rotated = await issuer.mint();
    expect(await verifier.verifyToken(rotated)).toMatchObject({ reason: 'unknown_key' });
    now += 30_000;
    expect((await verifier.verifyToken(rotated)).ok).toBe(true);
  });

  it('keeps serving cached keys while the IdP is down (stale-while-error)', async () => {
    const keys = source({ maxAgeMs: 60_000, cooldownMs: 10_000 });
    const verifier = verifierFor(keys);
    await verifier.verifyToken(await issuer.mint());
    idp.mode = 'error';
    now += 120_000; // older than maxAge: a background refresh fails
    expect((await verifier.verifyToken(await issuer.mint())).ok).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(keys.stats.failures).toBe(1);
    expect((await verifier.verifyToken(await issuer.mint())).ok).toBe(true);
  });

  it('refreshes in the background after maxAge (picks up a removed key)', async () => {
    const keys = source({ maxAgeMs: 60_000, cooldownMs: 10_000 });
    const verifier = verifierFor(keys);
    const oldToken = await issuer.mint();
    await verifier.verifyToken(oldToken);
    await issuer.rotate();
    now += 61_000;
    await verifier.verifyToken(oldToken); // still served from cache, triggers refresh
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(await verifier.verifyToken(oldToken)).toMatchObject({ reason: 'unknown_key' });
  });

  it('stops trusting keys older than maxStale when the refresh keeps failing (503)', async () => {
    const keys = source({ maxAgeMs: 60_000, maxStaleMs: 3_600_000, cooldownMs: 10_000 });
    const verifier = verifierFor(keys);
    await verifier.verifyToken(await issuer.mint());
    idp.mode = 'error';
    now += 3_600_001;
    await expect(verifier.verifyToken(await issuer.mint())).rejects.toBeInstanceOf(
      AuthUnavailableError,
    );
  });

  it('IdP down before the first load: 503, bounded retries, recovery afterwards', async () => {
    const keys = source({ cooldownMs: 30_000 });
    const verifier = verifierFor(keys);
    idp.mode = 'timeout';
    for (let i = 0; i < 20; i += 1) {
      await expect(verifier.verifyToken(await issuer.mint())).rejects.toBeInstanceOf(
        AuthUnavailableError,
      );
    }
    expect(keys.stats.attempts).toBe(1); // later calls fail fast inside the cooldown
    idp.mode = 'ok';
    now += 30_000;
    expect((await verifier.verifyToken(await issuer.mint())).ok).toBe(true);
    expect(await keys.warmUp()).toBe(true);
  });

  it('a refetch that fails during an unknown-kid lookup is a 503 condition', async () => {
    const keys = source({ cooldownMs: 30_000 });
    const verifier = verifierFor(keys);
    await verifier.verifyToken(await issuer.mint());
    idp.mode = 'error';
    now += 30_000;
    await expect(
      verifier.verifyToken(await issuer.mintWith({ kid: 'new-kid' })),
    ).rejects.toBeInstanceOf(AuthUnavailableError);
    // Known keys keep working meanwhile.
    expect((await verifier.verifyToken(await issuer.mint())).ok).toBe(true);
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    const keys = source();
    await Promise.all(Array.from({ length: 25 }, () => keys.current()));
    expect(idp.calls).toHaveLength(2);
  });

  it.each([
    ['an issuer mismatch', { issuer: 'https://evil.example.com', jwks_uri: JWKS_URI }],
    ['an http jwks_uri', { issuer: ISSUER, jwks_uri: 'http://idp.example.com/keys' }],
    ['no jwks_uri', { issuer: ISSUER }],
  ])('refuses a discovery document with %s', async (_n, document) => {
    idp.bodies.set(discoveryUrl(ISSUER), document);
    await expect(source().current()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(idp.calls.map((c) => c.url)).not.toContain('http://idp.example.com/keys');
  });

  // The discovery URL is transport-checked too, on the parsed scheme.
  it.each([
    ['http', 'http://idp.example.com/tenant'],
    ['upper-case HTTP', 'HTTP://idp.example.com/tenant'],
    ['a tab inside the scheme', 'ht\ttp://idp.example.com/tenant'],
  ])('refuses discovery over %s (fails at construction, fetches nothing)', (_n, issuer) => {
    expect(() => source({ issuer })).toThrow(/https/);
    expect(idp.calls).toEqual([]);
  });

  it('refuses an upper-case HTTP jwks_uri from discovery and never fetches it', async () => {
    idp.bodies.set(discoveryUrl(ISSUER), {
      issuer: ISSUER,
      jwks_uri: 'HTTP://idp.example.com/keys',
    });
    await expect(source().current()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(idp.calls.map((c) => c.url)).toEqual([discoveryUrl(ISSUER)]);
  });

  it('refuses an upper-case HTTP AUTH_JWKS_URI', () => {
    expect(() => source({ jwksUri: 'HTTP://idp.example.com/keys' })).toThrow(/https/);
  });

  it('allows http only with the local insecure switch', () => {
    expect(() => source({ jwksUri: 'http://test-idp:9400/jwks.json' })).toThrow(/https/);
    expect(() =>
      source({ jwksUri: 'http://test-idp:9400/jwks.json', allowInsecure: true }),
    ).not.toThrow();
  });

  it.each([
    ['not a JWK Set', { hello: 'world' }],
    ['no usable key', { keys: [{ kty: 'oct', k: 'c2VjcmV0' }] }],
    ['only private keys', { keys: [{ kty: 'RSA', n: 'x', e: 'AQAB', d: 'secret' }] }],
  ])('rejects a JWKS that is %s', async (_n, body) => {
    idp.bodies.set(JWKS_URI, body);
    await expect(source({ jwksUri: JWKS_URI }).current()).rejects.toBeInstanceOf(
      AuthUnavailableError,
    );
  });

  it('caps the response size', async () => {
    idp.bodies.set(JWKS_URI, { keys: issuer.jwks().keys, padding: 'x'.repeat(300 * 1024) });
    await expect(source({ jwksUri: JWKS_URI }).current()).rejects.toBeInstanceOf(
      AuthUnavailableError,
    );
  });

  it('re-discovers after a failed JWKS fetch (moved jwks_uri)', async () => {
    const keys = source({ cooldownMs: 1_000 });
    idp.bodies.set(JWKS_URI, 'not json at all');
    await expect(keys.current()).rejects.toBeInstanceOf(AuthUnavailableError);
    idp.bodies.delete(JWKS_URI);
    now += 1_000;
    await keys.current();
    expect(idp.calls.filter((c) => c.url === discoveryUrl(ISSUER))).toHaveLength(2);
  });
});

describe('filterSigningKeys', () => {
  it('keeps public asymmetric signature keys allowed by the algorithm list', () => {
    const keys = [
      { kty: 'RSA', n: 'n', e: 'AQAB', kid: 'rsa', alg: 'RS256', use: 'sig' },
      { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'ec' },
      { kty: 'RSA', n: 'n', e: 'AQAB', kid: 'enc', use: 'enc' },
      { kty: 'RSA', n: 'n', e: 'AQAB', kid: 'ps', alg: 'PS512' },
      { kty: 'oct', k: 'a2V5', kid: 'hmac' },
      { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd', kid: 'private' },
      'garbage',
      null,
    ];
    expect(filterSigningKeys(keys, ['RS256', 'ES256']).map((k) => k.kid)).toEqual(['rsa', 'ec']);
  });
});
