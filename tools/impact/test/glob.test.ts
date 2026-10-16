import { describe, expect, it } from 'vitest';
import { expandBraces, lintPattern, matchGlob } from '../src/glob.ts';

describe('glob (GitLab rules:changes / Ruby fnmatch semantics)', () => {
  it.each([
    ['apps/api/**/*', 'apps/api/package.json', true],
    ['apps/api/**/*', 'apps/api/src/deep/file.ts', true],
    ['apps/api/**/*', 'apps/api-gateway/x.ts', false],
    ['apps/api/**/*', 'apps/apix', false],
    ['.gitlab/**/*', '.gitlab/ci/generated/components.yml', true],
    ['*.md', 'README.md', true],
    ['*.md', 'docs/guide.md', false],
    ['docs/**/*', 'docs/adr/0401.md', true],
    ['package.json', 'apps/api/package.json', false],
    ['package.json', 'package.json', true],
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'a/b/c.ts', true],
    ['apps/*/Dockerfile', 'apps/api/Dockerfile', true],
    ['apps/*/Dockerfile', 'apps/api/x/Dockerfile', false],
    ['.{npmrc,node-version}', '.npmrc', true],
    ['.{npmrc,node-version}', '.node-version', true],
    ['{apps/web,apps/api}/**/*', 'apps/web/src/a.ts', true],
    ['file?.txt', 'file1.txt', true],
    ['file?.txt', 'file/.txt', false],
    ['[ab].txt', 'a.txt', true],
    ['[!ab].txt', 'a.txt', false],
    ['dir/*', 'dir/.hidden', true], // FNM_DOTMATCH
    ['dir/**', 'dir/a/b', false], // `**` without `/` is a single segment
  ])('%s matches %s -> %s', (pattern, path, expected) => {
    expect(matchGlob(pattern, path)).toBe(expected);
  });

  it('expands nested braces', () => {
    expect(expandBraces('a{b,c{d,e}}f')).toEqual(['abf', 'acdf', 'acef']);
  });

  it('flags non-recursive ** and absolute patterns', () => {
    expect(lintPattern('dir/**')).toMatch(/single path segment/);
    expect(lintPattern('/abs/**/*')).toMatch(/repo-relative/);
    expect(lintPattern('dir/**/*')).toBeUndefined();
  });
});
