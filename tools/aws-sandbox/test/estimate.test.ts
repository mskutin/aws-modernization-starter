import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/cli.js';
import { estimate, resourceHourlyUsd, totalForHours } from '../src/model/estimate.js';
import { loadPriceBook, loadSupplement, DEFAULT_SUPPLEMENT } from '../src/model/prices.js';
import { contractTopology, synthTopology, SynthError } from '../src/model/topology.js';
import { estimateSchema } from '../src/schemas.js';
import { assembly, NOW, runCli } from './support.js';

const book = loadPriceBook();
const line = (e: ReturnType<typeof estimate>, id: string) => e.lineItems.find((i) => i.id === id);

describe('estimate (contract model)', () => {
  it('Phase 1 reproduces the planning-estimate figures (0.0203 USD/h, one-time 0.0003)', () => {
    const e = estimate(contractTopology(1), book, { now: NOW });
    expect(e.totals.perHourUsd).toBeCloseTo(0.0203, 4);
    expect(e.totals.oneTimeUsd).toBeCloseTo(0.0003, 4);
    expect(e.totals.partialHourRoundingUsd).toBe(0);
    expect(e.totals.byHours.map((h) => [h.hours, Math.round(h.workloadUsd * 100) / 100])).toEqual([
      [2, 0.04],
      [4, 0.08],
      [8, 0.16],
    ]);
    expect(e.stopRule.effectiveMaxRuntimeHours).toBe(4);
    expect(e.stopRule.bindingLimit).toBe('time-box');
  });

  it('Phase 2 prices the contract architecture: NAT, 3 public IPv4, internet-facing ALB, RDS, Fargate, 2 distributions', () => {
    const e = estimate(contractTopology(2), book, { now: NOW });
    expect(line(e, 'SBX-01')?.usdPerHour).toBe(0.059);
    expect(line(e, 'SBX-01')?.kind).toBe('hourly-partial');
    expect(line(e, 'SBX-02')?.quantity).toBe(3);
    expect(line(e, 'SBX-02')?.usdPerHour).toBeCloseTo(0.015, 6);
    expect(line(e, 'SBX-03')?.usdPerHour).toBe(0.0252);
    expect(line(e, 'SBX-06a')?.component).toMatch(/db\.t4g\.micro Single-AZ/);
    expect(line(e, 'SBX-06a')?.usdPerHour).toBe(0.025);
    expect(line(e, 'SBX-08a')?.usdPerHour).toBeCloseTo(0.25 * 0.04045 + 0.5 * 0.00442, 5);
    expect(line(e, 'SBX-09')?.usdPerHour).toBeCloseTo(3 / 730, 6);
    expect(line(e, 'SBX-47')).toBeUndefined(); // no Route 53 in the sandbox
    expect(e.totals.partialHourRoundingUsd).toBeCloseTo(0.059 + 0.0252 + 0.008, 6);
    expect(e.totals.perHourUsd).toBeGreaterThan(0.2);
    expect(e.totals.perHourUsd).toBeLessThan(0.26);
    // Every line names its price table and capture date; none claims to be live.
    for (const i of e.lineItems) expect(i.priceRef).toMatch(/\(captured 2026-10-1[34]\)/);
    expect(e.priceBasis.notLivePricing).toBe(true);
    expect(e.disclaimer).toMatch(/not live pricing/);
    expect(() => estimateSchema.parse(JSON.parse(JSON.stringify(e)))).not.toThrow();
  });

  it('derives the maximum runtime from the stop rule with margin, tax, account-level allowance and residual', () => {
    const e = estimate(contractTopology(2), book, { now: NOW, timeBoxHours: 1000 });
    const { perHourUsd, oneTimeUsd, partialHourRoundingUsd } = e.totals;
    const sr = e.stopRule;
    const spend = (h: number) =>
      ((oneTimeUsd + partialHourRoundingUsd + perHourUsd * h) * 1.25 +
        sr.accountLevelUsd +
        e.residual.worstUsd) *
      1.09;
    expect(spend(sr.maxRuntimeHours)).toBeLessThanOrEqual(13);
    expect(spend(sr.maxRuntimeHours + 0.1)).toBeGreaterThan(13);
    expect(sr.bindingLimit).toBe('stop-rule');
    expect(sr.maxRuntimeHoursWithoutAccountLevel).toBeGreaterThan(sr.maxRuntimeHours);
    // Prior spend shortens it; the time box caps it.
    expect(
      estimate(contractTopology(2), book, { spentUsd: 5, timeBoxHours: 1000 }).stopRule
        .maxRuntimeHours,
    ).toBeLessThan(sr.maxRuntimeHours);
    expect(
      estimate(contractTopology(2), book, { now: NOW }).stopRule.effectiveMaxRuntimeHours,
    ).toBe(8);
    expect(estimate(contractTopology(2), book, { spentUsd: 13 }).stopRule.maxRuntimeHours).toBe(0);
  });

  it('reports KMS keys pending deletion as likely free with the repo quote, and prices the unverified worst case', () => {
    const e = estimate(contractTopology(2), book, { now: NOW });
    const kms = e.residual.items.find((r) => r.id === 'RES-L1');
    expect(kms?.likelyUsd).toBe(0);
    expect(kms?.worstUsd).toBeCloseTo((3 * 8 * 24) / 730, 5);
    expect(kms?.basis).toMatch(/NOT IN THE PRICE SNAPSHOT/);
    expect(e.residual.kmsPendingDeletionCharge.quotedIn).toMatch(/aws\.amazon\.com\/kms\/pricing/);
    // No snapshot or retained backup is expected in the sandbox (destroy, automated backups deleted).
    expect(e.residual.items.some((r) => r.id === 'RES-L5' || r.id === 'RES-L6')).toBe(false);
  });

  it('totalForHours adds one-time and partial-hour rounding', () => {
    expect(totalForHours({ perHourUsd: 1, oneTimeUsd: 0.5, partialHourRoundingUsd: 0.25 }, 3)).toBe(
      3.75,
    );
  });
});

