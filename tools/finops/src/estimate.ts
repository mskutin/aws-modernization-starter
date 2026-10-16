/**
 * Cost-impact estimator: monthly on-demand cost per resource from the dated
 * price table × explicit usage assumptions. Deterministic and offline.
 *
 * It is an ESTIMATE for change review, not a bill forecast: it ignores free
 * tiers, discounts, taxes, inter-AZ/internet data transfer (except CloudFront
 * and NAT processing), CPU credits and anything listed as unpriced.
 */
import { usageFor, type Environment, type PriceTable, type UsageFile } from './config.js';
import { cdkPathOf, type CfnResource, type CfnTemplate, type LoadedTemplate } from './templates.js';

export interface CostLine {
  stack: string;
  environment: Environment | undefined;
  logicalId: string;
  type: string;
  cdkPath: string | undefined;
  monthlyUsd: number;
  /** Human-readable formula with the inputs used. */
  basis: string;
}

export interface UnpricedResource {
  stack: string;
  logicalId: string;
  type: string;
  reason: string;
}

export interface Estimate {
  lines: CostLine[];
  unpriced: UnpricedResource[];
  totals: Partial<Record<Environment | 'unknown', number>>;
}

/** Types that are free or negligible at this scale (listed so nothing is silently dropped). */
export const FREE_OR_NEGLIGIBLE: ReadonlySet<string> = new Set([
  'AWS::CDK::Metadata',
  'AWS::IAM::Role',
  'AWS::IAM::Policy',
  'AWS::IAM::ManagedPolicy',
  'AWS::EC2::SecurityGroup',
  'AWS::EC2::SecurityGroupIngress',
  'AWS::EC2::SecurityGroupEgress',
  'AWS::EC2::Subnet',
  'AWS::EC2::RouteTable',
  'AWS::EC2::Route',
  'AWS::EC2::SubnetRouteTableAssociation',
  'AWS::EC2::VPC',
  'AWS::EC2::InternetGateway',
  'AWS::EC2::VPCGatewayAttachment',
  'AWS::ECS::Cluster',
  'AWS::ECS::TaskDefinition',
  'AWS::ECS::ClusterCapacityProviderAssociations',
  'AWS::ElasticLoadBalancingV2::Listener',
  'AWS::ElasticLoadBalancingV2::TargetGroup',
  'AWS::ApplicationAutoScaling::ScalableTarget',
  'AWS::ApplicationAutoScaling::ScalingPolicy',
  'AWS::Lambda::Permission',
  'AWS::Lambda::Version',
  'AWS::Lambda::Alias',
  'AWS::KMS::Alias',
  'AWS::S3::BucketPolicy',
  'AWS::RDS::DBSubnetGroup',
  'AWS::RDS::DBParameterGroup',
  'AWS::SecretsManager::SecretTargetAttachment',
  'AWS::SNS::Topic',
  'AWS::SNS::TopicPolicy',
  'AWS::SNS::Subscription',
  'AWS::CloudFront::OriginAccessControl',
  'AWS::CloudFront::ResponseHeadersPolicy',
  'AWS::CloudFront::CachePolicy',
  'AWS::CloudFront::OriginRequestPolicy',
  'AWS::CloudFront::VpcOrigin',
  'AWS::Budgets::Budget',
  'AWS::Route53::RecordSet',
]);

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const round = (n: number) => Math.round(n * 100) / 100;
const refId = (v: unknown): string | undefined => {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['Ref'] === 'string') return o['Ref'];
    const ga = o['Fn::GetAtt'];
    if (Array.isArray(ga) && typeof ga[0] === 'string') return ga[0];
  }
  return undefined;
};
const mentions = (v: unknown, logicalId: string) =>
  JSON.stringify(v ?? null).includes(`"${logicalId}"`);

type Ctx = {
  stack: string;
  template: CfnTemplate;
  prices: PriceTable['services'];
  hours: number;
  usage: ReturnType<typeof usageFor>;
};

