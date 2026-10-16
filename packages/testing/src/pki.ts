/**
 * Throw-away X.509 material for TLS tests, generated at test time with the `openssl` CLI (the CI
 * node image and macOS ship it). Nothing is committed: keys live in a private temp directory
 * (0700) that `cleanup()` removes.
 *
 * - `ca`: the CA the client is told to trust (DB_SSL_ROOT_CERT).
 * - `otherCa`: an unrelated CA (wrong-CA tests).
 * - `server`: a leaf certificate issued by `ca` for exactly `dnsNames` + `ipAddresses`.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface PemFile {
  path: string;
  pem: string;
}

export interface TestPki {
  dir: string;
  ca: PemFile;
  otherCa: PemFile;
  server: { cert: PemFile; key: PemFile; dnsNames: string[]; ipAddresses: string[] };
  cleanup(): Promise<void>;
}

// No `prompt = no` + DN values here: LibreSSL (macOS) then ignores -subj, every certificate gets
// the same subject and a leaf "issued" by the CA looks self-signed (DEPTH_ZERO_SELF_SIGNED_CERT).
const OPENSSL_CONFIG = `[req]
distinguished_name = dn
[dn]
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
`;

async function openssl(args: string[], cwd: string): Promise<void> {
  try {
    await run('openssl', args, { cwd, timeout: 30_000 });
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') {
      throw new Error('openssl CLI not found on PATH (needed to generate test certificates)', {
        cause: error,
      });
    }
    throw new Error(`openssl ${args[0]} failed: ${e.stderr ?? e.message}`, { cause: error });
  }
}

async function selfSignedCa(dir: string, name: string, label: string): Promise<PemFile> {
  const cert = join(dir, `${name}.pem`);
  await openssl(
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, `${name}.key`),
      '-out',
      cert,
      '-days',
      '2',
      '-subj',
      `/CN=${label} ${randomBytes(4).toString('hex')}`,
      '-config',
      join(dir, 'openssl.cnf'),
      '-extensions',
      'v3_ca',
    ],
    dir,
  );
  return { path: cert, pem: await readFile(cert, 'utf8') };
}

export async function createTestPki(
  options: { dnsNames?: string[]; ipAddresses?: string[] } = {},
): Promise<TestPki> {
  const dnsNames = options.dnsNames ?? ['localhost'];
  const ipAddresses = options.ipAddresses ?? [];
  if (dnsNames.length + ipAddresses.length === 0) throw new Error('need at least one SAN');
  const dir = await mkdtemp(join(tmpdir(), 'starter-test-pki-'));
  await chmod(dir, 0o700);
  try {
    await writeFile(join(dir, 'openssl.cnf'), OPENSSL_CONFIG);
    const ca = await selfSignedCa(dir, 'ca', 'starter test CA');
    const otherCa = await selfSignedCa(dir, 'other-ca', 'starter unrelated test CA');

    const san = [...dnsNames.map((d) => `DNS:${d}`), ...ipAddresses.map((ip) => `IP:${ip}`)];
    await writeFile(
      join(dir, 'server-ext.cnf'),
      `[v3_server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${san.join(',')}
authorityKeyIdentifier = keyid,issuer
`,
    );
    const keyPath = join(dir, 'server.key');
    await openssl(
      [
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        join(dir, 'server.csr'),
        '-subj',
        `/CN=${dnsNames[0] ?? ipAddresses[0] ?? 'server'}`,
        '-config',
        join(dir, 'openssl.cnf'),
      ],
      dir,
    );
    const certPath = join(dir, 'server.pem');
    await openssl(
      [
        'x509',
        '-req',
        '-in',
        join(dir, 'server.csr'),
        '-CA',
        ca.path,
        '-CAkey',
        join(dir, 'ca.key'),
        '-set_serial',
        `0x${randomBytes(8).toString('hex')}`,
        '-out',
        certPath,
        '-days',
        '2',
        '-extfile',
        join(dir, 'server-ext.cnf'),
        '-extensions',
        'v3_server',
      ],
      dir,
    );
    await chmod(keyPath, 0o600);
    return {
      dir,
      ca,
      otherCa,
      server: {
        cert: { path: certPath, pem: await readFile(certPath, 'utf8') },
        key: { path: keyPath, pem: await readFile(keyPath, 'utf8') },
        dnsNames,
        ipAddresses,
      },
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
