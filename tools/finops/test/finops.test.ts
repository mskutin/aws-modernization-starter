import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { budgetCoverage } from '../src/budgets.js';
import { EXIT, main } from '../src/cli.js';
import {
  ConfigError,
  DEFAULT_PRICES,
  DEFAULT_REGION,
  loadPriceTable,
  loadPriceTableForRegion,
  priceTableFileFor,
  pricedRegions,
  loadThresholds,
  loadUsage,
  thresholdsFor,
  usageFor,
  type Thresholds,
} from '../src/config.js';
import { diffTemplates } from '../src/diff.js';
import { estimate } from '../src/estimate.js';
import { decide, readApproval } from '../src/gate.js';
import { buildReport, toMarkdown } from '../src/report.js';
import {
  environmentOfTemplate,
  loadTemplates,
  regionsOfAssembly,
  type CfnResource,
} from '../src/templates.js';
import {
  API,
  DATA,
  apiStack,
  baseAssembly,
  withResource,
  writeAssembly,
  type Assembly,
} from './fixtures/templates.js';

const prices = loadPriceTable();
const usage = loadUsage();
const thresholds = loadThresholds();

function run(base: Assembly, head: Assembly, env: NodeJS.ProcessEnv = {}) {
  const b = loadTemplates(writeAssembly(base));
  const h = loadTemplates(writeAssembly(head));
  const diff = diffTemplates(b, h);
  const be = estimate(b, prices, usage);
  const he = estimate(h, prices, usage);
  const decision = decide(diff, be, he, thresholds, readApproval(thresholds, env));
  return { diff, be, he, decision, h };
}

describe('configuration files', () => {
  it('price table is dated, versioned and labelled as a manual snapshot', () => {
    expect(prices.capturedAt).toBe('2026-10-13');
    expect(prices.region).toBe('ap-southeast-1');
    const text = readFileSync(
      join(import.meta.dirname, '..', 'pricing', 'ap-southeast-1.yaml'),
      'utf8',
    );
    expect(text).toMatch(/MANUALLY MAINTAINED SNAPSHOT, NOT LIVE PRICING/);
  });

  it('usage assumptions merge environment overrides over defaults', () => {
    expect(usageFor(usage, 'prod').lambda.invocationsPerMonth).toBe(1_000_000);
    expect(usageFor(usage, 'prod').lambda.avgDurationMs).toBe(300);
    expect(usageFor(usage, undefined).lambda.invocationsPerMonth).toBe(100_000);
  });

  it('thresholds resolve per environment and destructive approval cannot be disabled', () => {
    expect(thresholdsFor(thresholds, 'prod')).toEqual({
      monthlyIncreaseUsd: 25,
      monthlyIncreasePercent: 10,
    });
    expect(thresholdsFor(thresholds, 'staging')).toEqual({
      monthlyIncreaseUsd: 50,
      monthlyIncreasePercent: 20,
    });
    const dir = writeAssembly({});
    const bad = join(dir, 'thresholds.yaml');
    writeFileSync(
      bad,
      readFileSync(join(import.meta.dirname, '..', 'thresholds.yaml'), 'utf8').replace(
        'destructiveChangesRequireApproval: true',
        'destructiveChangesRequireApproval: false',
      ),
    );
    expect(() => loadThresholds(bad)).toThrow(ConfigError);
  });
});

