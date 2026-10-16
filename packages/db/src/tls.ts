/**
 * TLS for PostgreSQL connections (ADR 0222).
 *
 * `DB_SSL=verify-full` verifies the server certificate chain against the PEM bundle in
 * `DB_SSL_ROOT_CERT` **only** (Node's `ca` option replaces the built-in Mozilla store, and
 * NODE_EXTRA_CA_CERTS extends only that default store) and verifies the host name: `pg` sets
 * SNI/`servername` to `DB_HOST` (or checks the IP SANs when `DB_HOST` is an address) and Node's
 * `checkServerIdentity` rejects any mismatch. There is no "encrypt but do not verify" mode.
 *
 * On AWS the bundle is the Amazon RDS global CA bundle vendored in `packages/db/certs/`
 * (see its README); locally it is the CA generated for the compose stack or for a test.
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ConnectionOptions } from 'node:tls';
import type { DatabaseTls } from '@starter/config';

/** File name of the vendored Amazon RDS global CA bundle (`packages/db/certs/`). */
export const RDS_CA_BUNDLE_FILENAME = 'rds-global-bundle.pem';

/**
 * Absolute path of the vendored RDS bundle inside this package (works in the workspace and in a
 * `pnpm deploy` output, where `certs/` ships with the package). Bundlers (Lambda) must copy the
 * file next to the bundle instead and point `DB_SSL_ROOT_CERT` at the copy.
 */
export function rdsCaBundlePath(): string {
  return fileURLToPath(new URL(`../certs/${RDS_CA_BUNDLE_FILENAME}`, import.meta.url));
}

export class DatabaseTlsError extends Error {
  override readonly name = 'DatabaseTlsError';
}

export interface CaBundle {
  path: string;
  pem: string;
  /** Number of CA certificates in the bundle. */
  certificates: number;
  /** Earliest `notAfter` of the bundle's certificates. */
  earliestExpiry: Date;
  /** Latest `notAfter` of the bundle's certificates. */
  latestExpiry: Date;
}

const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * Reads and validates a PEM CA bundle: at least one certificate, every block a parseable CA
 * certificate, no private keys. Errors name the path, never the content.
 */
export function loadCaBundle(path: string): CaBundle {
  let pem: string;
  try {
    pem = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'read error';
    throw new DatabaseTlsError(`cannot read DB_SSL_ROOT_CERT ${path} (${code})`);
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
    throw new DatabaseTlsError(
      `DB_SSL_ROOT_CERT ${path} contains a private key; it must hold CA certificates only`,
    );
  }
  const blocks = pem.match(CERTIFICATE_BLOCK) ?? [];
  if (blocks.length === 0) {
    throw new DatabaseTlsError(`DB_SSL_ROOT_CERT ${path} contains no PEM certificate`);
  }
  let earliest = Number.POSITIVE_INFINITY;
  let latest = 0;
  blocks.forEach((block, index) => {
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(block);
    } catch {
      throw new DatabaseTlsError(
        `DB_SSL_ROOT_CERT ${path}: certificate #${index + 1} cannot be parsed`,
      );
    }
    if (!certificate.ca) {
      throw new DatabaseTlsError(
        `DB_SSL_ROOT_CERT ${path}: certificate #${index + 1} (${certificate.subject.replace(/\n/g, ', ')}) is not a CA certificate`,
      );
    }
    const notAfter = new Date(certificate.validTo).getTime();
    earliest = Math.min(earliest, notAfter);
    latest = Math.max(latest, notAfter);
  });
  return {
    path,
    pem,
    certificates: blocks.length,
    earliestExpiry: new Date(earliest),
    latestExpiry: new Date(latest),
  };
}

/** `pg` `ssl` option for a validated configuration (`false` = plain TCP, non-production only). */
export function pgTlsOptions(ssl: DatabaseTls): false | ConnectionOptions {
  if (ssl.mode === 'disable') return false;
  const bundle = loadCaBundle(ssl.rootCertPath);
  return {
    ca: bundle.pem,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    // No checkServerIdentity override: Node's default verifies DB_HOST against the SANs.
  };
}
