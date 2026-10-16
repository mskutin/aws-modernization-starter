/** Prettier runs with explicit options; no configuration near an output path is loaded. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { writeEvidence } from '../src/evidence.ts';
import { formatText, PRETTIER_OPTIONS } from '../src/format.ts';

const PKG = fileURLToPath(new URL('..', import.meta.url));

describe('explicit Prettier options', () => {
  it("equal the repository's .prettierrc.json (generated files stay stable under format:check)", () => {
    const repoConfig: unknown = JSON.parse(
      readFileSync(join(PKG, '..', '..', '.prettierrc.json'), 'utf8'),
    );
    expect({ ...PRETTIER_OPTIONS }).toEqual(repoConfig);
  });

  it('no source file resolves a Prettier configuration', () => {
    for (const file of readdirSync(join(PKG, 'src')).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(PKG, 'src', file), 'utf8');
      expect(text, file).not.toMatch(/resolveConfig|resolveConfigFile|editorconfig:\s*true/);
    }
  });

  it('a hostile .prettierrc.js / prettier.config.mjs / .editorconfig above the evidence path is never executed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aws-preflight-prettier-'));
    const out = join(dir, 'nested', 'out');
    mkdirSync(out, { recursive: true });
    const marker = join(dir, 'executed');
    const cjs = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); module.exports = { useTabs: true };\n`;
    writeFileSync(join(dir, '.prettierrc.js'), cjs);
    writeFileSync(join(dir, 'nested', '.prettierrc.cjs'), cjs);
    writeFileSync(
      join(out, 'prettier.config.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x'); export default { useTabs: true };\n`,
    );
    writeFileSync(join(out, 'package.json'), JSON.stringify({ prettier: './prettier.config.mjs' }));
    writeFileSync(
      join(out, '.editorconfig'),
      'root = true\n[*]\nindent_style = tab\nindent_size = 8\n',
    );
    const path = join(out, 'evidence.json');
    const outcome = await writeEvidence(
      path,
      { schemaVersion: 2, nested: { list: [1, 2, 3] } },
      {},
    );
    expect(outcome).toEqual({ written: true, path });
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(
      '{\n  "schemaVersion": 2,\n  "nested": {\n    "list": [1, 2, 3]\n  }\n}\n',
    );
  });

  it('formats markdown with the same options', async () => {
    expect(await formatText('| a | b |\n|---|---|\n| 1 | 2 |\n', 'markdown')).toBe(
      '| a   | b   |\n| --- | --- |\n| 1   | 2   |\n',
    );
  });
});