describe('estimator (deterministic, offline)', () => {
  it('prices the baseline exactly from the snapshot and assumptions', () => {
    const { be } = run(baseAssembly(), baseAssembly());
    const line = (id: string) => be.lines.find((l) => l.logicalId === id)?.monthlyUsd;
    expect(line('Database')).toBe(81.36); // db.t4g.medium 0.102 × 730 + 50 GB × 0.138
    expect(line('JobsTable')).toBe(22.18); // 20M RRU + 10M WRU × (1 + 1 GSI) + 10 GB + PITR
    expect(line('Service')).toBe(35.98); // 2 × (0.5 vCPU × 0.04045 + 1 GB × 0.00442) × 730
    expect(line('Alb')).toBe(30.08); // (0.0252 + 2 LCU × 0.008) × 730
    expect(line('ApiLogs')).toBe(1.41);
    expect(line('Fn')).toBe(2.2);
    expect(line('DataKey')).toBe(1);
    expect(be.totals).toEqual({ prod: 174.24 });
    expect(be.unpriced).toEqual([]);
  });

  it('applies the Fargate Spot assumption and flags unmodelled resources', () => {
    const head = withResource(baseAssembly(), API, 'Service', (r) => ({
      ...(r as CfnResource),
      Properties: {
        ...r?.Properties,
        CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE_SPOT', Weight: 1 }],
      },
    }));
    const withRepo = withResource(head, API, 'Repo', () => ({ Type: 'AWS::ECR::Repository' }));
    const { he } = run(baseAssembly(), withRepo);
    expect(he.lines.find((l) => l.logicalId === 'Service')?.monthlyUsd).toBe(10.79); // 35.98 × 0.3
    expect(he.unpriced).toEqual([
      expect.objectContaining({ logicalId: 'Repo', reason: 'resource type not modelled' }),
    ]);
  });
});

describe('template diff and approval gate', () => {
  it('no change: passes without approval', () => {
    const { diff, decision } = run(baseAssembly(), baseAssembly());
    expect(diff.resources).toEqual([]);
    expect(decision).toMatchObject({ requiresApproval: false, passed: true });
  });

  it('RDS resize + Multi-AZ: cost-relevant change, delta over the prod threshold → approval required', () => {
    const head = withResource(baseAssembly(), DATA, 'Database', (r) => ({
      ...(r as CfnResource),
      Properties: { ...r?.Properties, DBInstanceClass: 'db.m7g.large', MultiAZ: true },
    }));
    const { diff, decision } = run(baseAssembly(), head);
    expect(diff.costRelevant[0]?.changes.map((c) => [c.property, c.before, c.after])).toEqual([
      ['DBInstanceClass', 'db.t4g.medium', 'db.m7g.large'],
      ['MultiAZ', false, true],
    ]);
    expect(diff.destructive).toEqual([]);
    expect(decision.environments[0]).toMatchObject({
      environment: 'prod',
      baseUsd: 174.24,
      headUsd: 448.32,
      deltaUsd: 274.08, // 0.468 × 730 + 50 × 0.276 − 81.36
      exceeds: true,
    });
    expect(decision).toMatchObject({ requiresApproval: true, passed: false });
    expect(decision.reasons).toEqual([
      { kind: 'cost-increase', environment: 'prod', deltaUsd: 274.08, deltaPercent: 157.3 },
    ]);
  });

  it('the MR label (CI_MERGE_REQUEST_LABELS) or the approval variable grants approval', () => {
    const head = withResource(baseAssembly(), DATA, 'Database', (r) => ({
      ...(r as CfnResource),
      Properties: { ...r?.Properties, DBInstanceClass: 'db.m7g.large' },
    }));
    const labelled = run(baseAssembly(), head, {
      CI_MERGE_REQUEST_LABELS: 'backend,finops-approved',
    });
    expect(labelled.decision).toMatchObject({ passed: true, approval: { approved: true } });
    expect(labelled.decision.approval.via).toContain('finops-approved');
    // The approval variable is opt-in and not configured by default.
    const variable = run(baseAssembly(), head, { FINOPS_APPROVED: 'true' });
    expect(variable.decision.passed).toBe(false);
    expect(
      run(baseAssembly(), head, { CI_MERGE_REQUEST_LABELS: 'finops-approved-not' }).decision.passed,
    ).toBe(false);
  });

  it('percentage threshold catches a small absolute increase', () => {
    // +1 Fargate task (≈ $18) is below $25 but > 10 % of $174.
    const head = withResource(baseAssembly(), API, 'Service', (r) => ({
      ...(r as CfnResource),
      Properties: { ...r?.Properties, DesiredCount: 3 },
    }));
    const { decision } = run(baseAssembly(), head);
    expect(decision.environments[0]?.deltaUsd).toBe(17.99);
    expect(decision.environments[0]?.deltaPercent).toBe(10.32);
    expect(decision.requiresApproval).toBe(true);
  });

  it('small decreases and neutral changes pass', () => {
    const head = withResource(baseAssembly(), API, 'Fn', (r) => ({
      ...(r as CfnResource),
      Properties: { ...r?.Properties, MemorySize: 256 },
    }));
    const { decision, diff } = run(baseAssembly(), head);
    expect(diff.costRelevant).toHaveLength(1);
    expect(decision.environments[0]?.deltaUsd).toBe(-1);
    expect(decision.passed).toBe(true);
  });

  it('adding a NAT gateway is reported as new expensive resource and priced', () => {
    const head = withResource(baseAssembly(), API, 'Nat', () => ({
      Type: 'AWS::EC2::NatGateway',
      Properties: {},
    }));
    const { decision, he } = run(baseAssembly(), head);
    expect(he.lines.find((l) => l.logicalId === 'Nat')?.monthlyUsd).toBe(44.25); // 0.059 × 730 + 20 GB × 0.059
    expect(decision.reasons).toContainEqual({
      kind: 'new-resource-type',
      type: 'AWS::EC2::NatGateway',
      stack: API,
      logicalId: 'Nat',
    });
  });

  it('provisioned concurrency on an alias is priced', () => {
    const head = withResource(baseAssembly(), API, 'Live', () => ({
      Type: 'AWS::Lambda::Alias',
      Properties: {
        FunctionName: { Ref: 'Fn' },
        ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 2 },
      },
    }));
    const { he } = run(baseAssembly(), head);
    // 2 × 0.5 GB × 730 h × 3600 s × 0.0000041593 (arm64)
    expect(he.lines.find((l) => l.logicalId === 'Live')?.monthlyUsd).toBe(10.93);
  });

  it('missing base: everything is new', () => {
    const { diff, decision } = run({}, baseAssembly());
    expect(diff.resources.every((r) => r.kind === 'added')).toBe(true);
    expect(decision.reasons.map((r) => r.kind)).toEqual([
      'cost-increase',
      'new-resource-type',
      'new-resource-type',
    ]);
  });
});

