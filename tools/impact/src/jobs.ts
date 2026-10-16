import type { Component, Manifest } from './manifest.ts';
import type { CiJob } from './ciconfig.ts';

/**
 * Job catalogue: every job the pipeline can contain, with what triggers it and
 * whether the mandatory gate requires it. Generated jobs come from
 * components.yaml; hand-written jobs come from the CI YAML (see ciconfig.ts).
 */

export type Trigger =
  { kind: 'always' } | { kind: 'components'; components: string[] } | { kind: 'other' };

export interface JobSpec {
  name: string;
  family: string;
  source: 'generated' | 'hand-written';
  trigger: Trigger;
  /** Required by the `gates:mandatory` job when selected. */
  gated: boolean;
  /** Parallel matrix values (synth per environment). */
  matrix?: { variable: string; values: string[] };
  component?: string;
  /** Extra condition beyond the trigger, reported verbatim (e.g. default branch only). */
  condition?: string;
  /**
   * Part of the image build chain: absent when the project opted out with
   * STARTER_CONTAINER_BUILD=false (runners that cannot run rootless Buildah).
   */
  requiresContainerBuild?: boolean;
}

export const GATE_JOB = 'gates:mandatory';
export const IMPACT_JOB = 'impact';

export function hasTestJob(c: Component): boolean {
  return Boolean(c.package);
}

export function isContainer(c: Component): boolean {
  return c.build.artifact.type === 'container-image';
}

/**
 * Container chain per image component. build..provenance run on STARTER_RELEASE_RUNNER_TAG (empty =
 * the generic runner); publish exists only on protected release refs with the registry enabled;
 * sign, verify and chain-report additionally only with STARTER_RELEASE_SIGNING=true (opt-in). The
 * release steps run after the gate, so they are not gated themselves (ADR 0110, ADR 0411). Every step
 * but lint is absent when the project opted out of image builds (STARTER_CONTAINER_BUILD=false).
 */
export const CONTAINER_STEPS = [
  { step: 'lint', gated: true },
  { step: 'build', gated: false }, // covered transitively: scan/sbom/provenance `needs` it
  { step: 'scan', gated: true },
  { step: 'sbom', gated: true },
  { step: 'provenance', gated: true },
  { step: 'publish', gated: false }, // protected release refs + registry, after the gate
  { step: 'sign', gated: false }, // + STARTER_RELEASE_SIGNING=true, signing runner
  { step: 'verify', gated: false }, // + signing; independent of sign
  { step: 'chain-report', gated: false }, // + signing: runner and fresh clone of every chain job
] as const;

/** Schedule-only jobs per image component (SCHEDULE_TASK=rescan on a protected ref). */
export const RESCAN_STEPS = ['rescan-verify', 'rescan'] as const;

export const PUBLISH_STEP_CONDITION =
  'protected release refs only (protected default branch or tag) with the project container registry enabled';
export const SIGNING_STEP_CONDITION = `${PUBLISH_STEP_CONDITION}, and only with STARTER_RELEASE_SIGNING=true (opt-in)`;

export function generatedJobs(manifest: Manifest): JobSpec[] {
  const jobs: JobSpec[] = [];
  for (const c of manifest.components) {
    const self: Trigger = { kind: 'components', components: [c.id] };
    if (hasTestJob(c)) {
      jobs.push({
        name: `test:${c.id}`,
        family: 'test',
        source: 'generated',
        trigger: self,
        gated: true,
        component: c.id,
      });
    }
    if (isContainer(c)) {
      for (const { step, gated } of CONTAINER_STEPS) {
        const condition =
          step === 'publish'
            ? PUBLISH_STEP_CONDITION
            : ['sign', 'verify', 'chain-report'].includes(step)
              ? SIGNING_STEP_CONDITION
              : undefined;
        jobs.push({
          name: `container:${step}:${c.id}`,
          family: `container-${step}`,
          source: 'generated',
          trigger: self,
          gated,
          component: c.id,
          ...(condition ? { condition } : {}),
          ...(step === 'lint' ? {} : { requiresContainerBuild: true }),
        });
      }
      for (const step of RESCAN_STEPS) {
        jobs.push({
          name: `container:${step}:${c.id}`,
          family: `container-${step}`,
          source: 'generated',
          trigger: { kind: 'other' },
          gated: false,
          component: c.id,
          condition:
            'scheduled pipelines with SCHEDULE_TASK=rescan on a protected ref only (needs release signing)',
          requiresContainerBuild: true,
        });
      }
    }
    if (c.package && c.test.integration) {
      // Runs after the gate; required for merge via pipeline status, not by the gate itself.
      jobs.push({
        name: `integration:${c.id}`,
        family: 'integration',
        source: 'generated',
        trigger: self,
        gated: false,
        component: c.id,
      });
    }
    if (c.kind === 'infra' && c.infra) {
      // synth must exist whenever policy/finops (which `need` it) exist.
      jobs.push({
        name: `synth:${c.id}`,
        family: 'synth',
        source: 'generated',
        trigger: {
          kind: 'components',
          components: [
            ...new Set([c.id, ...c.infra.policyComponents, ...c.infra.finopsComponents]),
          ],
        },
        gated: true,
        matrix: { variable: 'CDK_ENV', values: c.infra.environments },
        component: c.id,
      });
      jobs.push({
        name: `policy:${c.id}`,
        family: 'policy',
        source: 'generated',
        trigger: { kind: 'components', components: [c.id, ...c.infra.policyComponents] },
        gated: true,
        component: c.id,
      });
      jobs.push({
        name: `finops:${c.id}`,
        family: 'finops',
        source: 'generated',
        trigger: { kind: 'components', components: [c.id, ...c.infra.finopsComponents] },
        gated: true,
        component: c.id,
      });
    }
  }
  return jobs;
}

export function handWrittenJobs(ciJobs: CiJob[]): JobSpec[] {
  return ciJobs.map((job) => ({
    name: job.name,
    family: job.name.split(':')[0] ?? job.name,
    source: 'hand-written' as const,
    trigger:
      job.trigger.kind === 'component'
        ? { kind: 'components' as const, components: job.trigger.components }
        : job.trigger,
    gated: job.gated,
    ...(job.requiresContainerBuild ? { requiresContainerBuild: true } : {}),
  }));
}

export function allJobs(manifest: Manifest, ciJobs: CiJob[]): JobSpec[] {
  const generated = generatedJobs(manifest);
  const names = new Set(generated.map((j) => j.name));
  const hand = handWrittenJobs(ciJobs).filter((j) => {
    if (names.has(j.name)) throw new Error(`job "${j.name}" is both generated and hand-written`);
    return j.name !== GATE_JOB;
  });
  return [...generated, ...hand].sort((a, b) => a.name.localeCompare(b.name));
}
