/**
 * Bearer access-token verification (ADR 0210). Every check is mandatory:
 *
 *  - `Authorization: Bearer <JWS compact>`; at most 8 KiB.
 *  - `alg` must be in the asymmetric allow-list BEFORE any key lookup (`none`/`HS*` can never
 *    pass: the config schema refuses them, this class refuses them, and jose's JWKS resolver
 *    has no symmetric keys).
 *  - `typ`, when present, must be an access-token type (`at+jwt`, `JWT`): other JWT kinds
 *    (logout tokens, DPoP proofs, ...) are refused. ID tokens are refused three ways: their
 *    `aud` is the SPA client id, never the API audience (enforced by config); a `nonce` claim
 *    (ID-token marker) is refused; and the optional `azp`/`client_id` allow-list applies.
 *  - Header-supplied keys (`jku`, `x5u`, `jwk`, `x5c`) are never used: keys come only from the
 *    issuer JWKS; unknown `crit` parameters are refused (jose).
 *  - Signature against the issuer JWKS (key selected by `kid`; an unknown `kid` triggers at
 *    most one rate-limited refetch, see key-source.ts).
 *  - Exact `iss` and `aud`; `exp`, `iat` and `sub` required; `exp`/`nbf`/`iat` with bounded
 *    clock skew; at most `maxTokenAgeSeconds` after `iat`.
 *  - `sub`: non-empty string of at most 255 characters without control characters.
 *
 * Failures carry a reason code for the log; the HTTP response never reveals it.
 */
import type { AsymmetricJwsAlgorithm } from '@starter/config';
import {
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type CompactJWSHeaderParameters,
  type CryptoKey,
  type JWTPayload,
} from 'jose';
import { AuthUnavailableError, type KeySource } from './key-source.js';
import { createPrincipal, scopesFromClaims, type Principal } from './principal.js';

export type AuthFailureReason =
  | 'missing_token'
  | 'malformed_header'
  | 'token_too_large'
  | 'malformed_token'
  | 'alg_not_allowed'
  | 'typ_not_allowed'
  | 'unknown_key'
  | 'ambiguous_key'
  | 'bad_signature'
  | 'expired'
  | 'token_too_old'
  | 'issued_in_future'
  | 'not_yet_valid'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'missing_claim'
  | 'invalid_claim'
  | 'id_token_marker'
  | 'client_not_allowed'
  | 'invalid_token';

export type VerificationResult =
  | { ok: true; principal: Principal }
  /** `tokenPresented` selects the RFC 6750 challenge (`error="invalid_token"` or none). */
  | { ok: false; reason: AuthFailureReason; tokenPresented: boolean };

export interface TokenVerifierOptions {
  issuer: string;
  audience: string;
  algorithms: readonly AsymmetricJwsAlgorithm[];
  clockToleranceSeconds: number;
  /** Maximum age after `iat` (AUTH_MAX_TOKEN_AGE_SECONDS); default 3600. */
  maxTokenAgeSeconds?: number;
  keys: KeySource;
  /** `azp`/`client_id` values accepted; empty or absent = any client of the issuer. */
  allowedClientIds?: readonly string[];
  /** Epoch milliseconds (tests). */
  now?: () => number;
}

export const MAX_TOKEN_LENGTH = 8 * 1024;
export const DEFAULT_MAX_TOKEN_AGE_SECONDS = 3_600;
const MAX_SUBJECT_LENGTH = 255;
const ASYMMETRIC: ReadonlySet<string> = new Set([
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
]);
/** Accepted `typ` header values after normalisation (absent is accepted too). */
const ACCESS_TOKEN_TYPES = new Set(['at+jwt', 'jwt']);
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const BEARER = /^Bearer +([^\s]+) *$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const fail = (reason: AuthFailureReason, tokenPresented = true): VerificationResult => ({
  ok: false,
  reason,
  tokenPresented,
});

function normalizeTyp(typ: string): string {
  const lower = typ.toLowerCase();
  return lower.startsWith('application/') ? lower.slice('application/'.length) : lower;
}

