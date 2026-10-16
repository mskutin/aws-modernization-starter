import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RemovalPolicy, Stack, Validations, type App } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, expect, it } from 'vitest';
import { applyBaselinePolicies } from '../src/cdk/apply.js';
import { BaselineChecks, GOVERNANCE_RULE_ID } from '../src/cdk/pack.js';
import { evaluateTemplate } from '../src/catalogue.js';
import { findTemplates, resolveGuardBinary, runGuardValidate } from '../src/guard/runner.js';
import type { Environment } from '../src/types.js';
import { CompliantReferenceStack, NonCompliantStack, addStage } from './fixtures/reference-app.js';
import { newApp, tempDir } from './helpers.js';

const guard = (() => {
  try {
    return resolveGuardBinary();
  } catch {
    return undefined;
  }
})();

const ENVS: Environment[] = ['dev', 'staging', 'prod'];

function referenceApp(withBad = false): App {
  const app = newApp();
  for (const env of ENVS) {
    addStage(app, env, (stage) => {
      new CompliantReferenceStack(stage, 'Ref', { environment: env });
      if (withBad) new NonCompliantStack(stage, 'Bad', { environment: env });
    });
  }
  return app;
}

const ruleSet = (pack: BaselineChecks) =>
  [...new Set(pack.lastFindings.map((f) => `${f.constructPath.split('/')[0]} ${f.ruleId}`))].sort();

describe('L2 reference architecture', () => {
  it('a stack built with idiomatic CDK satisfies the whole baseline in dev, staging and prod', () => {
    const app = referenceApp();
    app.synth();
    const pack = new BaselineChecks(app);
    const report = pack.validateScope(app);
    expect(report.violations).toEqual([]);
    expect(report.success).toBe(true);
  });

  it('a stack built from L2 defaults is flagged per environment', () => {
    const app = referenceApp(true);
    app.synth();
    const pack = new BaselineChecks(app);
    const report = pack.validateScope(app);
    expect(report.success).toBe(false);
    expect(ruleSet(pack)).toEqual(
      [
        ...['Dev', 'Staging', 'Prod'].flatMap((s) =>
          [
            'BASE-S3-001',
            'BASE-LMB-002',
            'BASE-LMB-003',
            'BASE-LMB-004',
            'BASE-LMB-005',
            'BASE-LMB-006',
            'BASE-DDB-001',
            'BASE-DDB-002',
          ].map((r) => `${s} ${r}`),
        ),
        'Staging BASE-STATE-001',
        'Prod BASE-STATE-001',
        'Prod BASE-DDB-003',
      ].sort(),
    );
    const lmb2 = report.violations.find((v) => v.ruleName === 'BASE-LMB-002');
    expect(lmb2?.severity).toBe('warning');
    expect(lmb2?.violatingResources.map((r) => r.constructPath)).toContain(
      'Dev/Bad/LegacyFn/Resource',
    );
  });

  it.runIf(guard)('Guard agrees with the TypeScript rules on real synthesized templates', () => {
    const app = referenceApp(true);
    const assembly = app.synth();
    const templates = findTemplates(assembly.directory);
    expect(templates.length).toBe(6);
    const guardResult = runGuardValidate({ templates, baseDir: assembly.directory });
    const key = (t: string, f: { ruleId: string; logicalId: string }) =>
      `${t} ${f.logicalId} ${f.ruleId}`;
    const fromGuard = new Set(guardResult.findings.map((f) => key(f.template, f)));
    const fromTs = new Set(
      templates.flatMap((file) =>
        evaluateTemplate(JSON.parse(readFileSync(file, 'utf8')), {}, 'guard').map((f) =>
          key(file.slice(assembly.directory.length + 1), f),
        ),
      ),
    );
    expect([...fromGuard].sort()).toEqual([...fromTs].sort());
    expect([...fromGuard].some((k) => k.includes('/Ref'))).toBe(false);
    expect(fromGuard.size).toBeGreaterThan(20);
  });
});

function exceptionsFile(entries: string): string {
  const file = join(tempDir(), 'exceptions.yaml');
  writeFileSync(file, `schemaVersion: 1\nexceptions:\n${entries}`);
  return file;
}

const waiver = (
  id: string,
  ruleId: string,
  resource: string,
  env: Environment,
  expiresAt = '2026-12-31',
) => `  - id: ${id}
    ruleId: ${ruleId}
    resource: '${resource}'
    environments: [${env}]
    justification: Test waiver with a sufficiently long justification.
    owner: platform-team
    approver: security-lead
    ticket: TKT-${id}
    createdAt: '2026-09-01'
    expiresAt: '${expiresAt}'
`;

