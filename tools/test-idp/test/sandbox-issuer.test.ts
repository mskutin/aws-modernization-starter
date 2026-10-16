/**
 * Offline end-to-end check of the AWS sandbox identity design:
 *
 *   sandbox-issuer keygen → export (static discovery + JWKS for S3/CloudFront)
 *   → the TEST-ONLY IdP on loopback with that key and an https issuer it does not serve
 *   → tokens for alice and bob (POST /test/token and the code + PKCE flow)
 *   → verified with jose against the EXPORTED jwks.json, and with the API's own TokenVerifier +
 *     RemoteJwksSource fetching the exported files from a stub standing in for the issuer URL
 *     (discovery and AUTH_JWKS_URI variants), configured as the sandbox API is.
 *
 * Negative controls: expired, signed by another key (unknown kid and forged under the published
 * kid), another run's key, a forged subject, wrong audience, alg=none, an RS256 token of an
 * in-memory IdP with the same issuer string, the SPA's ID token. Each must be refused; a test fails
 * if any of them is accepted.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { RemoteJwksSource, TokenVerifier } from '@starter/api/dist/auth/index.js';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestIdpConfigError, loadTestIdpConfig } from '../src/config.js';
import { createTestIdp } from '../src/idp.js';
import { parseSandboxIssuer, runSandboxIssuerCli } from '../src/sandbox-cli.js';
import { SigningKeyError } from '../src/signing-key.js';
import { cleanup, mintViaIdp, startIdp, tempDir } from './support.js';

const ISSUER = 'https://d111111abcdef8.cloudfront.net';
const SPA = 'https://d222222abcdef8.cloudfront.net';
const AUDIENCE = 'starter-jobs-api-sandbox';
const CLIENT_ID = 'starter-web-sandbox';

const c = cleanup();
afterEach(() => c.run());

async function cli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runSandboxIssuerCli(argv, {
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** keygen + export into a fresh run directory, as the lifecycle script does. */
async function prepareRun(issuer = ISSUER) {
  const run = tempDir(c);
  const keyFile = join(run, 'issuer-key.jwk');
  const keygen = await cli(['keygen', '--out', keyFile]);
  expect(keygen.code, keygen.err).toBe(0);
  const docs = join(run, 'issuer-docs');
  const exported = await cli(['export', '--issuer', issuer, '--key', keyFile, '--out', docs]);
  expect(exported.code, exported.err).toBe(0);
  const d = (JSON.parse(readFileSync(keyFile, 'utf8')) as { d: string }).d;
  return {
    keyFile,
    d,
    keygenOut: keygen.out,
    exportOut: exported.out,
    discovery: readFileSync(join(docs, 'openid-configuration'), 'utf8'),
    jwks: readFileSync(join(docs, 'jwks.json'), 'utf8'),
    docs,
  };
}

const sandboxIdpEnv = (keyFile: string): Record<string, string> => ({
  TEST_IDP_ISSUER: ISSUER,
  TEST_IDP_SIGNING_KEY_FILE: keyFile,
  TEST_IDP_AUDIENCE: AUDIENCE,
  TEST_IDP_CLIENT_ID: CLIENT_ID,
  TEST_IDP_REDIRECT_URIS: `${SPA}/`,
  TEST_IDP_ENABLE_TEST_ENDPOINTS: 'true',
});

/**
 * The API's verifier as the sandbox task definition configures it (APP_RUNTIME=aws: https only,
 * ES256, exact issuer/audience, the SPA client allow-list), with its JWKS source fetching from a
 * stub that serves the exported files at the issuer URL. Records every URL it was asked for.
 */
