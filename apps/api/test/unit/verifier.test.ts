/**
 * TokenVerifier: every check is enforced and mapped to a log reason code.
 */
import {
  NEGATIVE_TOKEN_CASES,
  OTHER_CLIENT,
  createTestIssuer,
  type TestIssuer,
} from '@starter/testing';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { RemoteJwksSource, StaticKeySource } from '../../src/auth/key-source.js';
import { TokenVerifier, type AuthFailureReason } from '../../src/auth/verifier.js';

const ISSUER = 'https://idp.example.com/realms/example';
const AUDIENCE = 'starter-jobs-api';

let issuer: TestIssuer;
let verifier: TokenVerifier;

beforeAll(async () => {
  issuer = await createTestIssuer({ issuer: ISSUER, audience: AUDIENCE });
  verifier = new TokenVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['RS256', 'ES256'],
    clockToleranceSeconds: 30,
    keys: new StaticKeySource(issuer.jwks()),
  });
});

async function reasonOf(token: string): Promise<AuthFailureReason | 'ok'> {
  const result = await verifier.verifyToken(token);
  return result.ok ? 'ok' : result.reason;
}

describe('TokenVerifier', () => {
  it('returns the principal of a valid token', async () => {
    const result = await verifier.verifyToken(await issuer.mint({ sub: 'user-123' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toMatchObject({ issuer: ISSUER, subject: 'user-123' });
    expect([...result.principal.scopes].sort()).toEqual(['jobs:read', 'jobs:write']);
    expect(result.principal.id).toBe(result.principal.key.slice(0, 16));
  });

  it.each([
    ['expired', 'expired'],
    ['notYetValid', 'not_yet_valid'],
    ['wrongIssuer', 'issuer_mismatch'],
    ['wrongAudience', 'audience_mismatch'],
    ['missingAudience', 'missing_claim'],
    ['missingSubject', 'missing_claim'],
    ['foreignKey', 'unknown_key'],
    ['unknownKid', 'unknown_key'],
    ['tamperedSignature', 'bad_signature'],
    ['tamperedPayload', 'bad_signature'],
    ['algNone', 'alg_not_allowed'],
    ['hs256WithPublicKey', 'alg_not_allowed'],
    ['wrongTyp', 'typ_not_allowed'],
    ['embeddedJwk', 'unknown_key'],
    ['jkuHeader', 'unknown_key'],
    ['x5uHeader', 'unknown_key'],
    ['x5cHeader', 'unknown_key'],
    ['unknownCrit', 'malformed_token'],
    ['idToken', 'audience_mismatch'],
    ['nonceMarker', 'id_token_marker'],
    ['tooOld', 'token_too_old'],
    ['issuedInFuture', 'issued_in_future'],
    ['missingIssuedAt', 'missing_claim'],
  ] as const)('%s → %s', async (name, reason) => {
    expect(await reasonOf(await issuer.mintWith(NEGATIVE_TOKEN_CASES[name]))).toBe(reason);
  });

  it('compares the issuer exactly (no trailing-slash or case normalisation)', async () => {
    expect(await reasonOf(await issuer.mintWith({ issuer: `${ISSUER}/` }))).toBe('issuer_mismatch');
    expect(await reasonOf(await issuer.mintWith({ issuer: ISSUER.toUpperCase() }))).toBe(
      'issuer_mismatch',
    );
  });

  it('accepts the audience as a member of an aud array, nothing else', async () => {
    expect(await reasonOf(await issuer.mintWith({ audience: ['spa-client', AUDIENCE] }))).toBe(
      'ok',
    );
    expect(await reasonOf(await issuer.mintWith({ audience: ['spa-client'] }))).toBe(
      'audience_mismatch',
    );
    // ID-token confusion: an ID token is addressed to the SPA client id, not the API.
    expect(
      await reasonOf(await issuer.mintWith({ audience: 'starter-web-local', typ: 'JWT' })),
    ).toBe('audience_mismatch');
  });

  it('applies the clock tolerance to exp and nbf, and no more', async () => {
    expect(await reasonOf(await issuer.mintWith({ expiresInSeconds: -10 }))).toBe('ok');
    expect(await reasonOf(await issuer.mintWith({ expiresInSeconds: -40 }))).toBe('expired');
    expect(await reasonOf(await issuer.mintWith({ notBeforeSeconds: 10 }))).toBe('ok');
    expect(await reasonOf(await issuer.mintWith({ notBeforeSeconds: 40 }))).toBe('not_yet_valid');
  });

  describe('maximum token age', () => {
    const withMaxAge = (maxTokenAgeSeconds: number) =>
      new TokenVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['RS256'],
        clockToleranceSeconds: 30,
        maxTokenAgeSeconds,
        keys: new StaticKeySource(issuer.jwks()),
      });

    it('bounds a long-lived token by iat + max age (default 1 h), whatever its exp', async () => {
      const tenYears = 10 * 365 * 24 * 3600;
      const fresh = await issuer.mintWith({ expiresInSeconds: tenYears });
      expect(await reasonOf(fresh)).toBe('ok');
      const old = await issuer.mintWith({
        expiresInSeconds: tenYears,
        issuedAtOffsetSeconds: -3_700,
      });
      expect(await reasonOf(old)).toBe('token_too_old');
    });

    it('honours a configured maximum age (within the clock tolerance)', async () => {
      const verifierWith900 = withMaxAge(900);
      const at = (offset: number) => issuer.mintWith({ issuedAtOffsetSeconds: offset });
      expect((await verifierWith900.verifyToken(await at(-900))).ok).toBe(true);
      expect((await verifierWith900.verifyToken(await at(-925))).ok).toBe(true); // skew 30 s
      expect(await verifierWith900.verifyToken(await at(-1_000))).toMatchObject({
        reason: 'token_too_old',
      });
    });

    it('rejects a non-numeric iat as an invalid claim', async () => {
      expect(await reasonOf(await issuer.mint({ sub: 'alice', iat: 'yesterday' }))).toBe(
        'invalid_claim',
      );
    });

    it('accepts iat slightly in the future (clock skew), not beyond', async () => {
      expect(await reasonOf(await issuer.mintWith({ issuedAtOffsetSeconds: 20 }))).toBe('ok');
      expect(await reasonOf(await issuer.mintWith({ issuedAtOffsetSeconds: 120 }))).toBe(
        'issued_in_future',
      );
    });
  });

  it('requires exp (a correctly signed token without exp never expires)', async () => {
    expect(await reasonOf(await issuer.mint({ exp: undefined }))).toBe('missing_claim');
  });

  it.each([
    ['access-token typ', 'at+jwt', 'ok'],
    ['media-type form', 'application/at+jwt', 'ok'],
    ['plain JWT', 'JWT', 'ok'],
    ['absent typ', null, 'ok'],
    ['DPoP proof', 'dpop+jwt', 'typ_not_allowed'],
    ['security event', 'secevent+jwt', 'typ_not_allowed'],
  ] as const)('typ: %s → %s', async (_n, typ, expected) => {
    expect(await reasonOf(await issuer.mintWith({ typ }))).toBe(expected);
  });

  it.each([
    ['empty', ''],
    ['too long', 'x'.repeat(256)],
    ['control character', 'alice\nadmin'],
    ['not a string', 42],
  ])('rejects a %s subject', async (_n, sub) => {
    expect(await reasonOf(await issuer.mint({ sub }))).toBe('invalid_claim');
  });

  it('rejects a token signed by a trusted kid but with another key type/alg', async () => {
    // ES256 signature under the RSA key's kid: no ES256 key carries that kid.
    const { privateKey } = await generateKeyPair('ES256');
    const token = await new SignJWT({ sub: 'alice', scope: 'jobs:read' })
      .setProtectedHeader({ alg: 'ES256', kid: issuer.activeKid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(privateKey);
    expect(await reasonOf(token)).toBe('unknown_key');
  });

  it('rejects ambiguous keys (several keys match a token without kid)', async () => {
    const a = await generateKeyPair('RS256', { extractable: true });
    const b = await generateKeyPair('RS256', { extractable: true });
    const keys = [
      { ...(await exportJWK(a.publicKey)), alg: 'RS256' },
      { ...(await exportJWK(b.publicKey)), alg: 'RS256' },
    ];
    const ambiguous = new TokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['RS256'],
      clockToleranceSeconds: 0,
      keys: new StaticKeySource({ keys }),
    });
    const token = await new SignJWT({ sub: 'alice' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(a.privateKey);
    const result = await ambiguous.verifyToken(token);
    expect(result).toEqual({ ok: false, reason: 'ambiguous_key', tokenPresented: true });
  });

  it('refuses to be constructed with a symmetric or unknown algorithm', () => {
    for (const algorithms of [['HS256'], ['RS256', 'none'], []]) {
      expect(
        () =>
          new TokenVerifier({
            issuer: ISSUER,
            audience: AUDIENCE,
            algorithms: algorithms as never,
            clockToleranceSeconds: 0,
            keys: new StaticKeySource(issuer.jwks()),
          }),
      ).toThrow(TypeError);
    }
  });

  it('drops symmetric and private keys from a key set', async () => {
    const withSecret = new StaticKeySource({
      keys: [{ kty: 'oct', k: 'c2VjcmV0', kid: issuer.activeKid, alg: 'HS256' }],
    });
    const strict = new TokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['RS256'],
      clockToleranceSeconds: 0,
      keys: withSecret,
    });
    expect((await strict.verifyToken(await issuer.mint())).ok).toBe(false);
  });

  it.each([
    ['missing', undefined, 'missing_token', false],
    ['blank', '  ', 'missing_token', false],
    ['basic', 'Basic Zm9vOmJhcg==', 'malformed_header', false],
    ['bare bearer', 'Bearer', 'malformed_header', true],
    ['lower-case scheme', 'bearer x.y.z', 'malformed_token', true],
  ] as const)('header %s → %s', async (_n, header, reason, presented) => {
    expect(await verifier.verifyAuthorizationHeader(header)).toEqual({
      ok: false,
      reason,
      tokenPresented: presented,
    });
  });

  it('a self-asserted key in the jwk header is ignored even under the trusted kid', async () => {
    // Signed by an attacker key, embedded in the header, but naming the TRUSTED kid.
    const token = await issuer.mintWith({
      foreignKey: true,
      embedJwk: true,
      kid: issuer.activeKid,
    });
    expect(await reasonOf(token)).toBe('bad_signature');
  });

  it('never fetches a jku/x5u URL named by the token', async () => {
    const fetched: string[] = [];
    const keys = new RemoteJwksSource({
      issuer: ISSUER,
      jwksUri: 'https://idp.example.com/keys',
      allowInsecure: false,
      algorithms: ['RS256'],
      logger: { info: () => undefined, warn: () => undefined },
      fetch: async (url) => {
        fetched.push(url);
        return new Response(JSON.stringify(issuer.jwks()), { status: 200 });
      },
    });
    const remote = new TokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['RS256'],
      clockToleranceSeconds: 0,
      keys,
    });
    for (const name of ['jkuHeader', 'x5uHeader'] as const) {
      const result = await remote.verifyToken(await issuer.mintWith(NEGATIVE_TOKEN_CASES[name]));
      expect(result).toMatchObject({ ok: false, reason: 'unknown_key' });
    }
    expect(fetched.every((url) => url === 'https://idp.example.com/keys')).toBe(true);
  });

  it('a correctly signed token with an unknown critical header parameter is rejected', async () => {
    expect(await reasonOf(await issuer.mintWith({ critical: 'exp', header: { exp: 1 } }))).toBe(
      'malformed_token',
    );
  });

  describe('client allow-list (AUTH_ALLOWED_CLIENT_IDS)', () => {
    const restricted = () =>
      new TokenVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['RS256'],
        clockToleranceSeconds: 0,
        keys: new StaticKeySource(issuer.jwks()),
        allowedClientIds: ['starter-web-local'],
      });

    it('accepts tokens of an allowed client (client_id or azp)', async () => {
      expect((await restricted().verifyToken(await issuer.mint())).ok).toBe(true);
      const azpOnly = await issuer.mint({ client_id: undefined, azp: 'starter-web-local' });
      expect((await restricted().verifyToken(azpOnly)).ok).toBe(true);
    });

    it('rejects a token issued to another client', async () => {
      expect(await restricted().verifyToken(await issuer.mintWith(OTHER_CLIENT))).toMatchObject({
        ok: false,
        reason: 'client_not_allowed',
      });
    });

    it('rejects a token without any client claim, or with conflicting ones', async () => {
      const none = await issuer.mintWith({ clientId: null });
      expect(await restricted().verifyToken(none)).toMatchObject({ reason: 'client_not_allowed' });
      const mixed = await issuer.mint({ client_id: 'starter-web-local', azp: 'some-other-client' });
      expect(await restricted().verifyToken(mixed)).toMatchObject({ reason: 'client_not_allowed' });
    });

    it('without an allow-list, other clients of the trusted issuer are accepted', async () => {
      expect((await verifier.verifyToken(await issuer.mintWith(OTHER_CLIENT))).ok).toBe(true);
    });
  });

  it('accepts the bearer scheme case-insensitively', async () => {
    const token = await issuer.mint();
    expect((await verifier.verifyAuthorizationHeader(`bearer ${token}`)).ok).toBe(true);
  });
});
