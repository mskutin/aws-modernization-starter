/**
 * Suppression governance over every deployable variant.
 *
 * 1. Build all variants with acknowledgments DISABLED and require a 1:1 match between raw
 *    cdk-nag findings and the recorded acknowledgments, on the EXACT resource (no acknowledgment
 *    on a construct subtree): no unacknowledged findings, no stale acknowledgments.
 * 2. Every acknowledgment is governed by an active suppression-register entry that lists the
 *    variant's environment, and every register entry is used (no stale entries, no unused
 *    IAM action allowances).
 * 3. Synthesize the same variants with acknowledgments enabled: synth passes (AwsSolutions plus the
 *    synth-time suppression audit) and the template audit that CI runs (`check-exceptions
 *    --templates --audit-scope all`) reports no issue.
 */
import {
  DEFAULT_EXCEPTIONS_FILE,
  IAM5_WILDCARD_RESOURCE,
  auditSuppressions,
  loadExceptionsFile,
  wildcardResourceActions,
  type AuditTemplate,
  type Environment,
} from '@starter/policies';
import type { App } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, expect, it } from 'vitest';
import { devSandboxFoundation } from '../environments/dev.js';
import {
  ENVIRONMENT_NAMES,
  RAW_ENVIRONMENT_CONFIGS,
  loadEnvironmentConfig,
  parseEnvironmentConfig,
  type EnvironmentConfig,
} from '../environments/index.js';
import {
  applyPolicyChecks,
  recordedAcknowledgments,
  setAcknowledgmentsEnabled,
  suppressionRegister,
} from '../lib/policy-hook.js';
import { WorkloadStage, STAGE_IDS } from '../stages/workload-stage.js';
import {
  IntegrationWorkflowStack,
  integrationRequiredTags,
} from '../stacks/integration-workflow-stack.js';
import { FIXTURE_ENTRIES, TEST_DIGEST, TEST_ORIGIN_VERIFY_SECRET, newApp } from './helpers.js';
import { useSandboxAdoptedRegisters } from './policy-registers.js';

// The shipped register carries only reference-design entries (never the sandbox); the Sandbox
// variant needs the sandbox example register, adopted here in memory (test-only).
useSandboxAdoptedRegisters();

/** A dev sandbox without a custom domain (valid config: webDomainName is optional there). */
function sandboxWithoutDomain(): EnvironmentConfig {
  const {
    webDomainName: _w,
    cloudFrontCertificateArn: _c,
    hostedZone: _h,
    ...edge
  } = devSandboxFoundation.edge;
  return parseEnvironmentConfig('dev', {
    ...structuredClone(RAW_ENVIRONMENT_CONFIGS.dev),
    foundation: { ...structuredClone(devSandboxFoundation), edge },
  });
}

/** Every deployable variant, keyed by its root construct id → environment. */
const VARIANT_ENVIRONMENTS: Readonly<Record<string, Environment>> = {
  Dev: 'dev',
  Staging: 'staging',
  Prod: 'prod',
  DevSandbox: 'dev',
  DevSandboxNoDomain: 'dev',
  Integration: 'dev', // the mini-stack carries Environment=dev (integrationRequiredTags)
  Sandbox: 'sandbox', // live validation (not governed): the adopted sandbox example (SUP-04NN)
};

