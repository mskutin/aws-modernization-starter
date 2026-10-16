/**
 * What the estimate prices: the cost-relevant shape of a phase. Two sources:
 *  - `contractTopology(phase)`: the planned resource list of the full sandbox stage (Phase 2) and
 *    the existing integration mini-stack (Phase 1), with every quantity the plan does not fix
 *    marked as an assumption;
 *  - `synthTopology(dir, phase)`: the offline synth (`cdk.out`, `-c envs=sandbox` or the
 *    integration app), read from the cloud-assembly manifests and templates. No AWS access.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Phase = 1 | 2;
export type Arch = 'arm64' | 'x86_64';
export type ContainerInsights = 'enhanced' | 'enabled' | 'disabled' | 'none';

export interface RdsShape {
  readonly logicalId: string;
  readonly instanceClass: string;
  readonly multiAz: boolean;
  readonly storageGiB: number;
  readonly storageType: string;
  /** DeletionPolicy Snapshot leaves a final snapshot (billed until deleted). */
  readonly snapshotOnDelete: boolean;
  /** DeleteAutomatedBackups=false keeps automated backups after the instance is deleted. */
  readonly retainsAutomatedBackups: boolean;
}

export interface FargateShape {
  readonly logicalId: string;
  readonly desiredCount: number;
  readonly vcpu: number;
  readonly memoryGb: number;
  readonly arch: Arch;
  /** A FARGATE_SPOT share exists; priced as on-demand anyway (conservative; Spot is not listed). */
  readonly spotShare: boolean;
}

export interface Topology {
  readonly phase: Phase;
  readonly basis: {
    readonly kind: 'contract' | 'synth';
    /** Where the shape came from (contract section or synth directory). */
    readonly ref: string;
    /** CloudFormation stack names covered. */
    readonly stacks: readonly string[];
  };
  readonly natGateways: number;
  /** Elastic IPs (public IPv4, e.g. the NAT gateway's). */
  readonly elasticIps: number;
  readonly albs: number;
  /** Public IPv4 addresses of internet-facing load balancers (one per AZ node). */
  readonly albPublicIpv4: number;
  readonly rds: readonly RdsShape[];
  readonly fargateServices: readonly FargateShape[];
  /** Task definitions that no service uses (one-off tasks: bootstrap, migrations, probes). */
  readonly oneOffTaskDefinitions: number;
  readonly ecsClusters: number;
  readonly containerInsights: ContainerInsights;
  readonly kmsKeys: number;
  /** Keys with DeletionPolicy Retain: they stay ENABLED (billed) after teardown. */
  readonly kmsRetainedKeys: number;
  /** Longest PendingWindowInDays of the deleted keys (CloudFormation default 30; 7 if no key). */
  readonly kmsPendingWindowDays: number;
  readonly secrets: number;
  readonly alarms: number;
  readonly dashboards: number;
  readonly cloudfrontDistributions: number;
  readonly cloudfrontFunctions: number;
  readonly lambdaFunctions: number;
  readonly stateMachines: number;
  readonly dynamodbTables: number;
  readonly dynamodbPitrTables: number;
  readonly logGroups: number;
  readonly s3Buckets: number;
  readonly ecrRepositories: number;
  /** Sum over interface endpoints of the AZs they are placed in (billed per AZ-hour). */
  readonly interfaceEndpointAzs: number;
  readonly eventRules: number;
  readonly hostedZones: number;
  readonly wafWebAcls: number;
  /** Resource types present that may bill but that this model does not price. */
  readonly unpricedTypes: readonly string[];
  /** Quantities taken from the contract or an assumption rather than a template. */
  readonly notes: readonly string[];
}

