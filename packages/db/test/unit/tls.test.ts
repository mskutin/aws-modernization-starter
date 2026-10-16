import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestPki, type TestPki } from '@starter/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseTlsError,
  RDS_CA_BUNDLE_FILENAME,
  loadCaBundle,
  pgTlsOptions,
  rdsCaBundlePath,
} from '../../src/tls.js';

describe('vendored Amazon RDS CA bundle (packages/db/certs)', () => {
  it('is exactly the file documented in certs/README.md (SHA-256)', async () => {
    const readme = await readFile(new URL('../../certs/README.md', import.meta.url), 'utf8');
    const documented = /SHA-256\s*\|\s*`([0-9a-f]{64})`/.exec(readme)?.[1];
    expect(documented).toBeDefined();
    const actual = createHash('sha256')
      .update(await readFile(rdsCaBundlePath()))
      .digest('hex');
    expect(actual).toBe(documented);
  });

  it('parses: CA certificates only, including the ap-southeast-1 root the instance uses', () => {
    const bundle = loadCaBundle(rdsCaBundlePath());
    expect(rdsCaBundlePath().endsWith(`/certs/${RDS_CA_BUNDLE_FILENAME}`)).toBe(true);
    expect(bundle.certificates).toBe(111);
    expect(bundle.pem).not.toMatch(/PRIVATE KEY/);
    expect(bundle.earliestExpiry.getTime()).toBeGreaterThan(Date.now());
    const subjects = (
      bundle.pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
    ).map((pem) => new X509Certificate(pem).subject);
    // CDK: caCertificate rds.CaCertificate.RDS_CA_RSA2048_G1 (infra/constructs/relational-database.ts).
    expect(
      subjects.some((s) => s.includes('CN=Amazon RDS ap-southeast-1 Root CA RSA2048 G1')),
    ).toBe(true);
  });
});

describe('loadCaBundle rejects unusable trust anchors without echoing their content', () => {
  let dir: string;
  let pki: TestPki;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'starter-db-tls-'));
    pki = await createTestPki({ dnsNames: ['db.test.internal'] });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await pki?.cleanup();
  });

  const write = async (name: string, content: string) => {
    const path = join(dir, name);
    await writeFile(path, content);
    return path;
  };

  it('a missing file names the path and the errno, nothing else', () => {
    expect(() => loadCaBundle(join(dir, 'missing.pem'))).toThrow(
      new DatabaseTlsError(`cannot read DB_SSL_ROOT_CERT ${join(dir, 'missing.pem')} (ENOENT)`),
    );
  });

  it('a file with a private key is refused', async () => {
    const path = await write('with-key.pem', `${pki.ca.pem}\n${pki.server.key.pem}`);
    const error = (() => {
      try {
        loadCaBundle(path);
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(DatabaseTlsError);
    expect(error?.message).toMatch(/contains a private key/);
    expect(error?.message).not.toContain('BEGIN');
  });

  it('a file without certificates is refused', async () => {
    expect(() => loadCaBundle(pki.server.key.path.replace('server.key', 'openssl.cnf'))).toThrow(
      /contains no PEM certificate/,
    );
  });

  it('a leaf (non-CA) certificate is refused as a trust anchor', async () => {
    const path = await write('leaf.pem', pki.server.cert.pem);
    expect(() => loadCaBundle(path)).toThrow(/certificate #1 .* is not a CA certificate/);
  });

  it('a corrupt certificate block is refused', async () => {
    const path = await write(
      'corrupt.pem',
      '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
    );
    expect(() => loadCaBundle(path)).toThrow(/certificate #1 cannot be parsed/);
  });
});

describe('pgTlsOptions', () => {
  it('disable = plain TCP (non-AWS runtimes only, enforced by the config schema)', () => {
    expect(pgTlsOptions({ mode: 'disable' })).toBe(false);
  });

  it('verify-full = the bundle as the ONLY trust store, chain and host name verified', () => {
    const options = pgTlsOptions({ mode: 'verify-full', rootCertPath: rdsCaBundlePath() });
    expect(options).toEqual({
      ca: loadCaBundle(rdsCaBundlePath()).pem,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
    // No override of Node's host-name check.
    expect(options && 'checkServerIdentity' in options).toBe(false);
  });
});