function buildVariants(app: App): void {
  for (const name of ENVIRONMENT_NAMES) {
    new WorkloadStage(app, STAGE_IDS[name], {
      config: loadEnvironmentConfig(name),
      imageDigest: TEST_DIGEST,
      handlerEntries: FIXTURE_ENTRIES,
    });
  }
  new WorkloadStage(app, 'DevSandbox', {
    config: loadEnvironmentConfig('dev', { foundationMode: 'sandbox' }),
    imageDigest: TEST_DIGEST,
    handlerEntries: FIXTURE_ENTRIES,
  });
  new WorkloadStage(app, 'DevSandboxNoDomain', {
    config: sandboxWithoutDomain(),
    imageDigest: TEST_DIGEST,
    handlerEntries: FIXTURE_ENTRIES,
  });
  new WorkloadStage(app, 'Sandbox', {
    config: loadEnvironmentConfig('sandbox'),
    imageDigest: TEST_DIGEST,
    handlerEntries: FIXTURE_ENTRIES,
    originVerifySecret: TEST_ORIGIN_VERIFY_SECRET,
  });

  new IntegrationWorkflowStack(app, 'Integration', {
    env: { region: 'ap-southeast-1' },
    runId: 'unit-test',
    expiresAt: '2030-01-01T00:00:00.000Z',
    handlerEntries: FIXTURE_ENTRIES,
    requiredTags: integrationRequiredTags(),
  });
}

/**
 * Sandbox-only fallbacks that need a stage named `Sandbox` (the register keys sandbox entries on
 * the stage name), so they live in a second app: master-secret rotation switched off (SUP-0428).
 */
function buildSandboxFallbacks(app: App): void {
  new WorkloadStage(app, 'Sandbox', {
    config: loadEnvironmentConfig('sandbox', { masterSecretRotation: false }),
    imageDigest: TEST_DIGEST,
    handlerEntries: FIXTURE_ENTRIES,
    originVerifySecret: TEST_ORIGIN_VERIFY_SECRET,
  });
}

const variantOf = (path: string): string => path.split('/')[0] ?? '';
const isFindingAck = (id: string) =>
  !id.startsWith('Annotation::') && !id.startsWith('CloudFormation-Validate::');

describe('cdk-nag acknowledgments', () => {
  setAcknowledgmentsEnabled(false);
  const app = newApp();
  buildVariants(app);
  const fallbacks = newApp();
  buildSandboxFallbacks(fallbacks);
  setAcknowledgmentsEnabled(true);
  const acks = [...recordedAcknowledgments()];

  const findings = [app, fallbacks].flatMap((a) =>
    new AwsSolutionsChecks(a)
      .validateScope(a)
      .violations.flatMap((v) =>
        v.violatingResources.map((r) => ({ rule: v.ruleName, path: r.constructPath ?? '' })),
      ),
  );
  const findingAcks = acks.filter((a) => isFindingAck(a.id));

  it('builds every variant', () => {
    const variants = new Set(acks.map((a) => variantOf(a.path)));
    expect([...variants].sort()).toEqual(Object.keys(VARIANT_ENVIRONMENTS).sort());
  });

  it('every raw finding is acknowledged on exactly its resource', () => {
    const unacknowledged = findings.filter(
      (f) => !findingAcks.some((a) => a.id === f.rule && a.path === f.path),
    );
    expect(unacknowledged).toEqual([]);
  });

  it('every acknowledgment matches a raw finding on the same resource (no stale suppressions)', () => {
    const stale = findingAcks.filter(
      (a) => !findings.some((f) => f.rule === a.id && f.path === a.path),
    );
    expect(stale).toEqual([]);
  });

  it('every acknowledgment is governed by an active register entry that lists the environment', () => {
    const register = suppressionRegister();
    expect(register.issues.filter((i) => i.level === 'error')).toEqual([]);
    const problems = acks.flatMap((a) => {
      const entry = register.active.find((e) => e.id === a.suppressionId);
      const env = VARIANT_ENVIRONMENTS[variantOf(a.path)];
      if (!entry) return [`${a.path} ${a.id}: no active entry ${a.suppressionId}`];
      if (entry.ruleId !== a.id) return [`${a.path}: ${a.suppressionId} is for ${entry.ruleId}`];
      if (!env || !entry.environments.includes(env)) {
        return [`${a.path}: ${a.suppressionId} does not list ${env ?? '<unknown env>'}`];
      }
      if (!a.reason.startsWith(`[${entry.id}] `)) {
        return [`${a.path}: reason does not cite ${entry.id}`];
      }
      return [];
    });
    expect(problems).toEqual([]);
  });

  it('every register entry is used by at least one variant (no stale register entries)', () => {
    const used = new Set(acks.map((a) => a.suppressionId));
    const unused = suppressionRegister()
      .suppressions.filter((e) => !used.has(e.id))
      .map((e) => `${e.id} ${e.ruleId} (${e.construct})`);
    expect(unused).toEqual([]);
  });

  it('acknowledgments are specific: never on a Stage/Stack root, always with a register reason', () => {
    for (const a of acks) {
      expect(a.path.split('/').length).toBeGreaterThan(2);
      expect(a.reason).toMatch(/^\[SUP-\d{4}\] .{40,}/);
    }
  });
});

