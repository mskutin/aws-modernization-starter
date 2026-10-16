/**
 * Persistent ES256 signing key of the TEST-ONLY IdP for the AWS sandbox.
 *
 * The sandbox API verifies tokens against a public JWKS on AWS, so the IdP that mints them (on the
 * operator host, never deployed) needs a key that outlives one process: a private EC P-256 JWK in
 * a file. The rules for that file:
 *
 *  - created exclusively (never overwrites), mode 0600, owned by the current user;
 *  - loaded only when it is a regular file (not a symlink), mode exactly 0600, owned by the
 *    current user, at most 16 KiB, a complete and consistent P-256 private key;
 *  - never inside a git work tree or this repository (it must not be committable);
 *  - `kid` = RFC 7638 JWK thumbprint (SHA-256) of the public key, so it is stable across exports
 *    and restarts, and a `kid` in the file that disagrees is refused;
 *  - no message ever contains key material (JSON parse errors are replaced, not wrapped).
 */
import {
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIGNING_ALGORITHM = 'ES256';
export const MAX_KEY_FILE_BYTES = 16 * 1024;
/** JWK members that only private (or symmetric) keys have; none may ever be published. */
export const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;
const P256_COORDINATE = /^[A-Za-z0-9_-]{43}$/;

export class SigningKeyError extends Error {
  override readonly name = 'SigningKeyError';
}

/** Public half as published in `jwks.json`. */
export interface PublicSigningJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid: string;
  alg: 'ES256';
  use: 'sig';
}

/** What `keygen` writes (and the loader reads): the public members plus `d`. */
export interface PrivateSigningJwk extends PublicSigningJwk {
  d: string;
}

export interface SigningKey {
  readonly kid: string;
  readonly algorithm: 'ES256';
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly publicJwk: PublicSigningJwk;
}

/** RFC 7638 thumbprint (SHA-256, base64url) of an EC public key: required members, sorted. */
export function ecThumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash('sha256').update(canonical).digest('base64url');
}

/** Throws when a JWK (or every key of a JWK Set) carries a private or symmetric member. */
export function assertPublicOnly(value: { keys: readonly object[] } | object): void {
  const keys = 'keys' in value && Array.isArray(value.keys) ? (value.keys as object[]) : [value];
  for (const key of keys) {
    const leaked = PRIVATE_JWK_MEMBERS.filter((member) => member in key);
    if (leaked.length > 0) {
      throw new SigningKeyError(
        `refusing to publish a key with private members (${leaked.join(', ')})`,
      );
    }
  }
}

// ── Where key files may live ────────────────────────────────────────────────────────────────

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** `path` with its longest existing prefix resolved through symlinks (the leaf may not exist). */
export function physicalPath(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** The git work tree (a directory holding a `.git` file or directory) that contains `path`. */
export function enclosingGitWorkTree(path: string): string | undefined {
  let dir = physicalPath(path);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

let cachedRepositoryRoot: string | null | undefined;
/** Root of the workspace this module was loaded from (undefined in the container bundle). */
export function repositoryRoot(): string | undefined {
  if (cachedRepositoryRoot === undefined) {
    cachedRepositoryRoot = null;
    let dir = physicalPath(dirname(fileURLToPath(import.meta.url)));
    for (;;) {
      if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
        cachedRepositoryRoot = dir;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return cachedRepositoryRoot ?? undefined;
}

/** Refuses a key path inside any git work tree or inside this repository. */
export function assertOutsideRepository(path: string, label: string): void {
  const physical = physicalPath(path);
  const tree = enclosingGitWorkTree(physical);
  if (tree) {
    throw new SigningKeyError(
      `${label} must not be inside a git work tree (${tree}): private keys never live in a repository`,
    );
  }
  const root = repositoryRoot();
  if (root && isInside(physical, root)) {
    throw new SigningKeyError(`${label} must not be inside the repository (${root})`);
  }
}

// ── Generate, write, load ───────────────────────────────────────────────────────────────────

/** A fresh P-256 key pair as a private JWK with `kid` = RFC 7638 thumbprint. */
export function generateSigningJwk(): PrivateSigningJwk {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { x, y, d } = privateKey.export({ format: 'jwk' });
  if (!x || !y || !d) throw new SigningKeyError('key generation returned an incomplete JWK');
  const kid = ecThumbprint({ crv: 'P-256', kty: 'EC', x, y });
  return { kty: 'EC', crv: 'P-256', x, y, d, kid, alg: SIGNING_ALGORITHM, use: 'sig' };
}

/**
 * Writes a NEW key file (O_EXCL: an existing file or symlink is never replaced) with mode 0600;
 * the parent directory is created with mode 0700 when missing. Returns the absolute path.
 */
export function writeNewKeyFile(path: string, jwk: PrivateSigningJwk): string {
  const absolute = resolve(path);
  assertOutsideRepository(absolute, 'the key file');
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new SigningKeyError(`${absolute} already exists: refusing to overwrite a key file`);
    }
    throw error;
  }
  try {
    fchmodSync(fd, 0o600); // the umask can only remove bits; make the mode exact anyway
    writeSync(fd, `${JSON.stringify(jwk, null, 2)}\n`);
  } catch (error) {
    closeSync(fd);
    unlinkSync(absolute);
    throw error;
  }
  closeSync(fd);
  return absolute;
}

/**
 * Refuses a JWK whose public point (x, y) is not d·G. The point is computed from `d` here, not
 * read back from the imported key: whether `createPrivateKey` checks a JWK's x/y against its d
 * depends on the Node.js/OpenSSL version (Node 24 keeps the given x/y, Node 26 refuses them), and
 * a key that signs with one d while publishing another key's x/y would mint unverifiable tokens.
 * Errors are replaced, never wrapped, so no message carries key material.
 */
function assertPublicMatchesPrivate(x: string, y: string, d: string): void {
  let derived: Buffer;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(d, 'base64url')); // throws unless 0 < d < n
    derived = ecdh.getPublicKey(); // uncompressed SEC 1 point: 0x04 || X || Y
  } catch {
    throw new SigningKeyError('the signing key is not a valid P-256 private key');
  }
  const declared = Buffer.concat([
    Buffer.of(0x04),
    Buffer.from(x, 'base64url'),
    Buffer.from(y, 'base64url'),
  ]);
  if (declared.length !== derived.length || !timingSafeEqual(declared, derived)) {
    throw new SigningKeyError('the public members (x, y) do not belong to the private key (d)');
  }
}