/** The planned architecture of each phase. */
export function contractTopology(phase: Phase): Topology {
  if (phase === 1) {
    return {
      phase,
      basis: {
        kind: 'contract',
        ref: 'Phase 1: the existing integration mini-stack (as synthesized offline)',
        stacks: ['starter-it-<runId>'],
      },
      natGateways: 0,
      elasticIps: 0,
      albs: 0,
      albPublicIpv4: 0,
      rds: [],
      fargateServices: [],
      oneOffTaskDefinitions: 0,
      ecsClusters: 0,
      containerInsights: 'none',
      kmsKeys: 1,
      kmsRetainedKeys: 0,
      kmsPendingWindowDays: 7,
      secrets: 0,
      alarms: 0,
      dashboards: 0,
      cloudfrontDistributions: 0,
      cloudfrontFunctions: 0,
      lambdaFunctions: 3,
      stateMachines: 1,
      dynamodbTables: 2,
      dynamodbPitrTables: 2,
      logGroups: 4,
      s3Buckets: 0,
      ecrRepositories: 0,
      interfaceEndpointAzs: 0,
      eventRules: 0,
      hostedZones: 0,
      wafWebAcls: 0,
      unpricedTypes: [],
      notes: [
        'Mini-stack resources as synthesized offline on this branch (1 KMS key, 2 PITR tables, 3 arm64 Lambdas, 1 STANDARD state machine, 4 log groups); additional mini-stack tests change usage, not fixed cost.',
      ],
    };
  }
  return {
    phase,
    basis: {
      kind: 'contract',
      ref: 'Phase 2: the sandbox CDK profile (full Sandbox stage)',
      stacks: [
        'Sandbox-Foundation',
        'Sandbox-TestIssuer',
        'Sandbox-Platform',
        'Sandbox-Data',
        'Sandbox-Workflow',
        'Sandbox-Migrations',
        'Sandbox-Api',
        'Sandbox-Frontend',
        'Sandbox-Observability',
      ],
    },
    natGateways: 1,
    elasticIps: 1,
    albs: 1,
    albPublicIpv4: 2,
    rds: [
      {
        logicalId: 'contract:rds',
        instanceClass: 'db.t4g.micro',
        multiAz: false,
        storageGiB: 20,
        storageType: 'gp3',
        snapshotOnDelete: false,
        retainsAutomatedBackups: false,
      },
    ],
    fargateServices: [
      {
        logicalId: 'contract:api',
        desiredCount: 1,
        vcpu: 0.25,
        memoryGb: 0.5,
        arch: 'arm64',
        spotShare: false,
      },
    ],
    oneOffTaskDefinitions: 3,
    ecsClusters: 1,
    containerInsights: 'enhanced',
    kmsKeys: 3,
    kmsRetainedKeys: 0,
    kmsPendingWindowDays: 7,
    secrets: 1,
    alarms: 18,
    dashboards: 1,
    cloudfrontDistributions: 2,
    cloudfrontFunctions: 1,
    lambdaFunctions: 3,
    stateMachines: 1,
    dynamodbTables: 1,
    dynamodbPitrTables: 1,
    logGroups: 11,
    s3Buckets: 3,
    ecrRepositories: 1,
    interfaceEndpointAzs: 0,
    eventRules: 1,
    hostedZones: 0,
    wafWebAcls: 0,
    unpricedTypes: [],
    notes: [
      '[CONTRACT §4] 1 NAT gateway + EIP, 2 AZs, internet-facing ALB, RDS PostgreSQL 17 db.t4g.micro single-AZ (destroy, automated backups deleted), ECS desired 1 on-demand Fargate arm64 0.25 vCPU / 0.5 GB, 2 CloudFront distributions (SPA + test issuer), no WAF / Route 53 / ACM, KMS deletion window 7 days, log retention 1 day.',
      '[ASSUMPTION] As the dev stage in sandbox foundation mode on this branch: 3 KMS keys (data, logs, alarm topic), 18 alarms, 1 dashboard, Container Insights enhanced, 1 secret (RDS master), 3 Lambdas, 11 log groups, 20 GiB gp3, 3 one-off task definitions; plus the test-issuer bucket (3 buckets).',
      '[ASSUMPTION] The internet-facing ALB has one public IPv4 address per AZ (2); it can add nodes under load.',
      'Re-run with --synth <cdk.out> once `-c envs=sandbox` synthesizes; the synth replaces every quantity above.',
    ],
  };
}

// ── Offline synth ────────────────────────────────────────────────────────────────────────────

interface CfnResource {
  readonly Type: string;
  readonly Properties?: Record<string, unknown>;
  readonly DeletionPolicy?: string;
}
interface CfnTemplate {
  readonly Resources?: Record<string, CfnResource>;
}

export interface SynthStack {
  readonly stackName: string;
  readonly templateFile: string;
  readonly template: CfnTemplate;
}

export class SynthError extends Error {
  override name = 'SynthError';
}

function findManifests(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...findManifests(full));
    else if (e.isFile() && e.name === 'manifest.json') out.push(full);
  }
  return out.sort();
}

