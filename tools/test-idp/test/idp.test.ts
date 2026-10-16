/**
 * The TEST-ONLY IdP over real HTTP: authorization code + PKCE (S256) end to end, every
 * rejection path of /authorize and /token, the guard on the test endpoints, CORS, sessions,
 * and the refusal to run outside local/CI. Tokens are verified with jose against /jwks.json.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTestIdpConfig, type TestIdpConfig } from '../src/config.js';
import { createTestIdp } from '../src/idp.js';

const REDIRECT = 'http://127.0.0.1:4173/';

interface Running {
  base: string;
  close(): Promise<void>;
}

const servers: Running[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(
  env: Record<string, string> = {},
): Promise<Running & { config: TestIdpConfig }> {
  // Bind an ephemeral port first: the issuer URL must contain the real port.
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const config = loadTestIdpConfig({
    APP_RUNTIME: 'ci',
    TEST_IDP_PORT: String(port),
    TEST_IDP_REDIRECT_URIS: REDIRECT,
    ...env,
  });
  const idp = await createTestIdp(config);
  server.on('request', (req, res) => void idp.handle(req, res));
  const running = {
    base: `http://127.0.0.1:${port}`,
    config,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  servers.push(running);
  return running;
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function authorizeParams(challenge: string, overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: 'code',
    client_id: 'starter-web-local',
    redirect_uri: REDIRECT,
    scope: 'openid jobs:read jobs:write',
    state: 'state-123',
    nonce: 'nonce-456',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...overrides,
  });
}

/** Signs in as `user` via the form; returns the redirect location and the session cookie. */
async function signIn(base: string, challenge: string, user = 'alice') {
  const form = authorizeParams(challenge);
  form.set('user', user);
  const response = await fetch(`${base}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  });
  expect(response.status).toBe(302);
  return {
    location: new URL(response.headers.get('location') ?? ''),
    cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
  };
}

const redeem = (base: string, fields: Record<string, string>, origin?: string) =>
  fetch(`${base}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(origin ? { origin } : {}),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'starter-web-local',
      redirect_uri: REDIRECT,
      ...fields,
    }),
  });

describe('configuration', () => {
  it.each([undefined, 'aws', 'prod'])('refuses to start with APP_RUNTIME=%s', (runtime) => {
    expect(() => loadTestIdpConfig({ APP_RUNTIME: runtime })).toThrow(/TEST ONLY/);
  });

  it('defaults to loopback, port 9400 and disabled test endpoints', () => {
    expect(loadTestIdpConfig({ APP_RUNTIME: 'local' })).toMatchObject({
      host: '127.0.0.1',
      port: 9400,
      issuer: 'http://127.0.0.1:9400',
      enableTestEndpoints: false,
      users: ['alice', 'bob', 'mallory'],
    });
  });
});

