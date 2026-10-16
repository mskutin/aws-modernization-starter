/**
 * TLS-terminating PostgreSQL proxy for client-side TLS tests (ADR 0222).
 *
 * GitLab CI jobs reach PostgreSQL as a plain `services:` container and have no container socket,
 * so they cannot start a TLS-enabled server with freshly generated keys. This proxy is a TLS
 * endpoint the test controls: it speaks PostgreSQL's SSL negotiation (SSLRequest -> 'S'), then a
 * real TLS handshake with the given certificate, and forwards the decrypted stream to the plain
 * backend. The client under test therefore performs its full `verify-full` validation (chain
 * against DB_SSL_ROOT_CERT, host name against the SANs) and, when it succeeds, talks to a real
 * PostgreSQL. A plain-text startup is refused, like `hostssl`-only `pg_hba.conf` rules.
 *
 * Binds 127.0.0.1 on an ephemeral port only.
 */
import { createServer, connect, type Server, type Socket } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';

/** PostgreSQL SSLRequest: int32 length 8 + int32 code 80877103. */
const SSL_REQUEST_CODE = 80_877_103;

export interface PgTlsProxy {
  host: string;
  port: number;
  /** Number of TLS handshakes the proxy completed (lets tests prove a TLS path was used). */
  handshakes(): number;
  close(): Promise<void>;
}

export async function startPgTlsProxy(options: {
  backend: { host: string; port: number };
  cert: string;
  key: string;
}): Promise<PgTlsProxy> {
  const context = createSecureContext({
    cert: options.cert,
    key: options.key,
    minVersion: 'TLSv1.2',
  });
  const sockets = new Set<Socket>();
  let handshakes = 0;

  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };

  const server: Server = createServer((client) => {
    track(client);
    client.on('error', () => client.destroy());
    let header = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      if (header.length < 8) return;
      client.off('data', onData);
      const isSslRequest =
        header.readInt32BE(0) === 8 && header.readInt32BE(4) === SSL_REQUEST_CODE;
      if (!isSslRequest || header.length > 8) {
        client.destroy(); // plain-text startup or a pipelined client: refuse
        return;
      }
      client.write('S');
      const tlsSocket = new TLSSocket(client, { isServer: true, secureContext: context });
      track(tlsSocket);
      const upstream = connect(options.backend.port, options.backend.host);
      track(upstream);
      const closeBoth = () => {
        tlsSocket.destroy();
        upstream.destroy();
      };
      tlsSocket.on('secure', () => {
        handshakes += 1;
      });
      tlsSocket.on('error', closeBoth);
      upstream.on('error', closeBoth);
      tlsSocket.on('close', closeBoth);
      upstream.on('close', closeBoth);
      tlsSocket.pipe(upstream);
      upstream.pipe(tlsSocket);
    };
    client.on('data', onData);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('proxy has no TCP address');
  return {
    host: '127.0.0.1',
    port: address.port,
    handshakes: () => handshakes,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