/** Maps a jose error to a reason; `undefined` = not a token problem (rethrow). */
export function reasonFor(error: unknown): AuthFailureReason | undefined {
  if (error instanceof AuthUnavailableError) return undefined;
  if (error instanceof errors.JWTExpired)
    return error.claim === 'iat' ? 'token_too_old' : 'expired';
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.reason === 'missing') return 'missing_claim';
    switch (error.claim) {
      case 'nbf':
        return 'not_yet_valid';
      case 'iat': // jose: `check_failed` = in the future; `invalid` = not a number
        return error.reason === 'check_failed' ? 'issued_in_future' : 'invalid_claim';
      case 'iss':
        return 'issuer_mismatch';
      case 'aud':
        return 'audience_mismatch';
      default:
        return 'invalid_claim';
    }
  }
  if (error instanceof errors.JOSEAlgNotAllowed) return 'alg_not_allowed';
  if (error instanceof errors.JWKSNoMatchingKey) return 'unknown_key';
  if (error instanceof errors.JWKSMultipleMatchingKeys) return 'ambiguous_key';
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'bad_signature';
  if (
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JOSENotSupported
  ) {
    return 'malformed_token';
  }
  // Anything else thrown while handling attacker-controlled input (e.g. a key that cannot be
  // imported for the header's alg) is still an invalid token, not a server error.
  return 'invalid_token';
}

export class TokenVerifier {
  private readonly algorithms: AsymmetricJwsAlgorithm[];

  constructor(private readonly options: TokenVerifierOptions) {
    const algorithms = [...new Set(options.algorithms)];
    if (algorithms.length === 0 || algorithms.some((alg) => !ASYMMETRIC.has(alg))) {
      // Defence in depth: the config schema already refuses these values.
      throw new TypeError('TokenVerifier accepts only asymmetric JWS algorithms');
    }
    this.algorithms = algorithms;
  }

  /** Throws `AuthUnavailableError` (→ 503) when the issuer keys cannot be obtained. */
  async verifyAuthorizationHeader(header: string | undefined): Promise<VerificationResult> {
    if (header === undefined || header.trim() === '') return fail('missing_token', false);
    const match = BEARER.exec(header);
    if (!match?.[1]) {
      // Another scheme (Basic, ...) or a bare "Bearer": no bearer token was presented.
      return fail('malformed_header', /^bearer\b/i.test(header.trim()));
    }
    return this.verifyToken(match[1]);
  }

  async verifyToken(token: string): Promise<VerificationResult> {
    if (token.length > MAX_TOKEN_LENGTH) return fail('token_too_large');
    if (!COMPACT_JWS.test(token)) return fail('malformed_token');

    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      return fail('malformed_token');
    }
    if (
      typeof header.alg !== 'string' ||
      !this.algorithms.includes(header.alg as AsymmetricJwsAlgorithm)
    ) {
      return fail('alg_not_allowed');
    }
    if (
      header.typ !== undefined &&
      (typeof header.typ !== 'string' || !ACCESS_TOKEN_TYPES.has(normalizeTyp(header.typ)))
    ) {
      return fail('typ_not_allowed');
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, (h: CompactJWSHeaderParameters) => this.resolveKey(h), {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: this.algorithms,
        clockTolerance: this.options.clockToleranceSeconds,
        // Requires `iat`, rejects it in the future beyond the skew and tokens older than the max.
        maxTokenAge: this.options.maxTokenAgeSeconds ?? DEFAULT_MAX_TOKEN_AGE_SECONDS,
        requiredClaims: ['sub', 'exp', 'iat'],
        ...(this.options.now ? { currentDate: new Date(this.options.now()) } : {}),
      }));
    } catch (error) {
      const reason = reasonFor(error);
      if (reason === undefined) throw error;
      return fail(reason);
    }

    const subject = payload.sub;
    if (
      typeof subject !== 'string' ||
      subject.length === 0 ||
      subject.length > MAX_SUBJECT_LENGTH ||
      CONTROL_CHARACTERS.test(subject)
    ) {
      return fail('invalid_claim');
    }
    // ID tokens carry the authorization request's nonce; access tokens do not.
    if (payload.nonce !== undefined) return fail('id_token_marker');
    if (!this.clientAllowed(payload)) return fail('client_not_allowed');
    return {
      ok: true,
      principal: createPrincipal(this.options.issuer, subject, scopesFromClaims(payload)),
    };
  }

  /** With an allow-list, `azp` and/or `client_id` must be present and every present value allowed. */
  private clientAllowed(payload: JWTPayload): boolean {
    const allowed = this.options.allowedClientIds ?? [];
    if (allowed.length === 0) return true;
    const presented = [payload.azp, payload.client_id].filter((v) => v !== undefined);
    return (
      presented.length > 0 && presented.every((v) => typeof v === 'string' && allowed.includes(v))
    );
  }

  private async resolveKey(header: CompactJWSHeaderParameters): Promise<CryptoKey> {
    const keys = await this.options.keys.current();
    try {
      return await keys(header);
    } catch (error) {
      if (error instanceof errors.JWKSNoMatchingKey && typeof header.kid === 'string') {
        const refreshed = await this.options.keys.refreshForUnknownKey();
        if (refreshed) return refreshed(header);
      }
      throw error;
    }
  }
}
