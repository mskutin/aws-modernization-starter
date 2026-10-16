/**
 * `file_mode` (scripts/_file-mode.sh): the permission check behind "the operator-role-arn file
 * must be 0600" and "the issuer key must be 0600" in the lifecycle scripts.
 *
 * Regression (seen on Linux CI): the scripts called BSD `stat -f '%Lp' f || stat -c '%a' f`. On GNU
 * coreutils `-f` means --file-system, so the first call printed the file system's details before
 * failing and every mode check refused on Linux CI while passing on macOS. These tests pin the
 * helper against GNU-like and BSD-like `stat` shims, so either userland is covered on any host,
 * plus the host's real `stat`, and statically forbid the raw idioms anywhere else.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SUITE = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const HELPER = join(SUITE, 'scripts', '_file-mode.sh');

const work = mkdtempSync(join(tmpdir(), 'starter-file-mode-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let seq = 0;
function fileWithMode(mode: number): string {
  const f = join(work, `f${String(seq++)}`);
  writeFileSync(f, 'arn:aws:iam::111122223333:role/x\n');
  chmodSync(f, mode);
  return f;
}

/** A directory holding a fake `stat` that answers like the given userland. */
function shim(kind: 'gnu' | 'bsd' | 'garbage'): string {
  const dir = mkdtempSync(join(work, `${kind}-`));
  const body = {
    // GNU coreutils: `-c FMT` works; `-f` is --file-system — prints file-system details to
    // stdout, then fails on the BSD format string taken as a file operand.
    gnu: `case "$1" in
  -c) printf '%s\\n' "$FAKE_MODE" ;;
  -f) printf '  File: "%s"\\n    ID: 1234 Namelen: 255 Type: ext2/ext3\\n' "\${@: -1}"
      echo "stat: cannot read file system information for '%Lp': No such file or directory" >&2
      exit 1 ;;
esac`,
    // BSD/macOS: no -c (usage error on stderr, nothing on stdout); `-f '%Lp'` works.
    bsd: `case "$1" in
  -c) echo "stat: illegal option -- c" >&2; exit 1 ;;
  -f) printf '%s\\n' "$FAKE_MODE" ;;
esac`,
    // Anything else that "succeeds" with non-octal output must not be taken as a mode.
    garbage: `echo "Size: 12 Blocks: 8"`,
  }[kind];
  writeFileSync(join(dir, 'stat'), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, 'stat'), 0o755);
  return dir;
}

function run(script: string, file: string, opts: { pathPrefix?: string; fakeMode?: string } = {}) {
  const PATH = opts.pathPrefix ? `${opts.pathPrefix}:${process.env.PATH ?? ''}` : process.env.PATH;
  const r = spawnSync('bash', ['-c', script, 'file-mode-test', HELPER, file], {
    encoding: 'utf8',
    env: { PATH, FAKE_MODE: opts.fakeMode ?? '' },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const FILE_MODE = 'set -euo pipefail; source "$1"; file_mode "$2"';
/** The idiom the scripts used before the fix (kept here only to prove the shim reproduces it). */
const OLD_IDIOM = `stat -f '%Lp' "$2" 2>/dev/null || stat -c '%a' "$2"`;

describe('file_mode (scripts/_file-mode.sh)', () => {
  it.each([0o600, 0o400, 0o644, 0o640, 0o604, 0o700])(
    'reports mode %o with the host stat',
    (mode) => {
      const r = run(FILE_MODE, fileWithMode(mode));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(`${mode.toString(8)}\n`);
    },
  );

  it('fails without output for a missing file (callers refuse)', () => {
    const r = run(FILE_MODE, join(work, 'missing'));
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });

  it('the GNU shim reproduces the Linux CI failure of the old BSD-first idiom', () => {
    const r = run(OLD_IDIOM, fileWithMode(0o600), { pathPrefix: shim('gnu'), fakeMode: '600' });
    expect(r.stdout).toMatch(/File: /);
    expect(r.stdout.trim()).not.toBe('600');
  });

  it.each([
    ['gnu', '600'],
    ['gnu', '644'],
    ['bsd', '600'],
    ['bsd', '644'],
  ] as const)('on a %s userland reports exactly %s', (kind, mode) => {
    const r = run(FILE_MODE, fileWithMode(0o600), { pathPrefix: shim(kind), fakeMode: mode });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${mode}\n`);
  });

  it('refuses non-octal stat output instead of passing it to the mode comparison', () => {
    const r = run(FILE_MODE, fileWithMode(0o600), { pathPrefix: shim('garbage') });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });
});

describe('no raw GNU- or BSD-only stat idioms in the lifecycle and preflight scripts', () => {
  const roots = ['tests/aws-integration', 'tools/aws-preflight/scripts'];
  const shellFiles = roots.flatMap((root) =>
    readdirSync(join(REPO, root), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.sh') && !f.split(/[\\/]/).includes('node_modules'))
      .map((f) => join(REPO, root, f)),
  );

  it('finds the scripts it audits', () => {
    expect(shellFiles.map((f) => relative(REPO, f))).toEqual(
      expect.arrayContaining([
        'tests/aws-integration/scripts/_common.sh',
        'tests/aws-integration/sandbox/_lib.sh',
        'tests/aws-integration/sandbox/up.sh',
        'tools/aws-preflight/scripts/sandbox-guard.sh',
      ]),
    );
  });

  it('only scripts/_file-mode.sh calls `stat -f` / `stat -c` (use file_mode)', () => {
    const offenders = shellFiles
      .filter((f) => f !== HELPER)
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((line, i) => ({ line, at: `${relative(REPO, f)}:${String(i + 1)}` }))
          .filter(({ line }) => !/^\s*#/.test(line) && /\bstat\s+-[a-zA-Z]*[fc]\b/.test(line))
          .map(({ at }) => at),
      );
    expect(offenders).toEqual([]);
  });
});