type Model = (
  r: CfnResource,
  logicalId: string,
  ctx: Ctx,
) => { usd: number; basis: string } | { unpriced: string };

const lambdaArch = (r: CfnResource | undefined): 'arm64' | 'x86_64' =>
  Array.isArray(r?.Properties?.['Architectures']) &&
  (r?.Properties?.['Architectures'] as unknown[])[0] === 'arm64'
    ? 'arm64'
    : 'x86_64';

const provisionedConcurrency: Model = (r, _id, ctx) => {
  const pc = num(
    (r.Properties?.['ProvisionedConcurrencyConfig'] as Record<string, unknown> | undefined)?.[
      'ProvisionedConcurrentExecutions'
    ],
    0,
  );
  if (pc <= 0) return { usd: 0, basis: 'no provisioned concurrency' };
  const fnId = refId(r.Properties?.['FunctionName']);
  const fn = fnId ? ctx.template.Resources?.[fnId] : undefined;
  if (!fn) return { unpriced: 'provisioned concurrency on a function outside this template' };
  const gb = num(fn.Properties?.['MemorySize'], 128) / 1024;
  const arch = lambdaArch(fn);
  const usd = pc * gb * ctx.hours * 3600 * ctx.prices.lambda.provisionedConcurrencyGbSecond[arch];
  return { usd, basis: `${pc} provisioned × ${gb} GB × ${ctx.hours} h (${arch})` };
};

