/**
 * The proposed baseline (`@starter/policies`) against every deployable variant the CDK apps
 * build — the three environment stages (bin/app.ts) and the integration mini-stack
 * (bin/integration.ts) — with the governed exceptions from policies/exceptions/exceptions.yaml
 * applied exactly as the policy hook does. Error-level findings fail `cdk synth`, so they must
 * be zero here; the only tolerated warning is the documented advisory BASE-LMB-004.
 *
 * Also: BASE-IAM-004 per stage against the configured boundary, no stale
 * governed exceptions, and the RDS master secret referenced by nothing but the database itself
 * and the exempted bootstrap task.
 */
import {
  DEFAULT_EXCEPTIONS_FILE,
  applyBaselinePolicies,
  globToRegExp,
  loadExceptionsFile,
  stageEnvironment,
} from '@starter/policies';
import { CfnResource, Stack, type App } from 'aws-cdk-lib';
import * as rds from 'aws-cdk-lib/aws-rds';
import { describe, expect, it } from 'vitest';
import {
  ENVIRONMENT_NAMES,
  loadEnvironmentConfig,
  type EnvironmentConfig,
} from '../environments/index.js';
import { baselinePolicyOptions, type BaselinePolicyOptions } from '../lib/policy-options.js';
import { WorkloadStage, STAGE_IDS } from '../stages/workload-stage.js';
import {
  IntegrationWorkflowStack,
  integrationRequiredTags,
} from '../stacks/integration-workflow-stack.js';
import { FIXTURE_ENTRIES, TEST_DIGEST, TEST_ORIGIN_VERIFY_SECRET, newApp } from './helpers.js';
import { useSandboxAdoptedRegisters } from './policy-registers.js';

/**
 * The shipped registers carry no sandbox entry; the opt-in Sandbox stage is evaluated with the
 * sandbox example register adopted in memory (test-only): this exceptions file plus the register.
 */
const SANDBOX_ADOPTED_EXCEPTIONS = useSandboxAdoptedRegisters();

/** Advisory findings accepted for now (see docs/policy-as-code.md). */
const ADVISORY_RULES = new Set(['BASE-LMB-004']);

type PackOptions = Partial<BaselinePolicyOptions> & {
  register: false;
  permissionsBoundaryArn?: string;
  exceptionsFile?: string | false;
};

function evaluate(
  build: (app: App) => void,
  // Same options as bin/app.ts (lib/policy-options.ts); the mini-stack app passes none.
  options: PackOptions = { register: false },
) {
  const app = newApp();
  build(app);
  // Required tags are applied by Aspects, which only run during synthesis (as in `cdk synth`).
  app.synth();
  const { pack, exceptions } = applyBaselinePolicies(app, options);
  const report = pack.validateScope(app);
  const errors = report.violations.filter((v) => v.severity === 'error');
  const warnings = report.violations.filter((v) => v.severity !== 'error');
  return { app, errors, warnings, exceptions };
}

const summarize = (
  violations: readonly {
    ruleName: string;
    violatingResources: readonly { constructPath?: string }[];
  }[],
) =>
  violations.flatMap((v) =>
    v.violatingResources.map((r) => `${v.ruleName} ${r.constructPath ?? ''}`),
  );

const stagesOf = (configs: readonly EnvironmentConfig[]) => (app: App) => {
  for (const config of configs) {
    new WorkloadStage(app, STAGE_IDS[config.name], {
      config,
      imageDigest: TEST_DIGEST,
      handlerEntries: FIXTURE_ENTRIES,
      ...(config.api.originMode === 'public-alb-http'
        ? { originVerifySecret: TEST_ORIGIN_VERIFY_SECRET }
        : {}),
    });
  }
};

const workflowStack = (app: App) =>
  new IntegrationWorkflowStack(app, 'IntegrationWorkflowStack', {
    env: { region: 'ap-southeast-1' },
    runId: 'policy-check',
    expiresAt: '2030-01-01T00:00:00.000Z',
    handlerEntries: FIXTURE_ENTRIES,
    requiredTags: integrationRequiredTags(),
  });

