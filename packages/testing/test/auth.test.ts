/**
 * Self-tests of the TEST-ONLY issuer: positive tokens verify with a standard verifier (jose)
 * against the published JWKS, and every negative case fails for the intended reason. If a
 * negative helper silently produced a valid token, the API's negative tests would prove nothing.
 */
import { createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INSUFFICIENT_SCOPE,
  NEGATIVE_TOKEN_CASES,
  OTHER_CLIENT,
  bearer,
  createTestIssuer,
  startTestIssuer,
  type StartedTestIssuer,
  type TestIssuer,
} from '../src/auth/index.js';

async function verify(issuer: TestIssuer, token: string) {
  return jwtVerify(token, createLocalJWKSet(issuer.jwks()), {
    issuer: issuer.issuer,
    audience: issuer.audience,
    algorithms: ['RS256', 'ES256'],
    requiredClaims: ['sub', 'exp'],
  });
}

async function failure(issuer: TestIssuer, token: string): Promise<unknown> {
  try {
    await verify(issuer, token);
  } catch (error) {
    return error;
  }
  throw new Error('token unexpectedly verified');
}

describe('createTestIssuer', () => {
  it('mints RFC 9068-style access tokens that verify against the published JWKS', async () => {
    const issuer = await createTestIssuer({ issuer: 'https://idp.test', audience: 'api://jobs' });
    const token = await issuer.mint({ sub: 'bob' });
    const { payload, protectedHeader } = await verify(issuer, token);
    expect(protectedHeader).toEqual({ alg: 'RS256', kid: issuer.activeKid, typ: 'at+jwt' });
    expect(payload).toMatchObject({
      iss: 'https://idp.test',
      aud: 'api://jobs',
      sub: 'bob',
      scope: 'jobs:read jobs:write',
    });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
    expect(bearer(token)).toBe(`Bearer ${token}`);
  });

  it('publishes only public key material', async () => {
    const issuer = await createTestIssuer({ algorithm: 'ES256' });
    const [jwk] = issuer.jwks().keys;
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    for (const privateMember of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']) {
      expect(jwk).not.toHaveProperty(privateMember);
    }
    await verify(issuer, await issuer.mint());
  });

  it.each([
    ['expired', errors.JWTExpired],
    ['notYetValid', errors.JWTClaimValidationFailed],
    ['wrongIssuer', errors.JWTClaimValidationFailed],
    ['wrongAudience', errors.JWTClaimValidationFailed],
    ['missingAudience', errors.JWTClaimValidationFailed],
    ['missingSubject', errors.JWTClaimValidationFailed],
    ['foreignKey', errors.JWKSNoMatchingKey],
    ['unknownKid', errors.JWKSNoMatchingKey],
    ['tamperedSignature', errors.JWSSignatureVerificationFailed],
    ['tamperedPayload', errors.JWSSignatureVerificationFailed],
    ['algNone', errors.JOSEAlgNotAllowed],
    ['hs256WithPublicKey', errors.JOSEAlgNotAllowed],
    ['embeddedJwk', errors.JWKSNoMatchingKey],
    ['jkuHeader', errors.JWKSNoMatchingKey],
    ['x5uHeader', errors.JWKSNoMatchingKey],
    ['x5cHeader', errors.JWKSNoMatchingKey],
    ['unknownCrit', errors.JOSENotSupported],
    ['idToken', errors.JWTClaimValidationFailed],
  ] as const)('negative case %s is rejected (%s)', async (name, expected) => {
    const issuer = await createTestIssuer();
    const error = await failure(issuer, await issuer.mintWith(NEGATIVE_TOKEN_CASES[name]));
    expect(error).toBeInstanceOf(expected);
  });

  it('wrongTyp carries a typ that is not an access-token type', async () => {
    const issuer = await createTestIssuer();
    const token = await issuer.mintWith(NEGATIVE_TOKEN_CASES.wrongTyp);
    expect(decodeProtectedHeader(token).typ).toBe('logout+jwt');
  });

  it('token-age cases carry the intended iat (only API policy rejects them)', async () => {
    const issuer = await createTestIssuer();
    const now = Math.floor(Date.now() / 1000);
    const old = await verify(issuer, await issuer.mintWith(NEGATIVE_TOKEN_CASES.tooOld));
    expect(now - (old.payload.iat ?? 0)).toBeGreaterThanOrEqual(7_190);
    const future = await verify(issuer, await issuer.mintWith(NEGATIVE_TOKEN_CASES.issuedInFuture));
    expect((future.payload.iat ?? 0) - now).toBeGreaterThanOrEqual(590);
    const none = await verify(issuer, await issuer.mintWith(NEGATIVE_TOKEN_CASES.missingIssuedAt));
    expect(none.payload.iat).toBeUndefined();
  });

  it('nonceMarker and OTHER_CLIENT are signature-valid: only API policy rejects them', async () => {
    const issuer = await createTestIssuer();
    const marked = await verify(issuer, await issuer.mintWith(NEGATIVE_TOKEN_CASES.nonceMarker));
    expect(marked.payload.nonce).toBe('n-0S6_WzA2Mj');
    const other = await verify(issuer, await issuer.mintWith(OTHER_CLIENT));
    expect(other.payload).toMatchObject({
      client_id: 'some-other-client',
      azp: 'some-other-client',
    });
    const normal = await verify(issuer, await issuer.mint());
    expect(normal.payload.client_id).toBe('starter-web-local');
    expect(normal.payload.nonce).toBeUndefined();
  });

  it('header-key cases name the key but sign with a key outside the JWKS', async () => {
    const issuer = await createTestIssuer();
    const embedded = decodeProtectedHeader(await issuer.mintWith(NEGATIVE_TOKEN_CASES.embeddedJwk));
    expect(embedded.jwk).toMatchObject({ kty: 'RSA' });
    expect(embedded.jwk).not.toHaveProperty('d');
    expect(embedded.kid).not.toBe(issuer.activeKid);
    const jku = decodeProtectedHeader(await issuer.mintWith(NEGATIVE_TOKEN_CASES.jkuHeader));
    expect(jku.jku).toMatch(/^http:/);
    const crit = decodeProtectedHeader(await issuer.mintWith(NEGATIVE_TOKEN_CASES.unknownCrit));
    expect(crit).toMatchObject({ crit: ['urn:example:unknown'], kid: issuer.activeKid });
  });

  it('builds the algorithm-confusion token from the public key (HS256, same kid)', async () => {
    const issuer = await createTestIssuer();
    const token = await issuer.mintWith(NEGATIVE_TOKEN_CASES.hs256WithPublicKey);
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'HS256', kid: issuer.activeKid });
    // Even a verifier that (wrongly) allowed HS256 cannot use the JWKS for it.
    const error = await jwtVerify(token, createLocalJWKSet(issuer.jwks()), {
      algorithms: ['HS256'],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(errors.JOSENotSupported);
  });

  it('mints a valid token without the API scopes for 403 tests', async () => {
    const issuer = await createTestIssuer();
    const { payload } = await verify(issuer, await issuer.mintWith(INSUFFICIENT_SCOPE));
    expect(payload.scope).toBe('profile email');
  });

  it('rotate() replaces the signing key and, by default, unpublishes the old one', async () => {
    const issuer = await createTestIssuer();
    const oldToken = await issuer.mint();
    const before = issuer.activeKid;
    const { previousKid, activeKid } = await issuer.rotate();
    expect(previousKid).toBe(before);
    expect(activeKid).not.toBe(before);
    expect(issuer.jwks().keys.map((k) => k.kid)).toEqual([activeKid]);
    await verify(issuer, await issuer.mint());
    expect(await failure(issuer, oldToken)).toBeInstanceOf(errors.JWKSNoMatchingKey);

    await issuer.rotate({ retainPrevious: true });
    expect(issuer.jwks().keys).toHaveLength(2);
  });

  it('honours an injected clock', async () => {
    const issuer = await createTestIssuer({ clock: () => Date.parse('2030-01-01T00:00:00Z') });
    const header = await issuer.mint();
    const payload = JSON.parse(Buffer.from(header.split('.')[1] ?? '', 'base64url').toString()) as {
      iat: number;
    };
    expect(payload.iat).toBe(Date.parse('2030-01-01T00:00:00Z') / 1000);
  });
});

