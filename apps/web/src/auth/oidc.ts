/**
 * OpenID Connect sign-in for the SPA: authorization code flow with PKCE (S256), `state`,
 * `nonce` and RFC 9207 `iss` checks (ADR 0213). Hand-rolled on purpose: the flow
 * is ~200 lines, has no dependency to supply-chain-review, and keeps tokens where we want them.
 *
 * Storage rules:
 *  - the access token and the session live in MEMORY only (lost on reload; the IdP session
 *    makes the next sign-in a redirect bounce). No refresh token is requested or stored;
 *  - sessionStorage holds only the short-lived PKCE verifier + state + nonce + return route of
 *    ONE pending sign-in across the redirect, and is cleared when the callback is handled.
 *
 * The ID token is received directly from the token endpoint over TLS, so its claims (iss, aud,
 * nonce, exp) are checked but its signature is not (OIDC Core 3.1.3.7 step 6); the API never
 * accepts it anyway (different audience).
 */
import type { AuthConfig } from './config';
import { randomValue, s256Challenge } from './pkce';

export interface Session {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  user: { sub: string; name: string };
}

export class LoginError extends Error {
  override readonly name = 'LoginError';
}

export interface ProviderMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  endSessionEndpoint?: string | undefined;
}

export interface OidcDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Navigates away (sign-in / sign-out redirects). */
  redirect: (url: string) => void;
  /** Origin of this SPA, e.g. http://127.0.0.1:4173. */
  origin: string;
  now: () => number;
  random: () => string;
  challenge: (verifier: string) => Promise<string>;
}

export const PENDING_KEY = 'starter.oidc.pending';
const PENDING_TTL_MS = 10 * 60_000;
const SAFE_ROUTE = /^#\/[A-Za-z0-9/_.~-]*$/;

/** Only same-document hash routes are ever restored after sign-in. */
export function safeReturnTo(route: string | null | undefined): string {
  return route && SAFE_ROUTE.test(route) && !route.includes('//') ? route : '#/';
}

interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  createdAt: number;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) throw new LoginError('The identity provider returned a malformed ID token.');
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof claims !== 'object' || claims === null) throw new Error('not an object');
    return claims as Record<string, unknown>;
  } catch {
    throw new LoginError('The identity provider returned a malformed ID token.');
  }
}

export class OidcClient {
  private metadata: Promise<ProviderMetadata> | undefined;

  constructor(
    private readonly config: AuthConfig,
    private readonly deps: OidcDeps,
  ) {}

  /** `${origin}/` — registered at the IdP as an exact redirect URI. */
  get redirectUri(): string {
    return `${this.deps.origin}/`;
  }

  discover(): Promise<ProviderMetadata> {
    this.metadata ??= this.loadMetadata().catch((error: unknown) => {
      this.metadata = undefined;
      throw error;
    });
    return this.metadata;
  }