describe('destructive change detection (always requires approval)', () => {
  const kinds = (head: Assembly) =>
    run(baseAssembly(), head).diff.destructive.map((d) => [d.kind, d.logicalId]);

  it('removing a stateful resource with DeletionPolicy Delete deletes data', () => {
    const base = withResource(baseAssembly(), DATA, 'JobsTable', (r) => ({
      ...(r as CfnResource),
      DeletionPolicy: 'Delete',
    }));
    const head = withResource(base, DATA, 'JobsTable', () => undefined);
    const { diff, decision } = run(base, head);
    expect(diff.destructive[0]).toMatchObject({ kind: 'stateful-removed', logicalId: 'JobsTable' });
    expect(diff.destructive[0]?.detail).toContain('will be DELETED');
    expect(decision.requiresApproval).toBe(true);
    expect(decision.reasons[0]).toEqual({ kind: 'destructive', count: 1 });
  });

  it('removing a retained resource is still flagged (orphaned)', () => {
    const { diff } = run(
      baseAssembly(),
      withResource(baseAssembly(), DATA, 'Assets', () => undefined),
    );
    expect(diff.destructive[0]?.detail).toContain('keeps (orphans/snapshots)');
  });

  it('replacement-forcing property changes on RDS, DynamoDB, S3 and KMS', () => {
    let head = withResource(baseAssembly(), DATA, 'Database', (r) => ({
      ...(r as CfnResource),
      Properties: { ...r?.Properties, StorageEncrypted: false },
    }));
    head = withResource(head, DATA, 'JobsTable', (r) => ({
      ...(r as CfnResource),
      Properties: { ...r?.Properties, KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] },
    }));
    head = withResource(head, DATA, 'Assets', (r) => ({
      ...(r as CfnResource),
      Properties: { ...r?.Properties, BucketName: 'starter-prod-assets-v2' },
    }));
    head = withResource(head, DATA, 'DataKey', (r) => ({
      ...(r as CfnResource),
      Properties: { ...r?.Properties, KeySpec: 'RSA_2048' },
    }));
    expect(kinds(head)).toEqual([
      ['stateful-replaced', 'Assets'],
      ['stateful-replaced', 'DataKey'],
      ['stateful-replaced', 'Database'],
      ['stateful-replaced', 'JobsTable'],
    ]);
  });

  it('weakening DeletionPolicy and disabling deletion protection', () => {
    let head = withResource(baseAssembly(), DATA, 'JobsTable', (r) => ({
      ...(r as CfnResource),
      DeletionPolicy: 'Delete',
      Properties: { ...r?.Properties, DeletionProtectionEnabled: false },
    }));
    head = withResource(head, DATA, 'Database', (r) => {
      const { DeletionProtection: _drop, ...props } = r?.Properties ?? {};
      return { ...(r as CfnResource), Properties: props };
    });
    expect(kinds(head)).toEqual([
      ['protection-disabled', 'Database'],
      ['protection-disabled', 'JobsTable'],
      ['retention-weakened', 'JobsTable'],
    ]);
  });

  it('strengthening retention is not destructive', () => {
    const base = withResource(baseAssembly(), DATA, 'JobsTable', (r) => ({
      ...(r as CfnResource),
      DeletionPolicy: 'Delete',
    }));
    expect(run(base, baseAssembly()).diff.destructive).toEqual([]);
  });

  it('a type change under the same logical ID is a removal', () => {
    const head = withResource(baseAssembly(), DATA, 'JobsTable', (r) => ({
      ...(r as CfnResource),
      Type: 'AWS::DynamoDB::GlobalTable',
    }));
    expect(kinds(head)).toEqual([['stateful-removed', 'JobsTable']]);
  });

  it('non-stateful removals are not destructive', () => {
    expect(kinds(withResource(baseAssembly(), API, 'Fn', () => undefined))).toEqual([]);
  });
});

