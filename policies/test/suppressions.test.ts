import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { App, CfnResource, Stack, Stage, Validations } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditSuppressions,
  unusedSuppressions,
  type AuditTemplate,
} from '../src/exceptions/audit.js';
import { todayUtc, type PolicyException } from '../src/exceptions/exceptions.js';
import {
  IAM5_WILDCARD_RESOURCE,
  MAX_SUPPRESSION_REVIEW_DAYS,
  cdkPathInScope,
  checkSuppressions,
  loadSuppressionsFile,
  suppressionKind,
  type DatedSuppressionEntry,
  type SuppressionEntry,
} from '../src/exceptions/suppressions.js';
import {
  SuppressionAuditPlugin,
  UngovernedSuppressionError,
  auditConstructTree,
  resolveSuppression,
} from '../src/cdk/suppressions.js';
import { DEFAULT_SUPPRESSIONS_PATH } from '../src/guard/layout.js';
import { EXIT, main } from '../src/cli/main.js';
import { RESOURCE_WILDCARD_ALLOWED_ACTIONS } from '../src/rules/iam.js';
import { tempDir } from './helpers.js';

const TODAY = '2026-10-13';

const entry = (overrides: Partial<DatedSuppressionEntry> = {}): DatedSuppressionEntry => ({
  id: 'SUP-0100',
  ruleId: 'AwsSolutions-SNS3',
  construct: 'Topics',
  resources: ['A/Resource'],
  environments: ['dev', 'staging', 'prod'],
  justification: 'Test fixture: the topic only receives messages from in-account AWS services.',
  owner: 'security-team',
  createdAt: '2026-10-01',
  reviewedAt: '2026-10-01',
  reviewBy: '2027-03-01',
  ...overrides,
});

const check = (...entries: unknown[]) =>
  checkSuppressions({ schemaVersion: 1, suppressions: entries }, { today: TODAY });
const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

