import { matchAny } from './glob.ts';
import type { Manifest } from './manifest.ts';
import { type ComponentGraph, dependencyPath, ownPatterns, reverseClosure } from './model.ts';
import type { JobSpec } from './jobs.ts';

/**
 * Pure impact analysis: (manifest, graph, change set, pipeline context) -> selection.
 *
 * Fail-safe rules — when in doubt, run MORE:
 *  - unknown change set (no/zero base SHA, git error)  -> run everything
 *  - global path changed (root config, lockfile, CI)   -> run everything
 *  - default branch, tags, schedules, web/API runs     -> run everything
 *  - unmapped path                                     -> error (pipeline fails loudly)
 */

export type ChangeSet =
  | { kind: 'diff'; base: string; head: string; files: string[] }
  | { kind: 'unknown'; reason: string };

export interface PipelineContext {
  source?: string | undefined; // CI_PIPELINE_SOURCE
  branch?: string | undefined; // CI_COMMIT_BRANCH
  defaultBranch?: string | undefined; // CI_DEFAULT_BRANCH
  tag?: string | undefined; // CI_COMMIT_TAG
  forceAll?: boolean | undefined; // IMPACT_RUN_ALL=true
  /**
   * STARTER_CONTAINER_BUILD: only the exact value "false" opts out of the image build chain;
   * anything else (unset, typo) keeps it (fail safe: run more, never fewer).
   */
  containerBuild?: boolean | undefined;
}

/** Shown in the impact report and by the gate whenever the project opted out of image builds. */
export const CONTAINER_BUILD_OPT_OUT_NOTICE =
  'STARTER_CONTAINER_BUILD=false: the project opted out of the image build chain — no container image is built, scanned (Trivy), described (SBOM, provenance), published or signed in this pipeline. container:lint still runs. Coverage is reduced on purpose; remove the variable once the runner can run rootless Buildah (docs/ci-cd.md).';

export type FileCategory = 'component' | 'global' | 'non-component' | 'unmapped';

export interface FileMatch {
  file: string;
  category: FileCategory;
  components: string[];
  pattern?: string;
}

export interface ComponentDecision {
  id: string;
  kind: string;
  selected: boolean;
  reasons: string[];
}

export interface JobDecision {
  name: string;
  family: string;
  source: JobSpec['source'];
  gated: boolean;
  selected: boolean;
  reason: string;
  matrix?: JobSpec['matrix'];
}

export interface ImpactResult {
  schemaVersion: 1;
  mode: 'all' | 'selective';
  reasons: string[];
  base: string | null;
  head: string | null;
  changedFiles: string[];
  files: FileMatch[];
  unmapped: string[];
  components: ComponentDecision[];
  jobs: JobDecision[];
  errors: string[];
  /** Deliberate, documented coverage reductions (project opt-outs). Never empty when one applies. */
  notices?: string[];
}

const RUN_ALL_SOURCES = new Set([
  'schedule',
  'web',
  'api',
  'trigger',
  'pipeline',
  'parent_pipeline',
]);

export function runAllReasons(context: PipelineContext): string[] {
  const reasons: string[] = [];
  if (context.forceAll) reasons.push('IMPACT_RUN_ALL=true was requested');
  if (context.tag) reasons.push(`tag pipeline (${context.tag})`);
  if (
    context.branch &&
    context.defaultBranch &&
    context.branch === context.defaultBranch &&
    context.source !== 'merge_request_event'
  ) {
    reasons.push(`default-branch pipeline (${context.branch})`);
  }
  if (context.source && RUN_ALL_SOURCES.has(context.source)) {
    reasons.push(`pipeline source "${context.source}" has no reliable diff`);
  }
  return reasons;
}

export function classifyFile(manifest: Manifest, file: string): FileMatch {
  const globalHit = matchAny(manifest.global, file);
  if (globalHit) return { file, category: 'global', components: [], pattern: globalHit };
  const components: string[] = [];
  let firstPattern: string | undefined;
  for (const c of manifest.components) {
    const hit = matchAny(ownPatterns(c), file);
    if (hit) {
      components.push(c.id);
      firstPattern ??= hit;
    }
  }
  if (components.length > 0) {
    return {
      file,
      category: 'component',
      components,
      ...(firstPattern ? { pattern: firstPattern } : {}),
    };
  }
  const nonComponent = matchAny(manifest.nonComponent, file);
  if (nonComponent)
    return { file, category: 'non-component', components: [], pattern: nonComponent };
  return { file, category: 'unmapped', components: [] };
}

