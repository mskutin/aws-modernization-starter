import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/cli.js';
import { renderInventory } from '../src/render.js';
import { inventorySchema, type Inventory } from '../src/schemas.js';
import {
  ACCOUNT,
  arn,
  assembly,
  awsArgs,
  awsError,
  fakeAws,
  fakeGuard,
  ok,
  RUN_ID,
  runCli,
  runTags,
  workspace,
  type Responder,
} from './support.js';

const stackId = (name: string) =>
  arn('cloudformation', `stack/${name}/00000000-0000-4000-8000-000000000001`);
const NESTED = 'Sandbox-Data-RotationNestedStack-ABC123';

function account(): Record<string, Responder> {
  const resources: Record<string, unknown[]> = {
    [stackId('Sandbox-Foundation')]: [
      {
        LogicalResourceId: 'Nat',
        ResourceType: 'AWS::EC2::NatGateway',
        PhysicalResourceId: 'nat-00000000000000002',
        ResourceStatus: 'CREATE_COMPLETE',
        LastUpdatedTimestamp: '2026-10-20T08:06:00Z',
      },
      {
        LogicalResourceId: 'NatEip',
        ResourceType: 'AWS::EC2::EIP',
        PhysicalResourceId: '203.0.113.10',
        ResourceStatus: 'CREATE_COMPLETE',
      },
      {
        LogicalResourceId: 'DataKey',
        ResourceType: 'AWS::KMS::Key',
        PhysicalResourceId: '00000000-0000-4000-8000-000000000001',
        ResourceStatus: 'CREATE_COMPLETE',
      },
      {
        LogicalResourceId: 'Vpc',
        ResourceType: 'AWS::EC2::VPC',
        PhysicalResourceId: 'vpc-00000000000000009',
        ResourceStatus: 'CREATE_COMPLETE',
      },
    ],
    [stackId('Sandbox-Data')]: [
      {
        LogicalResourceId: 'Database',
        ResourceType: 'AWS::RDS::DBInstance',
        PhysicalResourceId: 'starter-sbx-postgres',
        ResourceStatus: 'CREATE_COMPLETE',
      },
      {
        LogicalResourceId: 'MasterSecret',
        ResourceType: 'AWS::SecretsManager::Secret',
        PhysicalResourceId: arn('secretsmanager', 'secret:starter-sbx/rds/master-AbCdEf'),
        ResourceStatus: 'CREATE_COMPLETE',
      },
      {
        LogicalResourceId: 'DbLogs',
        ResourceType: 'AWS::Logs::LogGroup',
        PhysicalResourceId: '/aws/rds/instance/starter-sbx-postgres/postgresql',
        ResourceStatus: 'CREATE_COMPLETE',
      },
      {
        LogicalResourceId: 'Rotation',
        ResourceType: 'AWS::CloudFormation::Stack',
        PhysicalResourceId: arn('cloudformation', `stack/${NESTED}/2`),
        ResourceStatus: 'CREATE_COMPLETE',
      },
    ],
    [arn('cloudformation', `stack/${NESTED}/2`)]: [
      {
        LogicalResourceId: 'RotationFn',
        ResourceType: 'AWS::Lambda::Function',
        PhysicalResourceId: `${NESTED}-fn`,
        ResourceStatus: 'CREATE_COMPLETE',
      },
    ],
    [stackId('Sandbox-Api')]: [
      {
        LogicalResourceId: 'Alb',
        ResourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        PhysicalResourceId: arn('elasticloadbalancing', 'loadbalancer/app/starter-sbx-api/abc'),
        ResourceStatus: 'CREATE_COMPLETE',
      },
      {
        LogicalResourceId: 'Service',
        ResourceType: 'AWS::ECS::Service',
        PhysicalResourceId: arn('ecs', 'service/starter-sbx-cluster/starter-sbx-api'),
        ResourceStatus: 'CREATE_COMPLETE',
      },
      {
        LogicalResourceId: 'Old',
        ResourceType: 'AWS::EC2::NatGateway',
        PhysicalResourceId: 'nat-old',
        ResourceStatus: 'DELETE_COMPLETE',
      },
    ],
    [stackId('starter-cdk-toolkit')]: [],
  };
  return {
    'cloudformation describe-stacks': ok({
      Stacks: [
        {
          StackName: 'Sandbox-Foundation',
          StackId: stackId('Sandbox-Foundation'),
          StackStatus: 'CREATE_COMPLETE',
          CreationTime: '2026-10-20T08:00:00Z',
          Tags: [...runTags(), { Key: 'starter:expires-at', Value: '2026-10-20T16:00:00Z' }],
        },
        {
          StackName: 'Sandbox-Data',
          StackId: stackId('Sandbox-Data'),
          StackStatus: 'CREATE_COMPLETE',
          CreationTime: '2026-10-20T08:10:00Z',
          Tags: runTags(),
        },
        {
          StackName: NESTED,
          StackId: arn('cloudformation', `stack/${NESTED}/2`),
          ParentId: stackId('Sandbox-Data'),
          StackStatus: 'CREATE_COMPLETE',
          Tags: runTags(),
        },
        {
          StackName: 'Sandbox-Api',
          StackId: stackId('Sandbox-Api'),
          StackStatus: 'UPDATE_COMPLETE',
          CreationTime: '2026-10-20T08:30:00Z',
          EnableTerminationProtection: false,
          Tags: runTags(),
        },
        {
          StackName: 'Sandbox-Frontend',
          StackId: stackId('Sandbox-Frontend'),
          StackStatus: 'CREATE_COMPLETE',
          CreationTime: '2026-10-19T08:00:00Z',
          Tags: runTags('sbx-ffffff'),
        },
        {
          StackName: 'starter-cdk-toolkit',
          StackId: stackId('starter-cdk-toolkit'),
          StackStatus: 'CREATE_COMPLETE',
          CreationTime: '2026-10-20T07:00:00Z',
          Tags: [],
        },
        {
          StackName: 'acme-payments-prod',
          StackId: stackId('acme-payments-prod'),
          StackStatus: 'CREATE_COMPLETE',
          Tags: [],
        },
      ],
    }),
    'cloudformation list-stack-resources': (args) =>
      ok({ StackResourceSummaries: resources[args[args.indexOf('--stack-name') + 1] ?? ''] ?? [] }),
    'cloudformation describe-stack-events': (args) => {
      const ref = args[args.indexOf('--stack-name') + 1] ?? '';
      // Newest first, as the API returns them.
      return ok({
        StackEvents: (resources[ref] ?? []).flatMap((r) => {
          const lid = (r as { LogicalResourceId: string }).LogicalResourceId;
          return [
            {
              LogicalResourceId: lid,
              ResourceStatus: 'CREATE_COMPLETE',
              Timestamp: '2026-10-20T08:05:00Z',
              ResourceStatusReason: `token=${'x'.repeat(5)}`,
            },
            {
              LogicalResourceId: lid,
              ResourceStatus: 'CREATE_IN_PROGRESS',
              Timestamp: '2026-10-20T08:01:00Z',
            },
          ];
        }),
      });
    },
  };
}