describe('suppression register: schema and governance', () => {
  it('the repository register is valid today; every entry is narrow, owned and dated', () => {
    const r = loadSuppressionsFile(DEFAULT_SUPPRESSIONS_PATH);
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(r.suppressions.length).toBeGreaterThan(0);
    expect(r.active).toHaveLength(r.suppressions.length);
    for (const e of r.suppressions) {
      expect(e.ruleId.startsWith('BASE-')).toBe(false);
      expect(e.owner.length).toBeGreaterThan(3);
      for (const res of e.resources) expect(res).not.toContain('**');
      if (e.ruleId === IAM5_WILDCARD_RESOURCE) {
        expect(e.allowedActions?.length).toBeGreaterThan(0);
      }
    }
  });

  it('accepts a valid entry and warns when its review is due soon', () => {
    expect(check(entry()).ok).toBe(true);
    const soon = check(entry({ reviewBy: '2026-10-30' }));
    expect(soon.ok).toBe(true);
    expect(soon.issues).toEqual([
      expect.objectContaining({ level: 'warning', code: 'EXPIRING_SOON', exceptionId: 'SUP-0100' }),
    ]);
  });

  it('an overdue review deactivates the entry (reviewBy is inclusive)', () => {
    const due = entry({
      createdAt: '2026-06-01',
      reviewedAt: '2026-06-01',
      reviewBy: '2026-10-13',
    });
    expect(check(due).active).toHaveLength(1);
    const overdue = checkSuppressions(
      { schemaVersion: 1, suppressions: [due] },
      { today: '2026-10-14' },
    );
    expect(overdue.ok).toBe(false);
    expect(overdue.active).toEqual([]);
    expect(overdue.issues[0]).toMatchObject({ code: 'EXPIRED', exceptionId: 'SUP-0100' });
    expect(overdue.issues[0]?.message).toContain('review overdue since 2026-10-13');
  });

  it('rejects malformed entries with field-level messages', () => {
    const r = check({
      ...entry(),
      id: 'S-1',
      ruleId: 'AwsSolutions-*',
      construct: 'lowercase',
      resources: ['**/Resource', '*/Resource', '/A'],
      environments: ['production'],
      justification: 'too short',
      reviewBy: '2027-13-01',
      extra: true,
    });
    expect(r.ok).toBe(false);
    expect(new Set(codes(r))).toEqual(new Set(['MALFORMED']));
    const text = r.issues.map((i) => i.message).join('\n');
    for (const field of [
      'suppressions.0.id',
      'suppressions.0.ruleId',
      'suppressions.0.construct',
      'suppressions.0.resources.0',
      'suppressions.0.resources.1',
      'suppressions.0.resources.2',
      'suppressions.0.environments.0',
      'suppressions.0.justification',
      'suppressions.0.reviewBy',
    ]) {
      expect(text).toContain(field);
    }
    expect(text).toMatch(/unrecognized key|extra/i);
  });

  it('never registers BASE-* rules (those are governed exceptions)', () => {
    const r = check(entry({ ruleId: 'BASE-LMB-004' }));
    expect(codes(r)).toEqual(['MALFORMED']);
    expect(r.issues[0]?.message).toContain('exceptions.yaml');
  });

  it('enforces governance rules: unique id and scope, IAM5 action allowlists, review windows', () => {
    const r = check(
      entry(),
      entry({ resources: ['B/Resource'] }), // duplicate id
      entry({ id: 'SUP-0101' }), // same rule/construct/resource as SUP-0100
      entry({ id: 'SUP-0102', ruleId: IAM5_WILDCARD_RESOURCE }), // no allowedActions
      entry({
        id: 'SUP-0103',
        ruleId: IAM5_WILDCARD_RESOURCE,
        resources: ['G/Resource'],
        allowedActions: ['dynamodb:GetItem'],
      }),
      entry({
        id: 'SUP-0104',
        resources: ['C/Resource'],
        allowedActions: ['xray:PutTraceSegments'],
      }),
      entry({ id: 'SUP-0105', resources: ['D/Resource'], reviewBy: '2027-06-01' }),
      entry({
        id: 'SUP-0106',
        resources: ['E/Resource'],
        reviewedAt: '2026-09-01',
        reviewBy: '2027-02-01',
      }),
      entry({ id: 'SUP-0107', resources: ['F/Resource'], createdAt: '2026-11-01' }),
    );
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual([
      'DUPLICATE_ID',
      'DUPLICATE_SCOPE',
      'ACTIONS_REQUIRED',
      'ACTION_NOT_IN_BASELINE',
      'ACTIONS_REQUIRED',
      'INVALID_WINDOW', // SUP-0105: interval > 180 days
      'INVALID_WINDOW', // SUP-0106: reviewedAt before createdAt
      'INVALID_WINDOW', // SUP-0107: createdAt in the future ...
      'INVALID_WINDOW', // ... and therefore reviewedAt before createdAt
    ]);
    expect(r.issues.find((i) => i.exceptionId === 'SUP-0105')?.message).toContain(
      `exceeds the maximum of ${MAX_SUPPRESSION_REVIEW_DAYS}`,
    );
    expect(r.active.map((e) => e.id)).toEqual(['SUP-0100']);
  });

  it('allows one entry per environment for a scope (governed entry + non-governed sandbox twin), never two', () => {
    const twin = entry({ id: 'SUP-0101', environments: ['sandbox'] });
    expect(check(entry(), twin).ok).toBe(true);
    const overlap = check(entry(), entry({ id: 'SUP-0102', environments: ['prod', 'sandbox'] }));
    expect(codes(overlap)).toEqual(['DUPLICATE_SCOPE']); // reported once per resource
    expect(overlap.issues[0]?.message).toContain('is also in SUP-0100');
  });

  it('classifies acknowledgeable ids', () => {
    expect(suppressionKind('AwsSolutions-IAM5[Resource::*]')).toBe('rule');
    expect(suppressionKind('Annotation::@aws-cdk/aws-s3:accessLogsPolicyNotAdded')).toBe(
      'annotation',
    );
    expect(suppressionKind('CloudFormation-Validate::W3010')).toBe('cfn-validate');
    expect(suppressionKind('BASE-S3-001')).toBeUndefined();
    expect(suppressionKind('*')).toBeUndefined();
  });

  it('a register that is not YAML is malformed', () => {
    const file = join(tempDir(), 'suppressions.yaml');
    writeFileSync(file, 'schemaVersion: [1');
    expect(codes(loadSuppressionsFile(file))).toEqual(['MALFORMED']);
  });
});

