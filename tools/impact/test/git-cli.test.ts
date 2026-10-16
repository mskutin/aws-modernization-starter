import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { changedFiles, gitRunner, resolveBase } from '../src/git.ts';
import { commitChange, git, initGit, makeRepo } from './fixture.ts';

const ZERO = '0'.repeat(40);
const repos: string[] = [];
function repo(): string {
  const r = makeRepo();
  repos.push(r);
  return r;
}
afterEach(() => {
  for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function cli(
  root: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<number> {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env))
    if (key.startsWith('CI_') || key === 'IMPACT_RUN_ALL') delete process.env[key];
  Object.assign(process.env, env);
  try {
    return await main([...args, '--root', root]);
  } finally {
    process.env = saved;
  }
}

describe('base resolution', () => {
  it('prefers explicit, then MR diff base, then before SHA', () => {
    expect(resolveBase('abc', { CI_MERGE_REQUEST_DIFF_BASE_SHA: 'def' }).base).toBe('abc');
    expect(
      resolveBase(undefined, { CI_MERGE_REQUEST_DIFF_BASE_SHA: 'def', CI_COMMIT_BEFORE_SHA: 'ghi' })
        .base,
    ).toBe('def');
    expect(resolveBase(undefined, { CI_COMMIT_BEFORE_SHA: 'ghi' }).base).toBe('ghi');
  });

  it('treats the zero SHA and absence as unknown', () => {
    expect(resolveBase(undefined, { CI_COMMIT_BEFORE_SHA: ZERO })).toMatchObject({
      base: null,
      source: expect.stringMatching(/zero SHA/),
    });
    expect(resolveBase(undefined, {}).base).toBeNull();
  });
});

describe('changed files from git', () => {
  it('lists files changed between base and head', () => {
    const root = repo();
    const base = initGit(root);
    commitChange(root, { 'apps/web/src/App.tsx': 'x', 'docs/a.md': 'y' });
    const r = changedFiles(gitRunner(root), { base, source: 'test' }, 'HEAD');
    expect(r).toMatchObject({ kind: 'diff', files: ['apps/web/src/App.tsx', 'docs/a.md'] });
  });

  it('reports renames as delete + add so both owners are selected', () => {
    const root = repo();
    const base = initGit(root);
    git(root, 'mv', 'packages/domain/src/index.ts', 'packages/contracts/src/moved.ts');
    git(root, 'commit', '-q', '-m', 'mv', '--no-verify');
    const r = changedFiles(gitRunner(root), { base, source: 'test' }, 'HEAD');
    expect(r.kind === 'diff' && r.files.sort()).toEqual([
      'packages/contracts/src/moved.ts',
      'packages/domain/src/index.ts',
    ]);
  });

  it('fails safe when the base commit is missing and cannot be fetched', () => {
    const root = repo();
    initGit(root);
    const r = changedFiles(gitRunner(root), { base: 'f'.repeat(40), source: 'test' }, 'HEAD', {
      fetchMissing: true,
    });
    expect(r).toMatchObject({
      kind: 'unknown',
      reason: expect.stringMatching(/could not be fetched/),
    });
  });

  it('fails safe outside a git repository', () => {
    const root = repo();
    const r = changedFiles(gitRunner(root), { base: 'HEAD~1', source: 'test' }, 'HEAD');
    expect(r.kind).toBe('unknown');
  });
});

describe('cli', () => {
  it('generate writes the CI file and generate --check detects staleness', async () => {
    const root = repo();
    expect(await cli(root, ['generate', '--check'])).toBe(1);
    expect(await cli(root, ['generate'])).toBe(0);
    expect(await cli(root, ['generate', '--check'])).toBe(0);
    const file = join(root, '.gitlab/ci/generated/components.yml');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n# hand edit\n`);
    expect(await cli(root, ['generate', '--check'])).toBe(1);
  });

  it('analyze writes JSON, markdown and dotenv reports for an MR', async () => {
    const root = repo();
    await cli(root, ['generate']);
    const base = initGit(root);
    commitChange(root, { 'apps/api/src/routes.ts': 'export {};\n' });
    const code = await cli(root, ['analyze'], {
      CI_PIPELINE_SOURCE: 'merge_request_event',
      CI_MERGE_REQUEST_DIFF_BASE_SHA: base,
      CI_DEFAULT_BRANCH: 'main',
    });
    expect(code).toBe(0);
    const out = join(root, 'reports/impact');
    const json = JSON.parse(readFileSync(join(out, 'impact.json'), 'utf8'));
    expect(json.mode).toBe('selective');
    expect(
      json.components
        .filter((c: { selected: boolean }) => c.selected)
        .map((c: { id: string }) => c.id),
    ).toContain('api');
    expect(readFileSync(join(out, 'impact.env'), 'utf8')).toMatch(/^IMPACT_MODE=selective$/m);
    expect(existsSync(join(out, 'impact.md'))).toBe(true);
  });

  it('analyze exits non-zero on unmapped paths but still writes the report', async () => {
    const root = repo();
    await cli(root, ['generate']);
    const base = initGit(root);
    commitChange(root, { 'mystery/file.bin': 'x' });
    const code = await cli(root, ['analyze'], {
      CI_PIPELINE_SOURCE: 'merge_request_event',
      CI_MERGE_REQUEST_DIFF_BASE_SHA: base,
    });
    expect(code).toBe(1);
    expect(readFileSync(join(root, 'reports/impact/impact.md'), 'utf8')).toMatch(
      /mystery\/file.bin/,
    );
  });

  it('analyze fails when the generated CI file is stale', async () => {
    const root = repo();
    const base = initGit(root);
    commitChange(root, { 'apps/web/src/a.ts': 'x' });
    const code = await cli(root, ['analyze'], {
      CI_PIPELINE_SOURCE: 'merge_request_event',
      CI_MERGE_REQUEST_DIFF_BASE_SHA: base,
    });
    expect(code).toBe(1);
    expect(
      JSON.parse(readFileSync(join(root, 'reports/impact/impact.json'), 'utf8')).errors[0],
    ).toMatch(/stale/);
  });

  it('new-branch push (zero before SHA) runs everything', async () => {
    const root = repo();
    await cli(root, ['generate']);
    initGit(root);
    const code = await cli(root, ['analyze'], {
      CI_PIPELINE_SOURCE: 'push',
      CI_COMMIT_BRANCH: 'feature/x',
      CI_DEFAULT_BRANCH: 'main',
      CI_COMMIT_BEFORE_SHA: ZERO,
    });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'reports/impact/impact.json'), 'utf8')).mode).toBe(
      'all',
    );
  });

  it('gate passes only when every required job left a success marker', async () => {
    const root = repo();
    await cli(root, ['generate']);
    const base = initGit(root);
    commitChange(root, { 'apps/web/src/a.ts': 'x' });
    await cli(root, ['analyze'], {
      CI_PIPELINE_SOURCE: 'merge_request_event',
      CI_MERGE_REQUEST_DIFF_BASE_SHA: base,
    });
    const impact = JSON.parse(readFileSync(join(root, 'reports/impact/impact.json'), 'utf8'));
    const required = impact.jobs
      .filter((j: { gated: boolean; selected: boolean }) => j.gated && j.selected)
      .map((j: { name: string }) => j.name);
    expect(required).toEqual(['lint', 'test:tests-e2e', 'test:web']);
    expect(await cli(root, ['gate'], { GATE_101: 'lint' })).toBe(1);
    expect(readFileSync(join(root, 'reports/gate/gate.md'), 'utf8')).toMatch(/MISSING/);
    expect(
      await cli(root, ['gate'], {
        GATE_101: 'lint',
        GATE_102: 'test:web',
        GATE_103: 'test:tests-e2e',
      }),
    ).toBe(0);
  });

  it('gate fails when the impact report is missing', async () => {
    const root = repo();
    expect(await cli(root, ['gate'])).toBe(1);
  });
});