const allStages = () => ENVIRONMENT_NAMES.map((name) => loadEnvironmentConfig(name));
const sandboxDev = () => loadEnvironmentConfig('dev', { foundationMode: 'sandbox' });
/** The opt-in live-validation stage (not governed). */
const liveSandbox = () => loadEnvironmentConfig('sandbox');

describe('proposed baseline on the deployable apps', () => {
  it('environment stages (dev, staging, prod): no error-level findings', () => {
    const configs = allStages();
    const { errors, warnings } = evaluate(stagesOf(configs), baselinePolicyOptions(configs));
    expect(summarize(errors)).toEqual([]);
    expect(warnings.map((w) => w.ruleName).filter((r) => !ADVISORY_RULES.has(r))).toEqual([]);
  });

  it('environment stages: every baseline waiver cites a reference-design entry (no approval, no expiry)', () => {
    const configs = allStages();
    const { app, exceptions } = evaluate(stagesOf(configs), baselinePolicyOptions(configs));
    expect(exceptions.active.every((e) => e.status === 'reference')).toBe(true);
    const cited = app.node
      .findAll()
      .filter((c): c is CfnResource => CfnResource.isCfnResource(c))
      .flatMap(
        (c) =>
          (c.getMetadata('cdk_nag') as { rules_to_suppress?: { id: string; reason: string }[] })
            ?.rules_to_suppress ?? [],
      )
      .filter((s) => s.id.startsWith('BASE-'));
    expect(cited.length).toBeGreaterThan(0);
    for (const s of cited) expect(s.reason).toMatch(/^\[EXC-\d{4}\] .*reference design: no expiry/);
  });

  it('sandbox stage without an adopted sandbox register: the BASE-* findings stay open', () => {
    const configs = [liveSandbox()];
    const { errors } = evaluate(stagesOf(configs), baselinePolicyOptions(configs));
    expect(new Set(errors.map((e) => e.ruleName))).toEqual(
      new Set([
        'BASE-TAG-002',
        'BASE-ECS-009',
        'BASE-CF-004',
        'BASE-CF-005',
        'BASE-LMB-003',
        'BASE-LMB-006',
      ]),
    );
  });

  it('sandbox stage (live validation, not governed): no error-level findings, its waivers are sandbox-only', () => {
    const configs = [liveSandbox()];
    const { errors, warnings, app } = evaluate(stagesOf(configs), {
      ...baselinePolicyOptions(configs),
      exceptionsFile: SANDBOX_ADOPTED_EXCEPTIONS,
    });
    expect(summarize(errors)).toEqual([]);
    expect(warnings.map((w) => w.ruleName).filter((r) => !ADVISORY_RULES.has(r))).toEqual([]);
    // Every baseline waiver applied in the sandbox cites a sandbox-only exception (EXC-04NN).
    const cited = app.node
      .findAll()
      .filter((c): c is CfnResource => CfnResource.isCfnResource(c))
      .flatMap(
        (c) =>
          (c.getMetadata('cdk_nag') as { rules_to_suppress?: { id: string; reason: string }[] })
            ?.rules_to_suppress ?? [],
      )
      .filter((s) => s.id.startsWith('BASE-'));
    expect(cited.length).toBeGreaterThan(0);
    for (const s of cited)
      expect(s.reason).toMatch(
        /^\[EXC-04\d\d\] SANDBOX \(live validation, not a governed environment\):/,
      );
  });

  it('integration mini-stack (tags from integrationRequiredTags): no error-level findings', () => {
    const { errors, warnings } = evaluate(workflowStack);
    expect(summarize(errors)).toEqual([]);
    expect(warnings.map((w) => w.ruleName).filter((r) => !ADVISORY_RULES.has(r))).toEqual([]);
  });

  it('every reference or (adopted) sandbox exception waives a real finding (no stale exceptions)', () => {
    const configs = [...allStages(), liveSandbox()];
    const raw = evaluate(
      (app) => {
        stagesOf(configs)(app);
        workflowStack(app);
      },
      { ...baselinePolicyOptions(configs), exceptionsFile: false },
    );
    const findings = summarize(raw.errors).map((s) => {
      const [rule = '', path = ''] = s.split(' ');
      return { rule, path };
    });
    // The shipped reference exceptions plus the sandbox example register, adopted in memory.
    const stale = loadExceptionsFile(SANDBOX_ADOPTED_EXCEPTIONS)
      .active.filter(
        (exc) =>
          !findings.some(
            (f) =>
              f.rule === exc.ruleId &&
              globToRegExp(exc.resource).test(f.path) &&
              (exc.environments as readonly string[]).includes(
                f.path.split('/')[0]?.toLowerCase() ?? '',
              ),
          ),
      )
      .map((exc) => `${exc.id} ${exc.ruleId} ${exc.resource}`);
    expect(stale).toEqual([]);
  });
});