describe('suppression register: template audit (CI second line)', () => {
  const xrayEntry = entry({
    id: 'SUP-0200',
    ruleId: IAM5_WILDCARD_RESOURCE,
    construct: 'Workflow',
    resources: ['FnRole/DefaultPolicy/Resource'],
    allowedActions: ['xray:PutTraceSegments'],
  });
  const annotationEntry = entry({
    id: 'SUP-0201',
    ruleId: 'Annotation::@aws-cdk/aws-s3:accessLogsPolicyNotAdded',
    construct: 'Spa',
    resources: ['Bucket'],
  });
  const devOnly = entry({ id: 'SUP-0202', environments: ['dev'] });
  const suppressions = [entry(), xrayEntry, annotationEntry, devOnly];
  const exceptions: PolicyException[] = [];

  const resource = (cdkPath: string, id: string, reason: string, extra: object = {}) => ({
    Type: 'AWS::SNS::Topic',
    Metadata: { 'aws:cdk:path': cdkPath, cdk_nag: { rules_to_suppress: [{ id, reason }] } },
    ...extra,
  });
  const audit = (resources: Record<string, object>) =>
    auditSuppressions([{ file: 't.json', template: { Resources: resources } } as AuditTemplate], {
      exceptions,
      suppressions,
    });

  it('accepts a cited suppression on exactly the registered resource', () => {
    const r = audit({ A: resource('Dev/S/T/A/Resource', 'AwsSolutions-SNS3', '[SUP-0100] ok') });
    expect(r.issues).toEqual([]);
    expect(r.inventory).toEqual([
      expect.objectContaining({ governedBy: 'register', citation: 'SUP-0100' }),
    ]);
  });

  it('flags a citation outside the entry scope (other resource, or a parent construct)', () => {
    for (const path of ['Dev/S/T/B/Resource', 'Dev/S/T/A', 'Dev/S/T/A/Resource/Extra']) {
      const r = audit({ X: resource(path, 'AwsSolutions-SNS3', '[SUP-0100] forged') });
      expect(
        r.issues.map((i) => i.code),
        path,
      ).toEqual(['SCOPE_MISMATCH']);
    }
  });

  it('flags an environment the entry does not list', () => {
    const r = audit({ A: resource('Prod/S/T/A/Resource', 'AwsSolutions-SNS3', '[SUP-0202] dev') });
    expect(r.issues.map((i) => i.code)).toEqual(['ENVIRONMENT_MISMATCH']);
  });

  it('a sandbox-only entry covers the Sandbox stage and nothing outside it', () => {
    const sandboxOnly = entry({ id: 'SUP-0203', environments: ['sandbox'] });
    const run = (cdkPath: string) =>
      auditSuppressions(
        [
          {
            file: 't.json',
            template: {
              Resources: { A: resource(cdkPath, 'AwsSolutions-SNS3', '[SUP-0203] sandbox') },
            },
          } as AuditTemplate,
        ],
        { exceptions, suppressions: [sandboxOnly] },
      ).issues.map((i) => i.code);
    expect(run('Sandbox/S/T/A/Resource')).toEqual([]);
    expect(run('Dev/S/T/A/Resource')).toEqual(['ENVIRONMENT_MISMATCH']);
    // Outside any stage (e.g. the integration mini-stack): never a sandbox-only entry.
    expect(run('IntegrationWorkflowStack/T/A/Resource')).toEqual(['ENVIRONMENT_MISMATCH']);
  });

  it('flags uncited, unknown, inactive or wrong-rule citations as ungoverned', () => {
    const r = audit({
      A: resource('Dev/S/T/A/Resource', 'AwsSolutions-SNS3', 'no citation at all here'),
      B: resource('Dev/S/T/A/Resource', 'AwsSolutions-SNS3', '[SUP-0999] unknown'),
      C: resource('Dev/S/T/A/Resource', 'AwsSolutions-SNS2', '[SUP-0100] wrong rule'),
      D: resource('Dev/S/T/A/Resource', 'Unknown-Pack-Format!', '[SUP-0100] nonsense'),
    });
    expect(r.issues.map((i) => i.code)).toEqual([
      'UNGOVERNED_SUPPRESSION',
      'UNGOVERNED_SUPPRESSION',
      'UNGOVERNED_SUPPRESSION',
      'UNGOVERNED_SUPPRESSION',
    ]);
  });

  it('IAM5[Resource::*]: every action on Resource "*" must be in allowedActions', () => {
    const policy = (actions: string[]) =>
      resource(
        'Dev/Wf/Workflow/FnRole/DefaultPolicy/Resource',
        IAM5_WILDCARD_RESOURCE,
        '[SUP-0200] x-ray',
        {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyDocument: {
              Statement: [
                { Effect: 'Allow', Action: actions, Resource: '*' },
                { Effect: 'Allow', Action: 'dynamodb:GetItem', Resource: 'arn:aws:dynamodb:x' },
              ],
            },
          },
        },
      );
    expect(audit({ P: policy(['xray:PutTraceSegments']) }).issues).toEqual([]);
    const r = audit({ P: policy(['xray:PutTraceSegments', 'ec2:DescribeSubnets']) });
    expect(r.issues.map((i) => i.code)).toEqual(['ACTION_NOT_ALLOWED']);
    expect(r.issues[0]?.message).toContain('ec2:DescribeSubnets');
  });

  it('annotation entries also cover the resources below the annotated construct', () => {
    const id = '@aws-cdk/aws-s3:accessLogsPolicyNotAdded'; // cdk-nag strips "Annotation::"
    const r = audit({
      B: resource('Dev/F/Spa/Bucket/Resource', id, '[SUP-0201] imported log bucket'),
      P: resource('Dev/F/Spa/Bucket/Policy/Resource', id, '[SUP-0201] imported log bucket'),
      O: resource('Dev/F/Spa/Other/Resource', id, '[SUP-0201] imported log bucket'),
    });
    expect(r.issues.map((i) => `${i.code} ${i.message.split(' ')[1]}`)).toEqual([
      'SCOPE_MISMATCH O',
    ]);
  });

  it("aws-cdk-lib's own CloudFormation Validate acknowledgements are inventoried, not failed", () => {
    const r = audit({
      F: resource('Dev/N/Vpc/FlowLog', 'CloudFormation-Validate::F3002', 'camelCase is valid'),
    });
    expect(r.issues).toEqual([]);
    expect(r.inventory[0]?.governedBy).toBe('framework');
  });

  it('reports register entries no audited template uses (warning only)', () => {
    const r = audit({ A: resource('Dev/S/T/A/Resource', 'AwsSolutions-SNS3', '[SUP-0100] ok') });
    const unused = unusedSuppressions(r.inventory, suppressions);
    expect(unused.map((i) => `${i.level} ${i.exceptionId}`)).toEqual([
      'warning SUP-0200',
      'warning SUP-0201',
      'warning SUP-0202',
    ]);
  });

  it('scope paths are segment-aligned suffixes', () => {
    expect(cdkPathInScope(entry(), 'Dev/S/T/A/Resource')).toBe(true);
    expect(cdkPathInScope(entry(), 'Dev/S/T/XA/Resource')).toBe(false);
    expect(cdkPathInScope(entry(), 'A/Resource')).toBe(false); // no owner segment in front
    const glob = entry({ resources: ['Vpc/*Subnet?/Subnet'] });
    expect(cdkPathInScope(glob, 'Dev/F/Sandbox/Vpc/appSubnet1/Subnet')).toBe(true);
    expect(cdkPathInScope(glob, 'Dev/F/Sandbox/Vpc/appSubnet1/RouteTable')).toBe(false);
  });
});

