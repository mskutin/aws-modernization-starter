import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  analyze,
  type ChangeSet,
  CONTAINER_BUILD_OPT_OUT_NOTICE,
  type ImpactResult,
  type PipelineContext,
  requiredGateJobs,
} from '../src/analyze.ts';
import { loadCiJobs } from '../src/ciconfig.ts';
import { evaluateGate, renderGateMarkdown } from '../src/gate.ts';
import {
  CONTAINER_BUILD_OPT_OUT_IF,
  generateCiYaml,
  RUN_ALL_IF,
  SCHEDULE_TASK_IF,
} from '../src/generate.ts';
import { matchGlob } from '../src/glob.ts';
import { allJobs, type JobSpec } from '../src/jobs.ts';
import { loadManifest, type Manifest } from '../src/manifest.ts';
import { buildGraph, checkConsistency, type ComponentGraph } from '../src/model.ts';
import { renderDotenv, renderMarkdown } from '../src/report.ts';
import { loadWorkspace } from '../src/workspace.ts';
import { makeRepo } from './fixture.ts';

let root: string;
let manifest: Manifest;
let graph: ComponentGraph;
let jobs: JobSpec[];
let generated: Record<string, { rules?: Array<Record<string, unknown>>; extends?: string[] }>;

const MR: PipelineContext = { source: 'merge_request_event', defaultBranch: 'main' };
const diff = (...files: string[]): ChangeSet => ({
  kind: 'diff',
  base: 'b'.repeat(40),
  head: 'HEAD',
  files,
});

function run(changes: ChangeSet, context: PipelineContext = MR): ImpactResult {
  return analyze(manifest, graph, jobs, changes, context);
}
const selectedComponents = (r: ImpactResult): string[] =>
  r.components
    .filter((c) => c.selected)
    .map((c) => c.id)
    .sort();
const selectedJobs = (r: ImpactResult): string[] =>
  r.jobs
    .filter((j) => j.selected)
    .map((j) => j.name)
    .sort();

/** Simulates GitLab's rules evaluation for a generated job in an MR pipeline. */
function gitlabWouldCreate(jobName: string, files: string[]): boolean {
  const job = generated[jobName];
  if (!job) throw new Error(`no generated job ${jobName}`);
  let rules = job.rules;
  for (const parent of job.extends ?? []) rules ??= generated[parent]?.rules;
  if (!rules) throw new Error(`job ${jobName} has no rules`);
  for (const rule of rules) {
    if (rule.if === SCHEDULE_TASK_IF) continue; // not a schedule-task pipeline
    if (rule.if === CONTAINER_BUILD_OPT_OUT_IF) continue; // default: image builds enabled
    if (rule.if === '$CI_COMMIT_REF_PROTECTED != "true"') return false; // protected-ref guard: MR -> never
    if (typeof rule.if === 'string' && rule.if.includes('$CI_COMMIT_TAG == null')) return false; // release-only guard: MR -> never
    if (rule.if === RUN_ALL_IF) continue; // MR pipeline, IMPACT_RUN_ALL unset
    const changes = rule.changes as { paths: string[] } | undefined;
    if (changes) return files.some((f) => changes.paths.some((p) => matchGlob(p, f)));
  }
  return false;
}

