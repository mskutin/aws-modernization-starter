/**
 * Offline template diff between base and head synthesized templates:
 * added/removed/modified resources, cost-relevant property changes and
 * destructive changes (data loss or protection removal).
 *
 * This is a static comparison of templates. It does NOT call CloudFormation
 * change sets, so replacement detection uses the curated table below
 * ("Update requires: Replacement" in the CloudFormation resource reference)
 * and is intentionally conservative but not exhaustive.
 */
import type { Environment } from './config.js';
import { cdkPathOf, type CfnResource, type LoadedTemplate } from './templates.js';

/** Resource types whose deletion or replacement loses data or keys. */
export const STATEFUL_TYPES: ReadonlySet<string> = new Set([
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBCluster',
  'AWS::DynamoDB::Table',
  'AWS::DynamoDB::GlobalTable',
  'AWS::S3::Bucket',
  'AWS::KMS::Key',
  'AWS::Logs::LogGroup',
  'AWS::SecretsManager::Secret',
  'AWS::ECR::Repository',
  'AWS::EFS::FileSystem',
]);

/**
 * Properties whose change forces REPLACEMENT of a stateful resource
 * (curated subset of the CloudFormation resource reference, 2026-10).
 */
export const REPLACEMENT_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  'AWS::RDS::DBInstance': [
    'DBInstanceIdentifier',
    'DBName',
    'Engine',
    'KmsKeyId',
    'StorageEncrypted',
    'MasterUsername',
    'CharacterSetName',
    'DBClusterIdentifier',
    'DBSnapshotIdentifier',
    'SourceDBInstanceIdentifier',
    'DBSubnetGroupName',
  ],
  'AWS::RDS::DBCluster': [
    'DBClusterIdentifier',
    'DatabaseName',
    'Engine',
    'KmsKeyId',
    'StorageEncrypted',
    'MasterUsername',
    'SnapshotIdentifier',
    'SourceDBClusterIdentifier',
    'DBSubnetGroupName',
  ],
  'AWS::DynamoDB::Table': ['TableName', 'KeySchema', 'LocalSecondaryIndexes'],
  'AWS::DynamoDB::GlobalTable': ['TableName', 'KeySchema', 'LocalSecondaryIndexes'],
  'AWS::S3::Bucket': ['BucketName', 'ObjectLockEnabled'],
  'AWS::KMS::Key': ['KeySpec', 'KeyUsage', 'MultiRegion', 'Origin'],
  'AWS::Logs::LogGroup': ['LogGroupName'],
  'AWS::SecretsManager::Secret': ['Name'],
  'AWS::ECR::Repository': ['RepositoryName'],
  'AWS::EFS::FileSystem': ['Encrypted', 'KmsKeyId', 'PerformanceMode'],
};

/** Properties that drive cost; changes are always surfaced, even for unpriced resources. */
export const COST_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  'AWS::RDS::DBInstance': [
    'DBInstanceClass',
    'AllocatedStorage',
    'MaxAllocatedStorage',
    'StorageType',
    'Iops',
    'StorageThroughput',
    'MultiAZ',
    'BackupRetentionPeriod',
    'EnablePerformanceInsights',
    'MonitoringInterval',
  ],
  'AWS::RDS::DBCluster': [
    'ServerlessV2ScalingConfiguration',
    'DBClusterInstanceClass',
    'StorageType',
  ],
  'AWS::ECS::Service': ['DesiredCount', 'LaunchType', 'CapacityProviderStrategy'],
  'AWS::ECS::TaskDefinition': ['Cpu', 'Memory', 'RuntimePlatform'],
  'AWS::ApplicationAutoScaling::ScalableTarget': ['MinCapacity', 'MaxCapacity'],
  'AWS::CloudFront::Distribution': ['DistributionConfig.PriceClass'],
  'AWS::DynamoDB::Table': [
    'BillingMode',
    'ProvisionedThroughput',
    'GlobalSecondaryIndexes',
    'PointInTimeRecoverySpecification',
    'TableClass',
  ],
  'AWS::DynamoDB::GlobalTable': ['BillingMode', 'Replicas', 'WriteProvisionedThroughputSettings'],
  'AWS::Lambda::Function': ['MemorySize', 'Architectures', 'Timeout', 'EphemeralStorage'],
  'AWS::Lambda::Alias': ['ProvisionedConcurrencyConfig'],
  'AWS::Lambda::Version': ['ProvisionedConcurrencyConfig'],
  'AWS::Logs::LogGroup': ['RetentionInDays', 'LogGroupClass'],
  'AWS::EC2::VPCEndpoint': ['SubnetIds', 'VpcEndpointType'],
  'AWS::StepFunctions::StateMachine': ['StateMachineType'],
};

