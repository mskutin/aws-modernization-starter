import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root: the nearest ancestor with pnpm-workspace.yaml. */
export function repoRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no pnpm-workspace.yaml above ${start}`);
    dir = parent;
  }
}
