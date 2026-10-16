/**
 * The sandbox signing-key file: created 0600 and exclusively, never inside a
 * repository, and loaded only when it is a 0600 regular file holding a consistent P-256 private
 * JWK whose kid is its RFC 7638 thumbprint. Every refusal has a test that fails if the check is
 * removed, and no refusal message may contain key material.
 */
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { calculateJwkThumbprint } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SigningKeyError,
  assertPublicOnly,
  generateSigningJwk,
  loadSigningKeyFile,
  repositoryRoot,
  signingKeyFromJwk,
  writeNewKeyFile,
  type PrivateSigningJwk,
} from '../src/signing-key.js';
import { cleanup, tempDir } from './support.js';

const c = cleanup();
afterEach(() => c.run());

/** Writes `content` with `mode` (bypassing writeNewKeyFile) for loader tests. */
function rawKeyFile(dir: string, content: string, mode = 0o600, name = 'key.jwk'): string {
  const file = join(dir, name);
  writeFileSync(file, content, { mode });
  chmodSync(file, mode);
  return file;
}

function expectRefusal(fn: () => unknown, pattern: RegExp, secret?: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SigningKeyError);
  const message = (caught as Error).message;
  expect(message).toMatch(pattern);
  if (secret) expect(message).not.toContain(secret);
}

describe('keygen output', () => {
  it('is a P-256 private JWK, mode 0600, kid = RFC 7638 thumbprint (checked with jose)', async () => {
    const dir = tempDir(c);
    const jwk = generateSigningJwk();
    const file = writeNewKeyFile(join(dir, 'run', 'issuer-key.jwk'), jwk);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'run')).mode & 0o777).toBe(0o700);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as PrivateSigningJwk;
    expect(stored).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(typeof stored.d).toBe('string');
    const { kty, crv, x, y } = stored;
    expect(stored.kid).toBe(await calculateJwkThumbprint({ kty, crv, x, y }, 'sha256'));

    const loaded = loadSigningKeyFile(file);
    expect(loaded.kid).toBe(stored.kid);
    expect(loaded.publicJwk).toEqual({ kty, crv, x, y, kid: stored.kid, alg: 'ES256', use: 'sig' });
    expect(() => assertPublicOnly(loaded.publicJwk)).not.toThrow();
  });

  it('two keys never share a kid', () => {
    expect(generateSigningJwk().kid).not.toBe(generateSigningJwk().kid);
  });

  it('never overwrites an existing file or symlink', () => {
    const dir = tempDir(c);
    const file = writeNewKeyFile(join(dir, 'issuer-key.jwk'), generateSigningJwk());
    const before = readFileSync(file, 'utf8');
    expectRefusal(() => writeNewKeyFile(file, generateSigningJwk()), /already exists/);
    expect(readFileSync(file, 'utf8')).toBe(before);
    const link = join(dir, 'link.jwk');
    symlinkSync(join(dir, 'elsewhere.jwk'), link);
    expectRefusal(() => writeNewKeyFile(link, generateSigningJwk()), /already exists/);
  });

  it('refuses any path inside a git work tree', () => {
    const repo = tempDir(c);
    mkdirSync(join(repo, '.git'));
    expectRefusal(
      () => writeNewKeyFile(join(repo, 'deep', 'er', 'issuer-key.jwk'), generateSigningJwk()),
      /git work tree/,
    );
    // A worktree / submodule marks itself with a `.git` FILE.
    const worktree = tempDir(c);
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere\n');
    expectRefusal(
      () => writeNewKeyFile(join(worktree, 'issuer-key.jwk'), generateSigningJwk()),
      /git work tree/,
    );
  });

  it('refuses paths inside this repository, also through a symlinked directory', () => {
    const root = repositoryRoot();
    expect(root).toBeDefined();
    const target = join(root ?? '/', 'tools', 'test-idp', 'never-written.jwk');
    expectRefusal(() => writeNewKeyFile(target, generateSigningJwk()), /repository|git work tree/);
    const dir = tempDir(c);
    symlinkSync(join(root ?? '/', 'tools'), join(dir, 'tools-link'));
    expectRefusal(
      () => writeNewKeyFile(join(dir, 'tools-link', 'never-written.jwk'), generateSigningJwk()),
      /repository|git work tree/,
    );
    expect(() => statSync(target)).toThrow();
  });
});

