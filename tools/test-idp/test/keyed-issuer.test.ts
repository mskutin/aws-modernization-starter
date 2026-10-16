/**
 * `createKeyedIssuer` (file-backed ES256 key) must mint exactly what `@starter/testing/auth`'s
 * `createTestIssuer` mints for every named case — same header parameters, same claims — so the
 * security suite's negative cases mean the same thing against the sandbox IdP. Each negative case
 * must also be refused by the API's own verifier, and rotation must be refused (static JWKS).
 */
import { StaticKeySource, TokenVerifier } from '@starter/api/dist/auth/index.js';
import {
  INSUFFICIENT_SCOPE,
  NEGATIVE_TOKEN_CASES,
  OTHER_CLIENT,
  createTestIssuer,
  type MintOptions,
} from '@starter/testing/auth';
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { KeyRotationUnavailableError, createKeyedIssuer } from '../src/keyed-issuer.js';
import { generateSigningJwk, signingKeyFromJwk } from '../src/signing-key.js';

const ISSUER = 'https://issuer.sandbox.test';
const AUDIENCE = 'starter-jobs-api-sandbox';
const FIXED_NOW = Date.UTC(2026, 9, 15, 4, 0, 0);

const CASES: Record<string, MintOptions> = {
  valid: {},
  ...NEGATIVE_TOKEN_CASES,
  insufficientScope: INSUFFICIENT_SCOPE,
  otherClient: OTHER_CLIENT,
};

/** Header/payload of a token with the values that legitimately differ normalised away. */
function shape(token: string, activeKid: string) {
  const header = decodeProtectedHeader(token) as Record<string, unknown>;
  const kid = header.kid;
  header.kid =
    kid === activeKid
      ? '<active>'
      : typeof kid === 'string' && kid.startsWith('foreign-')
        ? '<foreign>'
        : kid;
  if (typeof header.jwk === 'object' && header.jwk !== null) {
    header.jwk = Object.keys(header.jwk).sort();
  }
  const { jti, ...claims } = decodeJwt(token);
  expect(typeof jti).toBe('string');
  return { header, claims, signed: token.split('.')[2] !== '' };
}

async function issuers() {
  const key = signingKeyFromJwk(generateSigningJwk());
  const options = { issuer: ISSUER, audience: AUDIENCE, clock: () => FIXED_NOW };
  return {
    key,
    reference: await createTestIssuer({ ...options, algorithm: 'ES256' }),
    keyed: createKeyedIssuer({ ...options, key }),
  };
}

describe('createKeyedIssuer', () => {
  it.each(Object.entries(CASES))(
    'mints the same header and claims as createTestIssuer: %s',
    async (_name, options) => {
      const { reference, keyed } = await issuers();
      const claims = { sub: 'alice', client_id: 'starter-web-sandbox' };
      expect(shape(await keyed.mint(claims, options), keyed.activeKid)).toEqual(
        shape(await reference.mint(claims, options), reference.activeKid),
      );
    },
  );

  it('signs ES256 with the file key, kid = its thumbprint, verifiable against jwks()', async () => {
    const { key, keyed } = await issuers();
    expect(keyed.algorithm).toBe('ES256');
    expect(keyed.activeKid).toBe(key.kid);
    expect(keyed.jwks()).toEqual({ keys: [key.publicJwk] });
    const token = await createKeyedIssuer({ issuer: ISSUER, audience: AUDIENCE, key }).mint({
      sub: 'bob',
    });
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(keyed.jwks()), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['ES256'],
      typ: 'at+jwt',
    });
    expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: key.kid });
    expect(payload.sub).toBe('bob');
  });

  it('jwks() is a copy: callers cannot alter the published key', async () => {
    const { keyed } = await issuers();
    const first = keyed.jwks();
    (first.keys[0] as Record<string, unknown>).d = 'injected';
    expect(keyed.jwks().keys[0]).not.toHaveProperty('d');
  });

  it.each(Object.entries(NEGATIVE_TOKEN_CASES))(
    'the API verifier refuses the negative case %s',
    async (_name, options) => {
      const key = signingKeyFromJwk(generateSigningJwk());
      const keyed = createKeyedIssuer({ issuer: ISSUER, audience: AUDIENCE, key });
      const verifier = new TokenVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['ES256'],
        clockToleranceSeconds: 30,
        maxTokenAgeSeconds: 3600,
        allowedClientIds: ['starter-web-sandbox'],
        keys: new StaticKeySource(keyed.jwks()),
      });
      const positive = await verifier.verifyToken(
        await keyed.mint({ sub: 'alice', client_id: 'starter-web-sandbox' }),
      );
      expect(positive.ok).toBe(true);
      const result = await verifier.verifyToken(
        await keyed.mint({ sub: 'alice', client_id: 'starter-web-sandbox' }, options),
      );
      expect(result.ok).toBe(false);
    },
  );

  it('refuses rotation: the published JWKS is static', async () => {
    const { keyed, key } = await issuers();
    await expect(keyed.rotate()).rejects.toBeInstanceOf(KeyRotationUnavailableError);
    expect(keyed.activeKid).toBe(key.kid);
  });
});
