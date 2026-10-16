import { format } from 'prettier';
import { stringify } from 'yaml';
import type { Component, Manifest } from './manifest.ts';
import { type ComponentGraph, triggerPatterns } from './model.ts';
import {
  CONTAINER_STEPS,
  GATE_JOB,
  IMPACT_JOB,
  type JobSpec,
  RESCAN_STEPS,
  hasTestJob,
  isContainer,
} from './jobs.ts';

/**
 * Generates `.gitlab/ci/generated/components.yml`.
 *
 * Design (see docs/adr/0401-ci-impact-analysis.md): GitLab evaluates `rules`
 * when the pipeline is created, so a runtime job cannot prune jobs. We
 * therefore pre-compute, for every component, the `rules:changes` paths that
 * include its transitive workspace dependencies + global paths, and check the
 * file in. The `impact` job fails when this file is stale, and the
 * `gates:mandatory` job cross-checks the runtime analysis against the jobs that
 * actually ran.
 */

/** GitLab's documented limit for rules:changes entries. */
export const MAX_CHANGES_PATHS = 50;

export const RUN_ALL_IF =
  '$IMPACT_RUN_ALL == "true" || $CI_COMMIT_TAG || ($CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE != "merge_request_event") || $CI_PIPELINE_SOURCE =~ /^(schedule|web|api|trigger|pipeline|parent_pipeline)$/';

type Rule = Record<string, unknown>;

/** Scheduled task names (ADR 0412). Every other value, including the empty default, is a full pipeline. */
export const SCHEDULE_TASKS = ['rescan', 'stale', 'drift', 'sweep'] as const;
/**
 * The task guard used by every job rule and by workflow:rules. A bare `$SCHEDULE_TASK` is not used:
 * workflow:rules treated the empty YAML default as set, job rules
 * did not, and an unknown value would have produced a near-empty pipeline.
 */
export const SCHEDULE_TASK_IF = `$SCHEDULE_TASK =~ /^(${SCHEDULE_TASKS.join('|')})$/`;

export function impactRules(patterns: string[]): Rule[] {
  if (patterns.length > MAX_CHANGES_PATHS) {
    throw new Error(
      `rules:changes would need ${patterns.length} patterns (GitLab limit ${MAX_CHANGES_PATHS}); ` +
        'consolidate paths in components.yaml (e.g. brace patterns like "{a,b}/**/*")',
    );
  }
  return [
    // Task-only scheduled pipelines (rescan, stale, drift, sweep) run nothing else.
    { if: SCHEDULE_TASK_IF, when: 'never' },
    { if: RUN_ALL_IF },
    { changes: { paths: patterns } },
  ];
}

function pkgFilter(c: Component): string {
  return c.package as string;
}

function substitute(command: string, c: Component): string {
  return command.replaceAll('{package}', pkgFilter(c)).replaceAll('{path}', c.path ?? '');
}

const VITEST_CI_FLAGS = [
  '--reporter=default',
  '--reporter=junit',
  '--outputFile.junit="$CI_PROJECT_DIR/reports/junit/$COMPONENT_ID.xml"',
  '--coverage.enabled=true',
  '--coverage.reporter=cobertura',
  '--coverage.reporter=text-summary',
  '--coverage.reportsDirectory="$CI_PROJECT_DIR/reports/coverage/$COMPONENT_ID"',
].join(' ');

export function testJobScript(c: Component): string[] {
  const pkg = pkgFilter(c);
  const script = [
    ...c.ci.setup.map((s) => substitute(s, c)),
    `pnpm --filter "${pkg}^..." run --if-present build`,
  ];
  script.push(
    c.build.command
      ? substitute(c.build.command, c)
      : `pnpm --filter "${pkg}" run --if-present build`,
  );
  if (c.test.typecheck) script.push(`pnpm --filter "${pkg}" run typecheck`);
  if (c.test.unit) {
    const unit = substitute(c.test.unit, c);
    script.push(c.test.unitRunner === 'vitest' ? `${unit} ${VITEST_CI_FLAGS}` : unit);
  } else {
    script.push(
      `echo "No unit tests declared for ${c.id} in components.yaml (test.unit: null) — build and typecheck only."`,
    );
  }
  return script;
}