/** Resource types that are expensive enough that adding/removing them is always reported. */
export const EXPENSIVE_TYPES: ReadonlySet<string> = new Set([
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBCluster',
  'AWS::EC2::NatGateway',
  'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::CloudFront::Distribution',
  'AWS::ECS::Service',
  'AWS::EC2::VPCEndpoint',
  'AWS::DynamoDB::Table',
  'AWS::DynamoDB::GlobalTable',
]);

const RETAINING = ['Retain', 'Snapshot', 'RetainExceptOnCreate'];

export interface PropertyChange {
  property: string;
  before: unknown;
  after: unknown;
  costRelevant: boolean;
  forcesReplacement: boolean;
}

export interface ResourceChange {
  stack: string;
  environment: Environment | undefined;
  logicalId: string;
  type: string;
  cdkPath: string | undefined;
  kind: 'added' | 'removed' | 'modified';
  changes: PropertyChange[];
}

export type DestructiveKind =
  'stateful-removed' | 'stateful-replaced' | 'retention-weakened' | 'protection-disabled';

export interface DestructiveChange {
  kind: DestructiveKind;
  stack: string;
  environment: Environment | undefined;
  logicalId: string;
  type: string;
  cdkPath: string | undefined;
  detail: string;
}

export interface TemplateDiff {
  resources: ResourceChange[];
  destructive: DestructiveChange[];
  /** Added/removed resources of expensive types and cost-relevant property changes. */
  costRelevant: ResourceChange[];
}

const getPath = (obj: unknown, dotted: string): unknown =>
  dotted
    .split('.')
    .reduce<unknown>(
      (cur, k) =>
        cur && typeof cur === 'object' && !Array.isArray(cur)
          ? (cur as Record<string, unknown>)[k]
          : undefined,
      obj,
    );

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function propertyChanges(type: string, base: CfnResource, head: CfnResource): PropertyChange[] {
  const out: PropertyChange[] = [];
  const bp = base.Properties ?? {};
  const hp = head.Properties ?? {};
  const replacement = REPLACEMENT_PROPERTIES[type] ?? [];
  const cost = COST_PROPERTIES[type] ?? [];
  for (const key of [...new Set([...Object.keys(bp), ...Object.keys(hp)])].sort()) {
    if (key === 'Tags' || same(bp[key], hp[key])) continue;
    out.push({
      property: key,
      before: bp[key],
      after: hp[key],
      costRelevant: cost.includes(key),
      forcesReplacement: replacement.includes(key),
    });
  }
  for (const nested of cost.filter((c) => c.includes('.'))) {
    const before = getPath(bp, nested);
    const after = getPath(hp, nested);
    if (!same(before, after)) {
      out.push({ property: nested, before, after, costRelevant: true, forcesReplacement: false });
    }
  }
  for (const attr of ['DeletionPolicy', 'UpdateReplacePolicy'] as const) {
    if (base[attr] !== head[attr]) {
      out.push({
        property: attr,
        before: base[attr],
        after: head[attr],
        costRelevant: false,
        forcesReplacement: false,
      });
    }
  }
  return out;
}

const truthy = (v: unknown) => v === true || v === 'true';

