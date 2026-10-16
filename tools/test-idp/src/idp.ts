/**
 * TEST ONLY OpenID Connect provider (contracts rev. 2 §2.4, ADR 0213). Small on purpose:
 * node:http, one public client (the SPA), three test users, in-memory keys and codes.
 *
 *   GET  /.well-known/openid-configuration   discovery (CORS for the SPA origins)
 *   GET  /jwks.json                          public signing keys (CORS)
 *   GET  /authorize                          authorization code + PKCE S256 request → sign-in page
 *   POST /authorize                          chosen test user → 302 redirect_uri?code&state&iss
 *   POST /token                              code + code_verifier → access token + ID token (CORS)
 *   GET  /logout                             end the test session → post_logout_redirect_uri
 *   GET  /healthz                            liveness
 *   POST /test/token, POST /test/rotate      ONLY with TEST_IDP_ENABLE_TEST_ENDPOINTS=true
 *                                            (/test/rotate answers 409 with a key file)
 *
 * With a key file (its tokens are accepted by the internet-facing sandbox API) every request must
 * be addressed to a loopback authority of the port it arrived on (`Host` 127.0.0.1:<port>,
 * localhost:<port> or [::1]:<port>; else 421), and the test endpoints require
 * `content-type: application/json` (else 415): a DNS-rebinding page in the operator's browser can
 * neither address this IdP by its own name nor send a JSON POST without a CORS preflight that the
 * test endpoints never grant.
 *
 * Signing keys and token minting come from `@starter/testing/auth` — the same implementation as
 * the in-process issuer used by the API's integration tests. Access tokens: RFC 9068
 * (`typ: at+jwt`, `aud` = the API, `client_id`, `scope`); ID tokens: `aud` = the client id,
 * `nonce`, `typ: JWT` — so an ID token is never accepted by the API (different audience).
 *
 * With TEST_IDP_SIGNING_KEY_FILE (AWS sandbox) the keys come from that file instead
 * (`keyed-issuer.ts`, ES256, same minting rules) and the issuer identifier is usually an https URL
 * this process does not serve itself: the browser reaches `/authorize`, `/token` and `/logout`
 * through Playwright routing, and the API reads discovery + JWKS from a static copy on AWS
 * (`sandbox-issuer export`). Nothing here depends on the issuer being this server's own URL.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createTestIssuer, type MintOptions, type TestIssuer } from '@starter/testing/auth';
import type { TestIdpConfig } from './config.js';
import { discoveryDocument } from './discovery.js';
import { KeyRotationUnavailableError, createKeyedIssuer } from './keyed-issuer.js';
import { PAGE_CSP, errorPage, signInPage, signedOutPage } from './pages.js';
import { loadSigningKeyFile } from './signing-key.js';

const CODE_TTL_MS = 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;
const MAX_CODES = 1_000;
const MAX_SESSIONS = 1_000;
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_COOKIE = 'test_idp_session';
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const OPAQUE = /^[\x21-\x7e]{1,512}$/;

interface AuthorizationRequest {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  nonce: string;
  code_challenge: string;
  code_challenge_method: 'S256';
}

interface IssuedCode {
  request: AuthorizationRequest;
  user: string;
  expiresAt: number;
}

export interface TestIdp {
  readonly config: TestIdpConfig;
  readonly issuer: TestIssuer;
  /** `file`: TEST_IDP_SIGNING_KEY_FILE (static, published JWKS); `memory`: generated per process. */
  readonly keySource: 'file' | 'memory';
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string,
  ) {
    super(message);
  }
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');
const randomToken = () => base64url(randomBytes(32));

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES)
      throw new HttpError(413, 'invalid_request', 'request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function cookies(req: IncomingMessage): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) jar.set(name, rest.join('='));
  }
  return jar;
}

