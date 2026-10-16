/**
 * `sandbox-issuer`: operator CLI for the AWS sandbox test issuer.
 *
 *   keygen --out <file>
 *       New private EC P-256 JWK (ES256), kid = RFC 7638 thumbprint, written with mode 0600.
 *       Refuses a path inside any git work tree or this repository, and never overwrites.
 *       stdout: {"kid":…,"out":…}  (never key material)
 *
 *   export --issuer <https origin> --key <file> --out <dir>
 *       Writes the two PUBLIC documents the static issuer (S3 + CloudFront) serves:
 *         <dir>/openid-configuration  → s3 key .well-known/openid-configuration
 *         <dir>/jwks.json             → s3 key jwks.json
 *       The discovery document is the one the local IdP serves for the same issuer; the JWK Set
 *       holds only the public key (asserted: no d/p/q/dp/dq/qi/oth/k).
 *       stdout: {"issuer":…,"kid":…,"alg":"ES256","files":[{file,key,contentType}]}
 *
 * Exit codes: 0 done, 1 refused/failed, 2 usage.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { API_SCOPES, TestIdpConfigError, normalizeIssuer } from './config.js';
import { discoveryDocument, type DiscoveryDocument } from './discovery.js';
import {
  SigningKeyError,
  assertPublicOnly,
  generateSigningJwk,
  loadSigningKeyFile,
  writeNewKeyFile,
  type PublicSigningJwk,
} from './signing-key.js';

export const USAGE = `usage:
  sandbox-issuer keygen --out <file>
  sandbox-issuer export --issuer <https origin> --key <file> --out <dir>`;

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

class UsageError extends Error {}

/**
 * The issuer identifier of the sandbox: an https origin (the CloudFront default domain),
 * normalised by the SAME function as TEST_IDP_ISSUER (`normalizeIssuer`), so the
 * exported discovery document and the running IdP always carry the identical `issuer` string.
 */
export function parseSandboxIssuer(value: string): string {
  try {
    return normalizeIssuer(value, '--issuer', { httpsOnly: true });
  } catch (error) {
    if (error instanceof TestIdpConfigError) throw new UsageError(error.message);
    throw error;
  }
}

export interface ExportedFile {
  /** Local path written. */
  file: string;
  /** Object key in the issuer bucket (= URL path below the issuer). */
  key: string;
  contentType: 'application/json';
}

export interface ExportResult {
  issuer: string;
  kid: string;
  alg: 'ES256';
  files: ExportedFile[];
  discovery: DiscoveryDocument;
  jwks: { keys: PublicSigningJwk[] };
}

export function exportIssuerDocuments(options: {
  issuer: string;
  keyFile: string;
  outDir: string;
}): ExportResult {
  const issuer = parseSandboxIssuer(options.issuer);
  const key = loadSigningKeyFile(options.keyFile);
  const discovery = discoveryDocument(issuer, key.algorithm, API_SCOPES);
  const jwks = { keys: [structuredClone(key.publicJwk)] };
  assertPublicOnly(jwks);
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  const files: ExportedFile[] = [
    {
      file: join(outDir, 'openid-configuration'),
      key: '.well-known/openid-configuration',
      contentType: 'application/json',
    },
    { file: join(outDir, 'jwks.json'), key: 'jwks.json', contentType: 'application/json' },
  ];
  const [discoveryFile, jwksFile] = files as [ExportedFile, ExportedFile];
  writeFileSync(discoveryFile.file, `${JSON.stringify(discovery, null, 2)}\n`, { mode: 0o644 });
  writeFileSync(jwksFile.file, `${JSON.stringify(jwks, null, 2)}\n`, { mode: 0o644 });
  return { issuer, kid: key.kid, alg: key.algorithm, files, discovery, jwks };
}

function required(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || value === '') throw new UsageError(`--${name} is required`);
  return value;
}

export async function runSandboxIssuerCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'keygen') {
      const { values } = parseArgs({
        args: [...rest],
        options: { out: { type: 'string' } },
        strict: true,
        allowPositionals: false,
      });
      const jwk = generateSigningJwk();
      const out = writeNewKeyFile(required(values, 'out'), jwk);
      io.stdout(JSON.stringify({ kid: jwk.kid, alg: jwk.alg, out }));
      return 0;
    }
    if (command === 'export') {
      const { values } = parseArgs({
        args: [...rest],
        options: {
          issuer: { type: 'string' },
          key: { type: 'string' },
          out: { type: 'string' },
        },
        strict: true,
        allowPositionals: false,
      });
      const result = exportIssuerDocuments({
        issuer: required(values, 'issuer'),
        keyFile: required(values, 'key'),
        outDir: required(values, 'out'),
      });
      io.stdout(
        JSON.stringify({
          issuer: result.issuer,
          kid: result.kid,
          alg: result.alg,
          files: result.files,
        }),
      );
      return 0;
    }
    throw new UsageError(command ? `unknown command ${command}` : 'missing command');
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (
      error instanceof UsageError ||
      (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_'))
    ) {
      io.stderr(`sandbox-issuer: ${(error as Error).message}\n${USAGE}`);
      return 2;
    }
    if (error instanceof SigningKeyError) {
      io.stderr(`sandbox-issuer: refused: ${error.message}`);
      return 1;
    }
    io.stderr(`sandbox-issuer: failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