describe('budget alignment and reports', () => {
  it('compares the estimate with the CostGuardrails budget', () => {
    const { h, he } = run(baseAssembly(), baseAssembly());
    expect(budgetCoverage(h, he)).toEqual([
      expect.objectContaining({
        environment: 'prod',
        limitUsd: 1500,
        estimatedUsd: 174.24,
        utilisationPercent: 11.6,
        status: 'ok',
      }),
    ]);
    expect(budgetCoverage(h, he, 10)[0]?.status).toBe('warning');
  });

  it('markdown report states the disclaimer, price snapshot and decision', () => {
    const head = withResource(baseAssembly(), DATA, 'JobsTable', () => undefined);
    const { diff, be, he, decision, h } = run(baseAssembly(), head);
    const report = buildReport({
      decision,
      diff,
      base: be,
      head: he,
      budgets: budgetCoverage(h, he),
      thresholds: thresholds as Thresholds,
      prices,
      usage,
      now: new Date('2026-10-13T00:00:00Z'),
    });
    const md = toMarkdown(report);
    expect(md).toContain('BLOCKED');
    expect(md).toContain('NOT live AWS prices');
    expect(md).toContain('captured 2026-10-13');
    expect(md).toContain('| stateful-removed |');
    expect(report.costChanges[0]).toMatchObject({ logicalId: 'JobsTable', deltaUsd: -22.18 });
    expect(report.generatedAt).toBe('2026-10-13T00:00:00.000Z');
  });

  it('derives the environment from tags, then from the Stage assembly name', () => {
    expect(environmentOfTemplate('x.template.json', apiStack('staging'))).toBe('staging');
    expect(environmentOfTemplate('assembly-Dev/x.template.json', { Resources: {} })).toBe('dev');
    expect(environmentOfTemplate('x.template.json', { Resources: {} })).toBeUndefined();
  });
});