export async function createTestIdp(config: TestIdpConfig): Promise<TestIdp> {
  const keySource = config.signingKeyFile ? 'file' : 'memory';
  const issuer = config.signingKeyFile
    ? createKeyedIssuer({
        issuer: config.issuer,
        audience: config.audience,
        ttlSeconds: config.tokenTtlSeconds,
        key: loadSigningKeyFile(config.signingKeyFile),
      })
    : await createTestIssuer({
        issuer: config.issuer,
        audience: config.audience,
        ttlSeconds: config.tokenTtlSeconds,
      });
  const codes = new Map<string, IssuedCode>();
  const sessions = new Map<string, { user: string; expiresAt: number }>();
  // An https issuer is reached over TLS by the browser (directly or via Playwright routing).
  const cookieAttributes = `Path=/; HttpOnly; SameSite=Lax${config.issuer.startsWith('https:') ? '; Secure' : ''}`;

  const discovery = () => discoveryDocument(config.issuer, issuer.algorithm, config.apiScopes);

  const prune = (now: number) => {
    for (const [code, entry] of codes) if (entry.expiresAt <= now) codes.delete(code);
    for (const [id, entry] of sessions) if (entry.expiresAt <= now) sessions.delete(id);
  };

  function send(
    res: ServerResponse,
    status: number,
    body: string,
    type: string,
    headers: Record<string, string> = {},
  ) {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...(type.startsWith('text/html')
        ? { 'content-security-policy': PAGE_CSP, 'x-frame-options': 'DENY' }
        : {}),
      ...headers,
    });
    res.end(body);
  }
  const json = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => send(res, status, JSON.stringify(body), 'application/json', headers);
  const html = (res: ServerResponse, status: number, body: string) =>
    send(res, status, body, 'text/html; charset=utf-8');

  /** CORS for browser calls (discovery, JWKS, token) from the registered SPA origins only. */
  function cors(req: IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    if (!origin || !config.allowedOrigins.includes(origin)) return { vary: 'Origin' };
    return { 'access-control-allow-origin': origin, vary: 'Origin' };
  }

  /** Validates an authorization request; throws before anything is redirected anywhere. */
  function validateAuthorizationRequest(params: URLSearchParams): AuthorizationRequest {
    const get = (name: string) => params.get(name) ?? '';
    const clientId = get('client_id');
    const redirectUri = get('redirect_uri');
    if (clientId !== config.clientId)
      throw new HttpError(400, 'invalid_client', 'unknown client_id');
    // Exact match against the registered URIs (OAuth 2.0 Security BCP): never redirect elsewhere.
    if (!config.redirectUris.includes(redirectUri)) {
      throw new HttpError(400, 'invalid_request', 'redirect_uri is not registered for this client');
    }
    if (get('response_type') !== 'code') {
      throw new HttpError(400, 'unsupported_response_type', 'only response_type=code is supported');
    }
    if (get('code_challenge_method') !== 'S256' || !PKCE_CHALLENGE.test(get('code_challenge'))) {
      throw new HttpError(
        400,
        'invalid_request',
        'PKCE with code_challenge_method=S256 is required',
      );
    }
    for (const name of ['state', 'nonce'] as const) {
      if (!OPAQUE.test(get(name)))
        throw new HttpError(400, 'invalid_request', `${name} is required`);
    }
    const scope = get('scope');
    if (!scope.split(' ').includes('openid')) {
      throw new HttpError(400, 'invalid_scope', 'the openid scope is required');
    }
    return {
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state: get('state'),
      nonce: get('nonce'),
      code_challenge: get('code_challenge'),
      code_challenge_method: 'S256',
    };
  }

  function issueCode(
    res: ServerResponse,
    request: AuthorizationRequest,
    user: string,
    headers: Record<string, string> = {},
  ) {
    const now = Date.now();
    prune(now);
    if (codes.size >= MAX_CODES) {
      throw new HttpError(503, 'temporarily_unavailable', 'too many pending authorization codes');
    }
    const code = randomToken();
    codes.set(code, { request, user, expiresAt: now + CODE_TTL_MS });
    const location = new URL(request.redirect_uri);
    location.searchParams.set('code', code);
    location.searchParams.set('state', request.state);
    location.searchParams.set('iss', config.issuer); // RFC 9207
    res.writeHead(302, { location: location.href, 'cache-control': 'no-store', ...headers });
    res.end();
  }

  async function exchangeCode(req: IncomingMessage, res: ServerResponse) {
    if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
      throw new HttpError(400, 'invalid_request', 'use application/x-www-form-urlencoded');
    }
    const form = new URLSearchParams(await readBody(req));
    if (form.get('grant_type') !== 'authorization_code') {
      throw new HttpError(400, 'unsupported_grant_type', 'only authorization_code is supported');
    }
    const code = form.get('code') ?? '';
    const issued = codes.get(code);
    // Single use: a code is consumed by its first redemption attempt, successful or not.
    codes.delete(code);
    if (!issued || issued.expiresAt <= Date.now()) {
      throw new HttpError(400, 'invalid_grant', 'unknown, expired or already used code');
    }
    const { request, user } = issued;
    if (
      form.get('client_id') !== request.client_id ||
      form.get('redirect_uri') !== request.redirect_uri
    ) {
      throw new HttpError(
        400,
        'invalid_grant',
        'client_id or redirect_uri does not match the code',
      );
    }
    const verifier = form.get('code_verifier') ?? '';
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    if (!PKCE_VERIFIER.test(verifier) || !safeEqual(challenge, request.code_challenge)) {
      throw new HttpError(400, 'invalid_grant', 'PKCE verification failed');
    }
    const granted = request.scope.split(' ').filter((s) => config.apiScopes.includes(s));
    const accessToken = await issuer.mint({
      sub: user,
      scope: granted.join(' '),
      client_id: request.client_id,
    });
    const idToken = await issuer.mint(
      {
        sub: user,
        nonce: request.nonce,
        azp: request.client_id,
        client_id: undefined,
        scope: undefined,
        name: `${user} (test user)`,
        preferred_username: user,
        auth_time: Math.floor(Date.now() / 1000),
      },
      { audience: request.client_id, typ: 'JWT' },
    );
    json(
      res,
      200,
      {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: config.tokenTtlSeconds,
        scope: granted.join(' '),
        id_token: idToken,
      },
      cors(req),
    );
  }

  function sessionUser(req: IncomingMessage): string | undefined {
    const id = cookies(req).get(SESSION_COOKIE);
    const session = id ? sessions.get(id) : undefined;
    return session && session.expiresAt > Date.now() ? session.user : undefined;
  }

  function newSession(user: string): string {
    prune(Date.now());
    if (sessions.size >= MAX_SESSIONS) sessions.clear();
    const id = randomToken();
    sessions.set(id, { user, expiresAt: Date.now() + SESSION_TTL_MS });
    return `${SESSION_COOKIE}=${id}; ${cookieAttributes}; Max-Age=${SESSION_TTL_MS / 1000}`;
  }

  async function testToken(req: IncomingMessage, res: ServerResponse) {
    let input: { sub?: unknown; scope?: unknown; claims?: unknown; options?: unknown };
    try {
      input = JSON.parse((await readBody(req)) || '{}') as typeof input;
    } catch {
      throw new HttpError(400, 'invalid_request', 'body must be JSON');
    }
    const claims =
      typeof input.claims === 'object' && input.claims !== null
        ? (input.claims as Record<string, unknown>)
        : {};
    const options =
      typeof input.options === 'object' && input.options !== null
        ? (input.options as MintOptions)
        : {};
    const accessToken = await issuer.mint(
      {
        // Issued to this IdP's SPA client unless the caller overrides it (claims or options),
        // so the API's AUTH_ALLOWED_CLIENT_IDS accepts it like a token from the code flow.
        client_id: config.clientId,
        ...(typeof input.sub === 'string' ? { sub: input.sub } : {}),
        ...(typeof input.scope === 'string' ? { scope: input.scope } : {}),
        ...claims,
      },
      options,
    );
    json(res, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: config.tokenTtlSeconds,
    });
  }

  /** Key-file mode: only a loopback authority of the port this connection arrived on. */
  function loopbackHost(req: IncomingMessage): boolean {
    const port = req.socket.localPort;
    const host = (req.headers.host ?? '').toLowerCase();
    return (
      port !== undefined &&
      [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)
    );
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', config.issuer);
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (keySource === 'file' && !loopbackHost(req)) {
      throw new HttpError(
        421,
        'invalid_host',
        'this test IdP answers only requests addressed to its loopback address and port',
      );
    }
    if (
      keySource === 'file' &&
      method === 'POST' &&
      path.startsWith('/test/') &&
      !(req.headers['content-type'] ?? '').startsWith('application/json')
    ) {
      throw new HttpError(415, 'invalid_request', 'use content-type: application/json');
    }

    if (
      method === 'OPTIONS' &&
      ['/token', '/jwks.json', '/.well-known/openid-configuration'].includes(path)
    ) {
      const headers = cors(req);
      if (headers['access-control-allow-origin']) {
        headers['access-control-allow-methods'] = path === '/token' ? 'POST' : 'GET';
        headers['access-control-allow-headers'] = 'content-type';
        headers['access-control-max-age'] = '600';
      }
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (method === 'GET' && path === '/healthz') return json(res, 200, { status: 'ok' });
    if (method === 'GET' && path === '/.well-known/openid-configuration') {
      return json(res, 200, discovery(), cors(req));
    }
    if (method === 'GET' && path === '/jwks.json') return json(res, 200, issuer.jwks(), cors(req));

    if (method === 'GET' && path === '/authorize') {
      const request = validateAuthorizationRequest(url.searchParams);
      const user = sessionUser(req);
      if (user && url.searchParams.get('prompt') !== 'login') return issueCode(res, request, user);
      return html(res, 200, signInPage({ ...request, response_type: 'code' }, config.users));
    }
    if (method === 'POST' && path === '/authorize') {
      const form = new URLSearchParams(await readBody(req));
      const request = validateAuthorizationRequest(form);
      const user = form.get('user') ?? '';
      if (!config.users.includes(user))
        throw new HttpError(400, 'access_denied', 'unknown test user');
      return issueCode(res, request, user, { 'set-cookie': newSession(user) });
    }
    if (method === 'POST' && path === '/token') return exchangeCode(req, res);
    if (method === 'GET' && path === '/logout') {
      const id = cookies(req).get(SESSION_COOKIE);
      if (id) sessions.delete(id);
      const clear = `${SESSION_COOKIE}=; ${cookieAttributes}; Max-Age=0`;
      const target = url.searchParams.get('post_logout_redirect_uri') ?? '';
      if (config.redirectUris.includes(target)) {
        res.writeHead(302, { location: target, 'set-cookie': clear, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      res.setHeader('set-cookie', clear);
      return html(res, 200, signedOutPage());
    }
    if (config.enableTestEndpoints && method === 'POST' && path === '/test/token')
      return testToken(req, res);
    if (config.enableTestEndpoints && method === 'POST' && path === '/test/rotate') {
      let body: { retainPrevious?: unknown };
      try {
        body = JSON.parse((await readBody(req)) || '{}') as { retainPrevious?: unknown };
      } catch {
        throw new HttpError(400, 'invalid_request', 'body must be JSON');
      }
      try {
        return json(
          res,
          200,
          await issuer.rotate({ retainPrevious: body.retainPrevious === true }),
        );
      } catch (error) {
        if (error instanceof KeyRotationUnavailableError) {
          throw new HttpError(409, 'rotation_unavailable', error.message);
        }
        throw error;
      }
    }
    throw new HttpError(404, 'not_found', `no route for ${method} ${path}`);
  }

  return {
    config,
    issuer,
    keySource,
    async handle(req, res) {
      try {
        await route(req, res);
      } catch (error) {
        const failure =
          error instanceof HttpError
            ? error
            : new HttpError(500, 'server_error', 'unexpected error');
        if (!(error instanceof HttpError)) {
          console.error(
            JSON.stringify({ level: 'error', msg: 'test-idp request failed', err: String(error) }),
          );
        }
        if (res.headersSent) {
          res.end();
          return;
        }
        const path = new URL(req.url ?? '/', config.issuer).pathname;
        if (path === '/authorize' || path === '/logout') {
          return html(res, failure.status, errorPage(failure.message));
        }
        json(
          res,
          failure.status,
          { error: failure.error, error_description: failure.message },
          cors(req),
        );
      }
    },
  };
}
