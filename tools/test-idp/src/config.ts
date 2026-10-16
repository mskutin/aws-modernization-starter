/**
 * Configuration of the TEST-ONLY identity provider (contracts rev. 2 §2.4, ADR 0213).
 *
 *   APP_RUNTIME                     local | ci — REQUIRED; anything else (incl. unset = aws) refuses
 *   TEST_IDP_HOST / TEST_IDP_PORT   listen address (default 127.0.0.1:9400)
 *   TEST_IDP_ISSUER                 issuer identifier as browsers reach it (default http://127.0.0.1:<port>);
 *                                   an http(s) origin, normalised by `normalizeIssuer`
 *   TEST_IDP_AUDIENCE               `aud` of access tokens (default starter-jobs-api)
 *   TEST_IDP_CLIENT_ID              the SPA client (public client, PKCE) (default starter-web-local)
 *   TEST_IDP_REDIRECT_URIS          exact redirect URIs of that client, comma-separated
 *   TEST_IDP_TOKEN_TTL_SECONDS      access/ID token lifetime (default 600)
 *   TEST_IDP_ENABLE_TEST_ENDPOINTS  true enables POST /test/token and POST /test/rotate (default false)
 *   TEST_IDP_SIGNING_KEY_FILE       private EC P-256 JWK (ES256) to sign with instead of an in-memory
 *                                   RS256 key (AWS sandbox, see README); mode 0600, outside any
 *                                   repository; only with a loopback TEST_IDP_HOST; disables
 *                                   /test/rotate (the published JWKS is static)
 */
export interface TestIdpConfig {
  host: string;
  port: number;
  issuer: string;
  audience: string;
  clientId: string;
  redirectUris: string[];
  /** Origins allowed to call the token endpoint, discovery and JWKS from a browser (CORS). */
  allowedOrigins: string[];
  tokenTtlSeconds: number;
  enableTestEndpoints: boolean;
  /** API scopes this IdP grants when requested. */
  apiScopes: readonly string[];
  /** Test users offered on the sign-in page. */
  users: readonly string[];
  /** Private JWK file to sign with (TEST_IDP_SIGNING_KEY_FILE); undefined = in-memory key. */
  signingKeyFile: string | undefined;
}

export const TEST_USERS = ['alice', 'bob', 'mallory'] as const;
export const API_SCOPES = ['jobs:read', 'jobs:write'] as const;

export class TestIdpConfigError extends Error {
  override readonly name = 'TestIdpConfigError';
}

/** Hosts a key-file IdP may listen on: its token minting must never be reachable off-host. */
const LOOPBACK_HOST = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|localhost)$/;

const DEFAULT_REDIRECT_URIS = [
  'http://127.0.0.1:4173/',
  'http://localhost:4173/',
  'http://127.0.0.1:5173/',
  'http://localhost:5173/',
];

function integer(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new TestIdpConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

/**
 * The issuer identifier exactly as every party must compare it: an absolute http(s)
 * URL without credentials, query, fragment or path (this IdP serves its endpoints at the root),
 * normalised to its ORIGIN — lower-case scheme and host, default port dropped, no trailing slash.
 * `TEST_IDP_ISSUER` and `sandbox-issuer export --issuer` both go through this one function, so
 * the running IdP (`iss`, discovery) and the published static discovery document cannot differ.
 */
export function normalizeIssuer(
  value: string,
  name: string,
  options: { httpsOnly?: boolean } = {},
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TestIdpConfigError(`${name} must be an absolute URL`);
  }
  const https = url.protocol === 'https:';
  if (!https && (options.httpsOnly || url.protocol !== 'http:')) {
    throw new TestIdpConfigError(
      `${name} must be an ${options.httpsOnly ? 'https' : 'http(s)'} URL`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TestIdpConfigError(`${name} must not contain credentials, a query or a fragment`);
  }
  if (url.pathname !== '/') {
    throw new TestIdpConfigError(
      `${name} must be an origin without a path (e.g. https://d123.cloudfront.net)`,
    );
  }
  return url.origin;
}

function absoluteHttpUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TestIdpConfigError(`${name} must be an absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TestIdpConfigError(`${name} must be an http(s) URL`);
  }
  if (url.hash) throw new TestIdpConfigError(`${name} must not contain a fragment`);
  return url;
}

export function loadTestIdpConfig(
  env: Record<string, string | undefined> = process.env,
): TestIdpConfig {
  const runtime = env.APP_RUNTIME ?? 'aws';
  if (runtime !== 'local' && runtime !== 'ci') {
    throw new TestIdpConfigError(
      `TEST ONLY identity provider: refusing to start with APP_RUNTIME=${runtime} (only local or ci; unset means aws)`,
    );
  }
  const port = integer(env.TEST_IDP_PORT, 9400, 1, 65_535, 'TEST_IDP_PORT');
  const issuer = normalizeIssuer(
    env.TEST_IDP_ISSUER ?? `http://127.0.0.1:${port}`,
    'TEST_IDP_ISSUER',
  );
  const redirectUris = (env.TEST_IDP_REDIRECT_URIS ?? DEFAULT_REDIRECT_URIS.join(','))
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  if (redirectUris.length === 0) throw new TestIdpConfigError('TEST_IDP_REDIRECT_URIS is empty');
  const origins = redirectUris.map((u) => absoluteHttpUrl(u, 'TEST_IDP_REDIRECT_URIS').origin);
  const enable = env.TEST_IDP_ENABLE_TEST_ENDPOINTS ?? 'false';
  if (enable !== 'true' && enable !== 'false') {
    throw new TestIdpConfigError('TEST_IDP_ENABLE_TEST_ENDPOINTS must be "true" or "false"');
  }
  const host = env.TEST_IDP_HOST ?? '127.0.0.1';
  const signingKeyFile = env.TEST_IDP_SIGNING_KEY_FILE || undefined;
  if (signingKeyFile && !LOOPBACK_HOST.test(host)) {
    throw new TestIdpConfigError(
      'TEST_IDP_SIGNING_KEY_FILE requires a loopback TEST_IDP_HOST (127.0.0.1, ::1 or localhost): tokens signed with a published key must never be mintable off-host',
    );
  }
  return {
    host,
    port,
    issuer,
    audience: env.TEST_IDP_AUDIENCE ?? 'starter-jobs-api',
    clientId: env.TEST_IDP_CLIENT_ID ?? 'starter-web-local',
    redirectUris,
    allowedOrigins: [...new Set(origins)],
    tokenTtlSeconds: integer(
      env.TEST_IDP_TOKEN_TTL_SECONDS,
      600,
      30,
      86_400,
      'TEST_IDP_TOKEN_TTL_SECONDS',
    ),
    enableTestEndpoints: enable === 'true',
    apiScopes: API_SCOPES,
    users: TEST_USERS,
    signingKeyFile,
  };
}
