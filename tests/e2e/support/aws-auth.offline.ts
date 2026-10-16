/**
 * OFFLINE self-test of the aws-test-issuer routing helper (support/aws-auth.ts):
 * the routed sign-in runs here before it runs against the billed sandbox. No AWS, no internet.
 *
 *   pnpm build && pnpm --filter @starter/tests-e2e run test:aws-auth-offline
 *
 * Needs Playwright Chromium (`pnpm --filter @starter/tests-e2e browsers:install`), `openssl` on PATH,
 * and the built apps/web, apps/api, infra and tools/test-idp (`pnpm build`).
 *
 * What stands in for AWS: ONE local HTTPS server (a throwaway self-signed certificate made with
 * openssl per run) that Chromium reaches for two names through --host-resolver-rules:
 *   https://spa.sbx.test     the built SPA with the stack's CSP and /config.json (the functions the
 *                            CDK construct uses), and /v1/* answered after verifying the bearer token
 *                            with the API's own TokenVerifier against the exported JWKS
 *   https://issuer.sbx.test  ONLY /.well-known/openid-configuration and /jwks.json (CORS *), 403 for
 *                            anything else — like the S3 + CloudFront test issuer
 * The real operator tooling does the rest: `sandbox-issuer keygen/export`, the TEST-ONLY IdP on
 * loopback with the key file (Host guard on), and the routing helper — once through the lifecycle's
 * prepareContext (auth-mode.ts, what the specs use) and once directly.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  chromium,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { prepareContext } from './auth-mode.js';
import {
  awsTestIssuerOptionsFromEnv,
  forwardedRequestHeaders,
  fulfilledResponseHeaders,
  installAwsTestIssuerRoutes,
  isRoutedIssuerUrl,
  normalizeAwsTestIssuerOptions,
  rewriteIdpLocation,
} from './aws-auth.js';

const ISSUER = 'https://issuer.sbx.test';
const SPA = 'https://spa.sbx.test';
const AUDIENCE = 'starter-jobs-api-sandbox';
const CLIENT_ID = 'starter-web-sandbox';
const SCOPE = 'openid jobs:read jobs:write';
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const JWT = /eyJ[\w-]+\.[\w-]+\./;

// ── Pure functions (no browser) ─────────────────────────────────────────────────────────────

test.describe('aws-auth helper: options, matcher, headers', () => {
  test('options from the environment', () => {
    expect(awsTestIssuerOptionsFromEnv({})).toBeUndefined();
    expect(awsTestIssuerOptionsFromEnv({ E2E_AUTH_MODE: 'local' })).toBeUndefined();
    expect(
      awsTestIssuerOptionsFromEnv({ E2E_AUTH_MODE: 'aws-test-issuer', E2E_ISSUER: `${ISSUER}/` }),
    ).toEqual({ issuer: ISSUER, idpUrl: 'http://127.0.0.1:9400' });
    expect(() => awsTestIssuerOptionsFromEnv({ E2E_AUTH_MODE: 'aws' })).toThrow(/E2E_AUTH_MODE/);
    expect(() => awsTestIssuerOptionsFromEnv({ E2E_AUTH_MODE: 'aws-test-issuer' })).toThrow(
      /E2E_ISSUER/,
    );
  });

  test('refuses a non-https issuer, an issuer with a path and a non-loopback IdP', () => {
    const ok = { issuer: ISSUER, idpUrl: 'http://127.0.0.1:9400' };
    expect(normalizeAwsTestIssuerOptions({ ...ok, issuer: 'HTTPS://Issuer.SBX.test/' })).toEqual(
      ok,
    );
    for (const issuer of ['http://issuer.sbx.test', `${ISSUER}/realm`, `${ISSUER}/?q=1`]) {
      expect(() => normalizeAwsTestIssuerOptions({ ...ok, issuer }), issuer).toThrow(/E2E_ISSUER/);
    }
    for (const idpUrl of ['http://10.0.0.5:9400', 'http://idp.example:9400', 'file:///tmp/x']) {
      expect(() => normalizeAwsTestIssuerOptions({ ...ok, idpUrl }), idpUrl).toThrow(/E2E_IDP_URL/);
    }
    for (const idpUrl of ['http://localhost:9400', 'http://[::1]:9400', 'http://127.0.0.2:9400']) {
      expect(normalizeAwsTestIssuerOptions({ ...ok, idpUrl }).idpUrl).toBe(idpUrl);
    }
  });

  test('waitFor polls only a loopback http URL and sends nothing elsewhere', async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      return Promise.reject(new Error('no network in this check'));
    };
    try {
      const running = { exitCode: null } as ChildProcess;
      for (const url of [
        'http://idp.invalid:9400/healthz',
        'http://192.0.2.1:9400/healthz',
        'http://127.0.0.1.nip.io:9400/healthz',
        'https://127.0.0.1:9400/healthz',
      ]) {
        await expect(waitFor(url, 0, running), url).rejects.toThrow(/only a loopback http URL/);
      }
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('routes exactly /authorize, /token and /logout of the exact issuer origin', () => {
    const routed = (u: string) => isRoutedIssuerUrl(new URL(u), ISSUER);
    for (const u of [
      `${ISSUER}/authorize?client_id=x`,
      `${ISSUER}/token`,
      `${ISSUER}/logout?a=b`,
    ]) {
      expect(routed(u), u).toBe(true);
    }
    for (const u of [
      `${ISSUER}/.well-known/openid-configuration`,
      `${ISSUER}/jwks.json`,
      `${ISSUER}/authorize/x`,
      `${ISSUER}/authorizeX`,
      `${ISSUER}/test/token`,
      'http://issuer.sbx.test/authorize',
      'https://issuer.sbx.test:8443/authorize',
      'https://issuer.sbx.test.attacker.example/authorize',
      `${SPA}/authorize`,
    ]) {
      expect(routed(u), u).toBe(false);
    }
  });

  test('request headers: hop-by-hop and pseudo headers dropped, the rest kept', () => {
    expect(
      forwardedRequestHeaders({
        Host: 'issuer.sbx.test',
        ':authority': 'issuer.sbx.test',
        'Content-Length': '12',
        connection: 'keep-alive',
        Cookie: 'test_idp_session=abc',
        Origin: SPA,
        'content-type': 'application/x-www-form-urlencoded',
      }),
    ).toEqual({
      cookie: 'test_idp_session=abc',
      origin: SPA,
      'content-type': 'application/x-www-form-urlencoded',
    });
  });

  test('response headers: Location at the IdP rewritten, cookies kept apart, lengths dropped', () => {
    const options = { issuer: ISSUER, idpUrl: 'http://127.0.0.1:9400' };
    const headers = new Headers({
      location: 'http://127.0.0.1:9400/authorize?x=1',
      'content-length': '0',
      'content-encoding': 'gzip',
      'cache-control': 'no-store',
    });
    headers.append('set-cookie', 'a=1; Path=/; Secure');
    headers.append('set-cookie', 'b=2; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT');
    const out = fulfilledResponseHeaders(new Response(null, { status: 302, headers }), options);
    expect(out).toEqual({
      location: `${ISSUER}/authorize?x=1`,
      'cache-control': 'no-store',
      'set-cookie': 'a=1; Path=/; Secure\nb=2; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
    });
    expect(rewriteIdpLocation(`${SPA}/?code=c&state=s`, options)).toBe(`${SPA}/?code=c&state=s`);
    expect(rewriteIdpLocation('/authorize?x=1', options)).toBe('/authorize?x=1');
    expect(rewriteIdpLocation('http://127.0.0.1:9401/x', options)).toBe('http://127.0.0.1:9401/x');
  });
});

// ── The routed sign-in in Chromium ──────────────────────────────────────────────────────────

interface Principal {
  subject: string;
  key: string;
}
type Verification = { ok: true; principal: Principal } | { ok: false; reason: string };
interface ApiAuthModule {
  TokenVerifier: new (options: {
    issuer: string;
    audience: string;
    algorithms: string[];
    clockToleranceSeconds: number;
    maxTokenAgeSeconds: number;
    allowedClientIds: string[];
    keys: unknown;
  }) => { verifyAuthorizationHeader(header: string | undefined): Promise<Verification> };
  StaticKeySource: new (jwks: unknown) => unknown;
}
interface SpaHostingModule {
  contentSecurityPolicy(auth: { issuer: string; clientId: string; scope: string }): string;
  spaRuntimeConfig(auth: { issuer: string; clientId: string; scope: string }): string;
}

/** Built artifacts this check runs (fails with the command to produce them). */
function built(relative: string): string {
  const path = join(REPO, relative);
  if (!existsSync(path)) throw new Error(`${relative} is missing: run \`pnpm build\` first`);
  return path;
}