describe('synthesized templates (acknowledgments applied)', () => {
  // Path metadata (`aws:cdk:path`), as the CDK CLI writes it: the template audit scopes by it.
  const app = newApp({ context: { 'aws:cdk:enable-path-metadata': true } });
  buildVariants(app);
  const fallbacks = newApp({ context: { 'aws:cdk:enable-path-metadata': true } });
  buildSandboxFallbacks(fallbacks);
  // AwsSolutions + synth-time suppression audit; synth throws on any unacknowledged finding or
  // governance violation.
  const templates: AuditTemplate[] = [app, fallbacks].flatMap((a, i) => {
    applyPolicyChecks(a);
    return a.synth().stacksRecursively.map((s) => ({
      file: `${i === 0 ? '' : 'fallbacks/'}${s.templateFile}`,
      template: s.template as AuditTemplate['template'],
    }));
  });
  const register = suppressionRegister();
  const result = auditSuppressions(templates, {
    scope: 'all',
    exceptions: loadExceptionsFile(DEFAULT_EXCEPTIONS_FILE).active,
    suppressions: register.active,
  });

  it('the CI template audit (scope all) finds every suppression governed and in scope', () => {
    expect(result.issues).toEqual([]);
    expect(result.inventory.filter((i) => i.governedBy === 'ungoverned')).toEqual([]);
    expect(result.inventory.length).toBeGreaterThan(0);
  });

  it('each rule suppression sits on exactly one resource (no replication to child resources)', () => {
    const ruleSuppressions = result.inventory.filter((i) => isFindingAck(i.ruleId));
    // Per template file: the fallback app repeats the Sandbox stage's paths.
    const keys = ruleSuppressions.map((i) => `${i.file}|${i.cdkPath}|${i.ruleId}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of ruleSuppressions) expect(s.cdkPath).toMatch(/\/Resource$/);
  });

  it('every IAM5[Resource::*] allowance is needed (no unused actions in allowedActions)', () => {
    const iam5 = register.active.filter((e) => e.ruleId === IAM5_WILDCARD_RESOURCE);
    const usedBy = new Map<string, Set<string>>();
    for (const { template } of templates) {
      for (const resource of Object.values(template.Resources ?? {})) {
        const meta = resource.Metadata?.['cdk_nag'] as
          { rules_to_suppress?: { id?: string; reason?: string }[] } | undefined;
        for (const s of meta?.rules_to_suppress ?? []) {
          const id = /^\[(SUP-\d{4})\]/.exec(s.reason ?? '')?.[1];
          if (s.id !== IAM5_WILDCARD_RESOURCE || !id) continue;
          const set = usedBy.get(id) ?? new Set<string>();
          for (const action of wildcardResourceActions(resource)) set.add(action);
          usedBy.set(id, set);
        }
      }
    }
    const unused = iam5.flatMap((e) =>
      (e.allowedActions ?? []).filter((a) => !usedBy.get(e.id)?.has(a)).map((a) => `${e.id} ${a}`),
    );
    expect(unused).toEqual([]);
  });
});
