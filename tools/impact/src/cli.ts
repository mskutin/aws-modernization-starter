#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
// Only dependency-free modules are imported statically, so `gate` runs on a bare
// Node image without `pnpm install`. Modules needing yaml/zod/prettier load lazily.
import { analyze, type ChangeSet, type ImpactResult, type PipelineContext } from './analyze.ts';
import { evaluateGate, passedJobsFromEnv, renderGateMarkdown } from './gate.ts';
import { changedFiles, gitRunner, resolveBase } from './git.ts';
import { allJobs } from './jobs.ts';
import type { Manifest } from './manifest.ts';
import { buildGraph, checkConsistency, type ComponentGraph } from './model.ts';
import { renderDotenv, renderMarkdown } from './report.ts';

const GENERATED_FILE = '.gitlab/ci/generated/components.yml';

const USAGE = `starter-impact <command> [options]

Commands:
  analyze    Compute changed files vs. the right base, select components/jobs, write
             reports/impact/{impact.json,impact.md,impact.env}. Also validates the manifest,
             workspace consistency and that the generated CI file is fresh.
               --base <sha>  --head <ref=HEAD>  --out-dir <dir>  --fetch-missing  --no-fail
  generate   (Re)write ${GENERATED_FILE}.   --check: fail if it is stale instead.
  validate   Validate components.yaml against its schema and the pnpm workspace.
  gate       Verify required jobs passed (reads GATE_* markers).  --impact <file>  --out-dir <dir>
  plan       Local helper for git hooks: print affected packages as pnpm filters.
               --base <ref>  --format filters|components|json
  filters    Print pnpm --filter args for a component's dependency closure
             (package.json deps + dependsOn), e.g. to build what synth bundles:
               pnpm $(node tools/impact/src/cli.ts filters infra) run --if-present build
  schema     Print (or --write) the JSON schema for components.yaml.

Global: --root <repo root> (default: nearest dir with pnpm-workspace.yaml)
`;

function findRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'components.yaml')))
      return dir;
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error(`no repo root (pnpm-workspace.yaml + components.yaml) above ${start}`);
    dir = parent;
  }
}

interface Loaded {
  root: string;
  manifest: Manifest;
  graph: ComponentGraph;
  problems: string[];
}

async function load(root: string): Promise<Loaded> {
  const { loadManifest } = await import('./manifest.ts');
  const { loadWorkspace } = await import('./workspace.ts');
  const manifest = loadManifest(join(root, 'components.yaml'));
  const workspace = loadWorkspace(root);
  const graph = buildGraph(manifest, workspace);
  const problems = checkConsistency(manifest, workspace)
    .filter((p) => p.severity === 'error')
    .map((p) => p.message);
  return { root, manifest, graph, problems };
}

async function ciJobs(root: string) {
  const { loadCiJobs } = await import('./ciconfig.ts');
  return loadCiJobs(root);
}

async function renderGenerated(l: Loaded): Promise<string> {
  const { resolveConfig } = await import('prettier');
  const { generateCiYaml } = await import('./generate.ts');
  const jobs = allJobs(l.manifest, await ciJobs(l.root));
  const prettierOptions = (await resolveConfig(join(l.root, GENERATED_FILE))) ?? {};
  return generateCiYaml(l.manifest, l.graph, jobs, prettierOptions as Record<string, unknown>);
}

async function staleness(l: Loaded): Promise<string | undefined> {
  const file = join(l.root, GENERATED_FILE);
  const expected = await renderGenerated(l);
  const actual = existsSync(file) ? readFileSync(file, 'utf8') : '';
  return expected === actual
    ? undefined
    : `${GENERATED_FILE} is stale or hand-edited — run: pnpm --filter @starter/tool-impact run generate`;
}

function contextFromEnv(env: NodeJS.ProcessEnv): PipelineContext {
  return {
    source: env.CI_PIPELINE_SOURCE,
    branch: env.CI_COMMIT_BRANCH,
    defaultBranch: env.CI_DEFAULT_BRANCH,
    tag: env.CI_COMMIT_TAG,
    forceAll: env.IMPACT_RUN_ALL === 'true',
    containerBuild: env.STARTER_CONTAINER_BUILD !== 'false',
  };
}

