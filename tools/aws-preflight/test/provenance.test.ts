/** Provenance of the code that ran (source digest, git dirty flag), without a process. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gitDirty, parseGitIndex, runtimeFiles, toolSourceSha256 } from '../src/provenance.ts';

const blobSha1 = (content: string) => {
  const data = Buffer.from(content);
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data]))
    .digest('hex');
};

/** A minimal git index (version 2): entries are [path, content, stage]. */
function gitIndex(entries: readonly (readonly [string, string, number?])[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('DIRC', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const parts = [header];
  for (const [path, content, stage = 0] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    const name = Buffer.from(path);
    const length = (62 + name.length + 8) & ~7;
    const e = Buffer.alloc(length);
    e.writeUInt32BE(0o100644, 24);
    e.writeUInt32BE(Buffer.byteLength(content), 36);
    Buffer.from(blobSha1(content), 'hex').copy(e, 40);
    e.writeUInt16BE((stage << 12) | Math.min(name.length, 0xfff), 60);
    name.copy(e, 62);
    parts.push(e);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function repo(
  files: Record<string, string>,
  index: Record<string, string>,
  stages: Record<string, number> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'aws-preflight-git-'));
  mkdirSync(join(root, '.git'));
  const tool = join(root, 'tools', 'aws-preflight');
  mkdirSync(join(tool, 'src'), { recursive: true });
  for (const [path, content] of Object.entries(files)) writeFileSync(join(tool, path), content);
  writeFileSync(
    join(root, '.git', 'index'),
    gitIndex(
      Object.entries(index).map(([p, c]) => [`tools/aws-preflight/${p}`, c, stages[p] ?? 0]),
    ),
  );
  return { root, tool };
}

const FILES = {
  'package.json': '{"name":"x"}\n',
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': 'export {};\n',
};

describe('tool source digest', () => {
  it('covers package.json and src/*.ts, deterministically', () => {
    const { tool } = repo(FILES, FILES);
    writeFileSync(join(tool, 'src', 'notes.md'), 'ignored');
    expect(runtimeFiles(tool)).toEqual(['package.json', 'src/a.ts', 'src/b.ts']);
    const first = toolSourceSha256(tool);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(toolSourceSha256(tool)).toBe(first);
    writeFileSync(join(tool, 'src', 'a.ts'), 'export const a = 2;\n');
    expect(toolSourceSha256(tool)).not.toBe(first);
  });
});

describe('git dirty flag (index compared without starting git)', () => {
  it('clean when every runtime file matches its index entry', () => {
    const { tool } = repo(FILES, FILES);
    expect(gitDirty(tool)).toEqual({ dirty: false });
  });

  it.each([
    [
      'a modified file',
      (t: string) => writeFileSync(join(t, 'src', 'a.ts'), 'changed'),
      'src/a.ts differs from the git index',
    ],
    [
      'an untracked file',
      (t: string) => writeFileSync(join(t, 'src', 'c.ts'), 'new'),
      'src/c.ts is untracked',
    ],
    ['a deleted file', (t: string) => rmSync(join(t, 'src', 'b.ts')), 'src/b.ts is deleted'],
  ])('dirty with %s', (_, change, reason) => {
    const { tool } = repo(FILES, FILES);
    change(tool);
    expect(gitDirty(tool)).toEqual({ dirty: true, reason });
  });

  it('dirty with a conflict entry', () => {
    const { tool } = repo(FILES, FILES, { 'src/a.ts': 2 });
    expect(gitDirty(tool)).toEqual({
      dirty: true,
      reason: 'src/a.ts is in conflict or intent-to-add',
    });
  });

  it('follows a worktree .git file', () => {
    const { root, tool } = repo(FILES, FILES);
    const wt = mkdtempSync(join(tmpdir(), 'aws-preflight-wt-'));
    const wtTool = join(wt, 'tools', 'aws-preflight');
    mkdirSync(join(wtTool, 'src'), { recursive: true });
    for (const [p, c] of Object.entries(FILES)) writeFileSync(join(wtTool, p), c);
    writeFileSync(join(wt, '.git'), `gitdir: ${join(root, '.git')}\n`);
    expect(gitDirty(wtTool)).toEqual({ dirty: false });
    expect(gitDirty(tool)).toEqual({ dirty: false });
  });

  it("unknown when there is no checkout or the index can't be read", () => {
    const plain = mkdtempSync(join(tmpdir(), 'aws-preflight-nogit-'));
    mkdirSync(join(plain, 'src'));
    writeFileSync(join(plain, 'package.json'), '{}');
    // Only meaningful when the temp directory is not itself inside a git checkout.
    const r = gitDirty(plain);
    if (r.reason === 'not a git checkout') expect(r.dirty).toBe('unknown');
    const { root, tool } = repo(FILES, FILES);
    writeFileSync(join(root, '.git', 'index'), 'garbage');
    expect(gitDirty(tool)).toEqual({ dirty: 'unknown', reason: 'unsupported git index' });
    expect(parseGitIndex(Buffer.from('DIRC'))).toBeUndefined();
  });

  it('reads the real index of this checkout', () => {
    const toolDir = fileURLToPath(new URL('..', import.meta.url));
    const r = gitDirty(toolDir);
    expect(r.dirty === true || r.dirty === false, JSON.stringify(r)).toBe(true);
  });
});