beforeAll(async () => {
  root = makeRepo();
  manifest = loadManifest(join(root, 'components.yaml'));
  const workspace = loadWorkspace(root);
  graph = buildGraph(manifest, workspace);
  jobs = allJobs(manifest, loadCiJobs(root));
  generated = parse(await generateCiYaml(manifest, graph, jobs)) as typeof generated;
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('workspace + manifest', () => {
  it('reads the pnpm workspace graph from package.json files', () => {
    const ws = loadWorkspace(root);
    expect(ws.packages.map((p) => p.name)).toContain('@fx/api');
    expect(ws.byName.get('@fx/api')?.internalDeps).toEqual([
      '@fx/contracts',
      '@fx/domain',
      '@fx/fn-validator',
    ]);
    expect(checkConsistency(manifest, ws)).toEqual([]);
  });

  it('reports workspace packages missing from components.yaml', () => {
    const ws = loadWorkspace(root);
    const trimmed = {
      ...manifest,
      components: manifest.components.filter((c) => c.id !== 'domain'),
    };
    const problems = checkConsistency(trimmed, ws).map((p) => p.message);
    expect(problems.join('\n')).toMatch(/@fx\/domain .* not declared in components.yaml/);
  });

  it('builds component edges from package.json and dependsOn', () => {
    expect([...(graph.deps.get('api') ?? [])].sort()).toEqual([
      'contracts',
      'domain',
      'fn-validator',
    ]);
    expect([...(graph.deps.get('infra') ?? [])]).toEqual(['fn-validator']);
  });
});

describe('impact analysis scenarios (MR pipeline)', () => {
  it('frontend-only change selects web and its e2e suite only', () => {
    const r = run(diff('apps/web/src/App.tsx'));
    expect(r.mode).toBe('selective');
    expect(selectedComponents(r)).toEqual(['tests-e2e', 'web']);
    const j = selectedJobs(r);
    expect(j).toContain('test:web');
    expect(j).toContain('e2e:playwright');
    expect(j).toContain('lint');
    expect(j).not.toContain('test:api');
    expect(j).not.toContain('container:build:api');
    expect(j.some((n) => n.startsWith('synth:'))).toBe(false);
  });

  it('backend-only change selects api, container chain and dependent suites', () => {
    const r = run(diff('apps/api/src/server.ts'));
    expect(selectedComponents(r)).toEqual(['api', 'tests-e2e', 'tests-integration']);
    const j = selectedJobs(r);
    for (const step of [
      'lint',
      'build',
      'scan',
      'sbom',
      'provenance',
      'publish',
      'sign',
      'verify',
      'chain-report',
    ]) {
      expect(j).toContain(`container:${step}:api`);
    }
    // Schedule-only rescan jobs are never impact-selected.
    expect(j).not.toContain('container:rescan:api');
    expect(j).not.toContain('test:web');
    expect(j).not.toContain('contracts:openapi-drift');
  });

  it('shared contracts change fans out through the reverse dependency closure', () => {
    const r = run(diff('packages/contracts/src/v1/jobs.ts'));
    expect(selectedComponents(r)).toEqual([
      'api',
      'contracts',
      'db',
      'domain',
      'fn-validator',
      'infra',
      'tests-e2e',
      'tests-integration',
      'web',
    ]);
    const infra = r.components.find((c) => c.id === 'infra');
    expect(infra?.reasons.join(' ')).toMatch(/infra -> fn-validator -> contracts/);
    expect(selectedJobs(r)).toContain('contracts:openapi-drift');
    expect(selectedJobs(r)).toContain('synth:infra');
  });

  it('CDK infra change selects synth/policy/finops but no app jobs', () => {
    const r = run(diff('infra/lib/stack.ts'));
    expect(selectedComponents(r)).toEqual(['db', 'infra']);
    const j = selectedJobs(r);
    expect(j).toEqual(
      expect.arrayContaining(['test:infra', 'synth:infra', 'policy:infra', 'finops:infra']),
    );
    expect(j).not.toContain('test:api');
    expect(j).not.toContain('container:build:api');
  });

  it('policy-only change runs the policy check and the synth it needs', () => {
    const r = run(diff('policies/guard/s3.guard'));
    const j = selectedJobs(r);
    expect(j).toEqual(expect.arrayContaining(['test:policies', 'synth:infra', 'policy:infra']));
    expect(j).not.toContain('finops:infra');
  });

  it('root config change runs everything', () => {
    const r = run(diff('pnpm-lock.yaml'));
    expect(r.mode).toBe('all');
    expect(r.reasons.join()).toMatch(/global path changed: pnpm-lock.yaml/);
    expect(selectedComponents(r)).toHaveLength(manifest.components.length);
    expect(r.jobs.filter((j) => j.gated).every((j) => j.selected)).toBe(true);
  });

  it('CI config change runs everything', () => {
    expect(run(diff('.gitlab/ci/security.yml')).mode).toBe('all');
  });

  it('unknown path fails loudly instead of skipping', () => {
    const r = run(diff('random/new-thing.txt', 'apps/web/src/a.ts'));
    expect(r.unmapped).toEqual(['random/new-thing.txt']);
    expect(r.errors[0]).toMatch(/not mapped to any component/);
  });

  it('missing base SHA fails safe to run-all', () => {
    const r = run(
      { kind: 'unknown', reason: 'CI_COMMIT_BEFORE_SHA is the zero SHA' },
      { source: 'push', branch: 'feature', defaultBranch: 'main' },
    );
    expect(r.mode).toBe('all');
    expect(r.reasons.join()).toMatch(/change set unknown/);
    expect(r.errors).toEqual([]);
  });

  it('docs-only change runs only repo-wide jobs', () => {
    const r = run(diff('docs/ci-cd.md', 'README.md'));
    expect(selectedComponents(r)).toEqual([]);
    expect(selectedJobs(r)).toEqual(['lint']);
  });

  it('default branch, tags, schedules and IMPACT_RUN_ALL run everything', () => {
    for (const ctx of [
      { source: 'push', branch: 'main', defaultBranch: 'main' },
      { source: 'push', tag: 'v1.0.0' },
      { source: 'schedule', branch: 'main', defaultBranch: 'main' },
      { ...MR, forceAll: true },
    ]) {
      expect(run(diff('apps/web/src/a.ts'), ctx).mode).toBe('all');
    }
  });

  it('never selects credential/schedule-driven jobs by impact', () => {
    const r = run(diff('pnpm-lock.yaml'));
    expect(r.jobs.find((j) => j.name === 'aws:status')?.selected).toBe(false);
  });

  it('an image-build opt-out deselects the chain (never lint) and is reported, not hidden', () => {
    const files = diff('apps/api/src/server.ts');
    const chain = [
      'build',
      'scan',
      'sbom',
      'provenance',
      'publish',
      'sign',
      'verify',
      'chain-report',
    ];
    for (const ctx of [MR, { ...MR, containerBuild: true }]) {
      const r = run(files, ctx);
      for (const step of chain) expect(selectedJobs(r)).toContain(`container:${step}:api`);
      expect(r.notices).toEqual([]);
    }
    const r = run(files, { ...MR, containerBuild: false });
    const j = selectedJobs(r);
    for (const step of chain) expect(j).not.toContain(`container:${step}:api`);
    expect(j).toContain('container:lint:api');
    expect(j).toContain('test:api');
    expect(r.notices).toEqual([CONTAINER_BUILD_OPT_OUT_NOTICE]);
    expect(r.jobs.find((x) => x.name === 'container:scan:api')?.reason).toMatch(
      /opted out: STARTER_CONTAINER_BUILD=false/,
    );
    expect(requiredGateJobs(r)).not.toContain('container:scan:api');
    expect(renderMarkdown(r)).toContain('## Notices (deliberate coverage reductions)');
    expect(renderDotenv(r)).toContain('IMPACT_CONTAINER_BUILD=disabled');
    expect(renderDotenv(run(files))).toContain('IMPACT_CONTAINER_BUILD=enabled');
  });

  it('the gate shows the opt-out notice and still fails on any other missing job', () => {
    const r = run(diff('apps/api/src/server.ts'), { ...MR, containerBuild: false });
    const required = requiredGateJobs(r);
    const passed = evaluateGate(r, required);
    expect(passed.ok).toBe(true);
    expect(passed.notices).toEqual([CONTAINER_BUILD_OPT_OUT_NOTICE]);
    expect(renderGateMarkdown(passed)).toContain(`NOTICE: ${CONTAINER_BUILD_OPT_OUT_NOTICE}`);
    const missing = evaluateGate(
      r,
      required.filter((n) => n !== 'container:lint:api'),
    );
    expect(missing.ok).toBe(false);
    expect(missing.missing).toEqual(['container:lint:api']);
    // Without the opt-out the scan is required again.
    const enabled = run(diff('apps/api/src/server.ts'));
    expect(evaluateGate(enabled, required).missing).toEqual(
      expect.arrayContaining([
        'container:scan:api',
        'container:sbom:api',
        'container:provenance:api',
      ]),
    );
  });

  it('a hand-written job on .impact-image:<id> is impact-scoped and part of the image chain', () => {
    const real = loadCiJobs(join(import.meta.dirname, '../../..'));
    expect(real.find((x) => x.name === 'security:image-config:api')).toMatchObject({
      trigger: { kind: 'component', components: ['api'] },
      requiresContainerBuild: true,
      gated: false,
    });
    expect(real.find((x) => x.name === 'release:status')).toMatchObject({
      trigger: { kind: 'always' },
      gated: false,
      requiresContainerBuild: false,
    });
  });

  it('renders a markdown report that explains the selection', () => {
    const md = renderMarkdown(run(diff('packages/domain/src/x.ts')));
    expect(md).toContain('# CI impact report');
    expect(md).toMatch(/\| `api` \| service \| yes \| depends on domain: api -> domain \|/);
  });
});

describe('generated GitLab rules agree with the analyser', () => {
  const scenarios: string[][] = [
    ['apps/web/src/App.tsx'],
    ['apps/api/src/server.ts'],
    ['packages/contracts/src/x.ts'],
    ['packages/domain/src/x.ts'],
    ['functions/validator/src/handler.ts'],
    ['infra/lib/stack.ts'],
    ['policies/rules.guard'],
    ['tools/finops/src/cli.ts'],
    ['tests/e2e/specs/a.spec.ts'],
    ['.hadolint.yaml'],
    ['docs/x.md'],
    ['pnpm-lock.yaml'],
  ];

  // Created by GitLab only on protected release refs, never in an MR pipeline (ADR 0110/0411).
  const releaseOnly = /^container:(publish|sign|verify|chain-report):/;
  // Created only by SCHEDULE_TASK=rescan pipelines on a protected ref (ADR 0412).
  const scheduleOnly = /^container:rescan(-verify)?:/;

  it.each(scenarios)('%s', (...files) => {
    const result = run(diff(...files));
    for (const job of result.jobs.filter((j) => j.source === 'generated')) {
      const created = gitlabWouldCreate(job.name, files);
      if (scheduleOnly.test(job.name)) {
        expect({ job: job.name, created, selected: job.selected }).toEqual({
          job: job.name,
          created: false,
          selected: false,
        });
        continue;
      }
      const expected = result.mode === 'all' ? true : job.selected;
      expect({ job: job.name, created }).toEqual({
        job: job.name,
        created: expected && !releaseOnly.test(job.name),
      });
    }
  });

  it('every generated rules block guards schedule tasks and honours run-all', () => {
    for (const [name, body] of Object.entries(generated)) {
      if (!body.rules) continue;
      const rules = body.rules.map((r) => r.if);
      if (scheduleOnly.test(name)) {
        expect(rules, name).toEqual([
          '$CI_COMMIT_REF_PROTECTED == "true" && $SCHEDULE_TASK == "rescan"',
        ]);
        continue;
      }
      expect(rules, name).toContain(SCHEDULE_TASK_IF);
      expect(rules, name).toContain(RUN_ALL_IF);
    }
  });

  it('release steps exist only on protected release refs and run in order', () => {
    for (const step of ['publish', 'sign', 'verify', 'chain-report']) {
      const job = generated[`container:${step}:api`] as unknown as {
        rules: Array<{ if?: string; when?: string }>;
        needs: Array<{ job: string }>;
      };
      expect(job.rules[0], step).toEqual({
        if: '$CI_COMMIT_REF_PROTECTED != "true"',
        when: 'never',
      });
      expect(job.rules[1]?.if, step).toContain('$CI_COMMIT_TAG == null');
    }
    const needs = (step: string): string[] =>
      (
        generated[`container:${step}:api`] as unknown as { needs: Array<{ job: string }> }
      ).needs.map((n) => n.job);
    expect(needs('publish')).toContain('gates:mandatory');
    expect(needs('sign')).toEqual(
      expect.arrayContaining([
        'container:publish:api',
        'container:provenance:api',
        'container:sbom:api',
      ]),
    );
    expect(needs('verify')).toEqual(
      expect.arrayContaining(['container:sign:api', 'container:build:api']),
    );
    expect(needs('chain-report')).toContain('container:verify:api');
  });

  it('gate needs every gated job (optional) and never the image build', () => {
    const gate = generated['gates:mandatory'] as unknown as {
      needs: Array<{ job: string; optional?: boolean }>;
    };
    const needed = gate.needs.map((n) => n.job);
    expect(needed).toContain('impact');
    expect(needed).toContain('lint');
    expect(needed).toContain('contracts:openapi-drift');
    expect(needed).toContain('test:api');
    expect(needed).toContain('container:scan:api');
    expect(needed).not.toContain('container:build:api');
    expect(needed).not.toContain('e2e:playwright');
    expect(gate.needs.filter((n) => n.job !== 'impact').every((n) => n.optional)).toBe(true);
  });

  it('synth runs as a parallel matrix per environment', () => {
    const synth = generated['synth:infra'] as unknown as {
      parallel: { matrix: Array<Record<string, string[]>> };
    };
    expect(synth.parallel.matrix).toEqual([{ CDK_ENV: ['dev', 'prod'] }]);
  });

  it('adding a component needs only a manifest entry (+ package)', async () => {
    const extra = `${readFileSync(join(root, 'components.yaml'), 'utf8')}
  - id: fn-notifier
    kind: lambda
    path: functions/notifier
    package: '@fx/fn-notifier'
    deploy:
      stack: '{Stage}/Workflow'
      strategy: alias
      rollback: { automated: false, mechanism: alias shift }
`;
    const repo = makeRepo({ components: extra });
    mkdirSync(join(repo, 'functions/notifier'), { recursive: true });
    writeFileSync(
      join(repo, 'functions/notifier/package.json'),
      JSON.stringify({ name: '@fx/fn-notifier', dependencies: { '@fx/contracts': 'workspace:*' } }),
    );
    const m = loadManifest(join(repo, 'components.yaml'));
    const ws = loadWorkspace(repo);
    expect(checkConsistency(m, ws)).toEqual([]);
    const g = buildGraph(m, ws);
    const yaml = parse(await generateCiYaml(m, g, allJobs(m, loadCiJobs(repo)))) as Record<
      string,
      { extends?: string[]; rules?: Array<{ changes?: { paths: string[] } }> }
    >;
    expect(yaml['test:fn-notifier']?.extends).toEqual(['.component-test', '.impact:fn-notifier']);
    const paths = yaml['.impact:fn-notifier']?.rules?.find((r) => r.changes)?.changes?.paths ?? [];
    expect(paths).toEqual(
      expect.arrayContaining([
        'functions/notifier/**/*',
        'packages/contracts/**/*',
        'pnpm-lock.yaml',
      ]),
    );
    const gate = yaml['gates:mandatory'] as unknown as { needs: Array<{ job: string }> };
    expect(gate.needs.map((n) => n.job)).toContain('test:fn-notifier');
    rmSync(repo, { recursive: true, force: true });
  });
});
