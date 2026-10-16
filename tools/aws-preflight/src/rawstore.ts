/**
 * Private raw output: one JSON file per probe call, in a fresh run directory (mode 0700, files
 * 0600, owned by the current user) that must not be inside a git work tree. Raw files are never
 * committed, never printed and never read back by the tool.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Nearest ancestor (inclusive) containing `.git` (directory or worktree file), if any. */
export function findGitWorkTree(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface RawStore {
  readonly dir: string;
  /** Writes `<seq>-<name>.json` (0600, exclusive create). Returns the file name. */
  write(name: string, data: unknown): string;
}

const uid = (): number | undefined =>
  typeof process.getuid === 'function' ? process.getuid() : undefined;

function assertPrivate(path: string, kind: 'dir' | 'file'): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`${path} is a symbolic link`);
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile())
    throw new Error(`${path} is not a ${kind}`);
  const want = kind === 'dir' ? 0o700 : 0o600;
  if ((st.mode & 0o777) !== want) {
    throw new Error(
      `${path} has mode ${(st.mode & 0o777).toString(8)}, expected ${want.toString(8)}`,
    );
  }
  const me = uid();
  if (me !== undefined && st.uid !== me)
    throw new Error(`${path} is not owned by the current user`);
}

/**
 * Creates `<base>/<runId>` privately. Throws (caller exits 2 before any AWS call) when the base is
 * inside a git work tree, is writable by group/others, or modes cannot be enforced.
 */
export function openRawStore(base: string, runId: string): RawStore {
  const baseDir = resolve(base);
  const repo = findGitWorkTree(baseDir);
  if (repo) throw new Error(`raw output dir ${baseDir} is inside the git work tree ${repo}`);
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  // A symlinked path can point into a work tree that the path string does not reveal.
  const realRepo = findGitWorkTree(realpathSync(baseDir));
  if (realRepo) {
    throw new Error(`raw output dir ${baseDir} resolves into the git work tree ${realRepo}`);
  }
  const baseStat = statSync(baseDir);
  if (!baseStat.isDirectory()) throw new Error(`${baseDir} is not a directory`);
  if ((baseStat.mode & 0o022) !== 0) {
    throw new Error(`${baseDir} is writable by group or others; choose a private --raw-dir`);
  }
  if (!/^[A-Za-z0-9T-]{8,64}$/.test(runId)) throw new Error('invalid run id');
  const dir = join(baseDir, runId);
  mkdirSync(dir, { mode: 0o700 }); // fails if it already exists
  chmodSync(dir, 0o700);
  assertPrivate(dir, 'dir');

  let seq = 0;
  const write = (name: string, data: unknown): string => {
    seq += 1;
    const safe = name.replace(/[^A-Za-z0-9._@#[\]-]/g, '_').slice(0, 120);
    const file = `${String(seq).padStart(3, '0')}-${safe}.json`;
    const path = join(dir, file);
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
    assertPrivate(path, 'file');
    return file;
  };
  return { dir, write };
}
