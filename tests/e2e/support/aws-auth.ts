/**
 * Browser E2E against an AWS sandbox (live contract §5, E2E_AUTH_MODE=aws-test-issuer).
 *
 * The sandbox has no hosted IdP: a static issuer on AWS (S3 + CloudFront) serves only
 * `/.well-known/openid-configuration` and `/jwks.json`, and the TEST-ONLY IdP that signs in the
 * test users runs on the operator host (loopback, never reachable from the internet). This helper
 * routes, per browser context, exactly the interactive endpoints of the issuer —
 *
 *   ${issuer}/authorize   (GET sign-in page, POST chosen user → 302 to the SPA)
 *   ${issuer}/token       (POST code + PKCE verifier → tokens, CORS for the SPA origin)
 *   ${issuer}/logout      (RP-initiated logout → 302 back to the SPA)
 *
 * — to the local IdP in Node (method, query, body and headers including cookies are forwarded
 * unchanged; redirects are NOT followed, the browser follows them) and fulfils the browser with
 * the IdP's response. Only an absolute `Location` that points at the local IdP is rewritten to the
 * issuer (the IdP never emits one when TEST_IDP_ISSUER is the issuer; this is a safety net).
 *
 * Everything else stays real: the SPA and its CSP from CloudFront, `/config.json`, discovery and
 * JWKS from the real issuer distribution, the API behind CloudFront, the SPA's own PKCE, state,
 * nonce and `iss` checks. The browser itself never contacts 127.0.0.1 (no mixed content, no
 * private-network-access preflight): the forwarding happens in the Playwright (Node) process.
 *
 * Routes are per BrowserContext: install them on every context a spec creates
 * (`browser.newContext()` too), e.g. with `installAwsTestIssuerRoutesFromEnv(context)`.
 *
 * Env: E2E_AUTH_MODE=aws-test-issuer, E2E_ISSUER=https://<issuer domain>,
 *      E2E_IDP_URL=http://127.0.0.1:9400 (default). E2E_AUTH_MODE unset or "local" means no
 *      routing; any other value is refused.
 *
 * Offline self-test (no AWS, no internet): `pnpm --filter @starter/tests-e2e run test:aws-auth-offline`
 * (support/aws-auth.offline.ts).
 */
import type { BrowserContext, Route } from '@playwright/test';

export const AWS_TEST_ISSUER_MODE = 'aws-test-issuer';
export const DEFAULT_E2E_IDP_URL = 'http://127.0.0.1:9400';
export const ROUTED_ISSUER_PATHS = ['/authorize', '/token', '/logout'] as const;
export type RoutedIssuerPath = (typeof ROUTED_ISSUER_PATHS)[number];

export interface AwsTestIssuerOptions {
  /** https origin of the static test issuer (what `/config.json` and the API trust). */
  issuer: string;
  /** The local TEST-ONLY IdP (loopback only), e.g. http://127.0.0.1:9400. */
  idpUrl: string;
}

export interface AwsTestIssuerRoutes {
  readonly issuer: string;
  readonly idpUrl: string;
  /** Requests forwarded to the local IdP so far, per path (lets a spec prove routing happened). */
  readonly forwarded: Readonly<Record<RoutedIssuerPath, number>>;
  uninstall(): Promise<void>;
}

/** Request headers that describe the hop, not the request (never forwarded). */
const HOP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'content-length',
]);
/** Response headers Playwright recomputes from the fulfilled body (or that describe the hop). */
const HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
  'set-cookie', // re-added from getSetCookie() so several cookies stay separate
]);
const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])$/;

