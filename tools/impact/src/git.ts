import { spawnSync } from 'node:child_process';
import type { ChangeSet } from './analyze.ts';

const ZERO_SHA = /^0+$/;

export interface BaseResolution {
  base: string | null;
  source: string;
}

/**
 * Pick the diff base:
 *  1. explicit --base
 *  2. CI_MERGE_REQUEST_DIFF_BASE_SHA (merge request pipelines: merge-base with target)
 *  3. CI_COMMIT_BEFORE_SHA (branch push pipelines), unless it is the all-zero SHA
 * Anything else -> null (caller fails safe and runs everything).
 */
export function resolveBase(explicit: string | undefined, env: NodeJS.ProcessEnv): BaseResolution {
  if (explicit) return { base: explicit, source: '--base' };
  const mr = env.CI_MERGE_REQUEST_DIFF_BASE_SHA;
  if (mr && !ZERO_SHA.test(mr)) return { base: mr, source: 'CI_MERGE_REQUEST_DIFF_BASE_SHA' };
  const before = env.CI_COMMIT_BEFORE_SHA;
  if (before && !ZERO_SHA.test(before)) return { base: before, source: 'CI_COMMIT_BEFORE_SHA' };
  if (before && ZERO_SHA.test(before)) {
    return {
      base: null,
      source: 'CI_COMMIT_BEFORE_SHA is the zero SHA (new branch or first push)',
    };
  }
  return { base: null, source: 'no base SHA available (not a merge request or push pipeline)' };
}

export type GitRunner = (args: string[]) => { status: number; stdout: string; stderr: string };

/**
 * Environment variables that make git operate on a repository other than the one found from the
 * working directory. Git exports several of them to hooks (GIT_DIR, GIT_INDEX_FILE, ...); a git
 * command started from a hook-run test with the inherited environment therefore writes into the
 * repository being committed, not into its fixture (it once committed fixtures onto a branch and
 * set core.bare=true in the shared config). Every git call here starts without them.
 */
export const REPO_REDIRECTING_GIT_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_QUARANTINE_PATH',
] as const;

/** A copy of `env` without the variables that redirect git to another repository. */
export function isolatedGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of REPO_REDIRECTING_GIT_ENV) delete out[key];
  return out;
}

export function gitRunner(cwd: string): GitRunner {
  return (args) => {
    const r = spawnSync('git', args, {
      cwd,
      env: isolatedGitEnv(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      status: r.status ?? (r.error ? 127 : 1),
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? (r.error ? String(r.error) : ''),
    };
  };
}

function commitExists(git: GitRunner, sha: string): boolean {
  return git(['cat-file', '-e', `${sha}^{commit}`]).status === 0;
}

/**
 * Compute changed files between base and head. Never throws: every failure
 * becomes `{ kind: 'unknown' }` so the analyser runs everything.
 */
export function changedFiles(
  git: GitRunner,
  resolution: BaseResolution,
  head: string,
  options: { fetchMissing?: boolean; remote?: string } = {},
): ChangeSet {
  if (!resolution.base) return { kind: 'unknown', reason: resolution.source };
  const base = resolution.base;
  if (!commitExists(git, base)) {
    if (options.fetchMissing) {
      const remote = options.remote ?? 'origin';
      const fetched = git(['fetch', '--no-tags', '--quiet', '--depth=1', remote, base]);
      if (fetched.status !== 0 || !commitExists(git, base)) {
        return {
          kind: 'unknown',
          reason: `base ${base} (${resolution.source}) is not available locally and could not be fetched: ${fetched.stderr.trim() || 'unknown error'}`,
        };
      }
    } else {
      return {
        kind: 'unknown',
        reason: `base ${base} (${resolution.source}) is not available in this clone`,
      };
    }
  }
  if (!commitExists(git, head)) return { kind: 'unknown', reason: `head ${head} is not a commit` };
  const diff = git(['diff', '--name-only', '--no-renames', '-z', base, head]);
  if (diff.status !== 0) {
    return { kind: 'unknown', reason: `git diff ${base} ${head} failed: ${diff.stderr.trim()}` };
  }
  const files = diff.stdout.split('\0').filter((f) => f.length > 0);
  return { kind: 'diff', base, head, files };
}