export function analyze(
  manifest: Manifest,
  graph: ComponentGraph,
  jobs: JobSpec[],
  changes: ChangeSet,
  context: PipelineContext,
): ImpactResult {
  const reasons = runAllReasons(context);
  const errors: string[] = [];
  const changedFiles = changes.kind === 'diff' ? [...new Set(changes.files)].sort() : [];
  const files = changedFiles.map((f) => classifyFile(manifest, f));
  const unmapped = files.filter((f) => f.category === 'unmapped').map((f) => f.file);

  if (changes.kind === 'unknown')
    reasons.push(`change set unknown: ${changes.reason} — failing safe`);
  for (const f of files.filter((x) => x.category === 'global')) {
    reasons.push(`global path changed: ${f.file} (matches ${f.pattern})`);
  }
  if (unmapped.length > 0) {
    errors.push(
      `${unmapped.length} changed path(s) are not mapped to any component, global or non-component pattern in components.yaml: ` +
        `${unmapped.join(', ')}. Map them (components[].extraPaths, global or nonComponent) — CI refuses to guess.`,
    );
  }

  const mode: ImpactResult['mode'] = reasons.length > 0 ? 'all' : 'selective';

  // Component selection (reverse dependency closure of directly changed components).
  const direct = new Map<string, string[]>();
  for (const f of files) {
    for (const id of f.components) direct.set(id, [...(direct.get(id) ?? []), f.file]);
  }
  const affected = reverseClosure(graph, direct.keys());
  const components: ComponentDecision[] = manifest.components.map((c) => {
    const why: string[] = [];
    if (mode === 'all') why.push('run-all mode');
    const own = direct.get(c.id);
    if (own)
      why.push(
        `changed: ${own.slice(0, 5).join(', ')}${own.length > 5 ? ` (+${own.length - 5} more)` : ''}`,
      );
    if (!own && affected.has(c.id)) {
      const roots = [...direct.keys()].filter((d) => reverseClosure(graph, [d]).has(c.id)).sort();
      for (const r of roots.slice(0, 3))
        why.push(`depends on ${r}: ${dependencyPath(graph, c.id, r).join(' -> ')}`);
    }
    return { id: c.id, kind: c.kind, selected: mode === 'all' || affected.has(c.id), reasons: why };
  });
  const selectedIds = new Set(components.filter((c) => c.selected).map((c) => c.id));

  const optOut = context.containerBuild === false;
  const jobDecisions: JobDecision[] = jobs.map((job) => {
    let selected: boolean;
    let reason: string;
    if (optOut && job.requiresContainerBuild) {
      selected = false;
      reason = 'opted out: STARTER_CONTAINER_BUILD=false (no image build in this project)';
    } else if (job.trigger.kind === 'always') {
      selected = true;
      reason = 'always runs';
    } else if (job.trigger.kind === 'other') {
      selected = false;
      reason = 'not impact-managed (own rules: schedules, credentials, manual)';
    } else {
      const hits = job.trigger.components.filter((id) => selectedIds.has(id));
      selected = hits.length > 0;
      reason = selected
        ? `component(s) affected: ${hits.join(', ')}`
        : 'no triggering component affected';
      if (selected && job.condition) reason += ` (${job.condition})`;
    }
    return {
      name: job.name,
      family: job.family,
      source: job.source,
      gated: job.gated,
      selected,
      reason,
      ...(job.matrix ? { matrix: job.matrix } : {}),
    };
  });

  return {
    schemaVersion: 1,
    mode,
    reasons,
    base: changes.kind === 'diff' ? changes.base : null,
    head: changes.kind === 'diff' ? changes.head : null,
    changedFiles,
    files,
    unmapped,
    components,
    jobs: jobDecisions,
    errors,
    notices: optOut ? [CONTAINER_BUILD_OPT_OUT_NOTICE] : [],
  };
}

/** Jobs the mandatory gate must see as passed. */
export function requiredGateJobs(result: ImpactResult): string[] {
  return result.jobs.filter((j) => j.gated && j.selected).map((j) => j.name);
}
