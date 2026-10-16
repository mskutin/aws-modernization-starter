/**
 * A `TestIssuer` (the `@starter/testing/auth` contract) that signs with a GIVEN ES256 key instead of
 * one generated in memory: the TEST-ONLY IdP with `TEST_IDP_SIGNING_KEY_FILE` (AWS sandbox),
 * whose public key is published as a static JWKS on AWS.
 *
 * `mint` implements every `MintOptions` knob exactly like `createTestIssuer` (same claims, same
 * defaults, same negative cases), so `POST /test/token` behaves the same with either key source;
 * `test/keyed-issuer.test.ts` holds the two implementations to that for every named case.
 *
 * Differences, both deliberate:
 *  - `rotate()` throws `KeyRotationUnavailableError`: the published JWKS is a static file on AWS,
 *    so a new in-memory key could only mint tokens the deployed API rejects. Rotate by generating
 *    a new key file and exporting it again.
 *  - the "foreign" key of negative cases is generated in memory on first use (never published).
 */
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import {
  TEST_ISSUER_DEFAULTS,
  type MintOptions,
  type PublicJwks,
  type TestIssuer,
} from '@starter/testing/auth';
import { SignJWT, base64url, type JWTPayload } from 'jose';
import { ecThumbprint, type SigningKey } from './signing-key.js';

export class KeyRotationUnavailableError extends Error {
  override readonly name = 'KeyRotationUnavailableError';
}

export interface KeyedIssuerOptions {
  issuer: string;
  audience: string;
  key: SigningKey;
  scope?: string;
  ttlSeconds?: number;
  /** Epoch milliseconds; lets unit tests pin `iat`/`exp`. */
  clock?: () => number;
}

interface Signer {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** Public JWK without kid/alg/use (what an embedded `jwk` header carries). */
  bareJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
}

function foreignSigner(): Signer {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { x = '', y = '' } = publicKey.export({ format: 'jwk' });
  const bareJwk = { kty: 'EC' as const, crv: 'P-256' as const, x, y };
  return {
    kid: `foreign-${ecThumbprint(bareJwk).slice(0, 16)}`,
    privateKey,
    publicKey,
    bareJwk,
  };
}

const encodeJson = (value: unknown) => base64url.encode(JSON.stringify(value));

function flipSignatureBit(token: string): string {
  const [header, payload, signature] = token.split('.') as [string, string, string];
  const bytes = base64url.decode(signature);
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  return `${header}.${payload}.${base64url.encode(bytes)}`;
}

function replacePayload(token: string, claims: Record<string, unknown>): string {
  const [header, payload, signature] = token.split('.') as [string, string, string];
  const decoded = JSON.parse(new TextDecoder().decode(base64url.decode(payload))) as JWTPayload;
  return `${header}.${encodeJson({ ...decoded, ...claims })}.${signature}`;
}

export function createKeyedIssuer(options: KeyedIssuerOptions): TestIssuer {
  const { issuer, audience, key } = options;
  const ttlSeconds = options.ttlSeconds ?? TEST_ISSUER_DEFAULTS.ttlSeconds;
  const defaultScope = options.scope ?? TEST_ISSUER_DEFAULTS.scope;
  const nowSeconds = () => Math.floor((options.clock?.() ?? Date.now()) / 1000);
  const { kty, crv, x, y } = key.publicJwk;
  const active: Signer = {
    kid: key.kid,
    privateKey: key.privateKey,
    publicKey: key.publicKey,
    bareJwk: { kty, crv, x, y },
  };
  let foreign: Signer | undefined;

  async function mint(
    claims: Record<string, unknown> = {},
    opts: MintOptions = {},
  ): Promise<string> {
    const now = nowSeconds();
    const payload: JWTPayload = {
      iss: opts.issuer ?? issuer,
      sub: TEST_ISSUER_DEFAULTS.subject,
      aud: audience,
      scope: defaultScope,
      iat: now + (opts.issuedAtOffsetSeconds ?? 0),
      exp: now + (opts.expiresInSeconds ?? ttlSeconds),
      jti: randomUUID(),
      client_id: TEST_ISSUER_DEFAULTS.clientId,
      ...claims,
    };
    if (opts.issuedAtOffsetSeconds === null) delete payload.iat;
    if (opts.nonce !== undefined) payload.nonce = opts.nonce;
    if (opts.clientId !== undefined) {
      delete payload.client_id;
      delete payload.azp;
      if (opts.clientId !== null) {
        payload.client_id = opts.clientId;
        payload.azp = opts.clientId;
      }
    }
    if (opts.notBeforeSeconds !== undefined) payload.nbf = now + opts.notBeforeSeconds;
    if (opts.audience !== undefined) {
      if (opts.audience === null) delete payload.aud;
      else payload.aud = opts.audience;
    }
    if (opts.scope !== undefined) {
      if (opts.scope === null) delete payload.scope;
      else payload.scope = opts.scope;
    }
    if (opts.subject !== undefined) {
      if (opts.subject === null) delete payload.sub;
      else payload.sub = opts.subject;
    }
    const typ = opts.typ === undefined ? TEST_ISSUER_DEFAULTS.typ : opts.typ;
    const typHeader = {
      ...(typ === null ? {} : { typ }),
      ...opts.header,
      ...(opts.critical ? { crit: [opts.critical] } : {}),
    };

    let token: string;
    if (opts.algNone) {
      token = `${encodeJson({ alg: 'none', kid: active.kid, ...typHeader })}.${encodeJson(payload)}.`;
    } else if (opts.hs256WithPublicKey) {
      const pem = active.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      token = await new SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256', kid: active.kid, ...typHeader })
        .sign(new TextEncoder().encode(pem));
    } else {
      let signer = active;
      if (opts.foreignKey) {
        foreign ??= foreignSigner();
        signer = foreign;
      }
      token = await new SignJWT(payload)
        .setProtectedHeader({
          alg: key.algorithm,
          kid: opts.kid ?? signer.kid,
          ...typHeader,
          ...(opts.embedJwk ? { jwk: signer.bareJwk } : {}),
        })
        .sign(signer.privateKey, opts.critical ? { crit: { [opts.critical]: true } } : undefined);
    }
    if (opts.tamperPayload) token = replacePayload(token, opts.tamperPayload);
    if (opts.tamperSignature) token = flipSignatureBit(token);
    return token;
  }

  return {
    issuer,
    audience,
    algorithm: key.algorithm,
    activeKid: key.kid,
    jwks: (): PublicJwks => ({ keys: [structuredClone(key.publicJwk)] }),
    mint,
    mintWith: (opts) => mint(undefined, opts),
    rotate: () =>
      Promise.reject(
        new KeyRotationUnavailableError(
          'key rotation is disabled with TEST_IDP_SIGNING_KEY_FILE: the published JWKS is static (generate a new key file and export it instead)',
        ),
      ),
  };
}