function testJob(c: Component): Record<string, unknown> {
  const job: Record<string, unknown> = {
    extends: ['.component-test', `.impact:${c.id}`],
    variables: {
      COMPONENT_ID: c.id,
      COMPONENT_PACKAGE: c.package,
      COMPONENT_PATH: c.path,
      ...c.ci.variables,
    },
    script: testJobScript(c),
  };
  const location = c.build.artifact.location;
  if (location) job.artifacts = { paths: ['reports/', location] };
  return job;
}

export const RELEASE_REF_ONLY: Rule = {
  if: '$CI_COMMIT_TAG == null && $CI_COMMIT_BRANCH != $CI_DEFAULT_BRANCH',
  when: 'never',
};

/** Protected refs only (the default branch is protected; a Developer can create unprotected tags). */
export const PROTECTED_REF_ONLY: Rule = { if: '$CI_COMMIT_REF_PROTECTED != "true"', when: 'never' };

/**
 * Project opt-out of the image build chain (STARTER_CONTAINER_BUILD=false, ADR 0402): for runners
 * whose engine cannot run rootless Buildah. Only the exact value "false" disables (fail safe).
 */
export const CONTAINER_BUILD_OPT_OUT_IF = '$STARTER_CONTAINER_BUILD == "false"';
export const CONTAINER_BUILD_OPT_OUT: Rule = { if: CONTAINER_BUILD_OPT_OUT_IF, when: 'never' };

/** Publish needs the project's container registry (predefined; absent when it is disabled). */
export const REGISTRY_REQUIRED: Rule = {
  if: '$CI_REGISTRY_IMAGE == null || $CI_REGISTRY_IMAGE == ""',
  when: 'never',
};

/** Sign, verify and the chain report are opt-in (ADR 0411): STARTER_RELEASE_SIGNING=true. */
export const SIGNING_REQUIRED: Rule = { if: '$STARTER_RELEASE_SIGNING != "true"', when: 'never' };

/** Scheduled rescan of the latest published, signed image (SCHEDULE_TASK=rescan, protected ref). */
export const RESCAN_RULES: Rule[] = [
  { if: '$CI_COMMIT_REF_PROTECTED == "true" && $SCHEDULE_TASK == "rescan"' },
];

/** Optional need on the Maintainer-only gate-integrity child pipeline (ADR 0410). */
export const GATE_INTEGRITY_NEED = { job: 'policy:gate-integrity', optional: true } as const;

const VITEST_JUNIT_FLAGS = [
  '--reporter=default',
  '--reporter=junit',
  '--outputFile.junit="$CI_PROJECT_DIR/reports/junit/integration-$COMPONENT_ID.xml"',
].join(' ');

function integrationJob(c: Component): Record<string, unknown> {
  const pkg = pkgFilter(c);
  const command = substitute(c.test.integration as string, c);
  return {
    extends: ['.integration-test', `.impact:${c.id}`],
    needs: [
      { job: IMPACT_JOB, artifacts: false },
      { job: GATE_JOB, artifacts: false },
    ],
    variables: {
      COMPONENT_ID: c.id,
      COMPONENT_PACKAGE: c.package,
      COMPONENT_PATH: c.path,
      ...c.ci.variables,
    },
    script: [
      ...c.ci.setup.map((s) => substitute(s, c)),
      'sh tools/ci/scripts/wait-for-services.sh',
      `pnpm --filter "${pkg}..." run --if-present build`,
      c.test.integrationRunner === 'vitest' ? `${command} ${VITEST_JUNIT_FLAGS}` : command,
    ],
  };
}

/** Rules template of every job that needs the image build: impact rules + the opt-out. */
export function imageTemplate(c: Component): string {
  return `.impact-image:${c.id}`;
}

