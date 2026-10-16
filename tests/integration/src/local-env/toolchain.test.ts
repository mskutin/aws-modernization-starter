/**
 * Toolchain guard rails of a fresh checkout:
 *   - `pnpm install` refuses a Node.js major other than .node-version (root "engines" +
 *     engineStrict in pnpm-workspace.yaml; pnpm 12 no longer reads engine-strict from .npmrc);
 *   - the git hooks installed by `pnpm install` (scripts/git-hooks/install.sh) hold no absolute
 *     paths, so worktrees sharing one hooks directory each run their own lefthook, and they stay
 *     optional without weakening a check (a failing lefthook still blocks the commit).
 * Git runs in temp repositories with stub lefthook binaries; nothing touches this checkout's hooks.
 */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  existsSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GIT, REPO_ROOT, createSandbox, run, type Sandbox } from './support.js';

const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), 'utf8');

describe('Node.js version', () => {
  const nodeVersion = read('.node-version').trim();
  const major = Number(nodeVersion.split('.')[0]);
  const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };

  it('root engines accept exactly the .node-version major (no newer major slips through)', () => {
    const m = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/.exec(pkg.engines?.node ?? '');
    expect(m, `engines.node = ${pkg.engines?.node}`).not.toBeNull();
    const [, lo, loMinor, loPatch, hi] = (m ?? []).map(Number);
    expect(lo).toBe(major);
    expect(hi).toBe(major + 1);
    const [, minor = 0, patch = 0] = nodeVersion.split('.').map(Number);
    // .node-version itself satisfies the lower bound.
    expect(minor > (loMinor ?? 0) || (minor === loMinor && patch >= (loPatch ?? 0))).toBe(true);
  });

  it('pnpm enforces engines (engineStrict in pnpm-workspace.yaml)', () => {
    expect(read('pnpm-workspace.yaml')).toMatch(/^engineStrict: true$/m);
  });
});

const NO_GIT = GIT ? false : 'git is not installed on this machine';
const HOOKS = ['pre-commit', 'pre-push'];