/** Project construct (no jsii type info) with two SNS topics. */
class Topics extends Construct {
  public readonly a: sns.Topic;
  public readonly b: sns.Topic;
  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.a = new sns.Topic(this, 'A');
    this.b = new sns.Topic(this, 'B');
  }
}

const register = (...entries: SuppressionEntry[]) =>
  checkSuppressions({ schemaVersion: 1, suppressions: entries }, { today: TODAY });

function topicsIn(stageName = 'Dev'): Topics {
  const stack = new Stack(new Stage(new App(), stageName), 'S');
  return new Topics(stack, 'T');
}

describe('suppression register: construct-tree resolution', () => {
  it('resolves the entry by construct class and narrows to the named resources', () => {
    const topics = topicsIn();
    const r = resolveSuppression(topics, 'AwsSolutions-SNS3', register(entry()));
    expect(r.entry.id).toBe('SUP-0100');
    expect(r.owner).toBe(topics);
    expect(r.targets.map((t) => t.node.path)).toEqual(['Dev/S/T/A/Resource']);
    expect(CfnResource.isCfnResource(r.targets[0])).toBe(true);
  });

  it('matches aws-cdk-lib classes by their jsii name (decorated classes are renamed)', () => {
    const topics = topicsIn();
    const r = resolveSuppression(
      topics.a,
      'AwsSolutions-SNS3',
      register(entry({ construct: 'Topic', resources: ['Resource'] })),
    );
    expect(r.targets.map((t) => t.node.path)).toEqual(['Dev/S/T/A/Resource']);
  });

  it('annotation entries target the annotated construct itself', () => {
    const topics = topicsIn();
    const r = resolveSuppression(
      topics,
      'Annotation::@aws-cdk/aws-sns:someWarning',
      register(entry({ ruleId: 'Annotation::@aws-cdk/aws-sns:someWarning', resources: ['B'] })),
    );
    expect(r.targets).toEqual([topics.b]);
  });

  it('throws for ungoverned, ambiguous, inactive and out-of-environment acknowledgements', () => {
    const t = () => topicsIn();
    expect(() => resolveSuppression(t(), 'AwsSolutions-SNS3', register())).toThrow(
      UngovernedSuppressionError,
    );
    expect(() =>
      resolveSuppression(
        t(),
        'AwsSolutions-SNS3',
        register(entry(), entry({ id: 'SUP-0101', resources: ['A/Res*'] })),
      ),
    ).toThrow(/several register entries/);
    const overdue = checkSuppressions(
      { schemaVersion: 1, suppressions: [entry({ reviewBy: '2026-10-12' })] },
      { today: TODAY },
    );
    expect(() => resolveSuppression(t(), 'AwsSolutions-SNS3', overdue)).toThrow(/not active/);
    expect(() =>
      resolveSuppression(
        topicsIn('Prod'),
        'AwsSolutions-SNS3',
        register(entry({ environments: ['dev'] })),
      ),
    ).toThrow(/limited to dev, not prod/);
    expect(() => resolveSuppression(t(), 'BASE-SNS-001', register(entry()))).toThrow(
      /governed exceptions/,
    );
    expect(() => resolveSuppression(t(), 'not an id', register(entry()))).toThrow(
      /not an acknowledgeable id/,
    );
  });

  it('the stage environment selects between a governed entry and its sandbox twin', () => {
    const baseline = entry();
    const twin = entry({ id: 'SUP-0101', environments: ['sandbox'] });
    const reg = register(baseline, twin);
    expect(resolveSuppression(topicsIn('Dev'), 'AwsSolutions-SNS3', reg).entry.id).toBe('SUP-0100');
    expect(resolveSuppression(topicsIn('Sandbox'), 'AwsSolutions-SNS3', reg).entry.id).toBe(
      'SUP-0101',
    );
    // Outside a Dev/Staging/Prod/Sandbox stage only entries listing a governed environment apply.
    const outside = new Topics(new Stack(new App(), 'IntegrationWorkflowStack'), 'T');
    expect(resolveSuppression(outside, 'AwsSolutions-SNS3', reg).entry.id).toBe('SUP-0100');
    expect(() =>
      resolveSuppression(
        new Topics(new Stack(new App(), 'IntegrationWorkflowStack'), 'T'),
        'AwsSolutions-SNS3',
        register(twin),
      ),
    ).toThrow(/limited to sandbox, not a construct outside/);
    expect(() => resolveSuppression(topicsIn('Prod'), 'AwsSolutions-SNS3', register(twin))).toThrow(
      /limited to sandbox, not prod/,
    );
    expect(() =>
      resolveSuppression(topicsIn('Sandbox'), 'AwsSolutions-SNS3', register(baseline)),
    ).toThrow(/limited to dev\/staging\/prod, not sandbox/);
  });

  it('a malformed register makes every acknowledgement fail', () => {
    const malformed = checkSuppressions({ schemaVersion: 1, suppressions: [{ id: 'x' }] });
    expect(() => resolveSuppression(topicsIn(), 'AwsSolutions-SNS3', malformed)).toThrow(
      /malformed/,
    );
  });
});