function containerJobs(
  c: Component,
  graph: ComponentGraph,
  manifest: Manifest,
): Record<string, unknown> {
  const a = c.build.artifact;
  const vars = {
    COMPONENT_ID: c.id,
    DOCKERFILE: a.dockerfile,
    BUILD_CONTEXT: a.context,
    IGNORE_FILE: a.ignoreFile ?? '',
    IMAGE_NAME: a.image,
  };
  const build = `container:build:${c.id}`;
  const name = (step: string): string => `container:${step}:${c.id}`;
  const impact = impactRules(triggerPatterns(graph, manifest, [c.id]));
  // Protected release refs only (ADR 0110/0411): never in MR or other unprotected pipelines; never
  // after an opt-out of the image build; only with the project registry enabled.
  const publishRules = [
    PROTECTED_REF_ONLY,
    RELEASE_REF_ONLY,
    CONTAINER_BUILD_OPT_OUT,
    REGISTRY_REQUIRED,
    ...impact,
  ];
  // Signing chain: additionally opt-in.
  const signingRules = [
    PROTECTED_REF_ONLY,
    RELEASE_REF_ONLY,
    CONTAINER_BUILD_OPT_OUT,
    REGISTRY_REQUIRED,
    SIGNING_REQUIRED,
    ...impact,
  ];
  const out: Record<string, unknown> = {};
  for (const { step } of CONTAINER_STEPS) {
    const job: Record<string, unknown> = {
      // lint (hadolint) needs no engine and runs even after an opt-out of the image build.
      extends: [`.container-${step}`, step === 'lint' ? `.impact:${c.id}` : imageTemplate(c)],
      variables: vars,
    };
    if (step === 'build') {
      job.artifacts = {
        paths: [`oci-out/${c.id}/`, 'reports/chain/'],
        reports: { dotenv: `oci-out/${c.id}/image.env` },
      };
    }
    if (step === 'scan' || step === 'sbom' || step === 'provenance') {
      job.needs = [
        { job: IMPACT_JOB, artifacts: false },
        { job: build, artifacts: true },
      ];
    }
    if (step === 'publish') {
      // Only images that passed every mandatory gate are published, and only from release refs.
      job.extends = ['.container-publish'];
      job.rules = publishRules;
      job.needs = [
        { job: IMPACT_JOB, artifacts: false },
        { job: build, artifacts: true },
        { job: GATE_JOB, artifacts: false },
      ];
    }
    if (step === 'sign') {
      job.extends = ['.container-sign'];
      job.rules = signingRules;
      job.needs = [
        { job: IMPACT_JOB, artifacts: false },
        { job: build, artifacts: true },
        { job: name('provenance'), artifacts: true },
        { job: name('sbom'), artifacts: true },
        { job: name('publish'), artifacts: true },
      ];
    }
    if (step === 'verify') {
      job.extends = ['.container-verify'];
      job.rules = signingRules;
      job.needs = [
        { job: IMPACT_JOB, artifacts: false },
        { job: build, artifacts: true },
        { job: name('publish'), artifacts: true },
        { job: name('sign'), artifacts: true },
      ];
    }
    if (step === 'chain-report') {
      job.extends = ['.container-chain-report'];
      job.rules = signingRules;
      job.needs = [
        { job: IMPACT_JOB, artifacts: false },
        { job: name('verify'), artifacts: false },
      ];
    }
    out[name(step)] = job;
  }
  for (const step of RESCAN_STEPS) {
    out[name(step)] = {
      extends: [`.container-${step}`],
      rules: RESCAN_RULES,
      variables: vars,
      needs:
        step === 'rescan'
          ? [{ job: name('rescan-verify'), artifacts: true }]
          : [GATE_INTEGRITY_NEED],
    };
  }
  return out;
}