async function inventory(
  responses: Record<string, Responder>,
  extra: string[] = [],
  guardMode: Parameters<typeof fakeGuard>[0] = 'ok',
) {
  const ws = workspace();
  const aws = fakeAws(responses);
  const guard = fakeGuard(guardMode);
  const outFile = join(ws.dir, 'inv', 'inventory.json');
  const mdFile = join(ws.dir, 'inv', 'resource-inventory.md');
  const r = await runCli(
    [
      'inventory',
      '--run-id',
      RUN_ID,
      '--out',
      outFile,
      '--markdown',
      mdFile,
      ...awsArgs(ws),
      ...extra,
    ],
    { aws, guard, cwd: ws.dir },
  );
  const text = readFileSync(outFile, 'utf8');
  return {
    ...r,
    aws,
    guard,
    text,
    report: inventorySchema.parse(JSON.parse(text)) as Inventory,
    mdFile,
  };
}

describe('inventory', () => {
  it('lists the run stacks and resources with creation times and hourly cost, and the runtime limits', async () => {
    const { code, report, aws } = await inventory(account());
    expect(code).toBe(EXIT.OK);
    expect(report.phase).toBe(2);
    expect(report.status).toBe('ok');
    expect(report.account).toBe('********3333');
    expect(report.stacks.map((s) => s.name)).toEqual([
      'Sandbox-Foundation',
      'Sandbox-Data',
      'Sandbox-Api',
    ]);
    expect(report.otherRunStacks).toEqual([{ name: 'Sandbox-Frontend', runId: 'sbx-ffffff' }]);
    expect(report.bootstrap?.name).toBe('starter-cdk-toolkit');

    const foundation = report.stacks[0];
    const nat = foundation?.resources.find((r) => r.logicalId === 'Nat');
    expect(nat).toMatchObject({
      type: 'AWS::EC2::NatGateway',
      physicalId: 'nat-00000000000000002',
      createdAt: '2026-10-20T08:01:00.000Z',
      hourlyUsd: 0.059,
    });
    expect(foundation?.resources.find((r) => r.logicalId === 'DataKey')?.hourlyUsd).toBeCloseTo(
      1 / 730,
      6,
    );

    const data = report.stacks[1];
    expect(data?.resources.find((r) => r.logicalId === 'RotationFn')?.nestedStack).toBe(NESTED);
    expect(data?.resources.find((r) => r.logicalId === 'Database')?.hourlyUsd).toBeCloseTo(
      0.025 + (20 * 0.138) / 730,
      6,
    );

    const api = report.stacks[2];
    // Internet-facing ALB (contract): ALB hour + LCU + 2 public IPv4.
    expect(api?.resources.find((r) => r.logicalId === 'Alb')?.hourlyUsd).toBeCloseTo(
      0.0252 + 0.008 + 0.01,
      6,
    );
    expect(api?.resources.find((r) => r.logicalId === 'Old')?.hourlyUsd).toBe(0);

    expect(report.cost.startedAt).toBe('2026-10-20T08:00:00.000Z');
    expect(report.cost.elapsedHours).toBe(4);
    expect(report.cost.totalUsdPerHour).toBeCloseTo(
      report.cost.resourcesUsdPerHour + report.cost.otherUsdPerHour,
      6,
    );
    expect(report.cost.estimatedSpendSoFarUsd).toBeGreaterThan(0);
    expect(report.runtime.effectiveMaxRuntimeHours).toBe(8);
    expect(report.runtime.allDeletedBy).toBe('2026-10-20T16:00:00.000Z');
    expect(report.runtime.teardownStartBy).toBe('2026-10-20T14:00:00.000Z');
    expect(report.runtime.expiresAtTag).toBe('2026-10-20T16:00:00Z');
    expect(report.teardown.command).toMatch(
      /^SBX_RUN_ID=sbx-a1b2c3 tests\/aws-integration\/sandbox\/down\.sh /,
    );
    expect(report.teardown.verifyCommand).toContain('--inventory');
    // Ids verify-clean needs after the stacks are gone (masked like the rest).
    expect(report.experimentResources).toEqual({
      kmsKeys: [
        {
          stack: 'Sandbox-Foundation',
          logicalId: 'DataKey',
          keyId: '00000000-0000-4000-8000-000000000001',
          arn: 'arn:aws:kms:ap-southeast-1:********3333:key/00000000-0000-4000-8000-000000000001',
        },
      ],
      secrets: [
        {
          stack: 'Sandbox-Data',
          logicalId: 'MasterSecret',
          arn: 'arn:aws:secretsmanager:ap-southeast-1:********3333:secret:starter-sbx/rds/master-AbCdEf',
        },
      ],
      logGroups: [
        {
          stack: 'Sandbox-Data',
          logicalId: 'DbLogs',
          name: '/aws/rds/instance/starter-sbx-postgres/postgresql',
        },
      ],
    });
    expect(report.teardown.verifyCommand).toContain(`verify-clean --run-id ${RUN_ID}`);
    expect(
      aws
        .ops()
        .every((o) =>
          /^cloudformation (describe-stacks|list-stack-resources|describe-stack-events)$/.test(o),
        ),
    ).toBe(true);
  });

  it('masks account ids and IPv4 addresses and keeps no stack event reasons', async () => {
    const { text, mdFile, report } = await inventory(account());
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain('token=');
    // An EIP's physical id is its public IPv4 address: redacted.
    expect(text).not.toContain('203.0.113.10');
    expect(report.stacks[0]?.resources.find((r) => r.logicalId === 'NatEip')?.physicalId).toBe(
      '<ipv4-redacted>',
    );
    const md = readFileSync(mdFile, 'utf8');
    expect(md).toMatch(/^# Live validation — resource inventory, run `sbx-a1b2c3` \(Phase 2\)/);
    expect(md).toMatch(/\| Nat \| AWS::EC2::NatGateway \| nat-00000000000000002 \|/);
    expect(md).not.toContain(ACCOUNT);
  });

  it('infers Phase 1 from an it- run id and selects only starter-it-<runId>', async () => {
    const ws = workspace();
    const aws = fakeAws({
      'cloudformation describe-stacks': ok({
        Stacks: [
          {
            StackName: 'starter-it-it-abc123',
            StackId: stackId('starter-it-it-abc123'),
            StackStatus: 'CREATE_COMPLETE',
            CreationTime: '2026-10-20T11:00:00Z',
            Tags: runTags('it-abc123'),
          },
          {
            StackName: 'starter-it-it-000000',
            StackId: stackId('starter-it-it-000000'),
            StackStatus: 'CREATE_COMPLETE',
            Tags: [],
          },
        ],
      }),
    });
    const r = await runCli(
      ['inventory', '--run-id', 'it-abc123', '--out', join(ws.dir, 'i.json'), ...awsArgs(ws)],
      { aws, guard: fakeGuard(), cwd: ws.dir },
    );
    expect(r.code).toBe(EXIT.OK);
    const report = inventorySchema.parse(JSON.parse(readFileSync(join(ws.dir, 'i.json'), 'utf8')));
    expect(report.phase).toBe(1);
    expect(report.stacks.map((s) => s.name)).toEqual(['starter-it-it-abc123']);
    expect(report.runtime.timeBoxHours).toBe(4);
    expect(report.teardown.command).toMatch(/cleanup\.sh/);
  });

  it('reports no-stacks when nothing of the run exists', async () => {
    const { code, report } = await inventory({
      'cloudformation describe-stacks': ok({ Stacks: [] }),
    });
    expect(code).toBe(EXIT.OK);
    expect(report.status).toBe('no-stacks');
  });

  it('is incomplete (exit 4) when a read fails', async () => {
    const { code, report } = await inventory({
      ...account(),
      'cloudformation describe-stack-events': awsError('Throttling'),
    });
    expect(code).toBe(EXIT.INCOMPLETE);
    expect(report.errors[0]?.kind).toBe('throttled');
  });

  it('refuses (exit 3) without AWS calls when the guard refuses', async () => {
    const { code, report, aws } = await inventory(account(), [], 'refuse');
    expect(code).toBe(EXIT.REFUSED);
    expect(aws.calls).toHaveLength(0);
    expect(report.status).toBe('guard-refused');
    expect(report.stacks).toEqual([]);
  });

  it('prices resources from the synthesized template when --synth is given', async () => {
    const synth = assembly({
      'Sandbox-Api': {
        Alb: {
          Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
          Properties: { Scheme: 'internal', Subnets: ['a', 'b'] },
        },
        Td: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: { Cpu: '512', Memory: '1024', RuntimePlatform: { CpuArchitecture: 'ARM64' } },
        },
        Service: {
          Type: 'AWS::ECS::Service',
          Properties: { DesiredCount: 2, TaskDefinition: { Ref: 'Td' } },
        },
      },
    });
    const { report } = await inventory(account(), ['--synth', synth]);
    const api = report.stacks.find((s) => s.name === 'Sandbox-Api');
    // Internal ALB in this template: no public IPv4 addresses.
    expect(api?.resources.find((r) => r.logicalId === 'Alb')?.hourlyUsd).toBeCloseTo(
      0.0252 + 0.008,
      6,
    );
    expect(api?.resources.find((r) => r.logicalId === 'Service')?.hourlyUsd).toBeCloseTo(
      2 * (0.5 * 0.04045 + 1 * 0.00442),
      5,
    );
  });

  it('renders the inventory Markdown, also through the render command after schema validation', async () => {
    const { report, mdFile } = await inventory(account());
    expect(renderInventory(report)).toMatch(/## Teardown/);
    const dir = mdFile.replace(/\/[^/]+$/, '');
    const r = await runCli(
      ['render', '--in', join(dir, 'inventory.json'), '--out', join(dir, 'again.md')],
      { cwd: dir },
    );
    expect(r.code).toBe(EXIT.OK);
    expect(readFileSync(join(dir, 'again.md'), 'utf8')).toBe(readFileSync(mdFile, 'utf8'));
    const bad = await runCli(['render', '--in', join(dir, 'resource-inventory.md')], { cwd: dir });
    expect(bad.code).toBe(EXIT.USAGE);
  });
});