describe('suppression register: synth-time tree audit', () => {
  const reg = register(entry({ resources: ['A/Resource', 'B/Resource'] }));
  const audit = (root: Construct) =>
    auditConstructTree(root, { suppressions: reg.active, exceptions: [] }).map(
      (i) => `${i.code} ${i.constructPath}`,
    );

  it('accepts acknowledgements made exactly where the entry allows', () => {
    const topics = topicsIn();
    for (const t of [topics.a, topics.b]) {
      Validations.of(t.node.defaultChild as CfnResource).acknowledge({
        id: 'AwsSolutions-SNS3',
        reason: '[SUP-0100] fixture',
      });
    }
    expect(audit(topics.node.root as Construct)).toEqual([]);
  });

  it('flags direct, uncited and ancestor-wide acknowledgements', () => {
    const topics = topicsIn();
    Validations.of(topics.a).acknowledge({ id: 'AwsSolutions-SNS3', reason: 'no citation here' });
    Validations.of(topics).acknowledge({ id: 'AwsSolutions-SNS3', reason: '[SUP-0100] parent' });
    expect(audit(topics.node.root as Construct)).toEqual([
      'SCOPE_MISMATCH Dev/S/T',
      'UNGOVERNED_SUPPRESSION Dev/S/T/A',
    ]);
  });

  it('skips uncited CloudFormation Validate acknowledgements (aws-cdk-lib internals)', () => {
    const topics = topicsIn();
    Validations.of(topics).acknowledge({
      id: 'CloudFormation-Validate::W3010',
      reason: 'framework',
    });
    expect(audit(topics.node.root as Construct)).toEqual([]);
  });

  it('checks IAM5 action allowlists against the synthesized template', () => {
    const app = new App();
    const stack = new Stack(new Stage(app, 'Dev'), 'S');
    class Wf extends Construct {
      constructor(scope: Construct, id: string) {
        super(scope, id);
        const role = new iam.Role(this, 'FnRole', {
          assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });
        role.addToPolicy(
          new iam.PolicyStatement({
            actions: ['xray:PutTraceSegments', 'ec2:DescribeSubnets'],
            resources: ['*'],
          }),
        );
      }
    }
    const wf = new Wf(stack, 'W');
    const iam5 = register(
      entry({
        id: 'SUP-0300',
        ruleId: IAM5_WILDCARD_RESOURCE,
        construct: 'Wf',
        resources: ['FnRole/DefaultPolicy/Resource'],
        allowedActions: ['xray:PutTraceSegments'],
      }),
    );
    const policy = wf.node.findAll().find((c) => c.node.path.endsWith('DefaultPolicy/Resource'));
    Validations.of(policy as CfnResource).acknowledge({
      id: IAM5_WILDCARD_RESOURCE,
      reason: '[SUP-0300] x-ray',
    });
    const assembly = app.synth();
    const templateOf = (s: Stack) =>
      assembly.stacksRecursively.find((a) => a.hierarchicalId === s.node.path)?.template as never;
    const issues = auditConstructTree(app, {
      suppressions: iam5.active,
      exceptions: [],
      templateOf,
    });
    expect(issues.map((i) => i.code)).toEqual(['ACTION_NOT_ALLOWED']);
    expect(issues[0]?.message).toContain('ec2:DescribeSubnets');
  });

  it('the plugin reports fatal (unsuppressible) violations, including register errors', () => {
    const topics = topicsIn();
    Validations.of(topics.a).acknowledge({ id: 'AwsSolutions-SNS3', reason: 'uncited reason' });
    const overdue = checkSuppressions(
      { schemaVersion: 1, suppressions: [entry({ reviewBy: '2026-10-12' })] },
      { today: TODAY },
    );
    const report = new SuppressionAuditPlugin({ register: overdue }).validateScope(
      topics.node.root,
    );
    expect(report.success).toBe(false);
    expect(report.violations.map((v) => v.severity)).toEqual(['fatal', 'fatal']);
    expect(report.violations.map((v) => v.ruleName)).toEqual(['BASE-SUP-001', 'BASE-SUP-001']);
  });
});