/** Validates a parsed private JWK and imports it. Messages never contain key material. */
export function signingKeyFromJwk(value: unknown): SigningKey {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SigningKeyError('the signing key file must contain one JWK object');
  }
  const jwk = value as Record<string, unknown>;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
    throw new SigningKeyError('the signing key must be an EC P-256 key (ES256)');
  }
  if (jwk.d === undefined) {
    throw new SigningKeyError('the signing key file holds a public key; a private JWK is required');
  }
  const { x, y, d } = jwk;
  if (
    typeof x !== 'string' ||
    typeof y !== 'string' ||
    typeof d !== 'string' ||
    ![x, y, d].every((member) => P256_COORDINATE.test(member))
  ) {
    throw new SigningKeyError('the signing key has malformed x, y or d members');
  }
  if (jwk.alg !== undefined && jwk.alg !== SIGNING_ALGORITHM) {
    throw new SigningKeyError(`the signing key declares alg other than ${SIGNING_ALGORITHM}`);
  }
  if (jwk.use !== undefined && jwk.use !== 'sig') {
    throw new SigningKeyError('the signing key declares a use other than sig');
  }
  assertPublicMatchesPrivate(x, y, d);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x, y, d }, format: 'jwk' });
  } catch {
    throw new SigningKeyError('the signing key is not a valid P-256 private key');
  }
  const publicKey = createPublicKey(privateKey);
  const kid = ecThumbprint({ crv: 'P-256', kty: 'EC', x, y });
  if (jwk.kid !== undefined && jwk.kid !== kid) {
    throw new SigningKeyError('the key file kid is not the RFC 7638 thumbprint of its public key');
  }
  return {
    kid,
    algorithm: SIGNING_ALGORITHM,
    privateKey,
    publicKey,
    publicJwk: { kty: 'EC', crv: 'P-256', x, y, kid, alg: SIGNING_ALGORITHM, use: 'sig' },
  };
}

/**
 * Loads `TEST_IDP_SIGNING_KEY_FILE` / `export --key`: refuses unless the file is a regular file
 * (no symlink), mode exactly 0600, owned by the current user, outside any repository.
 */
export function loadSigningKeyFile(path: string): SigningKey {
  const absolute = resolve(path);
  assertOutsideRepository(absolute, 'the signing key file');
  let fd: number;
  try {
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new SigningKeyError(`${absolute} is a symlink; use the key file itself`);
    }
    if (code === 'ENOENT') throw new SigningKeyError(`${absolute} does not exist`);
    if (code === 'EACCES') throw new SigningKeyError(`${absolute} is not readable`);
    throw error;
  }
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new SigningKeyError(`${absolute} is not a regular file`);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      throw new SigningKeyError(
        `${absolute} has mode 0${mode.toString(8)}; a signing key file must have mode 0600 (chmod 600)`,
      );
    }
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
      throw new SigningKeyError(`${absolute} is owned by another user`);
    }
    if (stat.size > MAX_KEY_FILE_BYTES) {
      throw new SigningKeyError(`${absolute} is larger than ${MAX_KEY_FILE_BYTES} bytes`);
    }
    text = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never wrap the SyntaxError: V8 quotes part of the input (the key) in its message.
    throw new SigningKeyError(`${absolute} is not a JSON Web Key`);
  }
  return signingKeyFromJwk(parsed);
}
