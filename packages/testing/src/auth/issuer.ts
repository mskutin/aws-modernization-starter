/**
 * TEST ONLY — cryptographically valid JWT issuer for tests.
 *
 * `createTestIssuer` holds real asymmetric signing keys (RS256 by default) and mints access
 * tokens exactly as an OIDC provider would, plus deliberately broken tokens for negative tests:
 * expired, not yet valid, wrong `iss`/`aud`, missing scope or `sub`, a key that is not in the
 * JWKS (unknown `kid`), a tampered signature or payload, `alg: none`, and HS256 signed with the
 * issuer's PUBLIC key (algorithm confusion). Keys live in memory only and are generated per
 * issuer; nothing here is a secret worth protecting, and nothing here may be used outside tests.
 *
 * `startTestIssuer` (server.ts) serves the same issuer's discovery document and JWKS over HTTP.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  SignJWT,
  base64url,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from 'jose';

export type TestSigningAlgorithm = 'RS256' | 'ES256';

export const TEST_ISSUER_DEFAULTS = {
  issuer: 'https://test-issuer.invalid',
  audience: 'starter-jobs-api',
  subject: 'alice',
  scope: 'jobs:read jobs:write',
  ttlSeconds: 300,
  /** RFC 9068 access-token media type. */
  typ: 'at+jwt',
  /** `client_id` of minted access tokens (RFC 9068): the SPA client of the test IdP. */
  clientId: 'starter-web-local',
} as const;

export interface TestIssuerOptions {
  issuer?: string;
  audience?: string;
  algorithm?: TestSigningAlgorithm;
  /** `scope` claim of minted tokens unless overridden. */
  scope?: string;
  ttlSeconds?: number;
  /** Epoch milliseconds; lets unit tests pin `iat`/`exp`. */
  clock?: () => number;
}

/** Knobs for one token. Every negative case is reachable through these options. */
export interface MintOptions {
  /** `exp` = now + this (negative = already expired). Default: the issuer TTL. */
  expiresInSeconds?: number;
  /** Adds `nbf` = now + this (positive = not yet valid). */
  notBeforeSeconds?: number;
  /** `iat` = now + this (default 0); `null` omits `iat`. */
  issuedAtOffsetSeconds?: number | null;
  /** Overrides `iss` (wrong issuer). */
  issuer?: string;
  /** Overrides `aud`; `null` omits it. */
  audience?: string | string[] | null;
  /** Overrides `scope`; `null` omits it (insufficient scope). */
  scope?: string | null;
  /** Overrides `sub`; `null` omits it. */
  subject?: string | null;
  /** `typ` header; `null` omits it. Default `at+jwt`. */
  typ?: string | null;
  /** Header `kid` override while the ACTIVE key still signs (e.g. a random, unknown kid). */
  kid?: string;
  /** Sign with a key that is not (and never was) in the JWKS, under its own unknown kid. */
  foreignKey?: boolean;
  /** Flip one bit of the signature after signing. */
  tamperSignature?: boolean;
  /** Merge these claims into the payload AFTER signing (signature no longer matches). */
  tamperPayload?: Record<string, unknown>;
  /** Unsecured JWT: header `alg: none`, empty signature. */
  algNone?: boolean;
  /** HS256 with the active PUBLIC key (SPKI PEM bytes) as the HMAC secret. */
  hs256WithPublicKey?: boolean;
  /** Adds a `nonce` claim (an ID-token marker). */
  nonce?: string;
  /** Overrides `client_id` (and sets `azp`) — a token issued to another client; `null` omits both. */
  clientId?: string | null;
  /** Extra protected-header parameters (e.g. `jku`, `x5u`, `x5c`). */
  header?: Record<string, unknown>;
  /** Puts the signing key's public JWK into the `jwk` header (self-asserted key). */
  embedJwk?: boolean;
  /** Marks this header parameter as critical (`crit`) — a parameter no verifier understands. */
  critical?: string;
}

/** Named negative cases (each must be rejected with 401 by a correct verifier). */
export const NEGATIVE_TOKEN_CASES = {
  expired: { expiresInSeconds: -600 },
  notYetValid: { notBeforeSeconds: 600 },
  wrongIssuer: { issuer: 'https://evil-issuer.invalid' },
  wrongAudience: { audience: 'some-other-api' },
  missingAudience: { audience: null },
  missingSubject: { subject: null },
  foreignKey: { foreignKey: true },
  unknownKid: { kid: 'unknown-kid-0000' },
  tamperedSignature: { tamperSignature: true },
  tamperedPayload: { tamperPayload: { sub: 'mallory' } },
  algNone: { algNone: true },
  hs256WithPublicKey: { hs256WithPublicKey: true },
  wrongTyp: { typ: 'logout+jwt' },
  /** Attacker key, published only in the token's own `jwk` header. */
  embeddedJwk: { foreignKey: true, embedJwk: true },
  /** Attacker key "available" at a URL named by the token (must never be fetched). */
  jkuHeader: { foreignKey: true, header: { jku: 'http://127.0.0.1:9/attacker-jwks.json' } },
  x5uHeader: { foreignKey: true, header: { x5u: 'http://127.0.0.1:9/attacker-cert.pem' } },
  x5cHeader: { foreignKey: true, header: { x5c: ['MIIBszCCAVmgAwIBAgIUQ0VSVElGSUNBVEU='] } },
  /** Correctly signed by the trusted key, but with a critical extension nobody implements. */
  unknownCrit: { critical: 'urn:example:unknown', header: { 'urn:example:unknown': true } },
  /** An ID token for the SPA: SPA audience, nonce, typ JWT. */
  idToken: { audience: 'starter-web-local', nonce: 'n-0S6_WzA2Mj', typ: 'JWT' },
  /** Right audience, but an ID-token marker (`nonce`). */
  nonceMarker: { nonce: 'n-0S6_WzA2Mj' },
  /** Valid by `exp`, but issued 2 h ago: older than the API's default 1 h maximum age. */
  tooOld: { issuedAtOffsetSeconds: -7_200 },
  /** `iat` 10 minutes in the future (beyond any accepted clock skew). */
  issuedInFuture: { issuedAtOffsetSeconds: 600 },
  /** No `iat` claim (the API requires it to bound the token age). */
  missingIssuedAt: { issuedAtOffsetSeconds: null },
} as const satisfies Record<string, MintOptions>;
export type NegativeTokenCase = keyof typeof NEGATIVE_TOKEN_CASES;