describe('BASE-IAM-004: each stage against its configured permissions boundary', () => {
  it('imported stages resolve their own boundary ARN; a boundary-less sandbox is not applicable', () => {
    const configs = [sandboxDev(), ...allStages().filter((c) => c.name !== 'dev')];
    const options = baselinePolicyOptions(configs);
    const { app, errors } = evaluate(stagesOf(configs), options);
    expect(summarize(errors)).toEqual([]);
    const roleIn = (stage: string) =>
      app.node
        .findAll()
        .find(
          (c): c is CfnResource =>
            CfnResource.isCfnResource(c) &&
            c.cfnResourceType === 'AWS::IAM::Role' &&
            c.node.path.startsWith(`${stage}/`),
        );
    expect(options.permissionsBoundaryFor(roleIn('Dev') as CfnResource)).toBeUndefined();
    for (const config of configs.filter((c) => c.name !== 'dev')) {
      expect(options.permissionsBoundaryFor(roleIn(STAGE_IDS[config.name]) as CfnResource)).toBe(
        config.foundation.permissionsBoundaryPolicyArn,
      );
    }
  });

  it('a boundary-less sandbox stage no longer disables the check for staging and prod', () => {
    const configs = [sandboxDev(), ...allStages().filter((c) => c.name !== 'dev')];
    const real = baselinePolicyOptions(configs);
    // Same resolution, but staging expects another boundary: only Staging roles may fail.
    const { errors } = evaluate(stagesOf(configs), {
      ...real,
      permissionsBoundaryFor: (node) =>
        node.node.path.startsWith('Staging/')
          ? 'arn:aws:iam::000000000000:policy/AnotherBoundary'
          : real.permissionsBoundaryFor(node),
    });
    const failing = summarize(errors.filter((e) => e.ruleName === 'BASE-IAM-004'));
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.every((f) => f.includes(' Staging/'))).toBe(true);
  });

  it('a role with a boundary other than the configured one fails', () => {
    const configs = [loadEnvironmentConfig('prod')];
    const { errors } = evaluate(stagesOf(configs), {
      register: false,
      permissionsBoundaryFor: () => 'arn:aws:iam::000000000000:policy/NotTheLandingZoneBoundary',
    });
    expect(errors.map((e) => e.ruleName)).toContain('BASE-IAM-004');
  });

  it('enforcing BASE-IAM-004 on a boundary-less sandbox stage would fail (why it is per stage)', () => {
    const { errors } = evaluate(stagesOf([sandboxDev()]), {
      register: false,
      permissionsBoundaryArn: '*',
    });
    expect(errors.map((e) => e.ruleName)).toContain('BASE-IAM-004');
  });
});

/** JSON value → true when it references one of `ids` (Ref/GetAtt) or imports one of `exports`. */
function references(
  value: unknown,
  ids: ReadonlySet<string>,
  exports: ReadonlySet<string>,
): boolean {
  if (Array.isArray(value)) return value.some((v) => references(v, ids, exports));
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  const ref = obj['Ref'];
  if (typeof ref === 'string' && ids.has(ref)) return true;
  const getAtt = obj['Fn::GetAtt'];
  if (Array.isArray(getAtt) && typeof getAtt[0] === 'string' && ids.has(getAtt[0])) return true;
  const imported = obj['Fn::ImportValue'];
  if (typeof imported === 'string' && exports.has(imported)) return true;
  return Object.values(obj).some((v) => references(v, ids, exports));
}