function destructiveFor(change: ResourceChange, base?: CfnResource): DestructiveChange[] {
  const out: DestructiveChange[] = [];
  const ctx = {
    stack: change.stack,
    environment: change.environment,
    logicalId: change.logicalId,
    type: change.type,
    cdkPath: change.cdkPath,
  };
  if (!STATEFUL_TYPES.has(change.type)) return out;
  if (change.kind === 'removed') {
    const policy = base?.DeletionPolicy ?? 'Delete';
    out.push({
      ...ctx,
      kind: 'stateful-removed',
      detail: RETAINING.includes(policy)
        ? `Removed from the template; DeletionPolicy ${policy} keeps (orphans/snapshots) the physical resource.`
        : `Removed from the template with DeletionPolicy ${policy}: the resource and its data will be DELETED.`,
    });
    return out;
  }
  if (change.kind !== 'modified') return out;
  const replaced = change.changes.filter((c) => c.forcesReplacement);
  if (replaced.length > 0) {
    out.push({
      ...ctx,
      kind: 'stateful-replaced',
      detail: `Changing ${replaced.map((c) => c.property).join(', ')} forces REPLACEMENT (new resource, old one ${
        RETAINING.includes(base?.UpdateReplacePolicy ?? 'Delete') ? 'retained' : 'deleted'
      }).`,
    });
  }
  for (const c of change.changes) {
    if (
      (c.property === 'DeletionPolicy' || c.property === 'UpdateReplacePolicy') &&
      RETAINING.includes(String(c.before ?? 'Delete')) &&
      !RETAINING.includes(String(c.after ?? 'Delete'))
    ) {
      out.push({
        ...ctx,
        kind: 'retention-weakened',
        detail: `${c.property} ${String(c.before)} → ${String(c.after ?? 'Delete (default)')}.`,
      });
    }
    if (
      (c.property === 'DeletionProtection' || c.property === 'DeletionProtectionEnabled') &&
      truthy(c.before) &&
      !truthy(c.after)
    ) {
      out.push({
        ...ctx,
        kind: 'protection-disabled',
        detail: `${c.property} true → ${String(c.after ?? 'unset')}.`,
      });
    }
  }
  return out;
}

/** Diffs two sets of synthesized templates keyed by their path under cdk.out. */
export function diffTemplates(
  base: Map<string, LoadedTemplate>,
  head: Map<string, LoadedTemplate>,
): TemplateDiff {
  const resources: ResourceChange[] = [];
  const destructive: DestructiveChange[] = [];
  for (const stack of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    const b = base.get(stack)?.template.Resources ?? {};
    const h = head.get(stack)?.template.Resources ?? {};
    const environment = head.get(stack)?.environment ?? base.get(stack)?.environment;
    for (const logicalId of [...new Set([...Object.keys(b), ...Object.keys(h)])].sort()) {
      const br = b[logicalId];
      const hr = h[logicalId];
      let change: ResourceChange | undefined;
      if (!br && hr) {
        change = {
          stack,
          environment,
          logicalId,
          type: hr.Type,
          cdkPath: cdkPathOf(hr),
          kind: 'added',
          changes: [],
        };
      } else if (br && !hr) {
        change = {
          stack,
          environment,
          logicalId,
          type: br.Type,
          cdkPath: cdkPathOf(br),
          kind: 'removed',
          changes: [],
        };
      } else if (br && hr) {
        if (br.Type !== hr.Type) {
          // Same logical ID, different type: CloudFormation replaces it.
          resources.push({
            stack,
            environment,
            logicalId,
            type: br.Type,
            cdkPath: cdkPathOf(br),
            kind: 'removed',
            changes: [],
          });
          destructive.push(
            ...destructiveFor(resources[resources.length - 1] as ResourceChange, br),
          );
          change = {
            stack,
            environment,
            logicalId,
            type: hr.Type,
            cdkPath: cdkPathOf(hr),
            kind: 'added',
            changes: [],
          };
        } else {
          const changes = propertyChanges(br.Type, br, hr);
          if (changes.length === 0) continue;
          change = {
            stack,
            environment,
            logicalId,
            type: hr.Type,
            cdkPath: cdkPathOf(hr),
            kind: 'modified',
            changes,
          };
        }
      }
      if (!change) continue;
      resources.push(change);
      destructive.push(...destructiveFor(change, br));
    }
  }
  const costRelevant = resources.filter((r) =>
    r.kind === 'modified' ? r.changes.some((c) => c.costRelevant) : EXPENSIVE_TYPES.has(r.type),
  );
  return { resources, destructive, costRelevant };
}