/** Every CloudFormation stack artifact of the cloud assemblies below `dir` (nested assemblies too). */
export function loadSynthStacks(dir: string): SynthStack[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new SynthError(`synth directory ${dir} does not exist`);
  }
  const stacks: SynthStack[] = [];
  for (const manifestFile of findManifests(dir)) {
    let manifest: { artifacts?: Record<string, unknown> };
    try {
      manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as typeof manifest;
    } catch {
      continue;
    }
    for (const artifact of Object.values(manifest.artifacts ?? {})) {
      const a = artifact as {
        type?: string;
        properties?: { templateFile?: string; stackName?: string };
      };
      if (a.type !== 'aws:cloudformation:stack' || !a.properties?.templateFile) continue;
      const templateFile = join(dirname(manifestFile), a.properties.templateFile);
      if (!existsSync(templateFile)) continue;
      stacks.push({
        stackName:
          a.properties.stackName ?? a.properties.templateFile.replace(/\.template\.json$/, ''),
        templateFile,
        template: JSON.parse(readFileSync(templateFile, 'utf8')) as CfnTemplate,
      });
    }
  }
  return stacks;
}

/** Stack-name patterns of each phase (`Sandbox-<Stack>` names, or the `<resourcePrefix>-<suffix>` form). */
export const PHASE_STACK_PATTERNS: Readonly<Record<Phase, readonly RegExp[]>> = {
  1: [/^starter-it-/],
  2: [/^Sandbox-/, /^starter-sbx-/],
};