export const MODELS: Readonly<Record<string, Model>> = {
  'AWS::RDS::DBInstance': (r, _id, ctx) => {
    const p = r.Properties ?? {};
    if (p['DBClusterIdentifier'])
      return { unpriced: 'Aurora member instance (Aurora not modelled)' };
    const cls = String(p['DBInstanceClass'] ?? '');
    const multi = p['MultiAZ'] === true || p['MultiAZ'] === 'true';
    const az = multi ? 'multiAz' : 'singleAz';
    const hourly = ctx.prices.rds.postgresInstanceHour[cls]?.[az];
    if (p['Engine'] !== 'postgres' || hourly === undefined) {
      return { unpriced: `no price for engine ${String(p['Engine'])} class ${cls}` };
    }
    const storageType = String(p['StorageType'] ?? 'gp2');
    const gb = num(p['AllocatedStorage'], 20);
    const storage =
      ctx.prices.rds.storageGbMonth[storageType]?.[az] ??
      ctx.prices.rds.storageGbMonth['gp3']?.[az] ??
      0;
    return {
      usd: hourly * ctx.hours + gb * storage,
      basis: `${cls} ${az} ${hourly}/h × ${ctx.hours} h + ${gb} GB ${storageType} × ${storage}`,
    };
  },
  'AWS::ECS::Service': (r, id, ctx) => {
    const p = r.Properties ?? {};
    const tdId = refId(p['TaskDefinition']);
    const td = tdId ? ctx.template.Resources?.[tdId] : undefined;
    const strategy =
      (p['CapacityProviderStrategy'] as
        { CapacityProvider?: string; Weight?: number }[] | undefined) ?? [];
    const fargate =
      p['LaunchType'] === 'FARGATE' ||
      strategy.some((s) => String(s.CapacityProvider).startsWith('FARGATE'));
    if (!fargate) return { unpriced: 'not a Fargate service (EC2 capacity not modelled)' };
    if (!td) return { unpriced: 'task definition not in this template' };
    const vcpu = num(td.Properties?.['Cpu'], 256) / 1024;
    const gb = num(td.Properties?.['Memory'], 512) / 1024;
    const arch =
      (td.Properties?.['RuntimePlatform'] as Record<string, unknown> | undefined)?.[
        'CpuArchitecture'
      ] === 'ARM64'
        ? 'arm64'
        : 'x86_64';
    const target = Object.values(ctx.template.Resources ?? {}).find(
      (x) =>
        x.Type === 'AWS::ApplicationAutoScaling::ScalableTarget' &&
        mentions(x.Properties?.['ResourceId'], id),
    );
    const count = num(p['DesiredCount'], num(target?.Properties?.['MinCapacity'], 1));
    const totalWeight = strategy.reduce((s, x) => s + num(x.Weight, 0), 0);
    const spotWeight = strategy
      .filter((s) => s.CapacityProvider === 'FARGATE_SPOT')
      .reduce((s, x) => s + num(x.Weight, 0), 0);
    const spotShare = totalWeight > 0 ? spotWeight / totalWeight : 0;
    const factor = 1 - spotShare * (ctx.usage.fargate.spotDiscountPercent / 100);
    const perTask =
      (vcpu * ctx.prices.fargate.vcpuHour[arch] + gb * ctx.prices.fargate.gbHour[arch]) * ctx.hours;
    return {
      usd: count * perTask * factor,
      basis: `${count} task(s) × (${vcpu} vCPU + ${gb} GB ${arch}) × ${ctx.hours} h${spotShare ? ` × spot factor ${factor.toFixed(2)}` : ''}${target ? ` (autoscaling max ${String(target.Properties?.['MaxCapacity'])})` : ''}`,
    };
  },
  'AWS::EC2::NatGateway': (_r, _id, ctx) => {
    const gb = ctx.usage.natGateway.dataProcessedGbPerMonth;
    return {
      usd: ctx.prices.vpc.natGatewayHour * ctx.hours + gb * ctx.prices.vpc.natGatewayDataGb,
      basis: `${ctx.prices.vpc.natGatewayHour}/h × ${ctx.hours} h + ${gb} GB processed`,
    };
  },
  'AWS::EC2::EIP': (_r, _id, ctx) => ({
    usd: ctx.prices.vpc.publicIpv4Hour * ctx.hours,
    basis: `public IPv4 ${ctx.prices.vpc.publicIpv4Hour}/h × ${ctx.hours} h`,
  }),
  'AWS::EC2::VPCEndpoint': (r, _id, ctx) => {
    if ((r.Properties?.['VpcEndpointType'] ?? 'Gateway') !== 'Interface')
      return { usd: 0, basis: 'gateway endpoint (free)' };
    const azs = Array.isArray(r.Properties?.['SubnetIds'])
      ? (r.Properties?.['SubnetIds'] as unknown[]).length
      : 1;
    const gb = ctx.usage.vpcEndpoint.dataProcessedGbPerMonth;
    return {
      usd:
        azs * ctx.prices.vpc.interfaceEndpointHourPerAz * ctx.hours +
        gb * ctx.prices.vpc.interfaceEndpointDataGb,
      basis: `${azs} AZ × ${ctx.prices.vpc.interfaceEndpointHourPerAz}/h × ${ctx.hours} h + ${gb} GB`,
    };
  },
  'AWS::ElasticLoadBalancingV2::LoadBalancer': (r, _id, ctx) => {
    const type = r.Properties?.['Type'] ?? 'application';
    if (type !== 'application') return { unpriced: `${String(type)} load balancer not modelled` };
    const lcu = ctx.usage.alb.averageLcu;
    return {
      usd: (ctx.prices.elb.albHour + lcu * ctx.prices.elb.albLcuHour) * ctx.hours,
      basis: `ALB ${ctx.prices.elb.albHour}/h + ${lcu} LCU × ${ctx.prices.elb.albLcuHour} × ${ctx.hours} h`,
    };
  },
  'AWS::CloudFront::Distribution': (_r, _id, ctx) => {
    const { dataTransferOutGbPerMonth: gb, requestsPerMonth: req } = ctx.usage.cloudfront;
    return {
      usd:
        gb * ctx.prices.cloudfront.dataTransferOutGb +
        (req / 10_000) * ctx.prices.cloudfront.httpsRequestsPer10k,
      basis: `${gb} GB out × ${ctx.prices.cloudfront.dataTransferOutGb} + ${req} HTTPS requests`,
    };
  },
  'AWS::DynamoDB::Table': (r, _id, ctx) => {
    const p = r.Properties ?? {};
    const u = ctx.usage.dynamodb;
    const d = ctx.prices.dynamodb;
    const gsis = Array.isArray(p['GlobalSecondaryIndexes'])
      ? (p['GlobalSecondaryIndexes'] as Record<string, unknown>[])
      : [];
    const pitr =
      (p['PointInTimeRecoverySpecification'] as Record<string, unknown> | undefined)?.[
        'PointInTimeRecoveryEnabled'
      ] === true;
    const storage = u.storageGb * d.storageGbMonth + (pitr ? u.storageGb * d.pitrGbMonth : 0);
    if (p['BillingMode'] === 'PROVISIONED') {
      const tp = (x: unknown, k: string) => num((x as Record<string, unknown> | undefined)?.[k], 0);
      const rcu =
        tp(p['ProvisionedThroughput'], 'ReadCapacityUnits') +
        gsis.reduce((s, g) => s + tp(g['ProvisionedThroughput'], 'ReadCapacityUnits'), 0);
      const wcu =
        tp(p['ProvisionedThroughput'], 'WriteCapacityUnits') +
        gsis.reduce((s, g) => s + tp(g['ProvisionedThroughput'], 'WriteCapacityUnits'), 0);
      return {
        usd: (rcu * d.provisionedRcuHour + wcu * d.provisionedWcuHour) * ctx.hours + storage,
        basis: `provisioned ${rcu} RCU + ${wcu} WCU × ${ctx.hours} h + ${u.storageGb} GB${pitr ? ' + PITR' : ''}`,
      };
    }
    const writes = u.writeRequestUnitsPerMonth * (1 + gsis.length);
    return {
      usd:
        (u.readRequestUnitsPerMonth / 1e6) * d.onDemandReadPerMillion +
        (writes / 1e6) * d.onDemandWritePerMillion +
        storage,
      basis: `on-demand ${u.readRequestUnitsPerMonth} RRU + ${writes} WRU (${gsis.length} GSI) + ${u.storageGb} GB${pitr ? ' + PITR' : ''}`,
    };
  },
  'AWS::DynamoDB::GlobalTable': (r, id, ctx) => {
    const replicas = Array.isArray(r.Properties?.['Replicas'])
      ? (r.Properties?.['Replicas'] as unknown[]).length
      : 1;
    const asTable = MODELS['AWS::DynamoDB::Table']?.(
      { ...r, Properties: { ...r.Properties, BillingMode: 'PAY_PER_REQUEST' } },
      id,
      ctx,
    );
    if (!asTable || 'unpriced' in asTable) return { unpriced: 'global table' };
    return {
      usd: asTable.usd * replicas,
      basis: `${replicas} replica(s) × (${asTable.basis}) (approximation)`,
    };
  },
  'AWS::Lambda::Function': (r, _id, ctx) => {
    const gb = num(r.Properties?.['MemorySize'], 128) / 1024;
    const arch = lambdaArch(r);
    const { invocationsPerMonth: inv, avgDurationMs: ms } = ctx.usage.lambda;
    const usd =
      (inv / 1e6) * ctx.prices.lambda.requestPerMillion +
      inv * (ms / 1000) * gb * ctx.prices.lambda.gbSecond[arch];
    return { usd, basis: `${inv} invocations × ${ms} ms × ${gb} GB (${arch})` };
  },
  'AWS::Lambda::Alias': provisionedConcurrency,
  'AWS::Lambda::Version': provisionedConcurrency,
  'AWS::StepFunctions::StateMachine': (r, _id, ctx) => {
    const u = ctx.usage.stepFunctions;
    if (r.Properties?.['StateMachineType'] === 'EXPRESS') {
      const gbs =
        u.executionsPerMonth * (u.expressAvgDurationMs / 1000) * (u.expressMemoryMb / 1024);
      return {
        usd:
          (u.executionsPerMonth / 1e6) * ctx.prices.stepFunctions.expressRequestPerMillion +
          gbs * ctx.prices.stepFunctions.expressGbSecond,
        basis: `express ${u.executionsPerMonth} executions`,
      };
    }
    const transitions = u.executionsPerMonth * u.stateTransitionsPerExecution;
    return {
      usd: (transitions / 1000) * ctx.prices.stepFunctions.standardTransitionPer1k,
      basis: `standard ${u.executionsPerMonth} executions × ${u.stateTransitionsPerExecution} transitions`,
    };
  },
  'AWS::Logs::LogGroup': (r, _id, ctx) => {
    const u = ctx.usage.logs;
    const days = num(r.Properties?.['RetentionInDays'], u.assumedRetentionDaysWhenUnset);
    const stored = u.ingestGbPerMonthPerLogGroup * u.storedCompressionRatio * (days / 30);
    return {
      usd:
        u.ingestGbPerMonthPerLogGroup * ctx.prices.cloudwatch.logIngestGb +
        stored * ctx.prices.cloudwatch.logStorageGbMonth,
      basis: `${u.ingestGbPerMonthPerLogGroup} GB ingested + ${stored.toFixed(2)} GB stored (${days} d retention)`,
    };
  },
  'AWS::CloudWatch::Alarm': (r, _id, ctx) => {
    // Billed per metric evaluated: metric-math alarms count each MetricStat they reference.
    const list = r.Properties?.['Metrics'];
    const metrics = Array.isArray(list)
      ? Math.max(1, (list as Record<string, unknown>[]).filter((m) => m['MetricStat']).length)
      : 1;
    return {
      usd: metrics * ctx.prices.cloudwatch.alarmStandardMonth,
      basis: `${metrics} alarm metric(s)`,
    };
  },
  'AWS::KMS::Key': (_r, _id, ctx) => ({
    usd: ctx.prices.kms.keyMonth,
    basis: '1 customer managed key',
  }),
  'AWS::SecretsManager::Secret': (_r, _id, ctx) => ({
    usd: ctx.prices.secretsManager.secretMonth,
    basis: '1 secret',
  }),
  'AWS::S3::Bucket': (_r, _id, ctx) => ({
    usd: ctx.usage.s3.storageGbPerBucket * ctx.prices.s3.standardGbMonth,
    basis: `${ctx.usage.s3.storageGbPerBucket} GB Standard`,
  }),
};

