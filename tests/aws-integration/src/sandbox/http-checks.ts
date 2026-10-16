/**
 * HTTP checks of the deployed sandbox (no AWS API calls; plain HTTPS to the public endpoints):
 *
 *  - issuerCheck   the published discovery document and JWKS of the test issuer (CloudFront + S3)
 *                  answer 200 application/json with the expected content, AND a token minted by
 *                  the LOCAL test IdP verifies against the PUBLISHED key (ES256, node:crypto) —
 *                  proof that the operator's private key and the public JWKS belong together.
 *  - spaCheck      the SPA shell and its /config.json through CloudFront.
 *  - albDirectCheck the ALB without the origin-verify header must not serve the API: 403 from the
 *                  listener default, or no connection at all (the ALB security group admits only
 *                  CloudFront's origin-facing prefix list). Any other status fails.
 *
 * Results never contain tokens or secrets. Every function takes `fetchImpl` for offline tests.
 */
import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CheckOutcome {
  name: string;
  ok: boolean;
  detail: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const b64urlJson = (part: string): unknown =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

async function getJson(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
): Promise<{ status: number; contentType: string; body: unknown; text: string }> {
  const res = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body, text };
}

/** ES256 JWS verification of `token` against the JWK with its `kid` in `jwks`. */
export function verifyEs256(token: string, jwks: unknown): { ok: boolean; reason: string } {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'not a compact JWS' };
  const [h, p, s] = parts as [string, string, string];
  let header: unknown;
  try {
    header = b64urlJson(h);
  } catch {
    return { ok: false, reason: 'unreadable JWS header' };
  }
  if (!isRecord(header) || header.alg !== 'ES256') return { ok: false, reason: 'alg is not ES256' };
  const keys = isRecord(jwks) && Array.isArray(jwks.keys) ? (jwks.keys as unknown[]) : [];
  const jwk = keys.find((k) => isRecord(k) && k.kid === header.kid);
  if (!isRecord(jwk)) return { ok: false, reason: `no published key with the token's kid` };
  if ('d' in jwk) return { ok: false, reason: 'the published JWKS contains a PRIVATE key' };
  try {
    const key = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
    return ok ? { ok, reason: 'signature verified' } : { ok, reason: 'signature does not verify' };
  } catch (err) {
    return { ok: false, reason: `key error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const canonicalKeys = (jwks: unknown): string => {
  const keys = isRecord(jwks) && Array.isArray(jwks.keys) ? (jwks.keys as unknown[]) : [];
  return JSON.stringify(
    keys
      .filter(isRecord)
      .map((k) => Object.fromEntries(Object.entries(k).sort(([a], [b]) => (a < b ? -1 : 1))))
      .sort((a, b) => String(a.kid).localeCompare(String(b.kid))),
  );
};

export interface IssuerCheckOptions {
  issuer: string;
  /** Public JWKS exported locally (`sandbox-issuer.js export`), the expected published content. */
  expectedJwks: unknown;
  /** Local test IdP base URL (mint a token, verify it against the published key); optional. */
  idpUrl?: string | undefined;
  audience: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export async function issuerCheck(opts: IssuerCheckOptions): Promise<CheckOutcome[]> {
  const f = opts.fetchImpl ?? fetch;
  const t = opts.timeoutMs ?? 10_000;
  const issuer = opts.issuer.replace(/\/+$/, '');
  const out: CheckOutcome[] = [];
  const disc = await getJson(f, `${issuer}/.well-known/openid-configuration`, t);
  const d = isRecord(disc.body) ? disc.body : {};
  out.push({
    name: 'issuer: discovery document',
    ok:
      disc.status === 200 &&
      disc.contentType.startsWith('application/json') &&
      d.issuer === issuer &&
      d.jwks_uri === `${issuer}/jwks.json`,
    detail: `HTTP ${disc.status} ${disc.contentType}; issuer ${d.issuer === issuer ? 'matches' : 'MISMATCH'}; jwks_uri ${d.jwks_uri === `${issuer}/jwks.json` ? 'matches' : 'MISMATCH'}`,
  });
  const jwks = await getJson(f, `${issuer}/jwks.json`, t);
  const same = canonicalKeys(jwks.body) === canonicalKeys(opts.expectedJwks);
  const hasPrivate = /"d"\s*:/.test(jwks.text);
  out.push({
    name: 'issuer: JWKS',
    ok:
      jwks.status === 200 &&
      jwks.contentType.startsWith('application/json') &&
      same &&
      !hasPrivate &&
      canonicalKeys(jwks.body) !== '[]',
    detail: `HTTP ${jwks.status} ${jwks.contentType}; keys ${same ? 'equal the exported public JWKS' : 'DIFFER from the exported public JWKS'}${hasPrivate ? '; PRIVATE KEY MATERIAL PUBLISHED' : ''}`,
  });
  if (opts.idpUrl) {
    const res = await f(`${opts.idpUrl.replace(/\/+$/, '')}/test/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: 'sbx-issuer-check', scope: 'jobs:read' }),
      signal: AbortSignal.timeout(t),
    });
    const body = (await res.json().catch(() => undefined)) as
      { access_token?: unknown } | undefined;
    const token = typeof body?.access_token === 'string' ? body.access_token : '';
    let claims: Record<string, unknown> = {};
    try {
      const c = b64urlJson(token.split('.')[1] ?? '');
      if (isRecord(c)) claims = c;
    } catch {
      claims = {};
    }
    const sig = token
      ? verifyEs256(token, jwks.body)
      : { ok: false, reason: `IdP answered HTTP ${res.status}` };
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const claimsOk = claims.iss === issuer && aud.includes(opts.audience);
    out.push({
      name: 'issuer: a locally minted token verifies against the published key',
      ok: sig.ok && claimsOk,
      detail: `${sig.reason}; iss ${claims.iss === issuer ? 'matches' : 'MISMATCH'}; aud ${aud.includes(opts.audience) ? 'matches' : 'MISMATCH'}`,
    });
  }
  return out;
}

