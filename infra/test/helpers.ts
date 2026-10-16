import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { PolicyViolation } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { IConstruct } from 'constructs';
import { ImportedLandingZoneFoundation } from '../constructs/foundation/index.js';
import {
  loadEnvironmentConfig,
  type ConfigOverrides,
  type EnvironmentConfig,
  type EnvironmentName,
} from '../environments/index.js';
import { handlerEntries } from '../lib/lambda-entries.js';
import { INFRA_ROOT } from '../lib/paths.js';
import { WorkloadStage, STAGE_IDS } from '../stages/workload-stage.js';

/** Feature flags from cdk.json so tests synthesize exactly like `cdk synth`. */
export const CDK_CONTEXT: Record<string, unknown> = (
  JSON.parse(readFileSync(path.join(INFRA_ROOT, 'cdk.json'), 'utf8')) as {
    context: Record<string, unknown>;
  }
).context;

export const FIXTURE_ENTRIES = handlerEntries('fixtures');
export const TEST_DIGEST = `sha256:${'a'.repeat(64)}`;
/** X-Origin-Verify value for sandbox stages in tests (not a real secret). */
export const TEST_ORIGIN_VERIFY_SECRET = 'test-origin-verify-0123456789abcdef0123456789abcdef';
export const TEST_ENV = { account: '000000000000', region: 'ap-southeast-1' } as const;

/**
 * NodejsFunction bundles with `pnpm exec esbuild` (pnpm lock file detected),
 * so tests that really bundle need pnpm on PATH, as when run through
 * `pnpm --filter @starter/infra test`. Fail with an actionable message otherwise.
 */
export function requirePnpmOnPath(): void {
  const probe = spawnSync('pnpm', ['--version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      'Bundling tests need `pnpm` on PATH (NodejsFunction runs `pnpm exec esbuild`). ' +
        'Run them via `pnpm --filter @starter/infra test`.',
    );
  }
}

/**
 * New App with the project's feature flags. Lambda bundling is skipped by
 * default (fast, no package manager needed); pass `bundle: true` to run the
 * real local esbuild bundling.
 */
export function newApp(opts: { bundle?: boolean; context?: Record<string, unknown> } = {}): App {
  return new App({
    context: {
      ...CDK_CONTEXT,
      ...(opts.bundle ? {} : { 'aws:cdk:bundling-stacks': [] }),
      ...opts.context,
    },
  });
}

export function testStack(app: App = newApp(), id = 'TestStack'): Stack {
  return new Stack(app, id, { env: TEST_ENV });
}

export function devConfig(): EnvironmentConfig {
  return loadEnvironmentConfig('dev');
}

/** Imported dev foundation inside `stack` (no AWS resources, offline). */
export function importedFoundation(stack: Stack): ImportedLandingZoneFoundation {
  const cfg = devConfig().foundation;
  if (cfg.mode !== 'import') throw new Error('dev config must import the foundation');
  return new ImportedLandingZoneFoundation(stack, 'Foundation', cfg);
}

export interface SynthesizedStage {
  readonly app: App;
  readonly stage: WorkloadStage;
  readonly config: EnvironmentConfig;
  readonly templates: Record<
    'Platform' | 'Data' | 'Workflow' | 'Migrations' | 'Api' | 'Frontend' | 'Observability',
    Template
  >;
  /** Sandbox foundation and test issuer (only when the stage has them). */
  readonly foundationTemplate?: Template;
  readonly testIssuerTemplate?: Template;
}

const stageCache = new Map<string, SynthesizedStage>();

/** Builds (and caches) one environment stage with fixture handlers. */
export function synthStage(
  name: EnvironmentName,
  overrides: ConfigOverrides = {},
): SynthesizedStage {
  const key = `${name}:${JSON.stringify(overrides)}`;
  const cached = stageCache.get(key);
  if (cached) return cached;
  const app = newApp();
  const config = loadEnvironmentConfig(name, overrides);
  const stage = new WorkloadStage(app, STAGE_IDS[name], {
    config,
    imageDigest: TEST_DIGEST,
    handlerEntries: FIXTURE_ENTRIES,
    ...(config.api.originMode === 'public-alb-http'
      ? { originVerifySecret: TEST_ORIGIN_VERIFY_SECRET }
      : {}),
  });
  const result: SynthesizedStage = {
    app,
    stage,
    config,
    ...(stage.foundationStack
      ? { foundationTemplate: Template.fromStack(stage.foundationStack) }
      : {}),
    ...(stage.testIssuer ? { testIssuerTemplate: Template.fromStack(stage.testIssuer) } : {}),
    templates: {
      Platform: Template.fromStack(stage.platform),
      Data: Template.fromStack(stage.data),
      Workflow: Template.fromStack(stage.workflow),
      Migrations: Template.fromStack(stage.migrations),
      Api: Template.fromStack(stage.api),
      Frontend: Template.fromStack(stage.frontend),
      Observability: Template.fromStack(stage.observability),
    },
  };
  stageCache.set(key, result);
  return result;
}

/** cdk-nag AwsSolutions findings for a construct tree (acknowledged ones excluded). */
export function nagViolations(scope: IConstruct): string[] {
  const report = new AwsSolutionsChecks(scope).validateScope(scope);
  return report.violations.flatMap((v: PolicyViolation) =>
    v.violatingResources.map(
      (r) => `${v.severity ?? 'error'} ${v.ruleName} @ ${r.constructPath ?? '?'}`,
    ),
  );
}

type Resources = Record<string, { Type: string; Properties?: Record<string, unknown> }>;

/** All resources of `type` in a template, as [logicalId, properties]. */
export function resourcesOf(template: Template, type: string): [string, Record<string, unknown>][] {
  const resources = template.toJSON().Resources as Resources;
  return Object.entries(resources)
    .filter(([, r]) => r.Type === type)
    .map(([id, r]) => [id, r.Properties ?? {}]);
}

/**
 * Parses a state machine `DefinitionString` (an Fn::Join with tokens) into
 * the ASL object, replacing intrinsic parts with a placeholder string.
 */
export function stateMachineDefinition(template: Template): {
  StartAt: string;
  TimeoutSeconds?: number;
  States: Record<string, Record<string, unknown>>;
} {
  const machines = resourcesOf(template, 'AWS::StepFunctions::StateMachine');
  if (machines.length !== 1) throw new Error(`expected 1 state machine, got ${machines.length}`);
  const def = machines[0]![1].DefinitionString as string | { 'Fn::Join': [string, unknown[]] };
  const json =
    typeof def === 'string'
      ? def
      : def['Fn::Join'][1].map((p) => (typeof p === 'string' ? p : 'TOKEN')).join('');
  return JSON.parse(json) as ReturnType<typeof stateMachineDefinition>;
}