function writeOutputs(outDir: string, result: ImpactResult): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'impact.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(outDir, 'impact.md'), renderMarkdown(result));
  writeFileSync(join(outDir, 'impact.env'), renderDotenv(result));
}

async function cmdAnalyze(root: string, values: Record<string, unknown>): Promise<number> {
  const outDir = resolve(root, (values['out-dir'] as string | undefined) ?? 'reports/impact');
  let l: Loaded;
  try {
    l = await load(root);
  } catch (error) {
    // Even a broken manifest must produce a truthful report.
    const message = (error as Error).message;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'impact.md'), `# CI impact report\n\nFAILED: ${message}\n`);
    console.error(message);
    return 1;
  }
  const git = gitRunner(root);
  const head = (values.head as string | undefined) ?? 'HEAD';
  const resolution = resolveBase(values.base as string | undefined, process.env);
  const changes: ChangeSet = changedFiles(git, resolution, head, {
    fetchMissing: Boolean(values['fetch-missing']),
  });
  const jobs = allJobs(l.manifest, await ciJobs(root));
  const result = analyze(l.manifest, l.graph, jobs, changes, contextFromEnv(process.env));
  result.errors.unshift(...l.problems);
  const stale = await staleness(l);
  if (stale) result.errors.unshift(stale);
  writeOutputs(outDir, result);

  const selected = result.components.filter((c) => c.selected).map((c) => c.id);
  console.log(`impact: mode=${result.mode} base=${result.base ?? '-'} (${resolution.source})`);
  for (const r of result.reasons) console.log(`  run-all reason: ${r}`);
  console.log(`  changed files: ${result.changedFiles.length}`);
  console.log(`  components: ${selected.join(', ') || '(none — repo-wide jobs only)'}`);
  console.log(
    `  jobs selected: ${result.jobs.filter((j) => j.selected).length}/${result.jobs.length}`,
  );
  console.log(`  report: ${join(outDir, 'impact.md')}`);
  for (const n of result.notices ?? []) console.log(`NOTICE: ${n}`);
  for (const e of result.errors) console.error(`ERROR: ${e}`);
  return result.errors.length > 0 && !values['no-fail'] ? 1 : 0;
}

async function cmdGenerate(root: string, values: Record<string, unknown>): Promise<number> {
  const l = await load(root);
  if (l.problems.length > 0) {
    for (const p of l.problems) console.error(`ERROR: ${p}`);
    return 1;
  }
  if (values.check) {
    const stale = await staleness(l);
    if (stale) {
      console.error(`ERROR: ${stale}`);
      return 1;
    }
    console.log(`${GENERATED_FILE} is up to date`);
    return 0;
  }
  const file = join(root, GENERATED_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await renderGenerated(l));
  console.log(`wrote ${GENERATED_FILE}`);
  return 0;
}

async function cmdValidate(root: string): Promise<number> {
  const l = await load(root);
  for (const p of l.problems) console.error(`ERROR: ${p}`);
  if (l.problems.length === 0) {
    console.log(
      `components.yaml OK: ${l.manifest.components.length} components, schema v${l.manifest.schemaVersion}`,
    );
  }
  return l.problems.length > 0 ? 1 : 0;
}