describe('starter-finops CLI', () => {
  let logs: string[] = [];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  const head = withResource(baseAssembly(), DATA, 'Database', (r) => ({
    ...(r as CfnResource),
    Properties: { ...r?.Properties, DBInstanceClass: 'db.m7g.large' },
  }));

  it('check: exit 1 when approval is required and missing; reports written', () => {
    const out = writeAssembly({});
    const code = main(
      [
        'check',
        '--base',
        writeAssembly(baseAssembly()),
        '--head',
        writeAssembly(head),
        '--out',
        out,
        '--quiet',
      ],
      {},
    );
    expect(code).toBe(EXIT.APPROVAL_REQUIRED);
    const json = JSON.parse(readFileSync(join(out, 'finops-report.json'), 'utf8'));
    expect(json.decision.requiresApproval).toBe(true);
    expect(readFileSync(join(out, 'finops-report.md'), 'utf8')).toContain(
      'FinOps approval required',
    );
  });

  it('check: exit 0 with the approval label; diff never gates', () => {
    const args = [
      '--base',
      writeAssembly(baseAssembly()),
      '--head',
      writeAssembly(head),
      '--out',
      writeAssembly({}),
      '--quiet',
    ];
    expect(main(['check', ...args], { CI_MERGE_REQUEST_LABELS: 'finops-approved' })).toBe(EXIT.OK);
    expect(main(['diff', ...args], {})).toBe(EXIT.OK);
  });

  it('exit 2 for usage and configuration errors', () => {
    expect(main([], {})).toBe(EXIT.USAGE);
    expect(main(['check', '--head', writeAssembly({})], {})).toBe(EXIT.USAGE);
    const badPrices = join(writeAssembly({}), 'prices.yaml');
    writeFileSync(badPrices, 'schemaVersion: 1\nversion: x\n');
    expect(
      main(['check', '--head', writeAssembly(baseAssembly()), '--prices', badPrices], {}),
    ).toBe(EXIT.USAGE);
    expect(logs.join('\n')).toContain('Price table');
  });

  /** An assembly whose cloud assembly manifest pins its stacks to `region`. */
  const inRegion = (assembly: Assembly, region: string): string => {
    const dir = writeAssembly(assembly);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        artifacts: {
          Stack: { type: 'aws:cloudformation:stack', environment: `aws://000000000000/${region}` },
          Tree: { type: 'cdk:tree' },
        },
      }),
    );
    return dir;
  };

  it('prices the default region from the assembly manifest', () => {
    const out = writeAssembly({});
    const args = ['--base', inRegion(baseAssembly(), 'ap-southeast-1'), '--head'];
    expect(
      main(['diff', ...args, inRegion(head, 'ap-southeast-1'), '--out', out, '--quiet'], {}),
    ).toBe(EXIT.OK);
    const json = JSON.parse(readFileSync(join(out, 'finops-report.json'), 'utf8'));
    expect(json.priceTable.region).toBe('ap-southeast-1');
    expect(json.basePriceTable).toBeUndefined();
  });

  it('fails closed for a region without a price table, naming the missing file', () => {
    expect(main(['diff', '--head', inRegion(head, 'eu-west-1'), '--quiet'], {})).toBe(EXIT.USAGE);
    const text = logs.join('\n');
    expect(text).toContain('no FinOps price table for region "eu-west-1"');
    expect(text).toContain('tools/finops/pricing/eu-west-1.yaml does not exist');
    expect(text).toContain('public AWS Price List offer files');
    expect(text).toContain("never use another region's prices");
  });

  it('a region move needs price tables for both regions (no borrowing)', () => {
    const args = ['--base', inRegion(baseAssembly(), 'eu-west-1')];
    expect(main(['diff', ...args, '--head', inRegion(head, 'ap-southeast-1'), '--quiet'], {})).toBe(
      EXIT.USAGE,
    );
    expect(logs.join('\n')).toContain('tools/finops/pricing/eu-west-1.yaml does not exist');
  });

  it('refuses a --region or --prices that disagrees with the templates', () => {
    const headDir = inRegion(head, 'ap-southeast-1');
    expect(main(['diff', '--head', headDir, '--region', 'eu-west-1', '--quiet'], {})).toBe(
      EXIT.USAGE,
    );
    expect(logs.join('\n')).toContain(
      '--region eu-west-1 does not match the head cloud assembly, whose stacks are in ap-southeast-1',
    );
    const otherPrices = join(writeAssembly({}), 'prices.yaml');
    writeFileSync(
      otherPrices,
      readFileSync(DEFAULT_PRICES, 'utf8').replace('region: ap-southeast-1', 'region: eu-west-1'),
    );
    expect(main(['diff', '--head', headDir, '--prices', otherPrices, '--quiet'], {})).toBe(
      EXIT.USAGE,
    );
    expect(logs.join('\n')).toMatch(
      /is for region eu-west-1, but the templates are in ap-southeast-1/,
    );
    expect(
      main(['diff', '--head', writeAssembly(head), '--region', 'eu-west-1', '--quiet'], {}),
    ).toBe(EXIT.USAGE);
  });

  it('refuses templates that span several regions', () => {
    const dir = inRegion(head, 'ap-southeast-1');
    writeFileSync(
      join(dir, 'assembly-Prod', 'manifest.json'),
      JSON.stringify({
        artifacts: { S: { type: 'aws:cloudformation:stack', environment: 'aws://1/eu-west-1' } },
      }),
    );
    expect(main(['diff', '--head', dir, '--quiet'], {})).toBe(EXIT.USAGE);
    expect(logs.join('\n')).toContain('span several regions (ap-southeast-1, eu-west-1)');
  });
});

