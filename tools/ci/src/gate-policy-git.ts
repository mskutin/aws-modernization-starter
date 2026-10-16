/**
 * Git access of the gate-policy tooling (ADR 0410): read DEFAULT_GATE_PATHS as committed at a
 * revision and compute the gate state of a revision, both from a given git directory (a bare object
 * cache), never from the running checkout. Every git call runs without inherited GIT_* variables,
 * so a hook or a caller cannot redirect it to another repository.
 */
import { spawnSync } from 'node:child_process';
import {
  GATE_POLICY_SOURCE,
  gatePathsFromSource,
  type GateState,
  stateFromLsTree,
} from './gate-policy.ts';

/** The process environment without the variables that point git at another repository. */
export function cleanGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
}

/** DEFAULT_GATE_PATHS as committed at `rev` in `gitDir` (not the running checkout's). */
export function gatePathsAt(gitDir: string, rev: string): string[] {
  const r = spawnSync('git', ['--git-dir', gitDir, 'show', `${rev}:${GATE_POLICY_SOURCE}`], {
    encoding: 'utf8',
    env: cleanGitEnv(),
  });
  if (r.status !== 0) throw new Error(`git show ${rev}:${GATE_POLICY_SOURCE}: ${r.stderr}`);
  return gatePathsFromSource(r.stdout);
}

/** The gate state of `rev` over `paths` (one `git ls-tree` entry per path, or `absent`). */
export function stateAt(gitDir: string, rev: string, paths: readonly string[]): GateState {
  return stateFromLsTree(paths, (path) => {
    const r = spawnSync('git', ['--git-dir', gitDir, 'ls-tree', '--full-tree', rev, '--', path], {
      encoding: 'utf8',
      env: cleanGitEnv(),
    });
    if (r.status !== 0) throw new Error(`git ls-tree ${rev} -- ${path}: ${r.stderr}`);
    return r.stdout;
  });
}
