/**
 * LOCAL ONLY: DB_SSL=verify-full against PostgreSQL's own TLS (ssl=on, hostssl-only pg_hba),
 * started by Testcontainers with a certificate generated at test time. Same assertions as the
 * CI suite (tls.test.ts, through the TLS proxy), plus the server-side refusal of plain TCP.
 */
import { SecretValue, type DatabaseConfig } from '@starter/config';
import { createTestPki, startTlsPostgres, type TestPki } from '@starter/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgPool } from '../../src/pool.js';

const silent = { warn: () => undefined, debug: () => undefined };

describe('verify-full against a real TLS PostgreSQL (container)', () => {
  let pki: TestPki;
  let server: Awaited<ReturnType<typeof startTlsPostgres>>;

  beforeAll(async () => {
    pki = await createTestPki({ dnsNames: ['localhost'] });
    server = await startTlsPostgres(pki);
  });
  afterAll(async () => {
    await server?.stop();
    await pki?.cleanup();
  });

  const config = (host: string, ssl: DatabaseConfig['ssl']): DatabaseConfig => ({
    host,
    port: server.endpoint.port,
    database: server.endpoint.database,
    user: server.endpoint.user,
    auth: { mode: 'password', source: 'env', password: new SecretValue(server.endpoint.password) },
    ssl,
    poolMax: 1,
  });

  async function attempt(cfg: DatabaseConfig) {
    const pool = createPgPool(cfg, silent, { connectionTimeoutMillis: 10_000 });
    try {
      const { rows } = await pool.query<{ ssl: boolean; version: string }>(
        'SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
      );
      return { ok: true as const, tls: rows[0] };
    } catch (error) {
      return { ok: false as const, error: error as Error & { code?: string } };
    } finally {
      await pool.end();
    }
  }

  it('right CA + host name: an encrypted session (pg_stat_ssl) with TLS 1.2+', async () => {
    const result = await attempt(
      config('localhost', { mode: 'verify-full', rootCertPath: pki.ca.path }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tls?.ssl).toBe(true);
      expect(result.tls?.version).toMatch(/^TLSv1\.[23]$/);
    }
  });

  it('wrong CA: rejected', async () => {
    const result = await attempt(
      config('localhost', { mode: 'verify-full', rootCertPath: pki.otherCa.path }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN']).toContain(
        result.error.code,
      );
  });

  it('host name mismatch: rejected', async () => {
    const result = await attempt(
      config('127.0.0.1', { mode: 'verify-full', rootCertPath: pki.ca.path }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
  });

  it('plain TCP: refused by the server (hostnossl reject)', async () => {
    const result = await attempt(config('localhost', { mode: 'disable' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('28000');
      expect(result.error.message).toMatch(/no encryption/);
    }
  });
});