describe('region-specific price data', () => {
  it('the default region mirrors the single source of truth', () => {
    const canonical = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'packages', 'config', 'src', 'region.ts'),
      'utf8',
    );
    expect(/export const DEFAULT_AWS_REGION = '([a-z0-9-]+)';/.exec(canonical)?.[1]).toBe(
      DEFAULT_REGION,
    );
    expect(DEFAULT_PRICES.endsWith(`pricing/${DEFAULT_REGION}.yaml`)).toBe(true);
  });

  it('only regions with a committed table are priced', () => {
    expect(pricedRegions()).toEqual(['ap-southeast-1']);
    expect(loadPriceTableForRegion('ap-southeast-1').region).toBe('ap-southeast-1');
    for (const region of ['eu-west-1', '../thresholds', 'ap-southeast-1/../../x', '']) {
      expect(() => priceTableFileFor(region)).toThrow(ConfigError);
    }
  });

  it('regionsOfAssembly reads pinned stack environments, ignoring environment-agnostic ones', () => {
    const dir = writeAssembly({});
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        artifacts: {
          A: { type: 'aws:cloudformation:stack', environment: 'aws://000000000000/eu-west-1' },
          B: {
            type: 'aws:cloudformation:stack',
            environment: 'aws://unknown-account/unknown-region',
          },
          C: { type: 'cdk:asset-manifest', environment: 'aws://1/us-east-1' },
        },
      }),
    );
    expect(regionsOfAssembly(dir)).toEqual(['eu-west-1']);
    expect(regionsOfAssembly(writeAssembly({}))).toEqual([]);
  });
});

describe('budget examples (aligned with infra CostGuardrails)', () => {
  const dir = join(import.meta.dirname, '..', 'budgets');
  it.each(['dev', 'staging', 'prod'])('%s: create-budget JSON matches the YAML summary', (env) => {
    const summary = parse(readFileSync(join(dir, 'budgets.example.yaml'), 'utf8')) as {
      budgets: Record<string, { name: string; monthlyLimitUsd: number; project: string }>;
      notifications: { actualPercent: number[]; forecastedPercent: number };
    };
    const budget = JSON.parse(readFileSync(join(dir, 'aws-cli', `${env}.budget.json`), 'utf8'));
    const notifications = JSON.parse(
      readFileSync(join(dir, 'aws-cli', `${env}.notifications.json`), 'utf8'),
    ) as {
      Notification: { NotificationType: string; Threshold: number };
    }[];
    const s = summary.budgets[env];
    expect(budget).toMatchObject({ BudgetName: s?.name, BudgetType: 'COST', TimeUnit: 'MONTHLY' });
    expect(Number(budget.BudgetLimit.Amount)).toBe(s?.monthlyLimitUsd);
    expect(JSON.stringify(budget.FilterExpression)).toContain(`"Values":["${env}"]`);
    expect(
      notifications
        .filter((n) => n.Notification.NotificationType === 'ACTUAL')
        .map((n) => n.Notification.Threshold),
    ).toEqual(summary.notifications.actualPercent);
  });
});