function infraJobs(
  c: Component,
  graph: ComponentGraph,
  manifest: Manifest,
): Record<string, unknown> {
  const infra = c.infra;
  if (!infra) return {};
  const out: Record<string, unknown> = {};
  const all = [c.id, ...infra.policyComponents, ...infra.finopsComponents];
  out[`.trigger:synth:${c.id}`] = { rules: impactRules(triggerPatterns(graph, manifest, all)) };
  out[`.trigger:policy:${c.id}`] = {
    rules: impactRules(triggerPatterns(graph, manifest, [c.id, ...infra.policyComponents])),
  };
  out[`.trigger:finops:${c.id}`] = {
    rules: impactRules(triggerPatterns(graph, manifest, [c.id, ...infra.finopsComponents])),
  };
  out[`synth:${c.id}`] = {
    extends: ['.synth', `.trigger:synth:${c.id}`],
    variables: { COMPONENT_ID: c.id, COMPONENT_PACKAGE: c.package, COMPONENT_PATH: c.path },
    parallel: { matrix: [{ CDK_ENV: infra.environments }] },
  };
  out[`policy:${c.id}`] = {
    extends: ['.policy-check', `.trigger:policy:${c.id}`],
    variables: { COMPONENT_ID: c.id, COMPONENT_PATH: c.path },
    needs: [
      { job: IMPACT_JOB, artifacts: false },
      { job: `synth:${c.id}`, artifacts: true },
    ],
  };
  out[`finops:${c.id}`] = {
    extends: ['.finops', `.trigger:finops:${c.id}`],
    variables: { COMPONENT_ID: c.id, COMPONENT_PATH: c.path, COMPONENT_PACKAGE: c.package },
    needs: [
      { job: IMPACT_JOB, artifacts: false },
      { job: `synth:${c.id}`, artifacts: true },
    ],
  };
  return out;
}

function gateJob(jobs: JobSpec[]): Record<string, unknown> {
  const gated = jobs
    .filter((j) => j.gated)
    .map((j) => j.name)
    .sort();
  return {
    extends: ['.gates'],
    needs: [
      { job: IMPACT_JOB, artifacts: true },
      ...gated.map((name) => ({ job: name, optional: true, artifacts: true })),
    ],
  };
}

const HEADER = `# GENERATED by @starter/tool-impact from components.yaml + the hand-written CI files.
# DO NOT EDIT. Regenerate with:  pnpm --filter @starter/tool-impact run generate
# The \`impact\` CI job fails when this file is stale.
#
# - .impact:<component>  rules: run when the component, any transitive workspace
#   dependency, or a global path changes (always on default branch/tags/schedules).
# - .impact-image:<id>   the same rules plus the STARTER_CONTAINER_BUILD=false opt-out.
# - test:<component>     build + typecheck + unit tests (JUnit + Cobertura).
# - container:*:<id>     rootless image build, scan, SBOM, provenance; on protected release refs
#                        publish (registry enabled) and, opt-in (STARTER_RELEASE_SIGNING=true), sign,
#                        verify and the release-chain report; rescan on schedule.
# - synth/policy/finops  CDK synth matrix and policy/cost checks for infra components.
# - gates:mandatory      verifies every impact-required job ran and passed.
`;

export async function generateCiYaml(
  manifest: Manifest,
  graph: ComponentGraph,
  jobs: JobSpec[],
  prettierOptions: Record<string, unknown> = {},
): Promise<string> {
  const doc: Record<string, unknown> = {};
  for (const c of manifest.components) {
    if (!c.package) continue;
    doc[`.impact:${c.id}`] = { rules: impactRules(triggerPatterns(graph, manifest, [c.id])) };
    if (isContainer(c)) {
      doc[imageTemplate(c)] = {
        rules: [CONTAINER_BUILD_OPT_OUT, ...impactRules(triggerPatterns(graph, manifest, [c.id]))],
      };
    }
  }
  for (const c of manifest.components) {
    if (hasTestJob(c)) doc[`test:${c.id}`] = testJob(c);
    if (c.package && c.test.integration) doc[`integration:${c.id}`] = integrationJob(c);
    if (isContainer(c)) Object.assign(doc, containerJobs(c, graph, manifest));
    if (c.kind === 'infra') Object.assign(doc, infraJobs(c, graph, manifest));
  }
  doc[GATE_JOB] = gateJob(jobs);
  const body = stringify(doc, {
    lineWidth: 0,
    aliasDuplicateObjects: false,
    defaultStringType: 'PLAIN',
  });
  return format(`${HEADER}\n${body}`, { ...prettierOptions, parser: 'yaml' });
}
