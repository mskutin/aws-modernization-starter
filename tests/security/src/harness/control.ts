/**
 * Control server of the self-started harness: exposes the TEST-ONLY issuers (which live in the
 * vitest main process) to test workers with the same contract as the test IdP
 * (`tools/test-idp`): `POST <prefix>/test/token` and `POST <prefix>/test/rotate`, plus
 * `POST <prefix>/test/outage` ({ mode: none | error | hang }) for JWKS outage tests.
 * Binds to 127.0.0.1 only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { IssuerOutage, MintOptions, StartedTestIssuer } from '@starter/testing/auth';

export interface StartedControl {
  url: string;
  close(): Promise<void>;
}

const readJson = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      try {
        const value: unknown = body ? JSON.parse(body) : {};
        resolve(
          typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {},
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on('error', reject);
  });

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const OUTAGES: readonly IssuerOutage[] = ['none', 'error', 'hang'];

/** `issuers` maps a path prefix ('' or '/jwks') to an issuer. */
export async function startControl(
  issuers: Readonly<Record<string, StartedTestIssuer>>,
): Promise<StartedControl> {
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const match = /^(.*)\/test\/(token|rotate|outage)$/.exec(path);
      const issuer = match ? issuers[match[1] ?? ''] : undefined;
      if (req.method !== 'POST' || !match || !issuer) return send(res, 404, { error: 'not_found' });
      const body = await readJson(req);
      switch (match[2]) {
        case 'token': {
          const claims =
            typeof body['claims'] === 'object' && body['claims'] !== null
              ? (body['claims'] as Record<string, unknown>)
              : {};
          const options =
            typeof body['options'] === 'object' && body['options'] !== null
              ? (body['options'] as MintOptions)
              : {};
          const accessToken = await issuer.mint(
            {
              ...(typeof body['sub'] === 'string' ? { sub: body['sub'] } : {}),
              ...(typeof body['scope'] === 'string' ? { scope: body['scope'] } : {}),
              ...claims,
            },
            options,
          );
          return send(res, 200, { access_token: accessToken, token_type: 'Bearer' });
        }
        case 'rotate':
          return send(
            res,
            200,
            await issuer.rotate({ retainPrevious: body['retainPrevious'] === true }),
          );
        default: {
          const mode = body['mode'];
          if (typeof mode !== 'string' || !(OUTAGES as readonly string[]).includes(mode)) {
            return send(res, 400, { error: 'mode must be none, error or hang' });
          }
          issuer.setOutage(mode as IssuerOutage);
          return send(res, 200, { mode });
        }
      }
    })().catch((error: unknown) =>
      send(res, 500, { error: error instanceof Error ? error.message : String(error) }),
    );
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
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
