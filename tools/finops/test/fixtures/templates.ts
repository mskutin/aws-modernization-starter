/** Deterministic synthetic cdk.out fixtures (no AWS, no network). */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CfnResource, CfnTemplate } from '../../src/templates.js';

export const tags = (env: string) => [
  { Key: 'Project', Value: 'aws-modernization-starter' },
  { Key: 'Environment', Value: env },
];

const meta = (path: string) => ({ 'aws:cdk:path': path });

export function dataStack(env = 'prod'): CfnTemplate {
  return {
    Resources: {
      Database: {
        Type: 'AWS::RDS::DBInstance',
        DeletionPolicy: 'Snapshot',
        UpdateReplacePolicy: 'Snapshot',
        Metadata: meta('Prod/Data/Database/Resource'),
        Properties: {
          Engine: 'postgres',
          DBInstanceClass: 'db.t4g.medium',
          AllocatedStorage: '50',
          StorageType: 'gp3',
          MultiAZ: false,
          StorageEncrypted: true,
          DeletionProtection: true,
          Tags: tags(env),
        },
      },
      JobsTable: {
        Type: 'AWS::DynamoDB::Table',
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
        Metadata: meta('Prod/Data/JobsTable/Resource'),
        Properties: {
          BillingMode: 'PAY_PER_REQUEST',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          GlobalSecondaryIndexes: [{ IndexName: 'gsi1' }],
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          DeletionProtectionEnabled: true,
          Tags: tags(env),
        },
      },
      DataKey: {
        Type: 'AWS::KMS::Key',
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
        Properties: { KeySpec: 'SYMMETRIC_DEFAULT', Tags: tags(env) },
      },
      Assets: {
        Type: 'AWS::S3::Bucket',
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
        Properties: { BucketName: 'starter-prod-assets', Tags: tags(env) },
      },
      Budget: {
        Type: 'AWS::Budgets::Budget',
        Properties: {
          Budget: { BudgetName: 'starter-prd-monthly', BudgetLimit: { Amount: 1500, Unit: 'USD' } },
        },
      },
    },
  };
}

export function apiStack(env = 'prod'): CfnTemplate {
  return {
    Resources: {
      TaskDef: {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: {
          Cpu: '512',
          Memory: '1024',
          RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
          Tags: tags(env),
        },
      },
      Service: {
        Type: 'AWS::ECS::Service',
        Metadata: meta('Prod/Api/Service/Resource'),
        Properties: {
          TaskDefinition: { Ref: 'TaskDef' },
          CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE', Weight: 1 }],
          DesiredCount: 2,
          Tags: tags(env),
        },
      },
      Alb: {
        Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        Properties: { Type: 'application', Tags: tags(env) },
      },
      ApiLogs: {
        Type: 'AWS::Logs::LogGroup',
        Properties: { RetentionInDays: 30, Tags: tags(env) },
      },
      Fn: {
        Type: 'AWS::Lambda::Function',
        Properties: { MemorySize: 512, Architectures: ['arm64'], Tags: tags(env) },
      },
    },
  };
}

export type Assembly = Record<string, CfnTemplate>;

export const baseAssembly = (): Assembly => ({
  'assembly-Prod/ProdData.template.json': dataStack(),
  'assembly-Prod/ProdApi.template.json': apiStack(),
});

/** Writes an assembly (path → template) into a fresh temporary cdk.out directory. */
export function writeAssembly(assembly: Assembly): string {
  const dir = mkdtempSync(join(tmpdir(), 'starter-finops-'));
  for (const [rel, template] of Object.entries(assembly)) {
    const file = join(dir, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(template));
  }
  return dir;
}

/** Deep-clones an assembly and applies `mutate` to one resource. */
export function withResource(
  assembly: Assembly,
  stack: string,
  logicalId: string,
  mutate: (r: CfnResource | undefined) => CfnResource | undefined,
): Assembly {
  const copy = JSON.parse(JSON.stringify(assembly)) as Assembly;
  const resources = (copy[stack] as CfnTemplate).Resources as Record<string, CfnResource>;
  const next = mutate(resources[logicalId]);
  if (next) resources[logicalId] = next;
  else delete resources[logicalId];
  return copy;
}

export const DATA = 'assembly-Prod/ProdData.template.json';
export const API = 'assembly-Prod/ProdApi.template.json';