/** Valid token, but without the scope the API requires → 403, not 401. */
export const INSUFFICIENT_SCOPE: MintOptions = { scope: 'profile email' };

/**
 * Valid token issued to another OAuth client: rejected (401) only when the API restricts
 * clients (AUTH_ALLOWED_CLIENT_IDS), accepted otherwise.
 */
export const OTHER_CLIENT: MintOptions = { clientId: 'some-other-client' };

export interface PublicJwks {
  keys: JWK[];
}

export interface TestIssuer {
  readonly issuer: string;
  readonly audience: string;
  readonly algorithm: TestSigningAlgorithm;
  /** `kid` of the key that signs right now. */
  readonly activeKid: string;
  /** The published (public) JWK Set — a deep copy. */
  jwks(): PublicJwks;
  /** A valid access token; `claims` are merged over the defaults (sub alice, both scopes). */
  mint(claims?: Record<string, unknown>, opts?: MintOptions): Promise<string>;
  /** `mint(undefined, opts)`: typically a negative case. */
  mintWith(opts: MintOptions): Promise<string>;
  /**
   * New signing key. By default the previous key is REMOVED from the JWKS, so its tokens stop
   * verifying once a verifier refreshes; `retainPrevious` keeps it published (overlap period).
   */
  rotate(opts?: { retainPrevious?: boolean }): Promise<{ previousKid: string; activeKid: string }>;
}

interface SigningKey {
  kid: string;
  algorithm: TestSigningAlgorithm;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwk: JWK;
}

async function newSigningKey(
  algorithm: TestSigningAlgorithm,
  prefix = 'test',
): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(algorithm, { extractable: true });
  const exported = await exportJWK(publicKey);
  // RFC 7638-style thumbprint is overkill here; a short hash of the key is unique and stable.
  const kid = `${prefix}-${createHash('sha256').update(JSON.stringify(exported)).digest('hex').slice(0, 16)}`;
  return {
    kid,
    algorithm,
    privateKey,
    publicKey,
    jwk: { ...exported, kid, alg: algorithm, use: 'sig' },
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

export async function createTestIssuer(options: TestIssuerOptions = {}): Promise<TestIssuer> {
  const issuer = options.issuer ?? TEST_ISSUER_DEFAULTS.issuer;
  const audience = options.audience ?? TEST_ISSUER_DEFAULTS.audience;
  const algorithm = options.algorithm ?? 'RS256';
  const ttlSeconds = options.ttlSeconds ?? TEST_ISSUER_DEFAULTS.ttlSeconds;
  const defaultScope = options.scope ?? TEST_ISSUER_DEFAULTS.scope;
  const nowSeconds = () => Math.floor((options.clock?.() ?? Date.now()) / 1000);

  let active = await newSigningKey(algorithm);
  let published: SigningKey[] = [active];
  let foreign: SigningKey | undefined;

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
      const secret = new TextEncoder().encode(await exportSPKI(active.publicKey));
      token = await new SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256', kid: active.kid, ...typHeader })
        .sign(secret);
    } else {
      let key = active;
      if (opts.foreignKey) {
        foreign ??= await newSigningKey(algorithm, 'foreign');
        key = foreign;
      }
      const { kid: _kid, use: _use, alg: _alg, ...publicJwk } = key.jwk;
      token = await new SignJWT(payload)
        .setProtectedHeader({
          alg: key.algorithm,
          kid: opts.kid ?? key.kid,
          ...typHeader,
          ...(opts.embedJwk ? { jwk: publicJwk } : {}),
        })
        .sign(key.privateKey, opts.critical ? { crit: { [opts.critical]: true } } : undefined);
    }
    if (opts.tamperPayload) token = replacePayload(token, opts.tamperPayload);
    if (opts.tamperSignature) token = flipSignatureBit(token);
    return token;
  }

  return {
    issuer,
    audience,
    algorithm,
    get activeKid() {
      return active.kid;
    },
    jwks: () => ({ keys: published.map((k) => structuredClone(k.jwk)) }),
    mint,
    mintWith: (opts) => mint(undefined, opts),
    async rotate(opts = {}) {
      const previous = active;
      active = await newSigningKey(algorithm);
      published = opts.retainPrevious ? [active, previous] : [active];
      return { previousKid: previous.kid, activeKid: active.kid };
    },
  };
}

/** `Authorization` header value for a token. */
export const bearer = (token: string): string => `Bearer ${token}`;
