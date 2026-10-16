import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  adoptPaths,
  approve,
  assertStateForPaths,
  changedLines,
  DEFAULT_GATE_PATHS,
  GATE_POLICY_SOURCE,
  gatePathsFromSource,
  newPolicy,
  parsePolicy,
  prune,
  renderChildConfig,
  renderEntryConfig,
  slugOf,
  stateFromLsTree,
  stateMatchesPaths,
  type GatePolicy,
  type GateState,
  verdict,
} from '../src/gate-policy.ts';

const IMAGE = `docker.io/library/node:24.21.0-trixie@sha256:${'a'.repeat(64)}`;
const PATHS = [
  '.gitlab-ci.yml',
  '.gitlab',
  'components.yaml',
  'tools/ci',
  'policies',
  'tests/security',
];
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** git with no inherited GIT_* variable (never the repository a hook may run in). */
function git(repo: string, ...args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: repo,
    },
  });
}

function commit(repo: string, files: Record<string, string | null>, message = 'change'): string {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(repo, rel);
    if (content === null) rmSync(file, { force: true });
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message, '--no-verify');
  return git(repo, 'rev-parse', 'HEAD').trim();
}

function repo(): string {
  const r = mkdtempSync(join(tmpdir(), 'gate-policy-'));
  dirs.push(r);
  git(r, 'init', '-q', '-b', 'main');
  commit(r, {
    '.gitlab-ci.yml': 'include: [{ local: .gitlab/ci/security.yml }]\n',
    '.gitlab/ci/security.yml': 'secrets:gitleaks:\n  script: [gitleaks]\n',
    'components.yaml': 'components: [{ id: api }]\n',
    'tools/ci/scripts/gitleaks.sh': '#!/bin/sh\ngitleaks detect\n',
    'policies/exceptions/exceptions.yaml': 'exceptions: []\n',
    'apps/api/src/app.ts': 'export const a = 1;\n',
  });
  return r;
}

const tsState = (r: string, paths: readonly string[] = PATHS): GateState =>
  stateFromLsTree(paths, (p) => git(r, 'ls-tree', '--full-tree', 'HEAD', '--', p));

function policyFor(r: string): GatePolicy {
  return newPolicy({
    project: 'example/app',
    defaultBranch: 'main',
    policyProject: 'example/ci-policy',
    image: IMAGE,
    paths: PATHS,
    referenceSha: git(r, 'rev-parse', 'HEAD').trim(),
    referenceState: tsState(r),
    now: new Date('2026-10-14T00:00:00Z'),
  });
}