describe('RDS master secret', () => {
  it('is referenced only by the database itself and by tasks exempted from BASE-ECS-009', () => {
    const app = newApp({ context: { 'aws:cdk:enable-path-metadata': true } });
    stagesOf(allStages())(app);
    workflowStack(app);
    const assembly = app.synth();

    // 1. The master secret of every RDS instance: its CloudFormation resources per stack.
    const secretIds = new Map<string, Set<string>>(); // stack path → logical IDs
    const databases: string[] = [];
    for (const db of app.node.findAll().filter((c) => c instanceof rds.DatabaseInstance)) {
      databases.push(db.node.scope?.node.path ?? db.node.path);
      const secret = db.node.tryFindChild('Secret');
      for (const r of secret?.node.findAll() ?? []) {
        if (!CfnResource.isCfnResource(r)) continue;
        const stack = Stack.of(r);
        const ids = secretIds.get(stack.node.path) ?? new Set<string>();
        ids.add(stack.resolve(r.logicalId) as string);
        secretIds.set(stack.node.path, ids);
      }
    }
    expect(databases.length).toBeGreaterThan(0);

    // 2. Exports that carry it to other stacks.
    type Template = {
      Resources?: Record<string, { Metadata?: Record<string, unknown> }>;
      Outputs?: Record<string, { Value?: unknown; Export?: { Name?: unknown } }>;
    };
    const stacks = assembly.stacksRecursively.map((s) => ({
      path: s.hierarchicalId,
      template: s.template as Template,
    }));
    const exports = new Set<string>();
    for (const { path, template } of stacks) {
      const ids = secretIds.get(path) ?? new Set<string>();
      for (const output of Object.values(template.Outputs ?? {})) {
        const name = output.Export?.Name;
        if (typeof name === 'string' && references(output.Value, ids, new Set())) exports.add(name);
      }
    }

    // 3. Every resource that references it, and whether it may.
    const exemptions = loadExceptionsFile(DEFAULT_EXCEPTIONS_FILE).active.filter(
      (e) => e.ruleId === 'BASE-ECS-009',
    );
    const exemptTaskOwners = app.node
      .findAll()
      .filter(
        (c): c is CfnResource =>
          CfnResource.isCfnResource(c) && c.cfnResourceType === 'AWS::ECS::TaskDefinition',
      )
      .filter((td) =>
        exemptions.some(
          (e) =>
            globToRegExp(e.resource).test(td.node.path) &&
            (e.environments as readonly string[]).includes(stageEnvironment(td) ?? ''),
        ),
      )
      // The task's own construct (task definition, its roles and their policies).
      .map((td) => td.node.path.split('/').slice(0, -2).join('/'));
    const allowed = (p: string) =>
      [...databases, ...exemptTaskOwners].some((prefix) => p.startsWith(`${prefix}/`));

    const referencing: string[] = [];
    for (const { path, template } of stacks) {
      const ids = secretIds.get(path) ?? new Set<string>();
      for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
        if (!references(resource, ids, exports)) continue;
        const cdkPath = resource.Metadata?.['aws:cdk:path'];
        referencing.push(typeof cdkPath === 'string' ? cdkPath : `${path}/${logicalId}`);
      }
    }
    // Positive control: the scanner sees the database's own use of its secret.
    expect(referencing.some((p) => databases.some((d) => p.startsWith(`${d}/`)))).toBe(true);
    expect(referencing.filter((p) => !allowed(p))).toEqual([]);

    // Contracts rev. 2 §3.1 / §6 (decided): once the one-off DatabaseBootstrapTask exists, it is
    // the ONLY workload exempted from BASE-ECS-009 and the only one outside the database construct
    // that references the master secret — in every stage.
    const bootstrapTasks = app.node
      .findAll()
      .filter((c) => c.constructor.name === 'DatabaseBootstrapTask')
      .map((c) => c.node.path);
    if (bootstrapTasks.length > 0) {
      expect([...exemptTaskOwners].sort()).toEqual([...bootstrapTasks].sort());
      for (const owner of bootstrapTasks) {
        expect(
          referencing.some((p) => p.startsWith(`${owner}/`)),
          `${owner} uses the master secret`,
        ).toBe(true);
      }
      const outsideDatabase = referencing.filter(
        (p) => !databases.some((d) => p.startsWith(`${d}/`)),
      );
      expect(
        outsideDatabase.filter((p) => !bootstrapTasks.some((o) => p.startsWith(`${o}/`))),
      ).toEqual([]);
    }
  });
});