/** Estimates the monthly cost of every resource in a set of templates. */
export function estimate(
  templates: Map<string, LoadedTemplate>,
  prices: PriceTable,
  usageFile: UsageFile,
): Estimate {
  const lines: CostLine[] = [];
  const unpriced: UnpricedResource[] = [];
  const totals: Estimate['totals'] = {};
  for (const { key, template, environment } of templates.values()) {
    const ctx: Ctx = {
      stack: key,
      template,
      prices: prices.services,
      hours: usageFile.hoursPerMonth,
      usage: usageFor(usageFile, environment),
    };
    for (const [logicalId, r] of Object.entries(template.Resources ?? {})) {
      const model = MODELS[r.Type];
      if (!model) {
        if (!FREE_OR_NEGLIGIBLE.has(r.Type) && !r.Type.startsWith('Custom::')) {
          unpriced.push({
            stack: key,
            logicalId,
            type: r.Type,
            reason: 'resource type not modelled',
          });
        }
        continue;
      }
      const result = model(r, logicalId, ctx);
      if ('unpriced' in result) {
        unpriced.push({ stack: key, logicalId, type: r.Type, reason: result.unpriced });
        continue;
      }
      const usd = round(result.usd);
      lines.push({
        stack: key,
        environment,
        logicalId,
        type: r.Type,
        cdkPath: cdkPathOf(r),
        monthlyUsd: usd,
        basis: result.basis,
      });
      const env = environment ?? 'unknown';
      totals[env] = round((totals[env] ?? 0) + usd);
    }
  }
  return { lines, unpriced, totals };
}
