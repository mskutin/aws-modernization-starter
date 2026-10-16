/**
 * Provenance of the code that ran, computed without starting a process (only
 * executor.ts may): a SHA-256 over the tool's runtime sources (package.json and src/*.ts) and a
 * "dirty" flag read from the git index.
 *
 * dirty = true when a runtime source differs from its git index entry, is untracked, is missing,
 * or is in conflict. Changes that are staged but not committed are NOT detected (that needs the
 * HEAD tree, usually in pack files): the run procedure (clean checkout, `git status --porcelain`
 * empty) covers that, and sourceSha256 lets a reviewer compare with the reviewed commit.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Runtime sources relative to the tool directory, sorted. */
export function runtimeFiles(toolDir: string): string[] {
  const src = readdirSync(join(toolDir, 'src'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `src/${f}`);
  return ['package.json', ...src].sort();
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** SHA-256 over `<path>\0<sha256(content)>\n` of every runtime source. */
export function toolSourceSha256(toolDir: string): string {
  const lines = runtimeFiles(toolDir).map(
    (f) => `${f}\0${sha256(readFileSync(join(toolDir, f)))}\n`,
  );
  return sha256(lines.join(''));
}

const gitBlobSha1 = (content: Buffer) =>
  createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]))
    .digest('hex');

/** Index entries: path (repository-relative, '/') -> blob SHA-1, or 'CONFLICT'. */
export function parseGitIndex(buf: Buffer): Map<string, string> | undefined {
  if (buf.length < 32 || buf.toString('latin1', 0, 4) !== 'DIRC') return undefined;
  const version = buf.readUInt32BE(4);
  if (version < 2 || version > 4) return undefined;
  const count = buf.readUInt32BE(8);
  const entries = new Map<string, string>();
  let off = 12;
  let prev: Buffer = Buffer.alloc(0);
  for (let i = 0; i < count; i++) {
    const start = off;
    if (off + 62 > buf.length - 20) return undefined;
    const mode = buf.readUInt32BE(off + 24);
    const sha = buf.toString('hex', off + 40, off + 60);
    const flags = buf.readUInt16BE(off + 60);
    off += 62;
    let extended = 0;
    if (flags & 0x4000) {
      if (version < 3) return undefined;
      extended = buf.readUInt16BE(off);
      off += 2;
    }
    let path: Buffer;
    if (version === 4) {
      let b = buf[off++] ?? 0;
      let strip = b & 127;
      while (b & 128) {
        b = buf[off++] ?? 0;
        strip = ((strip + 1) << 7) | (b & 127);
      }
      const end = buf.indexOf(0, off);
      if (end < 0 || strip > prev.length) return undefined;
      path = Buffer.concat([prev.subarray(0, prev.length - strip), buf.subarray(off, end)]);
      off = end + 1;
    } else {
      const end = buf.indexOf(0, off);
      if (end < 0) return undefined;
      path = buf.subarray(off, end);
      off = start + ((off - start + path.length + 8) & ~7);
    }
    // Sparse-index directory entries cannot be compared file by file.
    if ((mode & 0o170000) === 0o040000) return undefined;
    const stage = (flags >> 12) & 3;
    const intentToAdd = (extended & 0x2000) !== 0;
    entries.set(path.toString('utf8'), stage !== 0 || intentToAdd ? 'CONFLICT' : sha);
    prev = path;
  }
  // Extensions: a split index ("link") keeps entries elsewhere: not supported.
  while (off + 8 <= buf.length - 20) {
    const signature = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32BE(off + 4);
    if (signature === 'link') return undefined;
    off += 8 + size;
  }
  return entries;
}

function locateGit(startDir: string): { workTree: string; gitDir: string } | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const dotGit = join(dir, '.git');
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return { workTree: dir, gitDir: dotGit };
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
      if (!pointer) return undefined;
      return { workTree: dir, gitDir: isAbsolute(pointer) ? pointer : resolve(dir, pointer) };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface DirtyResult {
  readonly dirty: boolean | 'unknown';
  readonly reason?: string;
}

export function gitDirty(toolDir: string): DirtyResult {
  try {
    const git = locateGit(toolDir);
    if (!git) return { dirty: 'unknown', reason: 'not a git checkout' };
    const index = parseGitIndex(readFileSync(join(git.gitDir, 'index')));
    if (!index) return { dirty: 'unknown', reason: 'unsupported git index' };
    const prefix = relative(git.workTree, toolDir).split(sep).join('/');
    const files = runtimeFiles(toolDir);
    for (const f of files) {
      const entry = index.get(`${prefix}/${f}`);
      if (entry === undefined) return { dirty: true, reason: `${f} is untracked` };
      if (entry === 'CONFLICT')
        return { dirty: true, reason: `${f} is in conflict or intent-to-add` };
      if (entry !== gitBlobSha1(readFileSync(join(toolDir, f)))) {
        return { dirty: true, reason: `${f} differs from the git index` };
      }
    }
    for (const path of index.keys()) {
      const rel = path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : undefined;
      if (rel && /^src\/[^/]+\.ts$/.test(rel) && !files.includes(rel)) {
        return { dirty: true, reason: `${rel} is deleted` };
      }
    }
    return { dirty: false };
  } catch {
    return { dirty: 'unknown', reason: 'git index unreadable' };
  }
}