describe.skipIf(NO_GIT)('git hooks installed by pnpm install', () => {
  const INSTALL = path.join(REPO_ROOT, 'scripts/git-hooks/install.sh');
  let sb: Sandbox;
  let repo: string;

  const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
    run(sb, 'git', args, { ...gitEnv, ...env }, { cwd });
  const install = (cwd: string, args: string[] = [], env: Record<string, string> = {}) =>
    run(sb, 'sh', [INSTALL, ...args], { ...gitEnv, ...env }, { cwd });
  let gitEnv: Record<string, string>;

  /** A stub node_modules/.bin/lefthook in `checkout` that logs "<label> <args>" and exits `code`. */
  const fakeLefthook = (checkout: string, label: string, code = 0) => {
    const bin = path.join(checkout, 'node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, 'lefthook'),
      `#!/bin/sh\necho "${label} $*" >> "$CALLS"\nexit ${code}\n`,
    );
    chmodSync(path.join(bin, 'lefthook'), 0o755);
  };

  beforeEach(() => {
    sb = createSandbox('starter-hooks-');
    gitEnv = {
      GIT_CONFIG_GLOBAL: path.join(sb.dir, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    writeFileSync(gitEnv.GIT_CONFIG_GLOBAL ?? '', '[init]\n\tdefaultBranch = main\n');
    repo = path.join(sb.dir, 'repo');
    mkdirSync(repo);
    expect(git(repo, ['init', '-q']).status).toBe(0);
    cpSync(path.join(REPO_ROOT, 'lefthook.yml'), path.join(repo, 'lefthook.yml'));
    expect(git(repo, ['add', 'lefthook.yml']).status).toBe(0);
    expect(git(repo, ['commit', '-q', '-m', 'init']).status).toBe(0);
  });
  afterEach(() => sb.cleanup());

  const hookFile = (name: string) => path.join(repo, '.git/hooks', name);

  it('installs every lefthook.yml hook as an executable wrapper without absolute paths', () => {
    const r = install(repo);
    expect(r.status, r.stderr).toBe(0);
    for (const name of HOOKS) {
      const text = readFileSync(hookFile(name), 'utf8');
      expect(statSync(hookFile(name)).mode & 0o111).not.toBe(0);
      expect(text).toContain('installed by scripts/git-hooks/install.sh');
      expect(text).toContain(`run ${name} "$@"`);
      for (const abs of [sb.dir, REPO_ROOT, '/Users/', '/home/', 'node_modules/.pnpm']) {
        expect(text, `${name} must not contain ${abs}`).not.toContain(abs);
      }
      expect(run(sb, 'sh', ['-n', hookFile(name)], {}).status).toBe(0);
    }
  });

  it('lefthook may not re-install its own hooks (they embed absolute paths)', () => {
    expect(read('lefthook.yml')).toMatch(/^no_auto_install: true$/m);
  });

  it("each worktree sharing the hooks directory runs its OWN checkout's lefthook", () => {
    expect(install(repo).status).toBe(0);
    const other = path.join(sb.dir, 'other');
    expect(git(repo, ['worktree', 'add', '-q', '-b', 'other', other]).status).toBe(0);
    fakeLefthook(repo, 'main-checkout');
    fakeLefthook(other, 'other-checkout');

    const c = git(other, ['commit', '-q', '--allow-empty', '-m', 'from the other worktree']);
    expect(c.status, c.stderr).toBe(0);
    expect(sb.readCalls().trim()).toBe('other-checkout run pre-commit');
  });

  it('a failing check still blocks the commit (hooks are optional, never weakened)', () => {
    expect(install(repo).status).toBe(0);
    fakeLefthook(repo, 'lefthook', 3);
    const c = git(repo, ['commit', '-q', '--allow-empty', '-m', 'blocked']);
    expect(c.status).not.toBe(0);
    expect(sb.readCalls()).toContain('lefthook run pre-commit');
  });

  it('LEFTHOOK=0 skips installing and skips a run', () => {
    const skipped = install(repo, [], { LEFTHOOK: '0' });
    expect(skipped.status).toBe(0);
    expect(existsSync(hookFile('pre-commit'))).toBe(false);

    expect(install(repo).status).toBe(0);
    fakeLefthook(repo, 'lefthook', 3);
    const c = git(repo, ['commit', '-q', '--allow-empty', '-m', 'skip once'], { LEFTHOOK: '0' });
    expect(c.status, c.stderr).toBe(0);
    expect(sb.readCalls()).toBe('');
  });

  it('without node_modules the hook says so and lets the commit through (as lefthook itself does)', () => {
    expect(install(repo).status).toBe(0);
    const c = git(repo, ['commit', '-q', '--allow-empty', '-m', 'no install yet']);
    expect(c.status, c.stderr).toBe(0);
    expect(c.stderr).toContain('pre-commit: lefthook not found (run pnpm install in');
  });

  it('replaces a hook from `lefthook install`, leaves foreign hooks alone, uninstalls only its own', () => {
    writeFileSync(
      hookFile('pre-commit'),
      '#!/bin/sh\ncall_lefthook()\n{\n  /abs/checkout/node_modules/.pnpm/lefthook/bin/lefthook "$@"\n}\n',
    );
    writeFileSync(hookFile('pre-push'), '#!/bin/sh\n# somebody else\nexit 0\n');
    const r = install(repo);
    expect(r.status).toBe(0);
    expect(readFileSync(hookFile('pre-commit'), 'utf8')).not.toContain('/abs/checkout');
    expect(readFileSync(hookFile('pre-push'), 'utf8')).toContain('somebody else');
    expect(r.stderr).toContain('pre-push: an existing hook was not written by this script');

    expect(install(repo, ['--uninstall']).status).toBe(0);
    expect(existsSync(hookFile('pre-commit'))).toBe(false);
    expect(existsSync(hookFile('pre-push'))).toBe(true);
  });

  it('does not write into a core.hooksPath directory (may be shared with other repositories)', () => {
    const shared = path.join(sb.dir, 'shared-hooks');
    mkdirSync(shared);
    expect(git(repo, ['config', 'core.hooksPath', shared]).status).toBe(0);
    const r = install(repo);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('core.hooksPath is set');
    expect(existsSync(path.join(shared, 'pre-commit'))).toBe(false);
  });

  it('outside a git checkout (e.g. a source archive) it does nothing and succeeds', () => {
    const plain = path.join(sb.dir, 'plain');
    mkdirSync(plain);
    const r = install(plain, [], { GIT_CEILING_DIRECTORIES: sb.dir });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('not a git checkout');
  });
});
