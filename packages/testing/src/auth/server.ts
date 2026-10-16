/**
 * TEST ONLY — serves a `createTestIssuer` over HTTP on 127.0.0.1 (ephemeral port):
 *
 *   GET /.well-known/openid-configuration   { issuer, jwks_uri, ... }
 *   GET /jwks.json                          the published JWK Set
 *
 * The issuer identifier defaults to the server URL (`http://127.0.0.1:<port>`), so an API under
 * test needs AUTH_ALLOW_INSECURE_ISSUER=true (refused with NODE_ENV=production). Request
 * counters and an outage switch let tests prove bounded JWKS fetching and IdP-outage behaviour.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createTestIssuer, type TestIssuer, type TestIssuerOptions } from './issuer.js';

export type IssuerOutage = 'none' | 'error' | 'hang';

export interface StartedTestIssuer extends TestIssuer {
  /** Base URL of the HTTP server (also the default issuer identifier). */
  readonly url: string;
  readonly jwksUri: string;
  readonly discoveryUrl: string;
  /** Requests answered (or swallowed during an outage) per document. */
  readonly stats: { readonly jwksRequests: number; readonly discoveryRequests: number };
  resetStats(): void;
  /** `error`: answer 503; `hang`: never answer (until `close`); `none`: normal. */
  setOutage(mode: IssuerOutage): void;
  close(): Promise<void>;
}

export async function startTestIssuer(
  options: TestIssuerOptions & { port?: number } = {},
): Promise<StartedTestIssuer> {
  let outage: IssuerOutage = 'none';
  const stats = { jwksRequests: 0, discoveryRequests: 0 };
  const sockets = new Set<Socket>();
  // Created after listen(): the default issuer identifier is the server URL.
  const state: { issuer?: TestIssuer; url: string } = { url: '' };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const isJwks = path === '/jwks.json';
    const isDiscovery = path === '/.well-known/openid-configuration';
    if (isJwks) stats.jwksRequests += 1;
    if (isDiscovery) stats.discoveryRequests += 1;
    const { issuer, url } = state;
    if (!issuer || req.method !== 'GET' || (!isJwks && !isDiscovery)) {
      send(res, 404, { error: 'not_found' });
      return;
    }
    if (outage === 'hang') return; // the socket is destroyed by close()
    if (outage === 'error') {
      send(res, 503, { error: 'temporarily_unavailable' });
      return;
    }
    if (isJwks) {
      send(res, 200, issuer.jwks());
      return;
    }
    send(res, 200, {
      issuer: issuer.issuer,
      jwks_uri: `${url}/jwks.json`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: [issuer.algorithm],
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const base = await createTestIssuer({ ...options, issuer: options.issuer ?? url });
  state.url = url;
  state.issuer = base;

  return {
    get issuer() {
      return base.issuer;
    },
    get audience() {
      return base.audience;
    },
    get algorithm() {
      return base.algorithm;
    },
    get activeKid() {
      return base.activeKid;
    },
    jwks: () => base.jwks(),
    mint: (claims, opts) => base.mint(claims, opts),
    mintWith: (opts) => base.mintWith(opts),
    rotate: (opts) => base.rotate(opts),
    url,
    jwksUri: `${url}/jwks.json`,
    discoveryUrl: `${url}/.well-known/openid-configuration`,
    stats,
    resetStats() {
      stats.jwksRequests = 0;
      stats.discoveryRequests = 0;
    },
    setOutage(mode) {
      outage = mode;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
