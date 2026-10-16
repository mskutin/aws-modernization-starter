/**
 * Runtime configuration of the SPA (`/config.json`, ADR 0213): one build for every environment.
 * Served by CloudFront (a CloudFront Function on AWS), the nginx web tier locally and the Vite
 * dev/preview server; it is never part of the build output, so a missing file fails loudly
 * instead of silently using another environment's IdP.
 *
 *   { "auth": { "issuer": "https://idp.example", "clientId": "spa-client", "scope": "openid jobs:read jobs:write" } }
 */
export interface AuthConfig {
  /** OpenID Connect issuer (exact `iss`); discovery at `${issuer}/.well-known/openid-configuration`. */
  issuer: string;
  /** Public client id of this SPA (authorization code + PKCE, no client secret). */
  clientId: string;
  /** Space-separated scopes; must include `openid`. */
  scope: string;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const isLoopback = (host: string) =>
  host === '127.0.0.1' || host === 'localhost' || host === '[::1]';

/** Validates untrusted JSON (runtime boundary). http is accepted only for a loopback issuer. */
export function parseAuthConfig(json: unknown): AuthConfig {
  const auth =
    typeof json === 'object' && json !== null ? (json as { auth?: unknown }).auth : undefined;
  if (typeof auth !== 'object' || auth === null) throw new ConfigError('config.json has no "auth"');
  const { issuer, clientId, scope } = auth as Record<string, unknown>;
  if (typeof issuer !== 'string' || typeof clientId !== 'string' || typeof scope !== 'string') {
    throw new ConfigError('config.json auth needs issuer, clientId and scope strings');
  }
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new ConfigError('config.json auth.issuer is not a URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new ConfigError('config.json auth.issuer must be https (http only for a local test IdP)');
  }
  if (!/^[\x21-\x7e]{1,256}$/.test(clientId)) throw new ConfigError('invalid auth.clientId');
  if (!scope.split(' ').includes('openid')) throw new ConfigError('auth.scope must include openid');
  return { issuer, clientId, scope };
}

export async function loadAuthConfig(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = (i, init) =>
    globalThis.fetch(i, init),
): Promise<AuthConfig> {
  let response: Response;
  try {
    response = await fetchImpl('/config.json', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    throw new ConfigError('Could not load /config.json', { cause: error });
  }
  if (!response.ok) throw new ConfigError(`/config.json answered HTTP ${response.status}`);
  return parseAuthConfig(await response.json().catch(() => undefined));
}