  private async loadMetadata(): Promise<ProviderMetadata> {
    const url = `${this.config.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const response = await this.deps.fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new LoginError('The identity provider is not reachable right now.');
    const doc = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (doc.issuer !== this.config.issuer) {
      throw new LoginError('The identity provider metadata does not match the configured issuer.');
    }
    const endpoint = (name: string): string | undefined => {
      const value = doc[name];
      if (value === undefined) return undefined;
      const url = typeof value === 'string' ? new URL(value) : undefined;
      const issuerProtocol = new URL(this.config.issuer).protocol;
      if (!url || (url.protocol !== 'https:' && url.protocol !== issuerProtocol)) {
        throw new LoginError(`The identity provider metadata has an invalid ${name}.`);
      }
      return url.href;
    };
    const authorizationEndpoint = endpoint('authorization_endpoint');
    const tokenEndpoint = endpoint('token_endpoint');
    if (!authorizationEndpoint || !tokenEndpoint) {
      throw new LoginError('The identity provider metadata lacks the authorization endpoints.');
    }
    return {
      issuer: this.config.issuer,
      authorizationEndpoint,
      tokenEndpoint,
      endSessionEndpoint: endpoint('end_session_endpoint'),
    };
  }

  /** Starts sign-in: remembers the PKCE verifier/state/nonce, then redirects to the IdP. */
  async beginLogin(returnTo: string): Promise<void> {
    const metadata = await this.discover();
    const pending: Pending = {
      state: this.deps.random(),
      nonce: this.deps.random(),
      verifier: this.deps.random(),
      returnTo: safeReturnTo(returnTo),
      createdAt: this.deps.now(),
    };
    this.deps.storage.setItem(PENDING_KEY, JSON.stringify(pending));
    const url = new URL(metadata.authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri,
      scope: this.config.scope,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: await this.deps.challenge(pending.verifier),
      code_challenge_method: 'S256',
    }).toString();
    this.deps.redirect(url.href);
  }

  /** The pending sign-in, removed in the same step (a callback can be processed once). */
  private takePending(): Pending | undefined {
    const raw = this.deps.storage.getItem(PENDING_KEY);
    this.deps.storage.removeItem(PENDING_KEY);
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as Partial<Pending>;
      if (
        typeof value.state === 'string' &&
        typeof value.nonce === 'string' &&
        typeof value.verifier === 'string' &&
        typeof value.createdAt === 'number'
      ) {
        return { ...value, returnTo: safeReturnTo(value.returnTo) } as Pending;
      }
    } catch {
      // corrupt entry: treated as missing
    }
    return undefined;
  }

  /**
   * Handles `?code=…&state=…` (or `?error=…`) on the redirect URI. Returns null when the URL is
   * not a sign-in callback; throws `LoginError` for every invalid response.
   */
  async handleCallback(currentUrl: string): Promise<{ session: Session; returnTo: string } | null> {
    const params = new URL(currentUrl).searchParams;
    const code = params.get('code');
    const error = params.get('error');
    if (code === null && error === null) return null;
    const pending = this.takePending();
    if (error !== null) {
      throw new LoginError('The identity provider did not complete the sign-in. Please try again.');
    }
    if (!pending || pending.state !== params.get('state')) {
      throw new LoginError('This sign-in response was not requested by this browser tab.');
    }
    if (this.deps.now() - pending.createdAt > PENDING_TTL_MS) {
      throw new LoginError('The sign-in took too long. Please try again.');
    }
    const iss = params.get('iss');
    if (iss !== null && iss !== this.config.issuer) {
      throw new LoginError('The sign-in response came from an unexpected identity provider.');
    }
    const metadata = await this.discover();
    const response = await this.deps.fetch(metadata.tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: this.redirectUri,
        client_id: this.config.clientId,
        code_verifier: pending.verifier,
      }).toString(),
    });
    const tokens = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (
      !response.ok ||
      typeof tokens.access_token !== 'string' ||
      typeof tokens.id_token !== 'string' ||
      typeof tokens.token_type !== 'string' ||
      tokens.token_type.toLowerCase() !== 'bearer'
    ) {
      throw new LoginError('The identity provider did not issue the expected tokens.');
    }
    const claims = decodeJwtPayload(tokens.id_token);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const nowSeconds = this.deps.now() / 1000;
    if (
      claims.iss !== this.config.issuer ||
      !audiences.includes(this.config.clientId) ||
      claims.nonce !== pending.nonce ||
      typeof claims.exp !== 'number' ||
      claims.exp < nowSeconds - 60 ||
      typeof claims.sub !== 'string'
    ) {
      throw new LoginError('The identity provider returned an ID token for another request.');
    }
    const expiresIn =
      typeof tokens.expires_in === 'number' && tokens.expires_in > 0 ? tokens.expires_in : 300;
    const name =
      typeof claims.preferred_username === 'string'
        ? claims.preferred_username
        : typeof claims.name === 'string'
          ? claims.name
          : claims.sub;
    return {
      session: {
        accessToken: tokens.access_token,
        expiresAt: this.deps.now() + expiresIn * 1000,
        user: { sub: claims.sub, name },
      },
      returnTo: pending.returnTo,
    };
  }

  /** Ends the IdP session too when the IdP supports RP-initiated logout. */
  async logout(): Promise<void> {
    const metadata = await this.discover().catch(() => undefined);
    if (!metadata?.endSessionEndpoint) {
      this.deps.redirect(this.redirectUri);
      return;
    }
    const url = new URL(metadata.endSessionEndpoint);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('post_logout_redirect_uri', this.redirectUri);
    this.deps.redirect(url.href);
  }
}

/** Production wiring of `OidcClient` (browser APIs). */
export function browserOidcClient(config: AuthConfig): OidcClient {
  return new OidcClient(config, {
    fetch: (input, init) => globalThis.fetch(input, init),
    storage: window.sessionStorage,
    redirect: (url) => window.location.assign(url),
    origin: window.location.origin,
    now: () => Date.now(),
    random: () => randomValue(),
    challenge: (verifier) => s256Challenge(verifier),
  });
}