describe('estimate (offline synth)', () => {
  const sandbox = () =>
    assembly({
      'Sandbox-Foundation': {
        Nat: { Type: 'AWS::EC2::NatGateway', Properties: {} },
        Eip: { Type: 'AWS::EC2::EIP', Properties: {} },
        DataKey: {
          Type: 'AWS::KMS::Key',
          DeletionPolicy: 'Delete',
          Properties: { PendingWindowInDays: 7 },
        },
        Retained: { Type: 'AWS::KMS::Key', DeletionPolicy: 'Retain', Properties: {} },
      },
      'Sandbox-Data': {
        Db: {
          Type: 'AWS::RDS::DBInstance',
          DeletionPolicy: 'Delete',
          Properties: {
            DBInstanceClass: 'db.t4g.small',
            AllocatedStorage: '30',
            StorageType: 'gp3',
            MultiAZ: false,
            DeleteAutomatedBackups: true,
          },
        },
        Table: {
          Type: 'AWS::DynamoDB::Table',
          Properties: { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } },
        },
        Queue: { Type: 'AWS::SQS::Queue', Properties: {} },
      },
      'Sandbox-Api': {
        Alb: {
          Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
          Properties: { Scheme: 'internet-facing', Subnets: ['a', 'b', 'c'] },
        },
        Td: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: { Cpu: '512', Memory: '1024', RuntimePlatform: { CpuArchitecture: 'ARM64' } },
        },
        OneOff: { Type: 'AWS::ECS::TaskDefinition', Properties: { Cpu: '256', Memory: '512' } },
        Svc: {
          Type: 'AWS::ECS::Service',
          Properties: {
            DesiredCount: 2,
            TaskDefinition: { Ref: 'Td' },
            CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE_SPOT', Weight: 1 }],
          },
        },
        Cluster: {
          Type: 'AWS::ECS::Cluster',
          Properties: { ClusterSettings: [{ Name: 'containerInsights', Value: 'enhanced' }] },
        },
      },
      'Dev-Other': { X: { Type: 'AWS::EC2::NatGateway', Properties: {} } },
    });

  it('reads quantities and properties from the templates of the phase stacks only', () => {
    const t = synthTopology(sandbox(), 2);
    expect(t.basis.kind).toBe('synth');
    expect(t.basis.stacks).toEqual(['Sandbox-Api', 'Sandbox-Data', 'Sandbox-Foundation']);
    expect(t.natGateways).toBe(1);
    expect(t.albPublicIpv4).toBe(3);
    expect(t.rds[0]).toMatchObject({
      instanceClass: 'db.t4g.small',
      storageGiB: 30,
      snapshotOnDelete: false,
      retainsAutomatedBackups: false,
    });
    expect(t.fargateServices[0]).toMatchObject({
      desiredCount: 2,
      vcpu: 0.5,
      memoryGb: 1,
      arch: 'arm64',
      spotShare: true,
    });
    expect(t.oneOffTaskDefinitions).toBe(1);
    expect(t.kmsKeys).toBe(2);
    expect(t.kmsRetainedKeys).toBe(1);
    expect(t.kmsPendingWindowDays).toBe(7);
    expect(t.dynamodbPitrTables).toBe(1);
    expect(t.unpricedTypes).toEqual(['AWS::SQS::Queue']);
  });

  it('prices the synth shape conservatively and lists what it cannot price', () => {
    const e = estimate(synthTopology(sandbox(), 2), book, { now: NOW });
    expect(line(e, 'SBX-06a')?.usdPerHour).toBe(0.051);
    expect(line(e, 'SBX-08a')?.component).toMatch(/Spot share priced on-demand/);
    expect(line(e, 'SBX-08a')?.usdPerHour).toBeCloseTo(2 * (0.5 * 0.04045 + 1 * 0.00442), 6);
    expect(line(e, 'SBX-02')?.quantity).toBe(4);
    expect(e.residual.items.find((r) => r.id === 'RES-L2')?.likelyUsd).toBeCloseTo(
      (30 * 24) / 730,
      5,
    );
    expect(e.notes).toContain('UNPRICED resource type in the synth: AWS::SQS::Queue');
  });

  it('notes an RDS class that is not in the snapshot instead of inventing a price', () => {
    const dir = assembly({
      'Sandbox-Data': {
        Db: { Type: 'AWS::RDS::DBInstance', Properties: { DBInstanceClass: 'db.x9.huge' } },
      },
    });
    const e = estimate(synthTopology(dir, 2), book);
    expect(e.notes.some((n) => /UNPRICED: RDS class db\.x9\.huge/.test(n))).toBe(true);
    expect(e.lineItems.some((i) => i.id.startsWith('SBX-06'))).toBe(false);
  });

  it('refuses a synth without stacks of the phase', () => {
    expect(() => synthTopology(assembly({ 'Dev-Api': {} }), 2)).toThrow(SynthError);
    expect(() => synthTopology(join(tmpdir(), 'does-not-exist-starter'), 1)).toThrow(SynthError);
  });
});

