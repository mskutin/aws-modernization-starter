/**
 * DB_SSL=verify-full against a TLS endpoint the test controls (ADR 0222). Runs in CI:
 * a TLS-terminating PostgreSQL proxy with a certificate generated at test time sits in front of the
 * PostgreSQL service, so the client performs its complete verification (chain against
 * DB_SSL_ROOT_CERT, host name against the SANs) and then talks to a real PostgreSQL.
 * The same assertions against PostgreSQL's own TLS stack: *.containers.test.ts (local only).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SecretValue, type DatabaseConfig } from '@starter/config';
import {
  createTestPki,
  startPgTlsProxy,
  type PgTlsProxy,
  type PostgresEndpoint,
  type TestPki,
} from '@starter/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyDbError } from '../../src/errors.js';
import { createPgPool } from '../../src/pool.js';
import { adminEndpoint, createTestDatabase, temporaryRole } from './support.js';

const CANARY = `canary-${Date.now().toString(36)}-Pa55word`;
const silent = { warn: () => undefined, debug: () => undefined };

/** Node/OpenSSL codes for "certificate not trusted" and "wrong host name". */
const UNTRUSTED = [
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
];
const HOST_MISMATCH = 'ERR_TLS_CERT_ALTNAME_INVALID';

describe('verify-full through a TLS endpoint (CI-capable)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let role: Awaited<ReturnType<typeof temporaryRole>>;
  let dnsPki: TestPki; // SAN: DNS:localhost only
  let ipPki: TestPki; // SAN: IP:127.0.0.1 only
  let dnsProxy: PgTlsProxy;
  let ipProxy: PgTlsProxy;

  const backend = (): PostgresEndpoint => db.endpoint;

  beforeAll(async () => {
    db = await createTestDatabase(adminEndpoint(), 'starter_tls');
    role = await temporaryRole(db.endpoint, CANARY);
    [dnsPki, ipPki] = await Promise.all([
      createTestPki({ dnsNames: ['localhost'] }),
      createTestPki({ dnsNames: [], ipAddresses: ['127.0.0.1'] }),
    ]);
    const target = { host: backend().host, port: backend().port };
    dnsProxy = await startPgTlsProxy({
      backend: target,
      cert: dnsPki.server.cert.pem,
      key: dnsPki.server.key.pem,
    });
    ipProxy = await startPgTlsProxy({
      backend: target,
      cert: ipPki.server.cert.pem,
      key: ipPki.server.key.pem,
    });
  });

  afterAll(async () => {
    await dnsProxy?.close();
    await ipProxy?.close();
    await db?.drop();
    await role?.drop();
    await dnsPki?.cleanup();
    await ipPki?.cleanup();
  });

  const config = (host: string, port: number, rootCertPath: string): DatabaseConfig => ({
    host,
    port,
    database: db.endpoint.database,
    user: role.name,
    auth: { mode: 'password', source: 'env', password: new SecretValue(CANARY) },
    ssl: { mode: 'verify-full', rootCertPath },
    poolMax: 1,
  });

  async function attempt(
    cfg: DatabaseConfig,
  ): Promise<{ ok: true; user: string } | { ok: false; error: Error & { code?: string } }> {
    const pool = createPgPool(cfg, silent, { connectionTimeoutMillis: 10_000 });
    try {
      const result = await pool.query<{ user: string }>('SELECT current_user AS user');
      return { ok: true, user: result.rows[0]?.user ?? '' };
    } catch (error) {
      return { ok: false, error: error as Error & { code?: string } };
    } finally {
      await pool.end();
    }
  }

  it('right CA + matching host name: connects and reaches PostgreSQL', async () => {
    const before = dnsProxy.handshakes();
    const result = await attempt(config('localhost', dnsProxy.port, dnsPki.ca.path));
    expect(result).toEqual({ ok: true, user: role.name });
    expect(dnsProxy.handshakes()).toBeGreaterThan(before); // the TLS path was really used
  });

  it('right CA + IP address in the IP SANs: connects (no SNI, IP checked)', async () => {
    expect(await attempt(config('127.0.0.1', ipProxy.port, ipPki.ca.path))).toEqual({
      ok: true,
      user: role.name,
    });
  });

  it('wrong CA: the handshake is rejected before any credential is sent', async () => {
    const result = await attempt(config('localhost', dnsProxy.port, dnsPki.otherCa.path));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(UNTRUSTED).toContain(result.error.code);
    expect(classifyDbError(result.error)).toBe('permanent');
    expect(`${result.error.message} ${result.error.stack}`).not.toContain(CANARY);
  });

  it('host name mismatch: rejected even with the right CA', async () => {
    // Certificate for DNS:localhost, client connects by IP.
    const byIp = await attempt(config('127.0.0.1', dnsProxy.port, dnsPki.ca.path));
    expect(byIp.ok).toBe(false);
    if (!byIp.ok) expect(byIp.error.code).toBe(HOST_MISMATCH);
    // Certificate for IP:127.0.0.1, client connects by name.
    const byName = await attempt(config('localhost', ipProxy.port, ipPki.ca.path));
    expect(byName.ok).toBe(false);
    if (!byName.ok) expect(byName.error.code).toBe(HOST_MISMATCH);
  });

  it('a TLS-only endpoint refuses plain-text clients (DB_SSL=disable)', async () => {
    const result = await attempt({
      ...config('localhost', dnsProxy.port, dnsPki.ca.path),
      ssl: { mode: 'disable' },
    });
    expect(result.ok).toBe(false);
  });

  it('trust is exclusive: NODE_EXTRA_CA_CERTS cannot widen DB_SSL_ROOT_CERT', async () => {
    // A child process trusts the server's CA via NODE_EXTRA_CA_CERTS, but DB_SSL_ROOT_CERT names an
    // unrelated CA: the connection must still be rejected.
    const dist = new URL('../../dist/index.js', import.meta.url).href; // built by `pnpm build`
    const script = `
      import { loadDbConfig, createPgPool } from '${dist}';
      const pool = createPgPool(loadDbConfig(), { warn() {}, debug() {} }, { connectionTimeoutMillis: 10000 });
      try { await pool.query('SELECT 1'); console.log('CONNECTED'); }
      catch (e) { console.log('REJECTED ' + e.code); }
      finally { await pool.end(); }`;
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: {
          PATH: process.env.PATH ?? '',
          NODE_EXTRA_CA_CERTS: dnsPki.ca.path,
          APP_RUNTIME: 'ci',
          DB_HOST: 'localhost',
          DB_PORT: String(dnsProxy.port),
          DB_NAME: db.endpoint.database,
          DB_USER: role.name,
          DB_PASSWORD: CANARY,
          DB_SSL: 'verify-full',
          DB_SSL_ROOT_CERT: dnsPki.otherCa.path,
        },
      });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('error', reject);
      child.on('exit', () => resolve(out.trim()));
    });
    expect(output).toMatch(
      /^REJECTED (UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN)$/,
    );
    expect(output).not.toContain(CANARY);
  });
});