function origin(value: string, name: string, rule: (url: URL) => string | undefined): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${name} must be an origin (no path, query, fragment or credentials)`);
  }
  const problem = rule(url);
  if (problem) throw new Error(`${name} ${problem}`);
  return url.origin;
}

/** Validates and normalises the options (origins without a trailing slash). */
export function normalizeAwsTestIssuerOptions(options: AwsTestIssuerOptions): AwsTestIssuerOptions {
  return {
    issuer: origin(options.issuer, 'E2E_ISSUER', (u) =>
      u.protocol === 'https:' ? undefined : 'must be an https URL (the sandbox issuer)',
    ),
    // The minting IdP must stay on this host: never forward sign-ins anywhere else.
    idpUrl: origin(options.idpUrl, 'E2E_IDP_URL', (u) =>
      (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.test(u.hostname)
        ? undefined
        : 'must be a loopback http(s) URL (the local TEST-ONLY IdP)',
    ),
  };
}

/**
 * Options from the environment, or `undefined` when E2E_AUTH_MODE is unset or "local" (local/CI
 * stacks reach the test IdP directly). Throws for an unknown mode or a missing/invalid E2E_ISSUER.
 */
export function awsTestIssuerOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): AwsTestIssuerOptions | undefined {
  const mode = env['E2E_AUTH_MODE'];
  if (mode === undefined || mode === '' || mode === 'local') return undefined;
  if (mode !== AWS_TEST_ISSUER_MODE) {
    throw new Error(
      `E2E_AUTH_MODE must be unset, "local" or "${AWS_TEST_ISSUER_MODE}" (got "${mode}")`,
    );
  }
  const issuer = env['E2E_ISSUER'];
  if (!issuer) throw new Error(`E2E_AUTH_MODE=${AWS_TEST_ISSUER_MODE} needs E2E_ISSUER`);
  return normalizeAwsTestIssuerOptions({
    issuer,
    idpUrl: env['E2E_IDP_URL'] || DEFAULT_E2E_IDP_URL,
  });
}

const ROUTED_PATHS: ReadonlySet<string> = new Set(ROUTED_ISSUER_PATHS);

/** The routing predicate: exactly the issuer's origin and exactly one of the routed paths. */
export function isRoutedIssuerUrl(url: URL, issuerOrigin: string): boolean {
  return url.origin === issuerOrigin && ROUTED_PATHS.has(url.pathname);
}

/** `${issuer}/x?y` for a URL at the local IdP's origin; anything else unchanged. */
export function rewriteIdpLocation(location: string, options: AwsTestIssuerOptions): string {
  let url: URL;
  try {
    url = new URL(location, options.idpUrl);
  } catch {
    return location;
  }
  if (url.origin !== new URL(options.idpUrl).origin || !/^[a-z][a-z0-9+.-]*:/i.test(location)) {
    return location; // relative Locations resolve against the issuer URL in the browser already
  }
  return `${options.issuer}${url.pathname}${url.search}${url.hash}`;
}

/** Headers of the browser request as sent to the local IdP. */
export function forwardedRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith(':') || HOP_REQUEST_HEADERS.has(lower)) continue;
    out[lower] = value;
  }
  return out;
}

/** Headers of the local IdP's response as given to the browser. */
export function fulfilledResponseHeaders(
  response: Response,
  options: AwsTestIssuerOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (!HOP_RESPONSE_HEADERS.has(name)) out[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) out['set-cookie'] = cookies.join('\n');
  if (out['location']) out['location'] = rewriteIdpLocation(out['location'], options);
  return out;
}

/**
 * Routes `${issuer}/authorize`, `/token` and `/logout` of `context` to the local test IdP.
 * Discovery, JWKS and every other URL are left to the network.
 */
export async function installAwsTestIssuerRoutes(
  context: BrowserContext,
  options: AwsTestIssuerOptions,
): Promise<AwsTestIssuerRoutes> {
  const normalized = normalizeAwsTestIssuerOptions(options);
  const issuerOrigin = normalized.issuer;
  const forwarded: Record<RoutedIssuerPath, number> = {
    '/authorize': 0,
    '/token': 0,
    '/logout': 0,
  };

  const matcher = (url: URL) => isRoutedIssuerUrl(url, issuerOrigin);
  const handler = async (route: Route) => {
    const request = route.request();
    const source = new URL(request.url());
    const target = new URL(`${source.pathname}${source.search}`, normalized.idpUrl);
    forwarded[source.pathname as RoutedIssuerPath] += 1;
    const postData = request.postDataBuffer();
    let response: Response;
    try {
      response = await fetch(target, {
        method: request.method(),
        headers: forwardedRequestHeaders(await request.allHeaders()),
        body: postData ? Uint8Array.from(postData) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await route.fulfill({
        status: 502,
        contentType: 'text/plain; charset=utf-8',
        body: `aws-test-issuer routing: the local test IdP at ${normalized.idpUrl} did not answer (${reason})`,
      });
      return;
    }
    await route.fulfill({
      status: response.status,
      headers: fulfilledResponseHeaders(response, normalized),
      body: Buffer.from(await response.arrayBuffer()),
    });
  };

  await context.route(matcher, handler);
  return {
    issuer: normalized.issuer,
    idpUrl: normalized.idpUrl,
    forwarded,
    uninstall: () => context.unroute(matcher, handler),
  };
}

/** `installAwsTestIssuerRoutes` when E2E_AUTH_MODE=aws-test-issuer; otherwise does nothing. */
export async function installAwsTestIssuerRoutesFromEnv(
  context: BrowserContext,
  env: Record<string, string | undefined> = process.env,
): Promise<AwsTestIssuerRoutes | undefined> {
  const options = awsTestIssuerOptionsFromEnv(env);
  return options ? installAwsTestIssuerRoutes(context, options) : undefined;
}
