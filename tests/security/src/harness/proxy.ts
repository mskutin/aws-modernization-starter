/**
 * Minimal reverse proxy that behaves like CloudFront and the ALB (and the local nginx web tier)
 * in the one respect the security suite depends on: it APPENDS the address of its own peer to
 * `X-Forwarded-For` (`$proxy_add_x_forwarded_for`), so a client-supplied `X-Forwarded-For` ends up
 * to the LEFT of the entries the API trusts. Requests and responses are streamed unchanged
 * otherwise (Authorization and bodies included).
 *
 * TEST ONLY. This is a simulation of the edge's forwarding semantics, not of CloudFront; the
 * external mode exercises the real local nginx (WEB_BASE_URL).
 */
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface StartedProxy {
  name: string;
  url: string;
  /** Requests forwarded so far. */
  readonly forwarded: number;
  close(): Promise<void>;
}

/** `X-Forwarded-For` after this hop: prior value(s), then the peer address. */
export function appendForwardedFor(prior: string | string[] | undefined, peer: string): string {
  const previous = Array.isArray(prior) ? prior.join(', ') : prior;
  return previous && previous.trim() !== '' ? `${previous}, ${peer}` : peer;
}

/** Peer address as proxies record it (IPv4-mapped IPv6 → IPv4). */
export const peerAddress = (socket: Socket): string =>
  (socket.remoteAddress ?? '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');

export function forwardHeaders(
  incoming: IncomingHttpHeaders,
  peer: string,
  upstreamHost: string,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined && !HOP_BY_HOP.has(key)) out[key] = value;
  }
  out['x-forwarded-for'] = appendForwardedFor(incoming['x-forwarded-for'], peer);
  out['x-forwarded-proto'] = 'https';
  out['x-forwarded-host'] = incoming.host ?? '';
  out.host = upstreamHost;
  return out;
}

export async function startProxy(name: string, upstreamUrl: string): Promise<StartedProxy> {
  const upstream = new URL(upstreamUrl);
  const sockets = new Set<Socket>();
  let forwarded = 0;
  const server = createServer((req, res) => {
    forwarded++;
    const upstreamReq = httpRequest(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req.headers, peerAddress(req.socket), upstream.host),
      },
      (up) => {
        const headers: OutgoingHttpHeaders = {};
        for (const [key, value] of Object.entries(up.headers)) {
          if (value !== undefined && !HOP_BY_HOP.has(key)) headers[key] = value;
        }
        res.writeHead(up.statusCode ?? 502, headers);
        up.pipe(res);
      },
    );
    upstreamReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('bad gateway');
    });
    req.pipe(upstreamReq);
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    name,
    url: `http://127.0.0.1:${port}`,
    get forwarded() {
      return forwarded;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