describe('loading TEST_IDP_SIGNING_KEY_FILE', () => {
  const valid = () => generateSigningJwk();

  it.each([0o644, 0o640, 0o604, 0o660, 0o400, 0o700])('refuses mode 0%o', (mode) => {
    const dir = tempDir(c);
    const jwk = valid();
    const file = rawKeyFile(dir, JSON.stringify(jwk), mode);
    expectRefusal(() => loadSigningKeyFile(file), /mode 0600/, jwk.d);
  });

  it('refuses a symlink, even to a valid 0600 key file', () => {
    const dir = tempDir(c);
    const file = rawKeyFile(dir, JSON.stringify(valid()));
    const link = join(dir, 'link.jwk');
    symlinkSync(file, link);
    expect(() => loadSigningKeyFile(file)).not.toThrow();
    expectRefusal(() => loadSigningKeyFile(link), /symlink/);
  });

  it('refuses a directory and a missing file', () => {
    const dir = tempDir(c);
    mkdirSync(join(dir, 'key.jwk'), { mode: 0o600 });
    expectRefusal(() => loadSigningKeyFile(join(dir, 'key.jwk')), /regular file/);
    expectRefusal(() => loadSigningKeyFile(join(dir, 'missing.jwk')), /does not exist/);
  });

  it('refuses a key file inside a git work tree', () => {
    const repo = tempDir(c);
    mkdirSync(join(repo, '.git'));
    const file = rawKeyFile(repo, JSON.stringify(valid()));
    expectRefusal(() => loadSigningKeyFile(file), /git work tree/);
  });

  it('refuses a public key (no d)', () => {
    const dir = tempDir(c);
    const { d: _d, ...publicOnly } = valid();
    const file = rawKeyFile(dir, JSON.stringify(publicOnly));
    expectRefusal(() => loadSigningKeyFile(file), /private JWK is required/);
  });

  it('refuses text that is not JSON without echoing it', () => {
    const dir = tempDir(c);
    const jwk = valid();
    const file = rawKeyFile(dir, `${JSON.stringify(jwk).slice(0, -5)} trailing`);
    expectRefusal(() => loadSigningKeyFile(file), /not a JSON Web Key/, jwk.d);
  });

  it('refuses a file larger than 16 KiB', () => {
    const dir = tempDir(c);
    const file = rawKeyFile(dir, JSON.stringify({ ...valid(), pad: 'x'.repeat(17 * 1024) }));
    expectRefusal(() => loadSigningKeyFile(file), /larger than/);
  });

  it.each<[string, (jwk: PrivateSigningJwk) => unknown, RegExp]>([
    [
      'an RSA key',
      () =>
        generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' }),
      /EC P-256/,
    ],
    [
      'a P-384 key',
      () => generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ format: 'jwk' }),
      /EC P-256/,
    ],
    ['a symmetric key', () => ({ kty: 'oct', k: 'c2VjcmV0' }), /EC P-256/],
    ['a JWK Set instead of a JWK', (jwk) => ({ keys: [jwk] }), /EC P-256/],
    ['an array', (jwk) => [jwk], /one JWK object/],
    ['alg RS256', (jwk) => ({ ...jwk, alg: 'RS256' }), /alg other than ES256/],
    ['use enc', (jwk) => ({ ...jwk, use: 'enc' }), /use other than sig/],
    [
      'a kid that is not the thumbprint',
      (jwk) => ({ ...jwk, kid: 'chosen-by-hand' }),
      /thumbprint/,
    ],
    ['a malformed d', (jwk) => ({ ...jwk, d: `${jwk.d}A` }), /malformed/],
    [
      'x/y of another key with this d',
      (jwk) => {
        const other = generateSigningJwk();
        return { ...jwk, x: other.x, y: other.y, kid: undefined };
      },
      /do not belong/,
    ],
    [
      'x of another key with this d',
      (jwk) => ({ ...jwk, x: generateSigningJwk().x, kid: undefined }),
      /do not belong/,
    ],
    ['d = 0', (jwk) => ({ ...jwk, d: 'A'.repeat(43), kid: undefined }), /not a valid/],
    [
      'd >= the group order',
      (jwk) => ({ ...jwk, d: '_'.repeat(43), kid: undefined }),
      /not a valid/,
    ],
  ])('refuses %s', (_name, mutate, pattern) => {
    const jwk = valid();
    expectRefusal(() => signingKeyFromJwk(mutate(jwk)), pattern, jwk.d);
  });

  it('accepts a valid key without the optional kid/alg/use members', () => {
    const { kty, crv, x, y, d, kid } = valid();
    expect(signingKeyFromJwk({ kty, crv, x, y, d }).kid).toBe(kid);
  });
});

describe('assertPublicOnly', () => {
  it.each(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'])('refuses a JWK Set with %s', (member) => {
    const { d: _d, ...publicJwk } = generateSigningJwk();
    expect(() => assertPublicOnly({ keys: [{ ...publicJwk, [member]: 'AAAA' }] })).toThrow(
      /private members/,
    );
  });
});
