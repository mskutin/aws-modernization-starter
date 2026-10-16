/**
 * Resolves the commit of the tool's checkout by reading git files directly (no `git` process:
 * only executor.ts may start processes). Handles worktrees (`.git` file + commondir) and packed
 * refs. Returns undefined when anything is unusual.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const SHA_RE = /^[0-9a-f]{40}$/;

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}

export function gitHeadCommit(start: string): string | undefined {
  let dir = resolve(start);
  let dotGit: string | undefined;
  for (;;) {
    const candidate = join(dir, '.git');
    if (existsSync(candidate)) {
      dotGit = candidate;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  let gitDir = dotGit;
  if (statSync(dotGit).isFile()) {
    const pointer = /^gitdir:\s*(.+)$/m.exec(read(dotGit) ?? '')?.[1]?.trim();
    if (!pointer) return undefined;
    gitDir = isAbsolute(pointer) ? pointer : resolve(dirname(dotGit), pointer);
  }
  const commonPointer = read(join(gitDir, 'commondir'));
  const commonDir = commonPointer
    ? isAbsolute(commonPointer)
      ? commonPointer
      : resolve(gitDir, commonPointer)
    : gitDir;
  const head = read(join(gitDir, 'HEAD'));
  if (!head) return undefined;
  if (SHA_RE.test(head)) return head;
  const ref = /^ref:\s*(refs\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
  if (!ref || ref.includes('..')) return undefined;
  for (const base of [gitDir, commonDir]) {
    const sha = read(join(base, ref));
    if (sha && SHA_RE.test(sha)) return sha;
  }
  const packed = read(join(commonDir, 'packed-refs')) ?? '';
  for (const line of packed.split('\n')) {
    const [sha, name] = line.trim().split(' ');
    if (name === ref && sha && SHA_RE.test(sha)) return sha;
  }
  return undefined;
}