describe('authorization code + PKCE (S256)', () => {
  it('issues an access token for the API and an ID token for the SPA', async () => {
    const idp = await start();
    const discovery = (await (
      await fetch(`${idp.base}/.well-known/openid-configuration`)
    ).json()) as Record<string, unknown>;
    expect(discovery).toMatchObject({
      issuer: idp.base,
      authorization_endpoint: `${idp.base}/authorize`,
      token_endpoint: `${idp.base}/token`,
      jwks_uri: `${idp.base}/jwks.json`,
      code_challenge_methods_supported: ['S256'],
    });

    const { verifier, challenge } = pkce();
    const page = await fetch(`${idp.base}/authorize?${authorizeParams(challenge)}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    const text = await page.text();
    expect(text).toContain('TEST ONLY identity provider');
    for (const user of ['alice', 'bob', 'mallory']) expect(text).toContain(`Sign in as ${user}`);

    const { location } = await signIn(idp.base, challenge, 'bob');
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('state')).toBe('state-123');
    expect(location.searchParams.get('iss')).toBe(idp.base);
    const code = location.searchParams.get('code') ?? '';

    const response = await redeem(
      idp.base,
      { code, code_verifier: verifier },
      'http://127.0.0.1:4173',
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4173');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const tokens = (await response.json()) as {
      access_token: string;
      id_token: string;
      scope: string;
    };
    expect(tokens.scope).toBe('jobs:read jobs:write');

    const jwks = createRemoteJWKSet(new URL(`${idp.base}/jwks.json`));
    const access = await jwtVerify(tokens.access_token, jwks, {
      issuer: idp.base,
      audience: 'starter-jobs-api',
      typ: 'at+jwt',
    });
    expect(access.payload).toMatchObject({
      sub: 'bob',
      scope: 'jobs:read jobs:write',
      client_id: 'starter-web-local',
    });
    expect(access.payload.nonce).toBeUndefined();
    const id = await jwtVerify(tokens.id_token, jwks, {
      issuer: idp.base,
      audience: 'starter-web-local',
    });
    expect(id.payload).toMatchObject({ sub: 'bob', nonce: 'nonce-456', azp: 'starter-web-local' });
    expect(id.payload.scope).toBeUndefined();
  });

  it('grants only the API scopes that were requested', async () => {
    const idp = await start();
    const { verifier, challenge } = pkce();
    const form = authorizeParams(challenge, { scope: 'openid jobs:read' });
    form.set('user', 'alice');
    const response = await fetch(`${idp.base}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      redirect: 'manual',
    });
    const code = new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const tokens = (await (await redeem(idp.base, { code, code_verifier: verifier })).json()) as {
      scope: string;
    };
    expect(tokens.scope).toBe('jobs:read');
  });

  it.each([
    // Change the last character to a DIFFERENT one (a fixed "A" equals it once in 64 runs).
    [
      'a wrong verifier',
      (v: string) => ({ code_verifier: `${v.slice(0, -1)}${v.endsWith('A') ? 'B' : 'A'}` }),
    ],
    ['no verifier', () => ({ code_verifier: '' })],
    [
      'another redirect_uri',
      (v: string) => ({ code_verifier: v, redirect_uri: 'http://127.0.0.1:5173/' }),
    ],
    ['another client', (v: string) => ({ code_verifier: v, client_id: 'evil-client' })],
  ])('rejects the redemption with %s and burns the code', async (_n, fields) => {
    const idp = await start();
    const { verifier, challenge } = pkce();
    const code = (await signIn(idp.base, challenge)).location.searchParams.get('code') ?? '';
    const failed = await redeem(idp.base, { code, ...fields(verifier) });
    expect(failed.status).toBe(400);
    expect(((await failed.json()) as { error: string }).error).toBe('invalid_grant');
    // The code is single use: even the correct verifier fails now.
    const retry = await redeem(idp.base, { code, code_verifier: verifier });
    expect(retry.status).toBe(400);
  });

  it('a code can be redeemed once', async () => {
    const idp = await start();
    const { verifier, challenge } = pkce();
    const code = (await signIn(idp.base, challenge)).location.searchParams.get('code') ?? '';
    expect((await redeem(idp.base, { code, code_verifier: verifier })).status).toBe(200);
    expect((await redeem(idp.base, { code, code_verifier: verifier })).status).toBe(400);
  });

  it.each([
    ['an unregistered redirect_uri', { redirect_uri: 'https://evil.example/cb' }],
    ['a redirect_uri prefix trick', { redirect_uri: `${REDIRECT}evil` }],
    ['an unknown client', { client_id: 'other' }],
    ['the plain PKCE method', { code_challenge_method: 'plain' }],
    ['no code_challenge', { code_challenge: '' }],
    ['the implicit flow', { response_type: 'token' }],
    ['no state', { state: '' }],
    ['no nonce', { nonce: '' }],
    ['no openid scope', { scope: 'jobs:read' }],
  ])('refuses %s without redirecting', async (_n, overrides) => {
    const idp = await start();
    const response = await fetch(
      `${idp.base}/authorize?${authorizeParams(pkce().challenge, overrides)}`,
      {
        redirect: 'manual',
      },
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    const body = await response.text();
    expect(body).toContain('Request rejected');
    expect(body).not.toContain('evil.example/cb"');
  });

  it('escapes reflected values on the sign-in page', async () => {
    const idp = await start();
    const page = await (
      await fetch(
        `${idp.base}/authorize?${authorizeParams(pkce().challenge, { state: '"><script>x</script>' })}`,
      )
    ).text();
    expect(page).not.toContain('<script>x</script>');
    expect(page).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('only accepts the three test users', async () => {
    const idp = await start();
    const form = authorizeParams(pkce().challenge);
    form.set('user', 'admin');
    const response = await fetch(`${idp.base}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      redirect: 'manual',
    });
    expect(response.status).toBe(400);
  });

  it('remembers the signed-in user (session cookie) unless prompt=login, until logout', async () => {
    const idp = await start();
    const { challenge } = pkce();
    const { cookie } = await signIn(idp.base, challenge, 'mallory');
    expect(cookie).toMatch(/^test_idp_session=/);
    const silent = await fetch(`${idp.base}/authorize?${authorizeParams(challenge)}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(silent.status).toBe(302);
    const forced = await fetch(
      `${idp.base}/authorize?${authorizeParams(challenge, { prompt: 'login' })}`,
      {
        headers: { cookie },
        redirect: 'manual',
      },
    );
    expect(forced.status).toBe(200);
    const logout = await fetch(
      `${idp.base}/logout?${new URLSearchParams({ post_logout_redirect_uri: REDIRECT })}`,
      { headers: { cookie }, redirect: 'manual' },
    );
    expect(logout.status).toBe(302);
    expect(logout.headers.get('location')).toBe(REDIRECT);
    const after = await fetch(`${idp.base}/authorize?${authorizeParams(challenge)}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(after.status).toBe(200);
  });

  it('never redirects a logout to an unregistered URI', async () => {
    const idp = await start();
    const response = await fetch(
      `${idp.base}/logout?${new URLSearchParams({ post_logout_redirect_uri: 'https://evil.example/' })}`,
      { redirect: 'manual' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('answers CORS only for registered SPA origins', async () => {
    const idp = await start();
    const allowed = await fetch(`${idp.base}/jwks.json`, {
      headers: { origin: 'http://127.0.0.1:4173' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4173');
    const denied = await fetch(`${idp.base}/jwks.json`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(`${idp.base}/token`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:4173', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST');
  });
});

describe('test endpoints', () => {
  it('do not exist unless TEST_IDP_ENABLE_TEST_ENDPOINTS=true', async () => {
    const idp = await start();
    expect((await fetch(`${idp.base}/test/token`, { method: 'POST', body: '{}' })).status).toBe(
      404,
    );
    expect((await fetch(`${idp.base}/test/rotate`, { method: 'POST', body: '{}' })).status).toBe(
      404,
    );
  });

  it('mint tokens with claim overrides and negative-case options, and rotate keys', async () => {
    const idp = await start({ TEST_IDP_ENABLE_TEST_ENDPOINTS: 'true' });
    const jwks = createRemoteJWKSet(new URL(`${idp.base}/jwks.json`));
    const minted = (await (
      await fetch(`${idp.base}/test/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sub: 'it-runner', scope: 'jobs:read', claims: { tenant: 'x' } }),
      })
    ).json()) as { access_token: string };
    const verified = await jwtVerify(minted.access_token, jwks, {
      issuer: idp.base,
      audience: 'starter-jobs-api',
    });
    expect(verified.payload).toMatchObject({ sub: 'it-runner', scope: 'jobs:read', tenant: 'x' });

    const expired = (await (
      await fetch(`${idp.base}/test/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ options: { expiresInSeconds: -600 } }),
      })
    ).json()) as { access_token: string };
    await expect(jwtVerify(expired.access_token, jwks, { issuer: idp.base })).rejects.toThrow(
      /exp/,
    );

    const rotated = (await (
      await fetch(`${idp.base}/test/rotate`, { method: 'POST', body: '{}' })
    ).json()) as { previousKid: string; activeKid: string };
    expect(rotated.activeKid).not.toBe(rotated.previousKid);
    const keys = (await (await fetch(`${idp.base}/jwks.json`)).json()) as {
      keys: { kid: string }[];
    };
    expect(keys.keys.map((k) => k.kid)).toEqual([rotated.activeKid]);
  });
});