export function selectPhaseStacks(
  stacks: readonly SynthStack[],
  phase: Phase,
  stackPrefix?: string,
): SynthStack[] {
  const patterns = stackPrefix
    ? [new RegExp(`^${stackPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)]
    : PHASE_STACK_PATTERNS[phase];
  return stacks.filter((s) => patterns.some((p) => p.test(s.stackName)));
}

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};
const isRef = (v: unknown): v is { Ref: string } =>
  typeof v === 'object' && v !== null && typeof (v as { Ref?: unknown }).Ref === 'string';

/** Types that never bill by themselves (or whose cost is priced through another line). */
const FREE_OR_COVERED = new Set([
  'AWS::CDK::Metadata',
  'AWS::IAM::Role',
  'AWS::IAM::Policy',
  'AWS::IAM::ManagedPolicy',
  'AWS::IAM::InstanceProfile',
  'AWS::EC2::VPC',
  'AWS::EC2::Subnet',
  'AWS::EC2::RouteTable',
  'AWS::EC2::Route',
  'AWS::EC2::SubnetRouteTableAssociation',
  'AWS::EC2::InternetGateway',
  'AWS::EC2::VPCGatewayAttachment',
  'AWS::EC2::SecurityGroup',
  'AWS::EC2::SecurityGroupIngress',
  'AWS::EC2::SecurityGroupEgress',
  'AWS::EC2::FlowLog',
  'AWS::EC2::NatGateway',
  'AWS::EC2::EIP',
  'AWS::EC2::VPCEndpoint',
  'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::ElasticLoadBalancingV2::Listener',
  'AWS::ElasticLoadBalancingV2::ListenerRule',
  'AWS::ElasticLoadBalancingV2::TargetGroup',
  'AWS::ECS::Cluster',
  'AWS::ECS::ClusterCapacityProviderAssociations',
  'AWS::ECS::Service',
  'AWS::ECS::TaskDefinition',
  'AWS::ECR::Repository',
  'AWS::ApplicationAutoScaling::ScalableTarget',
  'AWS::ApplicationAutoScaling::ScalingPolicy',
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBParameterGroup',
  'AWS::RDS::DBSubnetGroup',
  'AWS::DynamoDB::Table',
  'AWS::Lambda::Function',
  'AWS::Lambda::Version',
  'AWS::Lambda::Alias',
  'AWS::Lambda::Permission',
  'AWS::Lambda::EventInvokeConfig',
  'AWS::StepFunctions::StateMachine',
  'AWS::StepFunctions::StateMachineVersion',
  'AWS::StepFunctions::StateMachineAlias',
  'AWS::Logs::LogGroup',
  'AWS::Logs::ResourcePolicy',
  'AWS::CloudWatch::Alarm',
  'AWS::CloudWatch::CompositeAlarm',
  'AWS::CloudWatch::Dashboard',
  'AWS::SNS::Topic',
  'AWS::SNS::TopicPolicy',
  'AWS::SNS::Subscription',
  'AWS::Events::Rule',
  'AWS::Scheduler::Schedule',
  'AWS::KMS::Key',
  'AWS::KMS::Alias',
  'AWS::SecretsManager::Secret',
  'AWS::SecretsManager::SecretTargetAttachment',
  'AWS::SecretsManager::ResourcePolicy',
  'AWS::SecretsManager::RotationSchedule',
  'AWS::S3::Bucket',
  'AWS::S3::BucketPolicy',
  'AWS::CloudFront::Distribution',
  'AWS::CloudFront::Function',
  'AWS::CloudFront::OriginAccessControl',
  'AWS::CloudFront::ResponseHeadersPolicy',
  'AWS::CloudFront::CachePolicy',
  'AWS::CloudFront::OriginRequestPolicy',
  'AWS::CloudFront::VpcOrigin',
  'AWS::Route53::RecordSet',
  'AWS::Route53::HostedZone',
  'AWS::Budgets::Budget',
  'AWS::WAFv2::WebACL',
  'AWS::CloudFormation::Stack',
  'Custom::CDKBucketDeployment',
  'Custom::S3AutoDeleteObjects',
  'Custom::ECRAutoDeleteImages',
  'AWS::CloudFormation::CustomResource',
]);

/** Cost-relevant shape of the given stacks (offline; template properties only). */
export function synthTopology(dir: string, phase: Phase, stackPrefix?: string): Topology {
  const stacks = selectPhaseStacks(loadSynthStacks(dir), phase, stackPrefix);
  if (stacks.length === 0) {
    throw new SynthError(
      phase === 2
        ? `no Sandbox stacks (Sandbox-* or starter-sbx-*) in ${dir}: synthesize with -c envs=sandbox first`
        : `no starter-it-* stack in ${dir}: synthesize the integration app (-c runId=<id>) first`,
    );
  }
  const all: [string, CfnResource][] = stacks.flatMap((s) =>
    Object.entries(s.template.Resources ?? {}),
  );
  const ofType = (type: string) => all.filter(([, r]) => r.Type === type);
  const count = (...types: string[]) => all.filter(([, r]) => types.includes(r.Type)).length;
  const notes: string[] = [];

  // Load balancers: Scheme defaults to internet-facing; one public IPv4 per subnet (AZ node).
  let albPublicIpv4 = 0;
  const lbs = ofType('AWS::ElasticLoadBalancingV2::LoadBalancer').filter(
    ([, r]) => (r.Properties?.['Type'] ?? 'application') === 'application',
  );
  for (const [id, r] of lbs) {
    const scheme = r.Properties?.['Scheme'] ?? 'internet-facing';
    if (scheme !== 'internet-facing') continue;
    const subnets = r.Properties?.['Subnets'] ?? r.Properties?.['SubnetMappings'];
    if (Array.isArray(subnets)) albPublicIpv4 += subnets.length;
    else {
      albPublicIpv4 += 2;
      notes.push(`[ASSUMPTION] ${id}: subnets not literal; 2 public IPv4 addresses assumed`);
    }
  }

  const rds: RdsShape[] = ofType('AWS::RDS::DBInstance').map(([id, r]) => {
    const p = r.Properties ?? {};
    return {
      logicalId: id,
      instanceClass: String(p['DBInstanceClass'] ?? 'unknown'),
      multiAz: p['MultiAZ'] === true || p['MultiAZ'] === 'true',
      storageGiB: num(p['AllocatedStorage'], 20),
      storageType: String(p['StorageType'] ?? 'gp2'),
      snapshotOnDelete: (r.DeletionPolicy ?? 'Snapshot') === 'Snapshot',
      // CloudFormation default: automated backups are removed with the instance.
      retainsAutomatedBackups:
        p['DeleteAutomatedBackups'] === false || p['DeleteAutomatedBackups'] === 'false',
    };
  });

  const taskDefs = new Map(ofType('AWS::ECS::TaskDefinition'));
  const usedTaskDefs = new Set<string>();
  const fargateServices: FargateShape[] = ofType('AWS::ECS::Service').map(([id, r]) => {
    const p = r.Properties ?? {};
    const tdRef = p['TaskDefinition'];
    const tdId = isRef(tdRef) ? tdRef.Ref : undefined;
    if (tdId) usedTaskDefs.add(tdId);
    const td = tdId ? taskDefs.get(tdId)?.Properties : undefined;
    const arch =
      (td?.['RuntimePlatform'] as { CpuArchitecture?: string } | undefined)?.CpuArchitecture ===
      'ARM64'
        ? 'arm64'
        : 'x86_64';
    const strategy = (p['CapacityProviderStrategy'] ?? []) as {
      CapacityProvider?: string;
      Weight?: number;
      Base?: number;
    }[];
    const desiredCount = num(p['DesiredCount'], 1);
    const onDemandBase = strategy
      .filter((s) => s.CapacityProvider === 'FARGATE')
      .reduce((a, s) => a + num(s.Base, 0), 0);
    const spotShare =
      strategy.some((s) => s.CapacityProvider === 'FARGATE_SPOT' && num(s.Weight, 0) > 0) &&
      onDemandBase < desiredCount;
    if (!td) notes.push(`[ASSUMPTION] ${id}: task definition not resolvable; 0.25 vCPU / 0.5 GB`);
    return {
      logicalId: id,
      desiredCount,
      vcpu: td ? num(td['Cpu'], 256) / 1024 : 0.25,
      memoryGb: td ? num(td['Memory'], 512) / 1024 : 0.5,
      arch,
      spotShare,
    };
  });
  const oneOffTaskDefinitions = [...taskDefs.keys()].filter((id) => !usedTaskDefs.has(id)).length;

  const clusters = ofType('AWS::ECS::Cluster');
  let containerInsights: ContainerInsights = clusters.length === 0 ? 'none' : 'disabled';
  for (const [, r] of clusters) {
    const settings = (r.Properties?.['ClusterSettings'] ?? []) as {
      Name?: string;
      Value?: string;
    }[];
    const v = settings.find((s) => s.Name === 'containerInsights')?.Value;
    if (v === 'enhanced') containerInsights = 'enhanced';
    else if (v === 'enabled' && containerInsights !== 'enhanced') containerInsights = 'enabled';
  }

  const keys = ofType('AWS::KMS::Key');
  const deletedKeyWindows = keys
    .filter(([, r]) => r.DeletionPolicy !== 'Retain')
    .map(([, r]) => num(r.Properties?.['PendingWindowInDays'], 30));
  const tables = ofType('AWS::DynamoDB::Table');
  const pitr = tables.filter(([, r]) => {
    const spec = r.Properties?.['PointInTimeRecoverySpecification'] as
      { PointInTimeRecoveryEnabled?: unknown } | undefined;
    return spec?.PointInTimeRecoveryEnabled === true;
  }).length;
  const interfaceEndpointAzs = ofType('AWS::EC2::VPCEndpoint')
    .filter(([, r]) => r.Properties?.['VpcEndpointType'] === 'Interface')
    .reduce((a, [, r]) => {
      const subnets = r.Properties?.['SubnetIds'];
      return a + (Array.isArray(subnets) ? subnets.length : 2);
    }, 0);

  const unpricedTypes = [
    ...new Set(all.map(([, r]) => r.Type).filter((t) => !FREE_OR_COVERED.has(t))),
  ].sort();
  if (count('AWS::WAFv2::WebACL') > 0) {
    notes.push('WAF web ACLs present: not priced here (the contract says no WAF in the sandbox)');
  }
  if (fargateServices.some((s) => s.spotShare)) {
    notes.push(
      'FARGATE_SPOT share present: priced as on-demand (Spot prices are not in the snapshot)',
    );
  }

  return {
    phase,
    basis: { kind: 'synth', ref: dir, stacks: stacks.map((s) => s.stackName).sort() },
    natGateways: count('AWS::EC2::NatGateway'),
    elasticIps: count('AWS::EC2::EIP'),
    albs: lbs.length,
    albPublicIpv4,
    rds,
    fargateServices,
    oneOffTaskDefinitions,
    ecsClusters: clusters.length,
    containerInsights,
    kmsKeys: keys.length,
    kmsRetainedKeys: keys.filter(([, r]) => r.DeletionPolicy === 'Retain').length,
    kmsPendingWindowDays: deletedKeyWindows.length > 0 ? Math.max(...deletedKeyWindows) : 7,
    secrets: count('AWS::SecretsManager::Secret'),
    alarms: count('AWS::CloudWatch::Alarm', 'AWS::CloudWatch::CompositeAlarm'),
    dashboards: count('AWS::CloudWatch::Dashboard'),
    cloudfrontDistributions: count('AWS::CloudFront::Distribution'),
    cloudfrontFunctions: count('AWS::CloudFront::Function'),
    lambdaFunctions: count('AWS::Lambda::Function'),
    stateMachines: count('AWS::StepFunctions::StateMachine'),
    dynamodbTables: tables.length,
    dynamodbPitrTables: pitr,
    logGroups: count('AWS::Logs::LogGroup'),
    s3Buckets: count('AWS::S3::Bucket'),
    ecrRepositories: count('AWS::ECR::Repository'),
    interfaceEndpointAzs,
    eventRules: count('AWS::Events::Rule', 'AWS::Scheduler::Schedule'),
    hostedZones: count('AWS::Route53::HostedZone'),
    wafWebAcls: count('AWS::WAFv2::WebACL'),
    unpricedTypes,
    notes,
  };
}