async function freePort(): Promise<number> {
  const probe = createHttpServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Hosts this offline check may poll: the IdP child process it started on this machine. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Polls `url` until it answers 2xx; refuses anything but plain http on a loopback host. */
async function waitFor(url: string, deadlineMs: number, idp: ChildProcess): Promise<void> {
  const target = new URL(url);
  if (target.protocol === 'http:' && LOOPBACK_HOSTS.has(target.hostname)) {
    const until = Date.now() + deadlineMs;
    for (let delay = 50; ; delay = Math.min(delay * 2, 500)) {
      if (idp.exitCode !== null) throw new Error(`the test IdP exited with ${idp.exitCode}`);
      try {
        if ((await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(1_000) })).ok)
          return;
      } catch {
        // not listening yet
      }
      if (Date.now() > until) throw new Error(`${url} did not answer within ${deadlineMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`waitFor polls only a loopback http URL (offline check), not ${target.origin}`);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

interface World {
  run: string;
  browser: Browser;
  idp: ChildProcess;
  idpUrl: string;
  edge: Server;
  /** Requests the issuer stand-in received (method + path). */
  issuerRequests: string[];
  /** Principals the API stand-in accepted, and the reasons it refused tokens. */
  principals: Principal[];
  refusals: string[];
}

test.describe('aws-test-issuer routing in Chromium (offline)', () => {
  test.describe.configure({ mode: 'serial' });
  let world: World;

  test.beforeAll(async () => {
    const web = built('apps/web/dist/index.html').replace(/index\.html$/, '');
    const idpServer = built('tools/test-idp/dist/server.js');
    const issuerCli = built('tools/test-idp/dist/sandbox-issuer.js');
    const api = (await import(
      pathToFileURL(built('apps/api/dist/auth/index.js')).href
    )) as ApiAuthModule;
    const hosting = (await import(
      pathToFileURL(built('infra/dist/constructs/spa-hosting.js')).href
    )) as SpaHostingModule;

    // Per-run state OUTSIDE the repository (the key-file rules refuse repository paths).
    const run = mkdtempSync(join(tmpdir(), 'starter-aws-auth-offline-'));
    chmodSync(run, 0o700);
    const key = join(run, 'issuer-key.jwk');
    const docs = join(run, 'issuer-docs');
    execFileSync(process.execPath, [issuerCli, 'keygen', '--out', key], { stdio: 'ignore' });
    execFileSync(
      process.execPath,
      [issuerCli, 'export', '--issuer', ISSUER, '--key', key, '--out', docs],
      { stdio: 'ignore' },
    );
    const discovery = readFileSync(join(docs, 'openid-configuration'), 'utf8');
    const jwks = readFileSync(join(docs, 'jwks.json'), 'utf8');

    const tls = join(run, 'tls');
    mkdirSync(tls, { mode: 0o700 });
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-keyout',
          join(tls, 'key.pem'),
          '-out',
          join(tls, 'cert.pem'),
          '-subj',
          '/CN=sbx.test',
          '-addext',
          'subjectAltName=DNS:spa.sbx.test,DNS:issuer.sbx.test',
        ],
        { stdio: 'ignore' },
      );
    } catch (error) {
      throw new Error('openssl could not create the throwaway certificate (is it on PATH?)', {
        cause: error,
      });
    }

    const auth = { issuer: ISSUER, clientId: CLIENT_ID, scope: SCOPE };
    const csp = hosting.contentSecurityPolicy(auth);
    const verifier = new api.TokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['ES256'],
      clockToleranceSeconds: 30,
      maxTokenAgeSeconds: 3600,
      allowedClientIds: [CLIENT_ID],
      keys: new api.StaticKeySource(JSON.parse(jwks)),
    });
    const issuerRequests: string[] = [];
    const principals: Principal[] = [];
    const refusals: string[] = [];

    const edge = createServer(
      { key: readFileSync(join(tls, 'key.pem')), cert: readFileSync(join(tls, 'cert.pem')) },
      (req, res) => {
        void (async () => {
          const host = (req.headers.host ?? '').replace(/:\d+$/, '');
          const url = new URL(req.url ?? '/', `https://${host}`);
          if (host === 'issuer.sbx.test') {
            issuerRequests.push(`${req.method} ${url.pathname}`);
            const body =
              url.pathname === '/.well-known/openid-configuration'
                ? discovery
                : url.pathname === '/jwks.json'
                  ? jwks
                  : undefined;
            if (body === undefined) {
              res.writeHead(403, { 'content-type': 'text/plain' }).end('AccessDenied');
              return;
            }
            res
              .writeHead(200, {
                'content-type': 'application/json',
                'access-control-allow-origin': '*',
              })
              .end(body);
            return;
          }
          if (url.pathname === '/config.json') {
            res
              .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
              .end(hosting.spaRuntimeConfig(auth));
            return;
          }
          if (url.pathname.startsWith('/v1/')) {
            const result = await verifier.verifyAuthorizationHeader(req.headers.authorization);
            if (!result.ok) {
              refusals.push(result.reason);
              res
                .writeHead(401, { 'content-type': 'application/problem+json' })
                .end(JSON.stringify({ type: 'about:blank', title: 'Unauthorized', status: 401 }));
              return;
            }
            principals.push(result.principal);
            res
              .writeHead(200, { 'content-type': 'application/json' })
              .end(JSON.stringify({ items: [], nextCursor: null }));
            return;
          }
          const file = extname(url.pathname) ? url.pathname.slice(1) : 'index.html';
          const path = join(web, file);
          if (!path.startsWith(web) || !existsSync(path)) {
            res.writeHead(404).end();
            return;
          }
          res
            .writeHead(200, {
              'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
              'content-security-policy': csp,
            })
            .end(readFileSync(path));
        })();
      },
    );
    await new Promise<void>((resolve) => edge.listen(0, '127.0.0.1', resolve));
    const edgePort = (edge.address() as AddressInfo).port;

    const idpPort = await freePort();
    const idpUrl = `http://127.0.0.1:${idpPort}`;
    const idp = spawn(process.execPath, [idpServer], {
      env: {
        PATH: process.env['PATH'] ?? '',
        APP_RUNTIME: 'local',
        TEST_IDP_HOST: '127.0.0.1',
        TEST_IDP_PORT: String(idpPort),
        TEST_IDP_ISSUER: ISSUER,
        TEST_IDP_SIGNING_KEY_FILE: key,
        TEST_IDP_AUDIENCE: AUDIENCE,
        TEST_IDP_CLIENT_ID: CLIENT_ID,
        TEST_IDP_REDIRECT_URIS: `${SPA}/`,
        TEST_IDP_ENABLE_TEST_ENDPOINTS: 'true',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await waitFor(`${idpUrl}/healthz`, 15_000, idp);

    const browser = await chromium.launch({
      args: [
        `--host-resolver-rules=MAP spa.sbx.test 127.0.0.1:${edgePort}, MAP issuer.sbx.test 127.0.0.1:${edgePort}`,
      ],
    });
    world = { run, browser, idp, idpUrl, edge, issuerRequests, principals, refusals };
  });

  test.afterAll(async () => {
    if (!world) return;
    await world.browser.close();
    if (world.idp.exitCode === null) {
      const exited = new Promise((resolve) => world.idp.once('exit', resolve));
      world.idp.kill('SIGTERM');
      await exited;
    }
    world.edge.closeAllConnections();
    await new Promise<void>((resolve) => world.edge.close(() => resolve()));
    rmSync(world.run, { recursive: true, force: true }); // the key is deleted with the run
  });

  /** A context like the specs get (self-signed stand-in certificate accepted). */
  async function newContext(): Promise<{ context: BrowserContext; urls: string[] }> {
    const context = await world.browser.newContext({ ignoreHTTPSErrors: true });
    const urls: string[] = [];
    context.on('request', (r) => urls.push(r.url()));
    return { context, urls };
  }

  async function signIn(page: Page, user: string): Promise<void> {
    await page.goto(`${SPA}/`);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('TEST ONLY identity provider')).toBeVisible();
    expect(new URL(page.url()).origin).toBe(ISSUER); // the IdP page is shown AS the issuer
    await page.getByRole('button', { name: `Sign in as ${user}` }).click();
    await expect(page.getByText(`Signed in as ${user}`)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recent jobs' })).toBeVisible();
  }

  async function expectNoTokenInWebStorage(page: Page): Promise<void> {
    const storage = await page.evaluate(() =>
      JSON.stringify({ ...sessionStorage, ...localStorage }),
    );
    expect(storage).not.toMatch(JWT);
  }

  const loopbackRequests = (urls: string[]) =>
    urls.filter((u) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(u).hostname));

  test('negative control: without the routes the issuer has no /authorize', async () => {
    const { context } = await newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${SPA}/`);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByText('AccessDenied')).toBeVisible();
      expect(world.issuerRequests).toContain('GET /authorize');
    } finally {
      await context.close();
    }
  });

  test('alice signs in through prepareContext (the specs path); logout ends the IdP session', async () => {
    world.issuerRequests.length = 0;
    const { context, urls } = await newContext();
    try {
      await prepareContext(context, {
        kind: 'aws-test-issuer',
        issuer: ISSUER,
        idpUrl: world.idpUrl,
      });
      const page = await context.newPage();
      await signIn(page, 'alice');
      await expectNoTokenInWebStorage(page);

      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      expect(new URL(page.url()).origin).toBe(SPA);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByText('TEST ONLY identity provider')).toBeVisible(); // asked again

      expect(loopbackRequests(urls)).toEqual([]);
      // Interactive endpoints never reached the issuer stand-in; discovery did, over the network.
      expect(world.issuerRequests).toContain('GET /.well-known/openid-configuration');
      expect(world.issuerRequests.filter((r) => /\/(authorize|token|logout)$/.test(r))).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('bob signs in through installAwsTestIssuerRoutes; the API sees two distinct principals', async () => {
    const { context, urls } = await newContext();
    try {
      const routes = await installAwsTestIssuerRoutes(context, {
        issuer: ISSUER,
        idpUrl: world.idpUrl,
      });
      const page = await context.newPage();
      await signIn(page, 'bob');
      await expectNoTokenInWebStorage(page);
      expect(routes.forwarded['/authorize']).toBeGreaterThanOrEqual(2); // GET page + POST user
      expect(routes.forwarded['/token']).toBe(1);
      expect(loopbackRequests(urls)).toEqual([]);
    } finally {
      await context.close();
    }

    expect(world.refusals).toEqual([]);
    const subjects = [...new Set(world.principals.map((p) => p.subject))].sort();
    expect(subjects).toEqual(['alice', 'bob']);
    const keyOf = (s: string) => world.principals.find((p) => p.subject === s)?.key;
    expect(keyOf('alice')).toBeDefined();
    expect(keyOf('alice')).not.toBe(keyOf('bob'));
  });
});