describe('startTestIssuer', () => {
  let started: StartedTestIssuer | undefined;
  afterEach(async () => {
    await started?.close();
    started = undefined;
  });

  it('serves discovery and the JWKS over HTTP and counts requests', async () => {
    started = await startTestIssuer({ audience: 'starter-jobs-api' });
    expect(started.issuer).toBe(started.url);
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const discovery = (await (await fetch(started.discoveryUrl)).json()) as Record<string, unknown>;
    expect(discovery).toMatchObject({ issuer: started.issuer, jwks_uri: started.jwksUri });
    const jwks = (await (await fetch(started.jwksUri)).json()) as { keys: { kid: string }[] };
    expect(jwks.keys.map((k) => k.kid)).toEqual([started.activeKid]);
    expect(started.stats).toEqual({ jwksRequests: 1, discoveryRequests: 1 });
    started.resetStats();
    expect(started.stats.jwksRequests).toBe(0);
  });

  it('simulates an IdP outage (503 or no answer)', async () => {
    started = await startTestIssuer();
    started.setOutage('error');
    expect((await fetch(started.jwksUri)).status).toBe(503);
    started.setOutage('hang');
    const hung = await fetch(started.jwksUri, { signal: AbortSignal.timeout(200) }).catch(
      (e: unknown) => e,
    );
    expect((hung as Error).name).toBe('TimeoutError');
    started.setOutage('none');
    expect((await fetch(started.jwksUri)).status).toBe(200);
    expect(started.stats.jwksRequests).toBe(3);
  });
});
