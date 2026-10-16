/**
 * OIDC sign-in (authorization code + PKCE S256) without a browser: every check of the callback
 * must reject a forged or replayed response, and tokens must never reach Web Storage.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConfigError, loadAuthConfig, parseAuthConfig, type AuthConfig } from '../src/auth/config';
import { OidcClient, PENDING_KEY, safeReturnTo, type OidcDeps } from '../src/auth/oidc';
import { base64url, randomValue, s256Challenge } from '../src/auth/pkce';

const CONFIG: AuthConfig = {
  issuer: 'https://idp.example.com',
  clientId: 'starter-web',
  scope: 'openid jobs:read jobs:write',
};
const ORIGIN = 'https://app.example.com';
const METADATA = {
  issuer: CONFIG.issuer,
  authorization_endpoint: `${CONFIG.issuer}/authorize`,
  token_endpoint: `${CONFIG.issuer}/token`,
  end_session_endpoint: `${CONFIG.issuer}/logout`,
};
const NOW = Date.parse('2026-10-14T00:00:00Z');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.c2lnbmF0dXJl`;
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function harness(tokenResponse?: () => Response) {
  const storage = memoryStorage();
  const redirects: string[] = [];
  let counter = 0;
  const fetch = vi.fn<OidcDeps['fetch']>(async (url, init) => {
    if (url.endsWith('/.well-known/openid-configuration')) return json(METADATA);
    if (url === METADATA.token_endpoint && init?.method === 'POST') {
      return tokenResponse ? tokenResponse() : json({}, 400);
    }
    throw new Error(`unexpected ${url}`);
  });
  const deps: OidcDeps = {
    fetch,
    storage,
    redirect: (url) => redirects.push(url),
    origin: ORIGIN,
    now: () => NOW,
    random: () => `random-${(counter += 1)}`,
    challenge: async (v) => `challenge-of-${v}`,
  };
  return { client: new OidcClient(CONFIG, deps), storage, redirects, fetch };
}

/** Starts a sign-in and returns the state/nonce the IdP would echo. */
async function started(h: ReturnType<typeof harness>, returnTo = '#/jobs/abc') {
  await h.client.beginLogin(returnTo);
  const url = new URL(h.redirects.at(-1) ?? '');
  return { state: url.searchParams.get('state') ?? '', nonce: url.searchParams.get('nonce') ?? '' };
}

const goodTokens = (nonce: string, overrides: Record<string, unknown> = {}) =>
  json({
    access_token: 'access-token-value',
    token_type: 'Bearer',
    expires_in: 600,
    id_token: idToken({
      iss: CONFIG.issuer,
      aud: CONFIG.clientId,
      sub: 'user-1',
      nonce,
      exp: NOW / 1000 + 600,
      preferred_username: 'alice',
      ...overrides,
    }),
  });