/** Run the child job's check exactly as rendered: script from the YAML, empty environment. */
function runChild(policy: GatePolicy, r: string): { status: number | null; out: string } {
  const child = parse(renderChildConfig(policy)) as Record<string, { script?: string[] }>;
  const block = child['gate:integrity']?.script?.[0] ?? '';
  const script = block.split("<<'GATE_INTEGRITY'\n")[1]?.split('\nGATE_INTEGRITY')[0] ?? '';
  expect(script).toContain('sha256sum');
  const file = join(mkdtempSync(join(tmpdir(), 'gate-script-')), 'check.sh');
  dirs.push(dirname(file));
  writeFileSync(file, script);
  const res = spawnSync('sh', ['-eu', file], {
    cwd: r,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: '/tmp',
      LC_ALL: 'C',
      PROJECT: 'example/app',
      MR_IID: '7',
    },
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

describe('gate integrity (ADR 0410)', () => {
  it('the child job and the Maintainer tooling compute the same gate state id', () => {
    const r = repo();
    const expected = tsState(r);
    const { status, out } = runChild(policyFor(r), r);
    expect(status, out).toBe(0);
    expect(out).toContain(`gate state ${expected.id}`);
    expect(out).toContain('PASS: gate-defining paths equal the main reference state');
  });

  it('blocks an MR that disables a check, names the changed entry, and passes once approved', () => {
    const r = repo();
    const policy = policyFor(r);
    const sha = commit(r, {
      '.gitlab/ci/security.yml': 'secrets:gitleaks:\n  allow_failure: true\n  script: [gitleaks]\n',
    });
    const blocked = runChild(policy, r);
    expect(blocked.status).toBe(1);
    expect(blocked.out).toContain('BLOCKED');
    expect(blocked.out).toMatch(/040000 tree [0-9a-f]{40}\t\.gitlab/);
    expect(blocked.out).toContain(
      'gate-admin approve --project example/app --policy-project example/ci-policy --mr 7 --rerun',
    );
    const state = tsState(r);
    const approved = approve(policy, {
      stateId: state.id,
      mr: 7,
      sha,
      approvedBy: 'root',
      approvedAt: '2026-10-14T01:00:00Z',
      reason: 'reviewed',
      changed: changedLines(policy.reference.state, state),
    });
    expect(approved.approved[0]?.changed.join('\n')).toContain('\t.gitlab');
    const pass = runChild(approved, r);
    expect(pass.status, pass.out).toBe(0);
    expect(pass.out).toContain(`PASS: Maintainer-approved gate state ${state.id}`);
  });

  it.each([
    ['(a) delete a gate job', { '.gitlab/ci/security.yml': '# removed\n' }],
    ['(b) make a gate script exit 0', { 'tools/ci/scripts/gitleaks.sh': '#!/bin/sh\nexit 0\n' }],
    ['(c) drop a component', { 'components.yaml': 'components: []\n' }],
    [
      '(d) add a self-approved exception',
      { 'policies/exceptions/exceptions.yaml': 'exceptions: [{ id: X, approver: me }]\n' },
    ],
    [
      '(e) add or replace the published signing key (.gitlab/security/cosign.pub)',
      { '.gitlab/security/cosign.pub': '-----BEGIN PUBLIC KEY-----\nattacker\n' },
    ],
    ['add a file under a missing gate path', { 'tests/security/new.test.ts': 'export {}\n' }],
  ])('blocks %s', (_name, files) => {
    const r = repo();
    const policy = policyFor(r);
    commit(r, files);
    expect(runChild(policy, r).status).toBe(1);
  });

  it('lets ordinary changes through and blocks a downgrade to a superseded state', () => {
    const r = repo();
    const original = tsState(r);
    commit(r, { 'apps/api/src/app.ts': 'export const a = 2;\n' });
    expect(runChild(policyFor(r), r).status).toBe(0);
    // A gate change is approved, merged and synced: the old state is no longer accepted.
    commit(r, { 'tools/ci/scripts/new-check.sh': '#!/bin/sh\necho stricter\n' });
    const synced = policyFor(r);
    expect(verdict(synced, original.id).pass).toBe(false);
    commit(r, { 'tools/ci/scripts/new-check.sh': null });
    expect(tsState(r).id).toBe(original.id);
    expect(runChild(synced, r).status).toBe(1);
  });

  it('prunes approvals of closed MRs and approvals that equal the reference', () => {
    const r = repo();
    const p = policyFor(r);
    const mk = (id: string, mr: number) => ({
      stateId: id,
      mr,
      sha: 'x',
      approvedBy: 'root',
      approvedAt: 'now',
      reason: '',
      changed: [],
    });
    const withApprovals = {
      ...p,
      approved: [mk('a'.repeat(64), 1), mk('b'.repeat(64), 2), mk(p.reference.state.id, 3)],
    };
    expect(prune(withApprovals, [2, 3]).approved.map((a) => a.mr)).toEqual([2]);
  });

  it('pins every key of the bridge job and forwards no variables', () => {
    const r = repo();
    const entry = parse(renderEntryConfig(policyFor(r))) as Record<string, Record<string, unknown>>;
    expect(entry.include).toEqual([
      { project: '$CI_PROJECT_PATH', ref: '$CI_COMMIT_SHA', file: '.gitlab-ci.yml' },
    ]);
    const bridge = entry['policy:gate-integrity'] as Record<string, unknown>;
    expect(bridge).toMatchObject({
      stage: '.pre',
      needs: [],
      allow_failure: false,
      inherit: { default: false, variables: false },
      trigger: {
        include: [
          {
            project: 'example/ci-policy',
            ref: 'main',
            file: `projects/${slugOf('example/app')}/gate-integrity.yml`,
          },
        ],
        strategy: 'depend',
        forward: { yaml_variables: false, pipeline_variables: false },
      },
    });
    const child = parse(renderChildConfig(policyFor(r))) as Record<string, Record<string, unknown>>;
    expect(child['gate:integrity']?.image).toBe(IMAGE);
  });

  it('rejects unpinned images and odd paths in a policy file', () => {
    const r = repo();
    const ok = policyFor(r);
    expect(() => parsePolicy(JSON.stringify({ ...ok, image: 'node:24' }))).toThrow(/pinned/);
    expect(() => parsePolicy(JSON.stringify({ ...ok, paths: ['a; rm -rf /'] }))).toThrow(/plain/);
    expect(parsePolicy(JSON.stringify(ok)).project).toBe('example/app');
  });

  it('the child job is untagged by default (generic runner) and tagged only with a plain tag', () => {
    const r = repo();
    const untagged = parse(renderChildConfig(policyFor(r))) as Record<
      string,
      Record<string, unknown>
    >;
    expect(untagged['gate:integrity']).not.toHaveProperty('tags');
    const tagged = parse(renderChildConfig({ ...policyFor(r), runnerTag: 'docker' })) as Record<
      string,
      Record<string, unknown>
    >;
    expect(tagged['gate:integrity']?.tags).toEqual(['docker']);
    for (const bad of ['a]\nevil: [x', 'with space', 'x'.repeat(65)]) {
      expect(() => parsePolicy(JSON.stringify({ ...policyFor(r), runnerTag: bad }))).toThrow(
        /runnerTag/,
      );
      expect(() =>
        newPolicy({
          project: 'example/app',
          defaultBranch: 'main',
          policyProject: 'example/ci-policy',
          image: IMAGE,
          runnerTag: bad,
          referenceSha: 'a'.repeat(40),
          referenceState: tsState(r),
          now: new Date(),
        }),
      ).toThrow(/runnerTag/);
    }
  });
});

const REPO_ROOT = join(import.meta.dirname, '../../..');

describe('gate-defining paths', () => {
  it('cover the MiniStack emulator layer: guard, job scripts and baseline, reconcile/results code', () => {
    for (const p of [
      'infra/lib/emulator-guard.ts',
      'infra/lib/emulator-guard-cli.ts',
      'tests/aws-integration/emulator',
      'tests/aws-integration/src/emulator-ci.ts',
      'tests/aws-integration/src/emulator-gaps.ts',
      'tests/aws-integration/src/emulator-reconcile.ts',
      'tests/aws-integration/src/emulator-results.ts',
      // What decides which emulator tests run and how the guard resolves
      'tests/aws-integration/src/live-harness.ts',
      'tests/aws-integration/src/aws-gate.ts',
      'tests/aws-integration/package.json',
      'tests/aws-integration/tsconfig.build.json',
      'tests/aws-integration/vitest.config.ts',
      'infra/bin/integration.ts',
      'infra/package.json',
      'infra/tsconfig.json',
    ]) {
      expect(DEFAULT_GATE_PATHS).toContain(p);
    }
  });

  it('the source parser reads exactly DEFAULT_GATE_PATHS and refuses anything but literals', () => {
    expect(gatePathsFromSource(readFileSync(join(REPO_ROOT, GATE_POLICY_SOURCE), 'utf8'))).toEqual([
      ...DEFAULT_GATE_PATHS,
    ]);
    const src = (body: string) =>
      `export const DEFAULT_GATE_PATHS: readonly string[] = [\n${body}\n];\n`;
    expect(gatePathsFromSource(src("  'a', // it's a comment\n  'b/c.ts',"))).toEqual([
      'a',
      'b/c.ts',
    ]);
    for (const bad of [
      "  ...OTHER,\n  'a',",
      "  'a',\n  b,",
      '  `a`,',
      "  'a; rm',",
      "  'a',\n  'a',",
      '',
    ]) {
      expect(() => gatePathsFromSource(src(bad)), bad).toThrow();
    }
    expect(() => gatePathsFromSource('nothing here')).toThrow(/not found/);
  });

  it('every default gate path is one existing tree entry (a file or directory, never a glob)', () => {
    expect(new Set(DEFAULT_GATE_PATHS).size).toBe(DEFAULT_GATE_PATHS.length);
    for (const p of DEFAULT_GATE_PATHS) {
      expect(p, p).toMatch(/^[\w./-]+$/);
      expect(p, p).not.toMatch(/[*?[\]]|\/$/);
      expect(existsSync(join(REPO_ROOT, p)), `${p} exists`).toBe(true);
    }
    // the baseline and the scripts are inside the gate-defining directory
    expect(
      existsSync(join(REPO_ROOT, 'tests/aws-integration/emulator/expected-not-applicable.json')),
    ).toBe(true);
  });

  it('a state is only ever used with the path list it was computed over', () => {
    const r = repo();
    const state = tsState(r);
    expect(stateMatchesPaths(state, PATHS)).toBe(true);
    expect(stateMatchesPaths(state, [...PATHS, 'infra/lib/emulator-guard.ts'])).toBe(false);
    expect(stateMatchesPaths(state, [...PATHS].reverse())).toBe(false);
    expect(() => assertStateForPaths(state, PATHS.slice(1))).toThrow(/not computed over/);
  });

  it('adopting a new path list re-pins the reference and drops every approval', () => {
    const r = repo();
    const p = approve(policyFor(r), {
      stateId: 'c'.repeat(64),
      mr: 9,
      sha: 'x',
      approvedBy: 'root',
      approvedAt: 'now',
      reason: '',
      changed: [],
    });
    expect(p.approved).toHaveLength(1);
    const wider = [...PATHS, 'apps/api'];
    // A state of the old list is refused.
    expect(() => adoptPaths(p, wider, { sha: 'y', state: tsState(r), now: new Date(0) })).toThrow(
      /not computed over/,
    );
    const adopted = adoptPaths(p, wider, { sha: 'y', state: tsState(r, wider), now: new Date(0) });
    expect(adopted.paths).toEqual(wider);
    expect(adopted.approved).toEqual([]);
    expect(adopted.reference).toMatchObject({ sha: 'y', state: tsState(r, wider) });
    // The child job of the adopted policy now guards the new path: a change there is blocked.
    expect(runChild(adopted, r).status).toBe(0);
    commit(r, { 'apps/api/src/app.ts': 'export const a = 3;\n' });
    expect(runChild(adopted, r).status).toBe(1);
  });

  /** A repository whose committed gate-policy source lists `paths` (the operator's tree differs). */
  function repoWithPolicySource(paths: readonly string[]): string {
    const r = repo();
    const list = paths.map((p) => `  '${p}',`).join('\n');
    commit(r, {
      [GATE_POLICY_SOURCE]: `// x\nexport const DEFAULT_GATE_PATHS: readonly string[] = [\n${list}\n];\n`,
    });
    return r;
  }
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [join(REPO_ROOT, 'tools/ci/src/cli.ts'), 'gate-policy', ...args], {
      encoding: 'utf8',
    });

  it('the CLI: sync refuses a state of another path list; --adopt-default-paths adopts the list committed at the synced head', () => {
    const committed = [...PATHS, 'apps/api', GATE_POLICY_SOURCE];
    const r = repoWithPolicySource(committed);
    const head = git(r, 'rev-parse', 'HEAD').trim();
    // The operator's tree is dirty and lists something else: neither may matter.
    writeFileSync(
      join(r, GATE_POLICY_SOURCE),
      "export const DEFAULT_GATE_PATHS: readonly string[] = [\n  'x',\n];\n",
    );
    expect(DEFAULT_GATE_PATHS).not.toEqual(committed);
    const dir = mkdtempSync(join(tmpdir(), 'gate-cli-'));
    dirs.push(dir);
    const policyFile = join(dir, 'policy.json');
    writeFileSync(policyFile, JSON.stringify(policyFor(r)));
    const gitDir = join(r, '.git');
    const out = join(dir, 'out.json');
    const sync = (state: string, ...extra: string[]) =>
      cli('sync', '--policy', policyFile, '--sha', head, '--state', state, '--out', out, ...extra);

    // A state over this working tree's list (no --paths-from-rev) is refused either way.
    const treeState = join(dir, 'state-tree.json');
    expect(cli('state', '--git-dir', gitDir, '--rev', head, '--out', treeState).status).toBe(0);
    expect(sync(treeState).stderr).toMatch(/not computed over the policy paths/);
    expect(
      sync(treeState, '--adopt-default-paths', '--git-dir', gitDir, '--expect-sha', head).stderr,
    ).toMatch(/not computed over the policy paths/);
    // Adopting without naming the reviewed commit is refused outright.
    const unreviewed = sync(treeState, '--adopt-default-paths', '--git-dir', gitDir);
    expect(unreviewed.status).not.toBe(0);
    expect(unreviewed.stderr).toMatch(/requires the reviewed default-branch commit/);

    const headState = join(dir, 'state-head.json');
    const st = cli(
      'state',
      '--git-dir',
      gitDir,
      '--rev',
      head,
      '--paths-from-rev',
      '--out',
      headState,
    );
    expect(st.status, st.stderr).toBe(0);
    // The branch moved past the reviewed commit.
    const moved = sync(
      headState,
      '--adopt-default-paths',
      '--git-dir',
      gitDir,
      '--expect-sha',
      'f'.repeat(40),
    );
    expect(moved.status).not.toBe(0);
    expect(moved.stderr).toMatch(/not at the reviewed/);

    const adopt = sync(
      headState,
      '--adopt-default-paths',
      '--git-dir',
      gitDir,
      '--expect-sha',
      head,
    );
    expect(adopt.status, adopt.stderr).toBe(0);
    expect(adopt.stdout).toMatch(new RegExp(`adopted ${committed.length} gate paths from ${head}`));
    expect(adopt.stdout).toMatch(/added: apps\/api, tools\/ci\/src\/gate-policy\.ts/);
    expect(adopt.stdout).toMatch(/this working tree has a different list, which was ignored/);
    // The tree entry of each newly protected path is printed for review.
    expect(adopt.stdout).toMatch(/^ {2}040000 tree [0-9a-f]{40}\tapps\/api$/m);
    const adopted = parsePolicy(readFileSync(out, 'utf8'));
    expect(adopted.paths).toEqual(committed);
    expect(adopted.approved).toEqual([]);
  });

  it('--adopt-default-paths refuses to drop a gate path without --allow-path-removal', () => {
    const committed = PATHS.filter((p) => p !== 'tests/security');
    const r = repoWithPolicySource(committed);
    const head = git(r, 'rev-parse', 'HEAD').trim();
    const dir = mkdtempSync(join(tmpdir(), 'gate-cli-'));
    dirs.push(dir);
    const policyFile = join(dir, 'policy.json');
    writeFileSync(policyFile, JSON.stringify(policyFor(r)));
    const state = join(dir, 'state.json');
    const gitDir = join(r, '.git');
    expect(
      cli('state', '--git-dir', gitDir, '--rev', head, '--paths-from-rev', '--out', state).status,
    ).toBe(0);
    const args = [
      'sync',
      '--policy',
      policyFile,
      '--sha',
      head,
      '--state',
      state,
      '--out',
      join(dir, 'o.json'),
      '--adopt-default-paths',
      '--git-dir',
      gitDir,
      '--expect-sha',
      head,
    ];
    const refused = cli(...args);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/would remove gate path\(s\) tests\/security/);
    expect(cli(...args, '--allow-path-removal').status).toBe(0);
  });

  it('init with --git-dir takes the list committed at --sha', () => {
    const committed = [...PATHS, 'apps/api'];
    const r = repoWithPolicySource(committed);
    const head = git(r, 'rev-parse', 'HEAD').trim();
    const dir = mkdtempSync(join(tmpdir(), 'gate-cli-'));
    dirs.push(dir);
    const state = join(dir, 'state.json');
    const gitDir = join(r, '.git');
    expect(
      cli('state', '--git-dir', gitDir, '--rev', head, '--paths-from-rev', '--out', state).status,
    ).toBe(0);
    const out = join(dir, 'policy.json');
    const init = cli(
      'init',
      '--project',
      'example/app',
      '--default-branch',
      'main',
      '--policy-project',
      'example/ci-policy',
      '--image',
      IMAGE,
      '--sha',
      head,
      '--git-dir',
      gitDir,
      '--state',
      state,
      '--out',
      out,
    );
    expect(init.status, init.stderr).toBe(0);
    expect(parsePolicy(readFileSync(out, 'utf8')).paths).toEqual(committed);
  });
});
