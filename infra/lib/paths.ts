import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walks up from `start` until the pnpm workspace root is found. */
export function findRepoRoot(start: string = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate the repository root (pnpm-workspace.yaml) above ${start}`);
    }
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot();
export const INFRA_ROOT = path.join(REPO_ROOT, 'infra');
/** Lock file NodejsFunction uses to determine the bundling project root. */
export const DEPS_LOCK_FILE = path.join(REPO_ROOT, 'pnpm-lock.yaml');
