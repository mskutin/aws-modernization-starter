import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitRunner, isolatedGitEnv, REPO_REDIRECTING_GIT_ENV } from '../src/git.ts';
import { commitChange, git, initGit, makeRepo } from './fixture.ts';

/**
 * The related-unit-tests pre-commit hook runs these suites with git's hook environment (GIT_DIR,
 * GIT_INDEX_FILE, ...). Without isolation the fixture's `git init/add/commit` would write into the
 * repository being committed (fixture commits on a real branch, core.bare=true in the shared
 * config). Here an "outer" repository plays the role of that repository; the fixture must never
 * touch it.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const plainGit = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...isolatedGitEnv(),
      GIT_AUTHOR_NAME: 'outer',
      GIT_AUTHOR_EMAIL: 'outer@example.invalid',
      GIT_COMMITTER_NAME: 'outer',
      GIT_COMMITTER_EMAIL: 'outer@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: cwd,
    },
  }).trim();

function outerRepository(): string {
  const outer = mkdtempSync(join(tmpdir(), 'impact-outer-'));
  dirs.push(outer);
  plainGit(outer, 'init', '-q', '-b', 'main');
  writeFileSync(join(outer, 'real.txt'), 'real work\n');
  plainGit(outer, 'add', '-A');
  plainGit(outer, 'commit', '-q', '-m', 'real commit', '--no-verify');
  return outer;
}

describe('git fixtures are isolated from the repository a hook runs in', () => {
  it('ignores GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE pointing at another repository', () => {
    const outer = outerRepository();
    const outerHead = plainGit(outer, 'rev-parse', 'HEAD');
    const outerConfig = readFileSync(join(outer, '.git/config'), 'utf8');
    const outerIndex = readFileSync(join(outer, '.git/index'));
    const saved = { ...process.env };
    // What git exports to a hook of the outer repository.
    process.env.GIT_DIR = join(outer, '.git');
    process.env.GIT_INDEX_FILE = join(outer, '.git/index');
    process.env.GIT_WORK_TREE = outer;
    process.env.GIT_PREFIX = '';
    try {
      const root = makeRepo();
      dirs.push(root);
      const base = initGit(root);
      const head = commitChange(root, { 'README.md': '# changed\n' });
      expect(git(root, 'rev-list', '--count', 'HEAD')).toBe('2');
      expect(gitRunner(root)(['rev-parse', 'HEAD']).stdout.trim()).toBe(head);
      expect(base).not.toBe(outerHead);
    } finally {
      process.env = saved;
    }
    expect(plainGit(outer, 'rev-parse', 'HEAD')).toBe(outerHead);
    expect(plainGit(outer, 'log', '--format=%an', '-1')).toBe('outer');
    expect(readFileSync(join(outer, '.git/config'), 'utf8')).toBe(outerConfig);
    expect(plainGit(outer, 'config', '--get', 'core.bare')).toBe('false');
    expect(readFileSync(join(outer, '.git/index')).equals(outerIndex)).toBe(true);
  });

  it('isolatedGitEnv drops exactly the repository-redirecting variables', () => {
    const env = Object.fromEntries([
      ...REPO_REDIRECTING_GIT_ENV.map((k) => [k, 'x'] as const),
      ['GIT_AUTHOR_NAME', 'kept'],
      ['PATH', '/bin'],
    ]);
    expect(isolatedGitEnv(env)).toEqual({ GIT_AUTHOR_NAME: 'kept', PATH: '/bin' });
  });
});
