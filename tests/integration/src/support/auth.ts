/**
 * Bearer tokens for the black-box suite (identity). The API under test trusts the TEST-ONLY
 * IdP (tools/test-idp); its POST /test/token endpoint — enabled only in local and CI stacks
 * (TEST_IDP_ENABLE_TEST_ENDPOINTS=true) — mints access tokens for any test principal.
 *
 *   TEST_IDP_URL  base URL of that IdP (default http://127.0.0.1:9400)
 *
 * Every run uses its own principals (`it-<name>-<run>`), so its rate-limit budgets and job lists
 * are not shared with earlier runs against a long-lived stack.
 */
import { randomUUID } from 'node:crypto';
import { HEADER_KEY_MARKER, principalKey, principalScope } from '@starter/domain';

export const testIdpUrl = process.env.TEST_IDP_URL ?? 'http://127.0.0.1:9400';
const RUN = randomUUID().slice(0, 8);

/** A principal (`sub`) unique to this run. */
export const principal = (name: string) => `it-${name}-${RUN}`;
export const DEFAULT_PRINCIPAL = principal('runner');

export interface MintRequest {
  sub?: string;
  scope?: string;
  claims?: Record<string, unknown>;
  /** `MintOptions` of @starter/testing/auth (negative cases: expiresInSeconds, audience, ...). */
  options?: Record<string, unknown>;
}

export async function mintToken(body: MintRequest): Promise<string> {
  const response = await fetch(new URL('/test/token', testIdpUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) {
    throw new Error(
      `test IdP ${testIdpUrl}/test/token answered ${response.status} (TEST_IDP_ENABLE_TEST_ENDPOINTS=true?)`,
    );
  }
  return ((await response.json()) as { access_token: string }).access_token;
}

const cache = new Map<string, { token: Promise<string>; mintedAt: number }>();
/** Valid token (both API scopes) for `sub`; re-minted well before the IdP's 10 min lifetime. */
export function tokenFor(sub = DEFAULT_PRINCIPAL): Promise<string> {
  const cached = cache.get(sub);
  if (cached && Date.now() - cached.mintedAt < 4 * 60_000) return cached.token;
  const token = mintToken({ sub });
  cache.set(sub, { token, mintedAt: Date.now() });
  return token;
}

/** `iss` of a token (decoded, not verified: the suite only reproduces storage keys with it). */
export function issuerOf(token: string): string {
  const payload = token.split('.')[1] ?? '';
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    iss?: unknown;
  };
  if (typeof claims.iss !== 'string') throw new Error('token has no iss claim');
  return claims.iss;
}

/** The Idempotency-Key as the API stores it for `sub`: p:<sha256(iss|sub)>:h:<key>. */
export async function storedKey(headerKey: string, sub = DEFAULT_PRINCIPAL): Promise<string> {
  const iss = issuerOf(await tokenFor(sub));
  return `${principalScope(principalKey(iss, sub))}${HEADER_KEY_MARKER}${headerKey}`;
}