function openBucketApp(env: Environment): App {
  const app = newApp();
  addStage(app, env, (stage) => {
    const stack = new Stack(stage, 'Edge');
    new s3.Bucket(stack, 'Assets', {
      blockPublicAccess: new s3.BlockPublicAccess({ blockPublicPolicy: false }),
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  });
  return app;
}

describe('applyBaselinePolicies (CDK Validations integration + governed exceptions)', () => {
  const TODAY = '2026-10-13';

  it('fails synthesis on a blocking violation', () => {
    const app = openBucketApp('dev');
    applyBaselinePolicies(app, { exceptionsFile: false });
    expect(() => app.synth()).toThrow(/BASE-S3-001/);
  });

  it('passes synthesis for the compliant reference app and writes the validation report', () => {
    const app = referenceApp();
    applyBaselinePolicies(app, { exceptionsFile: false });
    const assembly = app.synth();
    const report = readFileSync(join(assembly.directory, 'validation-report.json'), 'utf8');
    expect(JSON.parse(report)).toMatchObject({ title: 'Validation Report' });
    expect(report).not.toContain('BASE-');
  });

  it('a matching, active exception becomes a targeted acknowledgement with an audit trail', () => {
    const app = openBucketApp('staging');
    const file = exceptionsFile(
      waiver('EXC-0001', 'BASE-S3-001', 'Staging/Edge/Assets/Resource', 'staging'),
    );
    const { applied } = applyBaselinePolicies(app, { exceptionsFile: file, today: TODAY });
    expect(applied).toEqual([
      {
        exceptionId: 'EXC-0001',
        ruleId: 'BASE-S3-001',
        constructPath: 'Staging/Edge/Assets/Resource',
        environment: 'staging',
      },
    ]);
    const assembly = app.synth();
    const [template] = findTemplates(assembly.directory);
    const resources = JSON.parse(readFileSync(template as string, 'utf8')).Resources as Record<
      string,
      { Type: string; Metadata?: Record<string, unknown> }
    >;
    const bucket = Object.values(resources).find((r) => r.Type === 'AWS::S3::Bucket');
    expect(JSON.stringify(bucket?.Metadata?.['cdk_nag'])).toContain('[EXC-0001]');
  });

  it('an exception scoped to another environment does not apply', () => {
    const app = openBucketApp('prod');
    const file = exceptionsFile(waiver('EXC-0001', 'BASE-S3-001', '**/Assets/Resource', 'staging'));
    const { applied } = applyBaselinePolicies(app, { exceptionsFile: file, today: TODAY });
    expect(applied).toEqual([]);
    expect(() => app.synth()).toThrow(/BASE-S3-001/);
  });

  it('an expired exception is not applied and fails synthesis with BASE-EXC-001', () => {
    const app = openBucketApp('staging');
    const file = exceptionsFile(
      waiver('EXC-0002', 'BASE-S3-001', 'Staging/Edge/Assets/Resource', 'staging', '2026-10-01'),
    );
    const { applied, exceptions } = applyBaselinePolicies(app, {
      exceptionsFile: file,
      today: TODAY,
    });
    expect(applied).toEqual([]);
    expect(exceptions.issues.map((i) => i.code)).toEqual(['EXPIRED']);
    expect(() => app.synth()).toThrow(
      new RegExp(
        `${GOVERNANCE_RULE_ID}[\\s\\S]*BASE-S3-001|BASE-S3-001[\\s\\S]*${GOVERNANCE_RULE_ID}`,
      ),
    );
  });

  it('a malformed exceptions file stops synthesis immediately', () => {
    const app = openBucketApp('dev');
    const file = exceptionsFile('  - id: nope\n');
    expect(() => applyBaselinePolicies(app, { exceptionsFile: file })).toThrow(/malformed/);
  });

  it('governed exceptions also acknowledge AwsSolutions findings (cdk-nag v3 Validations)', () => {
    const build = (withException: boolean) => {
      const app = openBucketApp('dev');
      const file = exceptionsFile(
        withException
          ? waiver('EXC-0003', 'AwsSolutions-S1', 'Dev/Edge/Assets/Resource', 'dev')
          : '  []\n',
      );
      applyBaselinePolicies(app, { exceptionsFile: withException ? file : false, today: TODAY });
      const aws = new AwsSolutionsChecks(app);
      return { app, aws };
    };
    const without = build(false);
    expect(() => without.app.synth()).toThrow();
    expect(without.aws.validateScope(without.app).violations.map((v) => v.ruleName)).toContain(
      'AwsSolutions-S1',
    );
    const withExc = build(true);
    expect(() => withExc.app.synth()).toThrow(/BASE-S3-001/);
    expect(withExc.aws.validateScope(withExc.app).violations.map((v) => v.ruleName)).not.toContain(
      'AwsSolutions-S1',
    );
  });

  it('register:false hands the pack to an external hook (infra applyPolicyChecks pattern)', () => {
    const unregistered = openBucketApp('dev');
    applyBaselinePolicies(unregistered, { exceptionsFile: false, register: false });
    expect(() => unregistered.synth()).not.toThrow();

    const app = openBucketApp('dev');
    const factory = (scope: App) =>
      applyBaselinePolicies(scope, { exceptionsFile: false, register: false }).pack;
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app), factory(app));
    expect(() => app.synth()).toThrow(/BASE-S3-001/);
  });

  it('a permissions boundary requirement is enforced when configured (BASE-IAM-004)', () => {
    const app = referenceApp();
    app.synth();
    const pack = new BaselineChecks(app, {
      permissionsBoundaryArn: 'arn:aws:iam::111122223333:policy/starter-workload-boundary',
    });
    const v = pack.validateScope(app).violations.find((x) => x.ruleName === 'BASE-IAM-004');
    expect(v?.violatingResources.length).toBeGreaterThan(5);
  });
});