function sandboxApiVerifier(files: { discovery: string; jwks: string }, jwksUri?: string) {
  const served = new Map([
    [`${ISSUER}/.well-known/openid-configuration`, files.discovery],
    [`${ISSUER}/jwks.json`, files.jwks],
  ]);
  const requested: string[] = [];
  const keys = new RemoteJwksSource({
    issuer: ISSUER,
    jwksUri,
    allowInsecure: false,
    algorithms: ['ES256'],
    logger: { info: () => undefined, warn: () => undefined },
    fetch: async (url, init) => {
      requested.push(url);
      expect(init.redirect).toBe('error');
      const body = served.get(url);
      return body === undefined
        ? new Response('not found', { status: 404 })
        : new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const verifier = new TokenVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['ES256'],
    clockToleranceSeconds: 30,
    maxTokenAgeSeconds: 3600,
    allowedClientIds: [CLIENT_ID],
    keys,
  });
  return { verifier, requested };
}

describe('sandbox-issuer CLI', () => {
  it('keygen and export print no key material; the export holds only the public key', async () => {
    const run = await prepareRun();
    for (const text of [run.keygenOut, run.exportOut, run.discovery, run.jwks]) {
      expect(text).not.toContain(run.d);
      expect(text).not.toMatch(/"(d|p|q|dp|dq|qi|oth|k)"\s*:/);
    }
    const jwks = JSON.parse(run.jwks) as { keys: Record<string, unknown>[] };
    expect(jwks.keys).toHaveLength(1);
    expect(Object.keys(jwks.keys[0] ?? {}).sort()).toEqual(
      ['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y'].sort(),
    );
    expect(JSON.parse(run.exportOut)).toMatchObject({
      issuer: ISSUER,
      alg: 'ES256',
      kid: jwks.keys[0]?.kid,
      files: [
        { key: '.well-known/openid-configuration', contentType: 'application/json' },
        { key: 'jwks.json', contentType: 'application/json' },
      ],
    });
    expect(statSync(run.keyFile).mode & 0o777).toBe(0o600);
  });

  it('writes the discovery document the contract requires', async () => {
    const discovery = JSON.parse((await prepareRun()).discovery) as Record<string, unknown>;
    expect(discovery).toMatchObject({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/jwks.json`,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      id_token_signing_alg_values_supported: ['ES256'],
      scopes_supported: ['openid', 'profile', 'jobs:read', 'jobs:write'],
    });
  });

  it.each([
    ['http://d111111abcdef8.cloudfront.net', /https/],
    ['https://d111111abcdef8.cloudfront.net/realm', /without a path/],
    ['https://d111111abcdef8.cloudfront.net/?x=1', /query/],
    ['https://user:pw@d111111abcdef8.cloudfront.net', /credentials/],
    ['d111111abcdef8.cloudfront.net', /absolute/],
  ])('export refuses the issuer %s', async (issuer, pattern) => {
    const run = await prepareRun();
    const result = await cli([
      'export',
      '--issuer',
      issuer,
      '--key',
      run.keyFile,
      '--out',
      run.docs,
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(pattern);
  });

  it.each([
    `${ISSUER}/`,
    ISSUER.toUpperCase(),
    'HTTPS://D111111ABCDEF8.CloudFront.net:443/',
    `${ISSUER}:443`,
  ])('export and TEST_IDP_ISSUER normalise %s to the same issuer', async (pasted) => {
    expect(parseSandboxIssuer(pasted)).toBe(ISSUER);
    expect(loadTestIdpConfig({ APP_RUNTIME: 'local', TEST_IDP_ISSUER: pasted }).issuer).toBe(
      ISSUER,
    );
    // ...and the IdP started with the pasted value serves the exported discovery document.
    const run = await prepareRun(pasted);
    const { base } = await startIdp(c, { ...sandboxIdpEnv(run.keyFile), TEST_IDP_ISSUER: pasted });
    expect(await (await fetch(`${base}/.well-known/openid-configuration`)).json()).toEqual(
      JSON.parse(run.discovery),
    );
    const { payload } = await jwtVerify(
      await mintViaIdp(base, { sub: 'alice' }),
      createLocalJWKSet(JSON.parse(run.jwks) as { keys: [] }),
    );
    expect(payload.iss).toBe(ISSUER);
  });

  it.each([
    ['http://d111111abcdef8.cloudfront.net/realm', /without a path/],
    ['ftp://d111111abcdef8.cloudfront.net', /http\(s\)/],
    ['http://user:pw@127.0.0.1:9400', /credentials/],
  ])('TEST_IDP_ISSUER refuses %s like export does', (issuer, pattern) => {
    expect(() => loadTestIdpConfig({ APP_RUNTIME: 'local', TEST_IDP_ISSUER: issuer })).toThrow(
      pattern,
    );
  });

  it('keeps the local http issuer unchanged', () => {
    for (const issuer of ['http://127.0.0.1:9400', 'http://127.0.0.1:9400/']) {
      expect(loadTestIdpConfig({ APP_RUNTIME: 'local', TEST_IDP_ISSUER: issuer }).issuer).toBe(
        'http://127.0.0.1:9400',
      );
    }
    expect(loadTestIdpConfig({ APP_RUNTIME: 'local', TEST_IDP_PORT: '19400' }).issuer).toBe(
      'http://127.0.0.1:19400',
    );
  });

  it('export refuses a key file with a loose mode, and usage errors exit 2', async () => {
    const run = await prepareRun();
    chmodSync(run.keyFile, 0o644);
    const loose = await cli([
      'export',
      '--issuer',
      ISSUER,
      '--key',
      run.keyFile,
      '--out',
      run.docs,
    ]);
    expect(loose.code).toBe(1);
    expect(loose.err).toMatch(/mode 0600/);
    expect((await cli(['keygen'])).code).toBe(2);
    expect((await cli(['keygen', '--out', 'x', '--force'])).code).toBe(2);
    expect((await cli(['rotate'])).code).toBe(2);
    expect((await cli([])).code).toBe(2);
  });
});

describe('the local IdP with the run key and an https issuer', () => {
  it('serves exactly the exported discovery document and JWK Set', async () => {
    const run = await prepareRun();
    const { base, idp } = await startIdp(c, sandboxIdpEnv(run.keyFile));
    expect(idp.keySource).toBe('file');
    const discovery = await (await fetch(`${base}/.well-known/openid-configuration`)).json();
    const jwks = await (await fetch(`${base}/jwks.json`)).json();
    expect(discovery).toEqual(JSON.parse(run.discovery));
    expect(jwks).toEqual(JSON.parse(run.jwks));
  });

  it.each([
    ['OIDC discovery', undefined],
    ['AUTH_JWKS_URI', `${ISSUER}/jwks.json`],
  ])(
    'mints alice and bob tokens the sandbox API accepts as distinct principals (%s)',
    async (_mode, jwksUri) => {
      const run = await prepareRun();
      const { base } = await startIdp(c, sandboxIdpEnv(run.keyFile));
      const { verifier, requested } = sandboxApiVerifier(run, jwksUri);
      const exportedKeys = createLocalJWKSet(JSON.parse(run.jwks) as { keys: [] });
      const kid = (JSON.parse(run.jwks) as { keys: { kid: string }[] }).keys[0]?.kid;

      const principals = [];
      for (const user of ['alice', 'bob']) {
        const token = await mintViaIdp(base, { sub: user });
        expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'ES256', kid, typ: 'at+jwt' });
        const { payload } = await jwtVerify(token, exportedKeys, {
          issuer: ISSUER,
          audience: AUDIENCE,
          algorithms: ['ES256'],
          typ: 'at+jwt',
          requiredClaims: ['sub', 'iat', 'exp', 'client_id', 'scope'],
        });
        expect(payload).toMatchObject({
          iss: ISSUER,
          aud: AUDIENCE,
          sub: user,
          client_id: CLIENT_ID,
          scope: 'jobs:read jobs:write',
        });
        expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(600);

        const result = await verifier.verifyAuthorizationHeader(`Bearer ${token}`);
        if (!result.ok) throw new Error(`API verifier refused ${user}: ${result.reason}`);
        expect(result.principal.subject).toBe(user);
        expect([...result.principal.scopes].sort()).toEqual(['jobs:read', 'jobs:write']);
        principals.push(result.principal);
      }
      expect(principals[0]?.key).not.toBe(principals[1]?.key);
      expect(requested).toEqual(
        jwksUri ? [jwksUri] : [`${ISSUER}/.well-known/openid-configuration`, `${ISSUER}/jwks.json`],
      );
    },
  );

  it('refuses expired, foreign-key, forged, wrong-audience, alg=none and other-IdP tokens', async () => {
    const run = await prepareRun();
    const other = await prepareRun();
    const { base } = await startIdp(c, sandboxIdpEnv(run.keyFile));
    const { base: otherRunBase } = await startIdp(c, sandboxIdpEnv(other.keyFile));
    const { base: memoryKeyBase } = await startIdp(c, {
      ...sandboxIdpEnv(run.keyFile),
      TEST_IDP_SIGNING_KEY_FILE: '',
    });
    const { verifier } = sandboxApiVerifier(run);
    const exportedKeys = createLocalJWKSet(JSON.parse(run.jwks) as { keys: [] });
    const activeKid = (JSON.parse(run.jwks) as { keys: { kid: string }[] }).keys[0]?.kid ?? '';

    // Positive control first: the same verifier accepts a valid token of this run.
    expect((await verifier.verifyToken(await mintViaIdp(base, { sub: 'alice' }))).ok).toBe(true);

    const cases: [string, Promise<string>, string][] = [
      [
        'expired',
        mintViaIdp(base, { sub: 'alice', options: { expiresInSeconds: -600 } }),
        'expired',
      ],
      [
        'another key, unknown kid',
        mintViaIdp(base, { sub: 'alice', options: { foreignKey: true } }),
        'unknown_key',
      ],
      [
        'another key under the published kid',
        mintViaIdp(base, { sub: 'alice', options: { foreignKey: true, kid: activeKid } }),
        'bad_signature',
      ],
      [
        'another run of the sandbox (its own key file)',
        mintViaIdp(otherRunBase, { sub: 'alice' }),
        'unknown_key',
      ],
      [
        'alice re-labelled as bob',
        mintViaIdp(base, { sub: 'alice', options: { tamperPayload: { sub: 'bob' } } }),
        'bad_signature',
      ],
      [
        'wrong audience',
        mintViaIdp(base, { sub: 'alice', options: { audience: 'some-other-api' } }),
        'audience_mismatch',
      ],
      [
        'alg=none',
        mintViaIdp(base, { sub: 'alice', options: { algNone: true } }),
        'alg_not_allowed',
      ],
      [
        'in-memory RS256 key, same issuer string',
        mintViaIdp(memoryKeyBase, { sub: 'alice' }),
        'alg_not_allowed',
      ],
      [
        'another client',
        mintViaIdp(base, { sub: 'alice', options: { clientId: 'some-other-client' } }),
        'client_not_allowed',
      ],
    ];
    for (const [name, pending, reason] of cases) {
      const token = await pending;
      const result = await verifier.verifyToken(token);
      expect(result, name).toEqual({ ok: false, reason, tokenPresented: true });
      if (name !== 'another client') {
        await expect(
          jwtVerify(token, exportedKeys, {
            issuer: ISSUER,
            audience: AUDIENCE,
            algorithms: ['ES256'],
          }),
          name,
        ).rejects.toThrow();
      }
    }
  });

  it('completes authorization code + PKCE for the SPA origin; the API takes the access token, not the ID token', async () => {
    const run = await prepareRun();
    const { base } = await startIdp(c, sandboxIdpEnv(run.keyFile));
    const { verifier } = sandboxApiVerifier(run);
    const verifierString = randomBytes(32).toString('base64url');
    const request = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: `${SPA}/`,
      scope: 'openid jobs:read jobs:write',
      state: 'state-sbx',
      nonce: 'nonce-sbx',
      code_challenge: createHash('sha256').update(verifierString).digest('base64url'),
      code_challenge_method: 'S256',
    });

    // The sign-in page posts to a RELATIVE /authorize: it works when the browser reached it as
    // https://<issuer>/authorize (Playwright routing).
    const page = await (await fetch(`${base}/authorize?${request}`)).text();
    expect(page).toContain('<form method="post" action="/authorize">');
    expect(page).not.toContain('127.0.0.1');

    request.set('user', 'bob');
    const signIn = await fetch(`${base}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: request,
      redirect: 'manual',
    });
    expect(signIn.status).toBe(302);
    expect(signIn.headers.get('set-cookie')).toMatch(/; Secure; Max-Age=/);
    const location = new URL(signIn.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(`${SPA}/`);
    expect(location.searchParams.get('iss')).toBe(ISSUER);

    const tokenResponse = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SPA },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: location.searchParams.get('code') ?? '',
        redirect_uri: `${SPA}/`,
        client_id: CLIENT_ID,
        code_verifier: verifierString,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.headers.get('access-control-allow-origin')).toBe(SPA);
    const tokens = (await tokenResponse.json()) as { access_token: string; id_token: string };

    const access = await verifier.verifyToken(tokens.access_token);
    if (!access.ok) throw new Error(`API verifier refused the access token: ${access.reason}`);
    expect(access.principal.subject).toBe('bob');
    expect(await verifier.verifyToken(tokens.id_token)).toEqual({
      ok: false,
      reason: 'audience_mismatch',
      tokenPresented: true,
    });
    const id = await jwtVerify(
      tokens.id_token,
      createLocalJWKSet(JSON.parse(run.jwks) as { keys: [] }),
      {
        issuer: ISSUER,
        audience: CLIENT_ID,
      },
    );
    expect(id.payload).toMatchObject({ sub: 'bob', nonce: 'nonce-sbx', azp: CLIENT_ID });
  });

  it('refuses /test/rotate (static published JWKS) and keeps serving the same key', async () => {
    const run = await prepareRun();
    const { base } = await startIdp(c, sandboxIdpEnv(run.keyFile));
    const rotate = await fetch(`${base}/test/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(rotate.status).toBe(409);
    expect(((await rotate.json()) as { error: string }).error).toBe('rotation_unavailable');
    expect(await (await fetch(`${base}/jwks.json`)).json()).toEqual(JSON.parse(run.jwks));
  });

  it('mints tokens for the configured SPA client by default; callers may still override it', async () => {
    const run = await prepareRun();
    const { base } = await startIdp(c, sandboxIdpEnv(run.keyFile));
    const keys = createLocalJWKSet(JSON.parse(run.jwks) as { keys: [] });
    const verify = async (token: string) => (await jwtVerify(token, keys)).payload;
    expect((await verify(await mintViaIdp(base, { sub: 'x' }))).client_id).toBe(CLIENT_ID);
    expect(
      (await verify(await mintViaIdp(base, { sub: 'x', claims: { client_id: 'c2' } }))).client_id,
    ).toBe('c2');
  });

  it('refuses a key file with a non-loopback listen address (no off-host minting)', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.internal']) {
      expect(() =>
        loadTestIdpConfig({
          APP_RUNTIME: 'local',
          TEST_IDP_HOST: host,
          TEST_IDP_SIGNING_KEY_FILE: '/nonexistent/issuer-key.jwk',
        }),
      ).toThrow(TestIdpConfigError);
    }
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      expect(
        loadTestIdpConfig({
          APP_RUNTIME: 'local',
          TEST_IDP_HOST: host,
          TEST_IDP_SIGNING_KEY_FILE: '/nonexistent/issuer-key.jwk',
        }).signingKeyFile,
      ).toBe('/nonexistent/issuer-key.jwk');
    }
  });

  it('still refuses APP_RUNTIME=aws with a key file', async () => {
    const run = await prepareRun();
    expect(() =>
      loadTestIdpConfig({ APP_RUNTIME: 'aws', TEST_IDP_SIGNING_KEY_FILE: run.keyFile }),
    ).toThrow(/TEST ONLY/);
  });

  it('does not start with a key file it must refuse', async () => {
    const run = await prepareRun();
    chmodSync(run.keyFile, 0o640);
    const config = loadTestIdpConfig({ APP_RUNTIME: 'local', ...sandboxIdpEnv(run.keyFile) });
    await expect(createTestIdp(config)).rejects.toBeInstanceOf(SigningKeyError);
  });
});

/** A raw HTTP request with an explicit (possibly hostile) Host header; fetch cannot set one. */
function raw(
  base: string,
  options: {
    method?: string;
    path: string;
    host?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; body: string }> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path,
        setHost: options.host !== undefined,
        headers: {
          ...(options.host !== undefined ? { host: options.host } : {}),
          ...options.headers,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('DNS-rebinding guard of a key-file IdP', () => {
  const JSON_POST = { 'content-type': 'application/json' };

  it.each(['127.0.0.1', 'localhost', '[::1]'])(
    'answers requests addressed to %s:<its port>',
    async (name) => {
      const run = await prepareRun();
      const { base } = await startIdp(c, sandboxIdpEnv(run.keyFile));
      const host = `${name}:${new URL(base).port}`;
      const minted = await raw(base, {
        method: 'POST',
        path: '/test/token',
        host,
        headers: JSON_POST,
        body: '{"sub":"alice"}',
      });
      expect(minted.status).toBe(200);
      expect((await raw(base, { path: '/healthz', host })).status).toBe(200);
    },
  );

  it('refuses every endpoint for any other Host (rebinding name, wrong port, none)', async () => {
    const run = await prepareRun();
    const { base } = await startIdp(c, sandboxIdpEnv(run.keyFile));
    const port = new URL(base).port;
    const hosts = [
      `rebind.attacker.example:${port}`,
      'rebind.attacker.example',
      `127.0.0.1:${Number(port) + 1}`,
      `127.0.0.1.attacker.example:${port}`,
      undefined, // no Host header at all
    ];
    const requests = [
      { method: 'POST', path: '/test/token', headers: JSON_POST, body: '{"sub":"alice"}' },
      { method: 'GET', path: '/authorize?client_id=starter-web-sandbox' },
      {
        method: 'POST',
        path: '/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=authorization_code',
      },
      { method: 'GET', path: '/jwks.json' },
      { method: 'GET', path: '/.well-known/openid-configuration' },
    ];
    for (const host of hosts) {
      for (const request of requests) {
        const response = await raw(base, { ...request, host });
        // No Host at all is already refused by node:http (HTTP/1.1 requires it) with 400.
        expect(response.status, `${request.method} ${request.path} Host=${host}`).toBe(
          host === undefined ? 400 : 421,
        );
        expect(response.body).not.toMatch(/eyJ[\w-]+\./);
      }
    }
  });

  it.each([undefined, 'text/plain', 'application/x-www-form-urlencoded'])(
    'refuses test endpoints without content-type application/json (%s)',
    async (contentType) => {
      const run = await prepareRun();
      const { base } = await startIdp(c, sandboxIdpEnv(run.keyFile));
      const host = `127.0.0.1:${new URL(base).port}`;
      const headers: Record<string, string> = contentType ? { 'content-type': contentType } : {};
      for (const path of ['/test/token', '/test/rotate']) {
        const response = await raw(base, {
          method: 'POST',
          path,
          host,
          headers,
          body: '{"sub":"alice"}',
        });
        expect(response.status, path).toBe(415);
        expect(response.body).not.toMatch(/eyJ[\w-]+\./);
      }
    },
  );

  it('leaves the in-memory (local/CI) IdP unrestricted: compose reaches it as test-idp:9400', async () => {
    const { base } = await startIdp(c, { TEST_IDP_ENABLE_TEST_ENDPOINTS: 'true' });
    expect((await raw(base, { path: '/jwks.json', host: 'test-idp:9400' })).status).toBe(200);
    expect(
      (await raw(base, { method: 'POST', path: '/test/token', host: 'test-idp:9400', body: '{}' }))
        .status,
    ).toBe(200);
  });
});

describe('test helper mintViaIdp (SAST node_ssrf: loopback allowlist)', () => {
  it.each([
    'http://idp.example:9400',
    'http://10.0.0.5:9400',
    'http://127.0.0.1.nip.io:9400',
    'https://127.0.0.1:9400',
    'file:///tmp/x',
  ])('refuses %s without sending a request', async (base) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'));
    try {
      await expect(mintViaIdp(base, { sub: 'alice' })).rejects.toThrow(/only a loopback http IdP/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