function cmdGate(root: string, values: Record<string, unknown>): number {
  const impactFile = resolve(
    root,
    (values.impact as string | undefined) ?? 'reports/impact/impact.json',
  );
  const outDir = resolve(root, (values['out-dir'] as string | undefined) ?? 'reports/gate');
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(impactFile)) {
    const msg = `impact report ${impactFile} not found — the gate cannot verify the selection`;
    writeFileSync(join(outDir, 'gate.md'), `# Mandatory gate\n\n**Result:** FAILED\n\n- ${msg}\n`);
    console.error(`ERROR: ${msg}`);
    return 1;
  }
  const result = JSON.parse(readFileSync(impactFile, 'utf8')) as ImpactResult;
  const outcome = evaluateGate(result, passedJobsFromEnv(process.env));
  writeFileSync(join(outDir, 'gate.json'), `${JSON.stringify(outcome, null, 2)}\n`);
  writeFileSync(join(outDir, 'gate.md'), renderGateMarkdown(outcome));
  console.log(`gate: ${outcome.required.length} required, ${outcome.passed.length} passed markers`);
  for (const r of outcome.required)
    console.log(`  ${outcome.missing.includes(r) ? 'MISSING' : 'ok     '} ${r}`);
  for (const n of outcome.notices) console.log(`NOTICE: ${n}`);
  for (const m of outcome.messages) console.error(`ERROR: ${m}`);
  return outcome.ok ? 0 : 1;
}

async function cmdPlan(root: string, values: Record<string, unknown>): Promise<number> {
  const l = await load(root);
  const git = gitRunner(root);
  const base = (values.base as string | undefined) ?? 'origin/main';
  const mergeBase = git(['merge-base', base, 'HEAD']);
  const resolution =
    mergeBase.status === 0
      ? { base: mergeBase.stdout.trim(), source: `merge-base(${base}, HEAD)` }
      : { base: null, source: `cannot resolve ${base}` };
  const changes = changedFiles(git, resolution, 'HEAD');
  const result = analyze(l.manifest, l.graph, allJobs(l.manifest, []), changes, {});
  const selected = l.manifest.components.filter(
    (c) => c.package && result.components.find((d) => d.id === c.id)?.selected,
  );
  const format = (values.format as string | undefined) ?? 'filters';
  if (format === 'json')
    console.log(
      JSON.stringify({
        mode: result.mode,
        reasons: result.reasons,
        components: selected.map((c) => c.id),
      }),
    );
  else if (format === 'components') console.log(selected.map((c) => c.id).join('\n'));
  else
    console.log(
      result.mode === 'all'
        ? '--recursive'
        : selected.map((c) => `--filter=${c.package}`).join(' '),
    );
  for (const e of result.errors) console.error(`warning: ${e}`);
  return 0;
}

async function cmdFilters(root: string, id: string | undefined): Promise<number> {
  const l = await load(root);
  const { dependencyClosure } = await import('./model.ts');
  if (!id || !l.graph.byId.has(id)) {
    console.error(`unknown component "${id ?? ''}"`);
    return 2;
  }
  const members = [...dependencyClosure(l.graph, id)].sort();
  const filters = members
    .map((m) => l.graph.byId.get(m)?.package)
    .filter((p): p is string => Boolean(p))
    .map((p) => `--filter=${p}`);
  console.log(filters.join(' '));
  return 0;
}

async function cmdSchema(root: string, values: Record<string, unknown>): Promise<number> {
  const { manifestJsonSchema } = await import('./manifest.ts');
  const text = `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`;
  if (values.write) {
    writeFileSync(join(root, 'tools/impact/components.schema.json'), text);
    console.log('wrote tools/impact/components.schema.json');
  } else process.stdout.write(text);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      'out-dir': { type: 'string' },
      impact: { type: 'string' },
      format: { type: 'string' },
      'fetch-missing': { type: 'boolean' },
      'no-fail': { type: 'boolean' },
      check: { type: 'boolean' },
      write: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  const root = values.root
    ? resolve(values.root)
    : findRoot(process.env.CI_PROJECT_DIR ?? process.cwd());
  switch (command) {
    case 'analyze':
      return cmdAnalyze(root, values);
    case 'generate':
      return cmdGenerate(root, values);
    case 'validate':
      return cmdValidate(root);
    case 'gate':
      return cmdGate(root, values);
    case 'plan':
      return cmdPlan(root, values);
    case 'schema':
      return cmdSchema(root, values);
    case 'filters':
      return cmdFilters(root, positionals[1]);
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/cli.ts')) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(1);
    },
  );
}
