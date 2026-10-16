/**
 * HTTP checks and canary submission of the sandbox tooling against an in-process server that plays
 * CloudFront (SPA, /config.json, /health, /v1), the published issuer (discovery + JWKS) and the
 * local test IdP (/test/token, real ES256 signatures). 127.0.0.1 only.
 */
import {
  generateKeyPairSync,
  randomUUID,
  sign,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { submitCanaries } from './canary.js';
import {
  albDirectCheck,
  clockSkewCheck,
  healthCheck,
  issuerCheck,
  spaCheck,
  verifyEs256,
} from './http-checks.js';

interface Key {
  privateKey: KeyObject;
  jwk: JsonWebKey & { kid: string };
}
const newKey = (kid: string): Key => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateKey,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' },
  };
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(key: Key, claims: Record<string, unknown>): string {
  const input = `${b64({ alg: 'ES256', kid: key.jwk.kid, typ: 'at+jwt' })}.${b64(claims)}`;
  const sig = sign('sha256', Buffer.from(input), {
    key: key.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${input}.${sig.toString('base64url')}`;
}

/** Mutable behaviour of the fake. */
const world = {
  issuer: '',
  signing: newKey('k1'),
  published: [] as JsonWebKey[],
  jwksContentType: 'application/json',
  discoveryIssuer: '' as string | undefined,
  readyStatus: 200,
  spaCsp: '',
  configIssuer: '',
  jobs: new Map<string, { title: string; content: string; polls: number }>(),
  calls: [] as string[],
};

let server: Server;
let base: string;

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, {
    'content-type': type,
    ...(world.spaCsp && type.startsWith('text/html')
      ? { 'content-security-policy': world.spaCsp }
      : {}),
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw = '';
  for await (const c of req) raw += String(c);
  const url = new URL(req.url ?? '/', base);
  world.calls.push(`${req.method} ${url.pathname}`);
  const p = url.pathname;
  if (p === '/.well-known/openid-configuration') {
    return send(res, 200, {
      issuer: world.discoveryIssuer ?? world.issuer,
      jwks_uri: `${world.issuer}/jwks.json`,
    });
  }
  if (p === '/jwks.json') return send(res, 200, { keys: world.published }, world.jwksContentType);
  if (p === '/test/token') {
    const body = JSON.parse(raw) as { sub: string; scope?: string };
    return send(res, 200, {
      access_token: jwt(world.signing, {
        iss: world.issuer,
        aud: 'starter-jobs-api-sandbox',
        sub: body.sub,
        scope: body.scope,
      }),
    });
  }
  if (p === '/')
    return send(res, 200, '<!doctype html><div id="root"></div>', 'text/html; charset=utf-8');
  if (p === '/config.json')
    return send(res, 200, {
      auth: {
        issuer: world.configIssuer,
        clientId: 'starter-web-sandbox',
        scope: 'openid jobs:read jobs:write',
      },
    });
  if (p === '/health/live') return send(res, 200, { status: 'ok' });
  if (p === '/health/ready')
    return send(res, world.readyStatus, {
      status: world.readyStatus === 200 ? 'ok' : 'unavailable',
      checks: {},
    });
  if (p.startsWith('/v1/')) {
    if (!/^Bearer \S+\.\S+\.\S+$/.test(req.headers.authorization ?? ''))
      return send(res, 401, { status: 401 });
    if (req.method === 'POST' && p === '/v1/jobs') {
      const { title, content } = JSON.parse(raw) as { title: string; content: string };
      const id = randomUUID();
      world.jobs.set(id, { title, content, polls: 0 });
      return send(res, 202, { jobId: id, status: 'PENDING' });
    }
    const id = p.split('/')[3] ?? '';
    const job = world.jobs.get(id);
    if (!job) return send(res, 404, { status: 404 });
    job.polls += 1;
    const short = job.content.split(/\s+/).length < 10;
    const status = job.polls < 2 ? 'PROCESSING' : short ? 'FAILED' : 'SUCCEEDED';
    return send(res, 200, {
      jobId: id,
      title: job.title,
      status,
      error:
        status === 'FAILED' ? { name: 'JobValidationError', message: 'at least 10 words' } : null,
    });
  }
  return send(res, 404, { status: 404 });
}

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  world.issuer = base;
  world.signing = newKey('k1');
  world.published = [world.signing.jwk];
  world.jwksContentType = 'application/json';
  world.discoveryIssuer = undefined;
  world.readyStatus = 200;
  world.spaCsp = `default-src 'self'; connect-src 'self' ${base}; script-src 'self'`;
  world.configIssuer = base;
  world.jobs.clear();
  world.calls = [];
});

describe('issuer check', () => {
  it('discovery, JWKS and a locally minted token verifying against the published key', async () => {
    const outcomes = await issuerCheck({
      issuer: base,
      expectedJwks: { keys: [world.signing.jwk] },
      idpUrl: base,
      audience: 'starter-jobs-api-sandbox',
    });
    expect(outcomes.map((o) => [o.name, o.ok])).toEqual([
      ['issuer: discovery document', true],
      ['issuer: JWKS', true],
      ['issuer: a locally minted token verifies against the published key', true],
    ]);
    expect(JSON.stringify(outcomes)).not.toMatch(/eyJ/);
  });

  it('a published key that is not the signing key fails the token check (same kid, other key)', async () => {
    const other = newKey('k1');
    world.published = [other.jwk];
    const outcomes = await issuerCheck({
      issuer: base,
      expectedJwks: { keys: [other.jwk] },
      idpUrl: base,
      audience: 'starter-jobs-api-sandbox',
    });
    expect(outcomes[2]).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/does not verify/),
    });
  });

  it('wrong content type, stale JWKS, a published private key or a wrong issuer fail', async () => {
    world.jwksContentType = 'binary/octet-stream';
    expect(
      (
        await issuerCheck({ issuer: base, expectedJwks: { keys: world.published }, audience: 'a' })
      )[1]?.ok,
    ).toBe(false);
    world.jwksContentType = 'application/json';
    expect(
      (
        await issuerCheck({
          issuer: base,
          expectedJwks: { keys: [newKey('k2').jwk] },
          audience: 'a',
        })
      )[1]?.ok,
    ).toBe(false);
    const priv = world.signing.privateKey.export({ format: 'jwk' });
    world.published = [{ ...priv, kid: 'k1' }];
    const leaked = await issuerCheck({
      issuer: base,
      expectedJwks: { keys: world.published },
      audience: 'a',
    });
    expect(leaked[1]).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/PRIVATE KEY MATERIAL/),
    });
    world.published = [world.signing.jwk];
    world.discoveryIssuer = 'https://evil.example';
    expect(
      (
        await issuerCheck({ issuer: base, expectedJwks: { keys: world.published }, audience: 'a' })
      )[0]?.ok,
    ).toBe(false);
  });

  it('verifyEs256 rejects alg confusion, unknown kids and garbage', () => {
    const token = jwt(world.signing, { sub: 'x' });
    expect(verifyEs256(token, { keys: [world.signing.jwk] }).ok).toBe(true);
    const [, p, s] = token.split('.');
    expect(
      verifyEs256(`${b64({ alg: 'HS256', kid: 'k1' })}.${p}.${s}`, { keys: [world.signing.jwk] })
        .ok,
    ).toBe(false);
    expect(verifyEs256(token, { keys: [{ ...world.signing.jwk, kid: 'other' }] }).ok).toBe(false);
    expect(verifyEs256('not-a-jwt', { keys: [] }).ok).toBe(false);
  });
});

describe('SPA, health and direct ALB checks', () => {
  it('SPA shell, CSP naming the issuer and /config.json', async () => {
    const outcomes = await spaCheck({
      baseUrl: base,
      issuer: base,
      clientId: 'starter-web-sandbox',
    });
    expect(outcomes.every((o) => o.ok)).toBe(true);
    world.configIssuer = 'https://other.example';
    world.spaCsp = 'script-src *';
    const bad = await spaCheck({ baseUrl: base, issuer: base, clientId: 'starter-web-sandbox' });
    expect(bad.map((o) => o.ok)).toEqual([true, false, false]);
  });

  it('health: both probes must answer 200', async () => {
    expect((await healthCheck({ baseUrl: base })).every((o) => o.ok)).toBe(true);
    world.readyStatus = 503;
    expect((await healthCheck({ baseUrl: base })).map((o) => o.ok)).toEqual([true, false]);
  });

  it('direct ALB: an answering API fails; a 403 passes; a refused connection passes as "no connection"', async () => {
    const served = await albDirectCheck({ albDnsName: new URL(base).host });
    expect(served.every((o) => !o.ok)).toBe(true);
    const forbidding = createServer((_req, res) => {
      res.writeHead(403);
      res.end();
    });
    await new Promise<void>((r) => forbidding.listen(0, '127.0.0.1', r));
    const port = (forbidding.address() as AddressInfo).port;
    try {
      expect((await albDirectCheck({ albDnsName: `127.0.0.1:${port}` })).every((o) => o.ok)).toBe(
        true,
      );
    } finally {
      await new Promise<void>((r) => forbidding.close(() => r()));
    }
    const closed = await albDirectCheck({ albDnsName: `127.0.0.1:${port}`, timeoutMs: 2_000 });
    expect(closed.every((o) => o.ok && /no connection/.test(o.detail))).toBe(true);
  });
});

describe('canary submission', () => {
  it('submits a canary and a business-invalid job, waits for both, checks the owner view', async () => {
    const run = await submitCanaries({
      baseUrl: base,
      idpUrl: base,
      runId: 'sbx-abcdef',
      pollIntervalMs: 1,
      sleep: async () => {},
    });
    expect(run).toMatchObject({
      canaryStatus: 'SUCCEEDED',
      failureStatus: 'FAILED',
      failureErrorName: 'JobValidationError',
      ownerView: { titleFound: true, contentCanariesFound: 0 },
    });
    for (const c of Object.values(run.canaries)) expect(c).toMatch(/[ ~]/);
    expect(JSON.stringify(run)).not.toMatch(/eyJ/);
    expect(world.calls.filter((c) => c === 'POST /v1/jobs')).toHaveLength(2);
  });

  it('refuses when the IdP does not mint a token', async () => {
    await expect(
      submitCanaries({ baseUrl: base, idpUrl: `${base}/nope`, runId: 'sbx-abcdef' }),
    ).rejects.toThrow(/test IdP answered HTTP 404/);
  });
});

describe('clock skew', () => {
  it('passes within the limit, fails beyond it or without a Date header', async () => {
    const dated = (date: string | null): typeof fetch =>
      (async () => new Response('', { headers: date ? { date } : {} })) as unknown as typeof fetch;
    const server = Date.parse('2026-10-15T00:00:00Z');
    const at = (offset: number) => () => server + offset;
    const ok = await clockSkewCheck({
      url: 'https://x',
      fetchImpl: dated(new Date(server).toUTCString()),
      now: at(10_000),
    });
    expect(ok[0]).toMatchObject({ ok: true });
    const off = await clockSkewCheck({
      url: 'https://x',
      fetchImpl: dated(new Date(server).toUTCString()),
      now: at(-45_000),
    });
    expect(off[0]).toMatchObject({ ok: false, detail: expect.stringMatching(/skew 45\.0 s/) });
    expect((await clockSkewCheck({ url: 'https://x', fetchImpl: dated(null) }))[0]?.ok).toBe(false);
  });
});