export interface SpaCheckOptions {
  baseUrl: string;
  issuer: string;
  clientId: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export async function spaCheck(opts: SpaCheckOptions): Promise<CheckOutcome[]> {
  const f = opts.fetchImpl ?? fetch;
  const t = opts.timeoutMs ?? 10_000;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const out: CheckOutcome[] = [];
  const shell = await f(`${base}/`, { redirect: 'manual', signal: AbortSignal.timeout(t) });
  const html = await shell.text();
  const ct = shell.headers.get('content-type') ?? '';
  out.push({
    name: 'spa: shell served through CloudFront',
    ok: shell.status === 200 && ct.startsWith('text/html') && html.includes('<div id="root"'),
    detail: `HTTP ${shell.status} ${ct}; root element ${html.includes('<div id="root"') ? 'present' : 'MISSING'}`,
  });
  const csp = shell.headers.get('content-security-policy') ?? '';
  out.push({
    name: 'spa: Content-Security-Policy names the issuer and no wildcard script source',
    ok: csp.includes(new URL(opts.issuer).origin) && !/script-src[^;]*\*/.test(csp),
    detail: csp ? `CSP present (${csp.length} chars)` : 'no CSP header',
  });
  const cfg = await getJson(f, `${base}/config.json`, t);
  const auth = isRecord(cfg.body) && isRecord(cfg.body.auth) ? cfg.body.auth : {};
  out.push({
    name: 'spa: /config.json names the sandbox issuer and client',
    ok:
      cfg.status === 200 &&
      auth.issuer === opts.issuer.replace(/\/+$/, '') &&
      auth.clientId === opts.clientId,
    detail: `HTTP ${cfg.status}; issuer ${auth.issuer === opts.issuer.replace(/\/+$/, '') ? 'matches' : 'MISMATCH'}; clientId ${auth.clientId === opts.clientId ? 'matches' : 'MISMATCH'}`,
  });
  return out;
}

export interface HealthCheckOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export async function healthCheck(opts: HealthCheckOptions): Promise<CheckOutcome[]> {
  const f = opts.fetchImpl ?? fetch;
  const t = opts.timeoutMs ?? 10_000;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const out: CheckOutcome[] = [];
  for (const path of ['/health/live', '/health/ready']) {
    const r = await getJson(f, `${base}${path}`, t);
    const status = isRecord(r.body) ? String(r.body.status) : '?';
    out.push({
      name: `health: GET ${path} through CloudFront -> 200`,
      ok: r.status === 200,
      detail: `HTTP ${r.status}; status=${status}; checks=${JSON.stringify(isRecord(r.body) ? (r.body.checks ?? null) : null)}`,
    });
  }
  return out;
}

export type DirectOutcome =
  { kind: 'status'; status: number } | { kind: 'blocked'; reason: string };

/** Classifies a direct request: an HTTP status, or a connection the network did not allow. */
export async function directRequest(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<DirectOutcome> {
  try {
    const res = await fetchImpl(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer().catch(() => undefined);
    return { kind: 'status', status: res.status };
  } catch (err) {
    const e = err as Error & { cause?: { code?: unknown } };
    const code = typeof e.cause?.code === 'string' ? e.cause.code : '';
    if (e.name === 'TimeoutError' || e.name === 'AbortError')
      return { kind: 'blocked', reason: 'timeout (dropped)' };
    if (
      /^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(
        code,
      )
    ) {
      return { kind: 'blocked', reason: code };
    }
    throw err;
  }
}

export interface AlbDirectOptions {
  albDnsName: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** Without, and with a WRONG, origin-verify header the ALB must not serve the API. */
export async function albDirectCheck(opts: AlbDirectOptions): Promise<CheckOutcome[]> {
  const f = opts.fetchImpl ?? fetch;
  const t = opts.timeoutMs ?? 8_000;
  const out: CheckOutcome[] = [];
  const cases: [string, Record<string, string>][] = [
    ['no origin-verify header', {}],
    ['a wrong origin-verify header', { 'x-origin-verify': `wrong-${Date.now().toString(36)}` }],
  ];
  for (const [label, headers] of cases) {
    for (const path of ['/health/live', '/v1/jobs']) {
      const r = await directRequest(`http://${opts.albDnsName}${path}`, headers, f, t);
      const ok = r.kind === 'blocked' || r.status === 403;
      out.push({
        name: `direct ALB, ${label}: GET ${path} is denied (403 or no connection)`,
        ok,
        detail: r.kind === 'blocked' ? `no connection: ${r.reason}` : `HTTP ${r.status}`,
      });
    }
  }
  return out;
}

export interface ClockSkewOptions {
  url: string;
  maxSkewSeconds?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Local clock vs the HTTP `Date` header of a server (CloudFront): tokens minted on this host must
 * be valid for the API (iat/exp, max token age), so the skew must stay below `maxSkewSeconds`
 * (default 30). The local time is the midpoint of the request; `Date` has one-second resolution.
 */
export async function clockSkewCheck(opts: ClockSkewOptions): Promise<CheckOutcome[]> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const max = opts.maxSkewSeconds ?? 30;
  const t0 = now();
  const res = await f(opts.url, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  const t1 = now();
  await res.arrayBuffer().catch(() => undefined);
  const header = res.headers.get('date');
  const server = header ? Date.parse(header) : Number.NaN;
  if (!Number.isFinite(server)) {
    return [
      {
        name: `clock: local clock within ${max} s of the server`,
        ok: false,
        detail: 'no Date header',
      },
    ];
  }
  const skew = Math.abs((t0 + t1) / 2 - server) / 1000;
  return [
    {
      name: `clock: local clock within ${max} s of the server`,
      ok: skew <= max + 1,
      detail: `skew ${skew.toFixed(1)} s (server Date ${header})`,
    },
  ];
}
