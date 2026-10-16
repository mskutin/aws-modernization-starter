import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { analyze, type ChangeSet, type PipelineContext } from '../src/analyze.ts';
import { GENERATED_FILE, loadCiJobs } from '../src/ciconfig.ts';
import { RUN_ALL_IF, SCHEDULE_TASK_IF } from '../src/generate.ts';
import { matchGlob } from '../src/glob.ts';
import { allJobs } from '../src/jobs.ts';
import { loadManifest } from '../src/manifest.ts';
import { buildGraph } from '../src/model.ts';
import { loadWorkspace } from '../src/workspace.ts';

// Real repository (read-only): the hand-written MiniStack jobs in .gitlab/ci/emulator.yml are part
// of the impact job universe, selected through the tests-aws-integration rule, and not gated.
const repo = join(import.meta.dirname, '..', '..', '..');
const manifest = loadManifest(join(repo, 'components.yaml'));
const graph = buildGraph(manifest, loadWorkspace(repo));
const jobs = allJobs(manifest, loadCiJobs(repo));
const MR: PipelineContext = { source: 'merge_request_event', defaultBranch: 'main' };
const EMULATOR = ['integration:ministack:cdk', 'integration:ministack:workflows'];
const diff = (...files: string[]): ChangeSet => ({
  kind: 'diff',
  base: 'b'.repeat(40),
  head: 'HEAD',
  files,
});
const selected = (files: string[]): string[] =>
  analyze(manifest, graph, jobs, diff(...files), MR)
    .jobs.filter((j) => j.selected && EMULATOR.includes(j.name))
    .map((j) => j.name)
    .sort();

/** GitLab's view: the committed `.impact:tests-aws-integration` rule in an MR pipeline. */
function gitlabWouldCreate(files: string[]): boolean {
  const generated = parse(readFileSync(join(repo, GENERATED_FILE), 'utf8')) as Record<
    string,
    { rules: Array<{ if?: string; changes?: { paths: string[] } }> }
  >;
  for (const rule of generated['.impact:tests-aws-integration']?.rules ?? []) {
    if (rule.if === SCHEDULE_TASK_IF || rule.if === RUN_ALL_IF) continue;
    if (rule.changes) return files.some((f) => rule.changes?.paths.some((p) => matchGlob(p, f)));
  }
  return false;
}

describe('MiniStack emulator jobs in the impact model', () => {
  it('are hand-written, triggered by tests-aws-integration and not required by the gate', () => {
    for (const name of EMULATOR) {
      expect(jobs.find((j) => j.name === name)).toMatchObject({
        source: 'hand-written',
        trigger: { kind: 'components', components: ['tests-aws-integration'] },
        gated: false,
      });
    }
  });

  it.each([
    ['infra', ['infra/stacks/integration-workflow-stack.ts']],
    ['workflow spec', ['workflows/processing/src/spec.ts']],
    ['a Lambda', ['functions/processor/src/handler.ts']],
    ['a shared package', ['packages/job-state/src/index.ts']],
    ['policies', ['policies/guard/rules.guard']],
    ['the emulator scripts', ['tests/aws-integration/emulator/ci.sh']],
  ])('run for a change to %s (analyser and GitLab rule agree)', (_name, files) => {
    expect(selected(files)).toEqual(EMULATOR);
    expect(gitlabWouldCreate(files)).toBe(true);
  });

  it.each([
    ['docs only', ['docs/testing.md', 'README.md']],
    ['the web app', ['apps/web/src/main.tsx']],
  ])('do not run for %s', (_name, files) => {
    expect(selected(files)).toEqual([]);
    expect(gitlabWouldCreate(files)).toBe(false);
  });
});