describe('price book', () => {
  it('loads the dated finops snapshot and the supplement', () => {
    expect(book.snapshot.version).toBe('2026.10.13-1');
    expect(book.snapshot.capturedAt).toBe('2026-10-13');
    expect(book.supplement.capturedAt).toBe('2026-10-14');
    expect(loadSupplement(DEFAULT_SUPPLEMENT).notLivePricing).toMatch(/NOT LIVE PRICING/);
    expect(book.rdsInstanceHour('db.t4g.micro', false)?.usd).toBe(0.025);
  });

  it('prices single resources for the inventory', () => {
    expect(resourceHourlyUsd('AWS::EC2::NatGateway', book)).toBe(0.059);
    expect(
      resourceHourlyUsd('AWS::ElasticLoadBalancingV2::LoadBalancer', book, {
        albPublicIpv4PerAlb: 0,
      }),
    ).toBeCloseTo(0.0332, 6);
    expect(resourceHourlyUsd('AWS::Lambda::Function', book)).toBe(0);
  });
});

describe('estimate CLI', () => {
  it('writes the JSON and Markdown and prints the table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'starter-est-'));
    const r = await runCli(
      ['estimate', '--phase', '2', '--hours', '6', '--out', 'e.json', '--markdown', 'e.md'],
      { cwd: dir },
    );
    expect(r.code).toBe(EXIT.OK);
    const json = estimateSchema.parse(JSON.parse(readFileSync(join(dir, 'e.json'), 'utf8')));
    expect(json.totals.byHours.map((h) => h.hours)).toEqual([2, 4, 6, 8]);
    expect(readFileSync(join(dir, 'e.md'), 'utf8')).toMatch(/Maximum runtime under USD 13/);
    expect(r.out).toMatch(/not live pricing/);
  });

  it('rejects a bad phase and a negative number', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'starter-est-'));
    expect((await runCli(['estimate', '--phase', '3'], { cwd: dir })).code).toBe(EXIT.USAGE);
    expect((await runCli(['estimate', '--phase', '2', '--spent', '-1'], { cwd: dir })).code).toBe(
      EXIT.USAGE,
    );
    expect((await runCli(['estimate', '--phase', '2', '--bogus'], { cwd: dir })).code).toBe(
      EXIT.USAGE,
    );
  });
});
