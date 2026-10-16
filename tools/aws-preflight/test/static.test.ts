import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(PKG, 'src');
const TEST = join(PKG, 'test');
const read = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));

const PROCESS_APIS =
  /\b(?:node:)?child_process\b|\bnode:worker_threads\b|\bnode:cluster\b|\bspawnSync\b|\bexecSync\b|\bexecFileSync\b|\bspawn\s*\(|\bfork\s*\(|process\.binding|process\.dlopen/;

describe('static guarantees of the package source', () => {
  it('only src/executor.ts can start processes', () => {
    const offenders = read(SRC)
      .filter(({ file, text }) => file !== 'executor.ts' && PROCESS_APIS.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
    const executor = readFileSync(join(SRC, 'executor.ts'), 'utf8');
    // ...and it uses execFile without a shell, nothing else.
    expect(executor).toMatch(/import \{ execFile \} from 'node:child_process';/);
    expect(executor.match(/child_process/g)).toHaveLength(1);
    expect(executor).toMatch(/shell: false/);
    // Standalone exec()/spawn() calls (RegExp.prototype.exec is `.exec(` and allowed).
    expect(executor).not.toMatch(/(?<![.\w])(?:exec|spawn)\s*\(|\bexecSync\b|shell:\s*true/);
  });

  it('imports no AWS SDK (source, tests, package.json)', () => {
    for (const { file, text } of [...read(SRC), ...read(TEST)]) {
      expect(text, file).not.toMatch(
        /from ['"]@aws-sdk\/|import\(['"]@aws-sdk\/|require\(['"]@aws-sdk\//,
      );
    }
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    const deps = { ...pkg['dependencies'], ...pkg['devDependencies'] };
    expect(Object.keys(deps).filter((d) => d.startsWith('@aws-sdk/') || d === 'aws-sdk')).toEqual(
      [],
    );
    expect(Object.keys(pkg['dependencies'] ?? {})).toEqual(['prettier']);
  });

  it('builds no shell command strings and never enables a shell', () => {
    for (const { file, text } of read(SRC)) {
      expect(text, file).not.toMatch(/shell:\s*true|\/bin\/sh|cmd\.exe|eval\(|new Function\(/);
    }
  });
});