describe('runtime configuration', () => {
  it('accepts https issuers and a loopback http issuer', () => {
    expect(parseAuthConfig({ auth: CONFIG })).toEqual(CONFIG);
    expect(parseAuthConfig({ auth: { ...CONFIG, issuer: 'http://127.0.0.1:9400' } }).issuer).toBe(
      'http://127.0.0.1:9400',
    );
  });

  it.each([
    ['no auth', {}],
    ['http issuer', { auth: { ...CONFIG, issuer: 'http://idp.example.com' } }],
    ['bad issuer', { auth: { ...CONFIG, issuer: 'nope' } }],
    ['no openid scope', { auth: { ...CONFIG, scope: 'jobs:read' } }],
    ['missing client', { auth: { issuer: CONFIG.issuer, scope: CONFIG.scope } }],
  ])('rejects %s', (_n, value) => {
    expect(() => parseAuthConfig(value)).toThrow(ConfigError);
  });

  it('fails loudly when /config.json is missing', async () => {
    await expect(loadAuthConfig(async () => new Response('', { status: 404 }))).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

describe('PKCE', () => {
  it('computes the RFC 7636 S256 example', async () => {
    expect(await s256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('draws 256-bit base64url random values', () => {
    const value = randomValue();
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomValue()).not.toBe(value);
  });
});

describe('safeReturnTo', () => {
  it.each([
    ['#/', '#/'],
    ['#/jobs/0f8fad5b-d9cb-469f-a165-70867728950e', '#/jobs/0f8fad5b-d9cb-469f-a165-70867728950e'],
    ['https://evil.example/', '#/'],
    ['//evil.example', '#/'],
    ['#//evil.example', '#/'],
    ['javascript:alert(1)', '#/'],
    ['#/<script>', '#/'],
    [null, '#/'],
  ])('%s → %s', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });
});

describe('OidcClient', () => {
  it('redirects to the IdP with code + PKCE S256, state and nonce; keeps only those in storage', async () => {
    const h = harness();
    await h.client.beginLogin('#/jobs/abc');
    const url = new URL(h.redirects[0] ?? '');
    expect(url.origin + url.pathname).toBe(METADATA.authorization_endpoint);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'starter-web',
      redirect_uri: `${ORIGIN}/`,
      scope: CONFIG.scope,
      state: 'random-1',
      nonce: 'random-2',
      code_challenge: 'challenge-of-random-3',
      code_challenge_method: 'S256',
    });
    expect(JSON.parse(h.storage.map.get(PENDING_KEY) ?? '{}')).toEqual({
      state: 'random-1',
      nonce: 'random-2',
      verifier: 'random-3',
      returnTo: '#/jobs/abc',
      createdAt: NOW,
    });
  });

  it('exchanges the code with the verifier and keeps the token in memory only', async () => {
    let tokenRequest: URLSearchParams | undefined;
    const h = harness();
    const { state, nonce } = await started(h);
    h.fetch.mockImplementation(async (url, init) => {
      if (url.endsWith('/.well-known/openid-configuration')) return json(METADATA);
      tokenRequest = new URLSearchParams(String(init?.body));
      return goodTokens(nonce);
    });
    const result = await h.client.handleCallback(
      `${ORIGIN}/?code=the-code&state=${state}&iss=${encodeURIComponent(CONFIG.issuer)}`,
    );
    expect(result).toEqual({
      session: {
        accessToken: 'access-token-value',
        expiresAt: NOW + 600_000,
        user: { sub: 'user-1', name: 'alice' },
      },
      returnTo: '#/jobs/abc',
    });
    expect(Object.fromEntries(tokenRequest ?? [])).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: `${ORIGIN}/`,
      client_id: 'starter-web',
      code_verifier: 'random-3',
    });
    // The pending entry is gone and no token was ever written to storage.
    expect(h.storage.map.size).toBe(0);
  });

  it('ignores a URL that is not a callback', async () => {
    const h = harness();
    expect(await h.client.handleCallback(`${ORIGIN}/#/jobs`)).toBeNull();
  });

  it.each([
    ['a foreign state', (s: string) => `state=x${s}`],
    ['no state', () => ''],
    ['another issuer (RFC 9207)', (s: string) => `state=${s}&iss=https%3A%2F%2Fevil.example`],
  ])('rejects a callback with %s', async (_n, query) => {
    const h = harness(() => json({}));
    const { state } = await started(h);
    await expect(h.client.handleCallback(`${ORIGIN}/?code=c&${query(state)}`)).rejects.toThrow();
    expect(h.storage.map.size).toBe(0);
  });

  it('rejects a replayed callback (the pending sign-in is consumed once)', async () => {
    const h = harness();
    const { state, nonce } = await started(h);
    h.fetch.mockImplementation(async (url) =>
      url.endsWith('/.well-known/openid-configuration') ? json(METADATA) : goodTokens(nonce),
    );
    const callback = `${ORIGIN}/?code=c&state=${state}`;
    await h.client.handleCallback(callback);
    await expect(h.client.handleCallback(callback)).rejects.toThrow(/not requested/);
  });

  it('rejects an IdP error response', async () => {
    const h = harness();
    const { state } = await started(h);
    await expect(
      h.client.handleCallback(`${ORIGIN}/?error=access_denied&state=${state}`),
    ).rejects.toThrow(/did not complete/);
  });

  it('rejects a stale pending sign-in', async () => {
    const h = harness();
    const { state } = await started(h);
    const stale = JSON.parse(h.storage.map.get(PENDING_KEY) ?? '{}') as Record<string, unknown>;
    h.storage.map.set(PENDING_KEY, JSON.stringify({ ...stale, createdAt: NOW - 11 * 60_000 }));
    await expect(h.client.handleCallback(`${ORIGIN}/?code=c&state=${state}`)).rejects.toThrow(
      /too long/,
    );
  });

  it.each([
    ['a wrong nonce', { nonce: 'other' }],
    ['another audience', { aud: 'other-client' }],
    ['another issuer', { iss: 'https://evil.example' }],
    ['an expired ID token', { exp: NOW / 1000 - 3_600 }],
  ])('rejects an ID token with %s', async (_n, overrides) => {
    const h = harness();
    const { state, nonce } = await started(h);
    h.fetch.mockImplementation(async (url) =>
      url.endsWith('/.well-known/openid-configuration')
        ? json(METADATA)
        : goodTokens(nonce, overrides),
    );
    await expect(h.client.handleCallback(`${ORIGIN}/?code=c&state=${state}`)).rejects.toThrow(
      /another request/,
    );
  });

  it('rejects a token response without a bearer access token', async () => {
    const h = harness();
    const { state } = await started(h);
    h.fetch.mockImplementation(async (url) =>
      url.endsWith('/.well-known/openid-configuration')
        ? json(METADATA)
        : json({ access_token: 'x', token_type: 'mac', id_token: 'a.b.c' }),
    );
    await expect(h.client.handleCallback(`${ORIGIN}/?code=c&state=${state}`)).rejects.toThrow(
      /expected tokens/,
    );
  });

  it('refuses provider metadata for another issuer', async () => {
    const h = harness();
    h.fetch.mockImplementation(async () => json({ ...METADATA, issuer: 'https://evil.example' }));
    await expect(h.client.beginLogin('#/')).rejects.toThrow(/does not match/);
    expect(h.redirects).toEqual([]);
  });

  it('logs out at the IdP and comes back to this origin', async () => {
    const h = harness();
    await h.client.logout();
    const url = new URL(h.redirects[0] ?? '');
    expect(url.origin + url.pathname).toBe(METADATA.end_session_endpoint);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${ORIGIN}/`);
    expect(url.searchParams.get('id_token_hint')).toBeNull();
  });
});