describe('check-exceptions CLI with the suppression register', () => {
  let logs: string[] = [];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  /** Temp dir with an exceptions file, a register and an empty cdk.out/assembly-Dev. */
  function fixture(suppressions: SuppressionEntry[]) {
    const dir = tempDir();
    const reg = join(dir, 'suppressions.yaml');
    writeFileSync(reg, stringify({ schemaVersion: 1, suppressions }));
    const exc = join(dir, 'exceptions.yaml');
    writeFileSync(exc, stringify({ schemaVersion: 1, exceptions: [] }));
    const templates = join(dir, 'cdk.out');
    const assembly = join(templates, 'assembly-Dev');
    mkdirSync(assembly, { recursive: true });
    return { dir, reg, exc, templates, assembly };
  }

  it('audits every suppression by default, writes an inventory, exits 1 on ungoverned ones', () => {
    const f = fixture([entry()]);
    const write = (resources: Record<string, object>) =>
      writeFileSync(
        join(f.assembly, 'DevS.template.json'),
        JSON.stringify({ Resources: resources }),
      );
    const meta = (id: string, reason: string) => ({
      Type: 'AWS::SNS::Topic',
      Metadata: {
        'aws:cdk:path': 'Dev/S/T/A/Resource',
        cdk_nag: { rules_to_suppress: [{ id, reason }] },
      },
    });
    const args = (report: string) => [
      'check-exceptions',
      '--file',
      f.exc,
      '--suppressions',
      f.reg,
      '--today',
      TODAY,
      '--templates',
      f.templates,
      '--report',
      report,
    ];

    write({ A: meta('AwsSolutions-SNS3', '[SUP-0100] governed') });
    const ok = join(f.dir, 'ok.json');
    expect(main(args(ok))).toBe(EXIT.OK);
    const report = JSON.parse(readFileSync(ok, 'utf8')) as {
      ok: boolean;
      audit: { scope: string; inventory: { governedBy: string }[] };
    };
    expect(report.ok).toBe(true);
    expect(report.audit.scope).toBe('all');
    expect(report.audit.inventory.map((i) => i.governedBy)).toEqual(['register']);

    write({ A: meta('AwsSolutions-SNS3', 'ungoverned in-code reason') });
    expect(main(args(join(f.dir, 'bad.json')))).toBe(EXIT.FAILED);
    expect(logs.join('\n')).toContain('UNGOVERNED_SUPPRESSION');
    // Legacy scope: AwsSolutions suppressions are not audited.
    expect(main([...args(join(f.dir, 'starter.json')), '--audit-scope', 'baseline'])).toBe(EXIT.OK);
    expect(main([...args(join(f.dir, 'x.json')), '--audit-scope', 'bogus'])).toBe(EXIT.USAGE);
  });

  it('fails when the register itself is invalid (e.g. a review is overdue)', () => {
    const f = fixture([entry({ reviewBy: '2026-10-12' })]);
    expect(
      main(['check-exceptions', '--file', f.exc, '--suppressions', f.reg, '--today', TODAY]),
    ).toBe(EXIT.FAILED);
    expect(logs.join('\n')).toMatch(/EXPIRED: SUP-0100: review overdue/);
  });
});

describe('IAM5 allowances stay within the BASE-IAM-002 baseline', () => {
  it('every allowedActions entry of the repository register is a baseline wildcard action', () => {
    const r = loadSuppressionsFile(DEFAULT_SUPPRESSIONS_PATH, { today: todayUtc() });
    for (const e of r.suppressions) {
      for (const a of e.allowedActions ?? []) {
        expect(Object.keys(RESOURCE_WILDCARD_ALLOWED_ACTIONS), `${e.id} ${a}`).toContain(a);
      }
    }
  });
});
