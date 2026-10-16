/**
 * Offline sandbox cost estimate: prices a Topology with the dated price book and the usage
 * assumptions, then derives the per-hour cost, totals for given lifetimes, the maximum runtime
 * that keeps the estimated attributable spend under the stop rule (with a safety margin), and the
 * residual cost after teardown. It is an ESTIMATE from list prices, not a price or a bill forecast.
 */
import { usageFor, type Assumption, type UsageProfile } from './assumptions.js';
import { HOURS_PER_MONTH, SECRETS_HOURS_PER_MONTH, type Price, type PriceBook } from './prices.js';
import type { Phase, Topology } from './topology.js';

export type LineKind = 'hourly' | 'hourly-partial' | 'usage' | 'one-time';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface LineItem {
  readonly id: string;
  readonly component: string;
  /** Approximate Billing / Cost Explorer service the charge appears under (for reconciliation). */
  readonly billingService: string;
  /** hourly-partial: billed per started hour (ALB, LCU, NAT): one extra hour per lifetime. */
  readonly kind: LineKind;
  readonly quantity: number;
  readonly quantityUnit: string;
  readonly unitPriceUsd: number;
  readonly priceUnit: string;
  readonly priceRef: string;
  readonly formula: string;
  readonly usdPerHour: number;
  readonly oneTimeUsd: number;
  readonly confidence: Confidence;
  readonly basis: string;
}

export interface ResidualItem {
  readonly id: string;
  readonly item: string;
  readonly likelyUsd: number;
  readonly worstUsd: number;
  readonly basis: string;
}

export interface HoursTotal {
  readonly hours: number;
  /** Workload only (list prices, no tax). */
  readonly workloadUsd: number;
  /** + the account-level allowance (high bound). */
  readonly withAccountLevelUsd: number;
  /** + tax at the stop-rule tax rate. */
  readonly withAccountLevelAndTaxUsd: number;
}

export interface StopRuleResult {
  readonly budgetUsd: number;
  readonly stopUsd: number;
  readonly spentUsd: number;
  readonly marginPercent: number;
  readonly taxRatePercent: number;
  readonly accountLevelUsd: number;
  /** (stop - spent) / (1 + tax): the pre-tax spend allowed. */
  readonly allowedEstimateUsd: number;
  /** (One-time + partial-hour rounding) x (1 + margin) + account-level allowance + residual (worst, 30 days). */
  readonly fixedUsd: number;
  readonly maxRuntimeHours: number;
  /** The same if the account owner confirms that no account-level service bills here. */
  readonly maxRuntimeHoursWithoutAccountLevel: number;
  readonly timeBoxHours: number;
  readonly timeBoxBasis: string;
  readonly effectiveMaxRuntimeHours: number;
  readonly bindingLimit: 'time-box' | 'stop-rule';
  readonly teardownHours: number;
  readonly formula: string;
}

export interface EstimateOptions {
  readonly hours?: readonly number[];
  readonly budgetUsd?: number;
  readonly stopUsd?: number;
  readonly spentUsd?: number;
  readonly marginPercent?: number;
  readonly taxRatePercent?: number;
  /** Overrides the account-level allowance (default: the profile's high bound). */
  readonly accountLevelUsd?: number;
  readonly timeBoxHours?: number;
  readonly now?: Date;
}

export interface Estimate {
  readonly kind: 'starter-aws-sandbox/estimate';
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly phase: Phase;
  readonly disclaimer: string;
  readonly priceBasis: {
    readonly snapshot: string;
    readonly snapshotCapturedAt: string;
    readonly supplement: string;
    readonly supplementCapturedAt: string;
    readonly region: string;
    readonly currency: 'USD';
    readonly hoursPerMonth: number;
    readonly notLivePricing: true;
  };
  readonly topology: Topology;
  readonly assumptions: readonly Assumption[];
  readonly lineItems: readonly LineItem[];
  readonly totals: {
    readonly perHourUsd: number;
    readonly perHourFixedUsd: number;
    readonly perHourUsageUsd: number;
    readonly oneTimeUsd: number;
    readonly partialHourRoundingUsd: number;
    readonly byHours: readonly HoursTotal[];
  };
  readonly accountLevel: {
    readonly status: 'UNKNOWN';
    readonly lowUsd: number;
    readonly highUsd: number;
    readonly usedUsd: number;
    readonly basis: string;
  };
  readonly residual: {
    readonly horizon: 'first 30 days after teardown';
    readonly items: readonly ResidualItem[];
    readonly likelyUsd: number;
    readonly worstUsd: number;
    readonly kmsPendingDeletionCharge: {
      readonly status: string;
      readonly repoQuote: string;
      readonly quotedIn: string;
      readonly treatment: string;
    };
  };
  readonly stopRule: StopRuleResult;
  readonly notes: readonly string[];
}

export const DISCLAIMER =
  'ESTIMATE from dated list-price snapshots and stated usage assumptions — not live pricing, not a quote, not a bill forecast. No free tier, credits, discounts or taxes in the line items (tax appears only in the stop-rule margin). Account-level services are UNKNOWN. No AWS account was accessed to produce it.';

export const DEFAULTS = {
  budgetUsd: 25,
  stopUsd: 13,
  marginPercent: 25,
  taxRatePercent: 9,
  hours: [2, 4, 8] as readonly number[],
} as const;

const MAX_HOURS = 8760;
const round = (n: number, digits = 6) => Math.round(n * 10 ** digits) / 10 ** digits;
const fmt = (n: number) => String(round(n, 7));

interface Builder {
  readonly items: LineItem[];
  add(item: Omit<LineItem, 'usdPerHour' | 'oneTimeUsd'> & { usd: number }): void;
}

function builder(): Builder {
  const items: LineItem[] = [];
  return {
    items,
    add({ usd, ...rest }) {
      if (rest.quantity <= 0) return;
      const oneTime = rest.kind === 'one-time';
      items.push({
        ...rest,
        usdPerHour: oneTime ? 0 : round(usd),
        oneTimeUsd: oneTime ? round(usd) : 0,
      });
    },
  };
}

const priced = (p: Price) => ({ unitPriceUsd: p.usd, priceUnit: p.unit, priceRef: p.ref });

/** Fargate on-demand task-hour for a shape (Spot is never assumed: conservative). */
function taskHour(book: PriceBook, vcpu: number, memoryGb: number, arch: 'arm64' | 'x86_64') {
  return vcpu * book.fargateVcpuHour[arch].usd + memoryGb * book.fargateGbHour[arch].usd;
}

export function priceTopology(
  topology: Topology,
  book: PriceBook,
  usage: UsageProfile,
): { items: LineItem[]; residual: ResidualItem[]; notes: string[]; assumptions: Assumption[] } {
  const b = builder();
  const notes: string[] = [];
  const used = new Map<string, Assumption>();
  const use = (x: Assumption) => {
    used.set(x.id, x);
    return x.value;
  };
  const u = usage.perHour;
  const lv = usage.level;
  const ot = usage.oneTime;
  const src = topology.basis.kind === 'synth' ? '[SYNTH]' : '[CONTRACT/ASSUMPTION]';
  const e = book.extra;

  // ── Time-based resources ────────────────────────────────────────────────────────────────
  b.add({
    id: 'SBX-01',
    component: 'NAT gateway hours',
    billingService: 'EC2 - Other (NAT gateway)',
    kind: 'hourly-partial',
    quantity: topology.natGateways,
    quantityUnit: 'NAT gateways',
    ...priced(book.natHour),
    formula: `${topology.natGateways} x ${book.natHour.usd} (partial hour = full hour)`,
    usd: topology.natGateways * book.natHour.usd,
    confidence: 'HIGH',
    basis: src,
  });
  const ipv4 = topology.elasticIps + topology.albPublicIpv4;
  b.add({
    id: 'SBX-02',
    component: `Public IPv4 addresses (${topology.elasticIps} EIP, ${topology.albPublicIpv4} internet-facing ALB nodes)`,
    billingService: 'Amazon Virtual Private Cloud (public IPv4)',
    kind: 'hourly',
    quantity: ipv4,
    quantityUnit: 'addresses',
    ...priced(book.publicIpv4Hour),
    formula: `${ipv4} x ${book.publicIpv4Hour.usd}`,
    usd: ipv4 * book.publicIpv4Hour.usd,
    confidence: topology.albPublicIpv4 > 0 ? 'MEDIUM' : 'HIGH',
    basis: `${src}; ALB: one address per AZ node`,
  });
  b.add({
    id: 'SBX-03',
    component: 'Application Load Balancer hours',
    billingService: 'Elastic Load Balancing',
    kind: 'hourly-partial',
    quantity: topology.albs,
    quantityUnit: 'ALBs',
    ...priced(book.albHour),
    formula: `${topology.albs} x ${book.albHour.usd} (hour or partial hour)`,
    usd: topology.albs * book.albHour.usd,
    confidence: 'HIGH',
    basis: src,
  });
  const lcu = topology.albs * (topology.albs > 0 ? use(lv.albLcu) : 0);
  b.add({
    id: 'SBX-04',
    component: 'ALB capacity units',
    billingService: 'Elastic Load Balancing',
    kind: 'hourly-partial',
    quantity: lcu,
    quantityUnit: 'LCU',
    ...priced(book.albLcuHour),
    formula: `${lcu} x ${book.albLcuHour.usd} (${lv.albLcu.id})`,
    usd: lcu * book.albLcuHour.usd,
    confidence: 'MEDIUM',
    basis: lv.albLcu.basis,
  });
  b.add({
    id: 'SBX-05',
    component: 'Interface VPC endpoints',
    billingService: 'Amazon Virtual Private Cloud',
    kind: 'hourly',
    quantity: topology.interfaceEndpointAzs,
    quantityUnit: 'endpoint-AZs',
    ...priced(book.interfaceEndpointHourPerAz),
    formula: `${topology.interfaceEndpointAzs} x ${book.interfaceEndpointHourPerAz.usd}`,
    usd: topology.interfaceEndpointAzs * book.interfaceEndpointHourPerAz.usd,
    confidence: 'HIGH',
    basis: src,
  });
  topology.rds.forEach((db, i) => {
    const inst = book.rdsInstanceHour(db.instanceClass, db.multiAz);
    if (!inst) {
      notes.push(
        `UNPRICED: RDS class ${db.instanceClass} (${db.logicalId}) is not in the price snapshot; the estimate is LOW by its hourly price`,
      );
    } else {
      b.add({
        id: `SBX-06${String.fromCharCode(97 + i)}`,
        component: `RDS PostgreSQL ${db.instanceClass} ${db.multiAz ? 'Multi-AZ' : 'Single-AZ'}`,
        billingService: 'Amazon Relational Database Service',
        kind: 'hourly',
        quantity: 1,
        quantityUnit: 'instance',
        ...priced(inst),
        formula: `${inst.usd} (per second, 10-minute minimum)`,
        usd: inst.usd,
        confidence: 'HIGH',
        basis: src,
      });
    }
    const storage = book.rdsStorageGbMonth(db.storageType, db.multiAz);
    if (!storage) {
      notes.push(`UNPRICED: RDS storage type ${db.storageType} (${db.logicalId})`);
    } else {
      b.add({
        id: `SBX-07${String.fromCharCode(97 + i)}`,
        component: `RDS ${db.storageType} storage ${db.storageGiB} GiB`,
        billingService: 'Amazon Relational Database Service',
        kind: 'hourly',
        quantity: db.storageGiB,
        quantityUnit: 'GiB',
        ...priced(storage),
        formula: `${db.storageGiB} x ${storage.usd} / ${HOURS_PER_MONTH}`,
        usd: (db.storageGiB * storage.usd) / HOURS_PER_MONTH,
        confidence: 'HIGH',
        basis: `${src}; backups within the free allocation while the instance runs`,
      });
    }
  });
  topology.fargateServices.forEach((svc, i) => {
    const rate = taskHour(book, svc.vcpu, svc.memoryGb, svc.arch);
    b.add({
      id: `SBX-08${String.fromCharCode(97 + i)}`,
      component: `Fargate ${svc.arch} on-demand ${svc.vcpu} vCPU / ${svc.memoryGb} GB x ${svc.desiredCount} task(s)${svc.spotShare ? ' (Spot share priced on-demand)' : ''}`,
      billingService: 'Amazon Elastic Container Service',
      kind: 'hourly',
      quantity: svc.desiredCount,
      quantityUnit: 'tasks',
      unitPriceUsd: round(rate),
      priceUnit: 'task-hour',
      priceRef: `${book.fargateVcpuHour[svc.arch].ref} + ${book.fargateGbHour[svc.arch].ref}`,
      formula: `${svc.desiredCount} x (${svc.vcpu} x ${book.fargateVcpuHour[svc.arch].usd} + ${svc.memoryGb} x ${book.fargateGbHour[svc.arch].usd})`,
      usd: svc.desiredCount * rate,
      confidence: 'HIGH',
      basis: src,
    });
  });
  b.add({
    id: 'SBX-09',
    component: 'KMS customer managed keys',
    billingService: 'AWS Key Management Service',
    kind: 'hourly',
    quantity: topology.kmsKeys,
    quantityUnit: 'keys',
    ...priced(book.kmsKeyMonth),
    formula: `${topology.kmsKeys} x ${book.kmsKeyMonth.usd} / ${HOURS_PER_MONTH}`,
    usd: (topology.kmsKeys * book.kmsKeyMonth.usd) / HOURS_PER_MONTH,
    confidence: 'HIGH',
    basis: src,
  });
  b.add({
    id: 'SBX-10',
    component: 'Secrets Manager secrets',
    billingService: 'AWS Secrets Manager',
    kind: 'hourly',
    quantity: topology.secrets,
    quantityUnit: 'secrets',
    ...priced(book.secretMonth),
    formula: `${topology.secrets} x ${book.secretMonth.usd} / ${SECRETS_HOURS_PER_MONTH}`,
    usd: (topology.secrets * book.secretMonth.usd) / SECRETS_HOURS_PER_MONTH,
    confidence: 'HIGH',
    basis: src,
  });
  b.add({
    id: 'SBX-11',
    component: 'CloudWatch alarms (standard)',
    billingService: 'AmazonCloudWatch',
    kind: 'hourly',
    quantity: topology.alarms,
    quantityUnit: 'alarms',
    ...priced(book.alarmMonth),
    formula: `${topology.alarms} x ${book.alarmMonth.usd} / ${HOURS_PER_MONTH}`,
    usd: (topology.alarms * book.alarmMonth.usd) / HOURS_PER_MONTH,
    confidence: 'HIGH',
    basis: src,
  });
  b.add({
    id: 'SBX-12',
    component: 'CloudWatch dashboards',
    billingService: 'AmazonCloudWatch',
    kind: 'hourly',
    quantity: topology.dashboards,
    quantityUnit: 'dashboards',
    ...priced(e.cloudwatchDashboardMonth),
    formula: `${topology.dashboards} x ${e.cloudwatchDashboardMonth.usd} / ${HOURS_PER_MONTH}`,
    usd: (topology.dashboards * e.cloudwatchDashboardMonth.usd) / HOURS_PER_MONTH,
    confidence: 'HIGH',
    basis: src,
  });
  if (topology.containerInsights === 'enhanced' || topology.containerInsights === 'enabled') {
    const m = use(lv.containerInsightsMetrics);
    b.add({
      id: 'SBX-13',
      component: `Container Insights (${topology.containerInsights}) ECS metrics`,
      billingService: 'AmazonCloudWatch',
      kind: 'hourly',
      quantity: m,
      quantityUnit: 'metrics',
      ...priced(e.containerInsightsEcsMetricMonth),
      formula: `${m} x ${e.containerInsightsEcsMetricMonth.usd} / ${HOURS_PER_MONTH} (${lv.containerInsightsMetrics.id})`,
      usd: (m * e.containerInsightsEcsMetricMonth.usd) / HOURS_PER_MONTH,
      confidence: topology.containerInsights === 'enhanced' ? 'MEDIUM' : 'LOW',
      basis: lv.containerInsightsMetrics.basis,
    });
  }
  if (topology.lambdaFunctions > 0) {
    const m = use(lv.customMetrics);
    b.add({
      id: 'SBX-14',
      component: 'CloudWatch custom metrics (reconciler EMF)',
      billingService: 'AmazonCloudWatch',
      kind: 'hourly',
      quantity: m,
      quantityUnit: 'metrics',
      ...priced(e.cloudwatchCustomMetricMonth),
      formula: `${m} x ${e.cloudwatchCustomMetricMonth.usd} / ${HOURS_PER_MONTH} (${lv.customMetrics.id})`,
      usd: (m * e.cloudwatchCustomMetricMonth.usd) / HOURS_PER_MONTH,
      confidence: 'HIGH',
      basis: lv.customMetrics.basis,
    });
  }
  if (topology.ecrRepositories > 0) {
    const gb = use(lv.ecrGb);
    b.add({
      id: 'SBX-15',
      component: 'ECR storage (API image)',
      billingService: 'Amazon EC2 Container Registry (ECR)',
      kind: 'hourly',
      quantity: gb,
      quantityUnit: 'GB',
      ...priced(e.ecrStorageGbMonth),
      formula: `${gb} x ${e.ecrStorageGbMonth.usd} / ${HOURS_PER_MONTH} (${lv.ecrGb.id})`,
      usd: (gb * e.ecrStorageGbMonth.usd) / HOURS_PER_MONTH,
      confidence: 'MEDIUM',
      basis: lv.ecrGb.basis,
    });
  }
  if (topology.s3Buckets > 0) {
    const gb = use(lv.s3StorageGb);
    b.add({
      id: 'SBX-16',
      component: `S3 storage (${topology.s3Buckets} buckets)`,
      billingService: 'Amazon Simple Storage Service',
      kind: 'hourly',
      quantity: gb,
      quantityUnit: 'GB',
      ...priced(book.s3GbMonth),
      formula: `${gb} x ${book.s3GbMonth.usd} / ${HOURS_PER_MONTH} (${lv.s3StorageGb.id})`,
      usd: (gb * book.s3GbMonth.usd) / HOURS_PER_MONTH,
      confidence: 'MEDIUM',
      basis: lv.s3StorageGb.basis,
    });
  }
  if (topology.dynamodbTables > 0) {
    const gb = use(lv.ddbStorageGb);
    const pitrShare = topology.dynamodbPitrTables / topology.dynamodbTables;
    const perGb = book.ddbStorageGbMonth.usd + pitrShare * book.ddbPitrGbMonth.usd;
    b.add({
      id: 'SBX-17',
      component: `DynamoDB storage + PITR (${topology.dynamodbTables} tables, ${topology.dynamodbPitrTables} with PITR)`,
      billingService: 'Amazon DynamoDB',
      kind: 'hourly',
      quantity: gb,
      quantityUnit: 'GB',
      unitPriceUsd: round(perGb),
      priceUnit: 'GB-month',
      priceRef: `${book.ddbStorageGbMonth.ref} + ${book.ddbPitrGbMonth.ref}`,
      formula: `${gb} x (${book.ddbStorageGbMonth.usd} + ${round(pitrShare, 3)} x ${book.ddbPitrGbMonth.usd}) / ${HOURS_PER_MONTH}`,
      usd: (gb * perGb) / HOURS_PER_MONTH,
      confidence: 'HIGH',
      basis: lv.ddbStorageGb.basis,
    });
  }
  if (topology.logGroups > 0) {
    const gb = use(lv.logStoredGb);
    b.add({
      id: 'SBX-18',
      component: `CloudWatch Logs storage (${topology.logGroups} log groups)`,
      billingService: 'AmazonCloudWatch',
      kind: 'hourly',
      quantity: gb,
      quantityUnit: 'GB',
      ...priced(book.logStorageGbMonth),
      formula: `${gb} x ${book.logStorageGbMonth.usd} / ${HOURS_PER_MONTH} (${lv.logStoredGb.id})`,
      usd: (gb * book.logStorageGbMonth.usd) / HOURS_PER_MONTH,
      confidence: 'MEDIUM',
      basis: lv.logStoredGb.basis,
    });
  }

  // ── Usage per hour of lifetime ──────────────────────────────────────────────────────────
  const usageLine = (
    id: string,
    component: string,
    billingService: string,
    present: boolean,
    assumption: Assumption,
    price: Price,
    per: number,
    confidence: Confidence,
  ) => {
    if (!present || assumption.value <= 0) return;
    const q = use(assumption);
    b.add({
      id,
      component,
      billingService,
      kind: 'usage',
      quantity: q,
      quantityUnit: assumption.unit,
      ...priced(price),
      formula: per === 1 ? `${q} x ${price.usd}` : `${q} x ${price.usd} / ${per}`,
      usd: (q * price.usd) / per,
      confidence,
      basis: `${assumption.id}: ${assumption.basis}`,
    });
  };
  const cf = topology.cloudfrontDistributions > 0;
  usageLine(
    'SBX-20',
    'CloudFront HTTPS requests',
    'Amazon CloudFront',
    cf,
    u.cloudfrontRequests,
    book.cloudfrontHttpsPer10k,
    10_000,
    'MEDIUM',
  );
  usageLine(
    'SBX-21',
    'CloudFront Functions',
    'Amazon CloudFront',
    topology.cloudfrontFunctions > 0,
    u.cloudfrontFunctionRuns,
    e.cloudfrontFunctionsPerMillion,
    1_000_000,
    'MEDIUM',
  );
  usageLine(
    'SBX-22',
    'CloudFront data transfer out (AP)',
    'Amazon CloudFront',
    cf,
    u.cloudfrontDtoGb,
    book.cloudfrontDtoGb,
    1,
    'MEDIUM',
  );
  usageLine(
    'SBX-23',
    'CloudFront data transfer to origin',
    'Amazon CloudFront',
    cf,
    u.cloudfrontToOriginGb,
    e.cloudfrontToOriginGb,
    1,
    'MEDIUM',
  );
  usageLine(
    'SBX-24',
    'NAT gateway data processed',
    'EC2 - Other (NAT gateway)',
    topology.natGateways > 0,
    u.natGb,
    book.natGb,
    1,
    'LOW',
  );
  usageLine(
    'SBX-25',
    'CloudWatch Logs ingestion',
    'AmazonCloudWatch',
    topology.logGroups > 0,
    u.logIngestGb,
    book.logIngestGb,
    1,
    'LOW',
  );
  usageLine(
    'SBX-26',
    'Step Functions STANDARD transitions',
    'AWS Step Functions',
    topology.stateMachines > 0,
    u.sfnTransitions,
    book.sfnTransitionPer1k,
    1000,
    'MEDIUM',
  );
  usageLine(
    'SBX-27',
    'Lambda requests',
    'AWS Lambda',
    topology.lambdaFunctions > 0,
    u.lambdaInvocations,
    book.lambdaRequestPerMillion,
    1_000_000,
    'MEDIUM',
  );
  usageLine(
    'SBX-28',
    'Lambda compute (arm64)',
    'AWS Lambda',
    topology.lambdaFunctions > 0,
    u.lambdaGbSeconds,
    book.lambdaGbSecondArm,
    1,
    'MEDIUM',
  );
  usageLine(
    'SBX-29',
    'DynamoDB write request units',
    'Amazon DynamoDB',
    topology.dynamodbTables > 0,
    u.ddbWru,
    book.ddbWritePerMillion,
    1_000_000,
    'MEDIUM',
  );
  usageLine(
    'SBX-30',
    'DynamoDB read request units',
    'Amazon DynamoDB',
    topology.dynamodbTables > 0,
    u.ddbRru,
    book.ddbReadPerMillion,
    1_000_000,
    'MEDIUM',
  );
  usageLine(
    'SBX-31',
    'X-Ray traces',
    'AWS X-Ray',
    topology.lambdaFunctions + topology.stateMachines > 0,
    u.xrayTraces,
    e.xrayTracesPerMillion,
    1_000_000,
    'MEDIUM',
  );
  usageLine(
    'SBX-32',
    'KMS requests',
    'AWS Key Management Service',
    topology.kmsKeys > 0,
    u.kmsRequests,
    book.kmsRequestsPer10k,
    10_000,
    'LOW',
  );
  usageLine(
    'SBX-33',
    'S3 PUT requests',
    'Amazon Simple Storage Service',
    topology.s3Buckets > 0,
    u.s3Put,
    e.s3PutPer1k,
    1000,
    'MEDIUM',
  );
  usageLine(
    'SBX-34',
    'S3 GET requests',
    'Amazon Simple Storage Service',
    topology.s3Buckets > 0,
    u.s3Get,
    e.s3GetPer10k,
    10_000,
    'MEDIUM',
  );
  usageLine(
    'SBX-35',
    'Data transfer out to the internet',
    'AWS Data Transfer',
    true,
    u.dtoInternetGb,
    e.dataTransferOutInternetGb,
    1,
    'LOW',
  );
  if (topology.natGateways + topology.albs > 0 && u.interAzGb.value > 0) {
    const q = use(u.interAzGb);
    b.add({
      id: 'SBX-36',
      component: 'Inter-AZ data transfer (both directions)',
      billingService: 'AWS Data Transfer',
      kind: 'usage',
      quantity: q,
      quantityUnit: u.interAzGb.unit,
      ...priced(e.dataTransferInterAzGb),
      formula: `${q} x ${e.dataTransferInterAzGb.usd} x 2`,
      usd: q * e.dataTransferInterAzGb.usd * 2,
      confidence: 'LOW',
      basis: `${u.interAzGb.id}: ${u.interAzGb.basis}`,
    });
  }
  usageLine(
    'SBX-37',
    'Secrets Manager API requests',
    'AWS Secrets Manager',
    topology.secrets > 0,
    u.secretsApi,
    e.secretsManagerApiPer10k,
    10_000,
    'MEDIUM',
  );
  usageLine(
    'SBX-38',
    'Scheduled invocations (reconciler; Scheduler price as upper bound)',
    'Amazon EventBridge',
    topology.eventRules > 0,
    u.scheduledInvocations,
    e.eventbridgeScheduledInvocationPerMillion,
    1_000_000,
    'MEDIUM',
  );

  // ── One-time per cycle ──────────────────────────────────────────────────────────────────
  const svc = topology.fargateServices[0];
  const taskRate = svc
    ? taskHour(book, svc.vcpu, svc.memoryGb, svc.arch)
    : taskHour(book, 0.25, 0.5, 'arm64');
  if (topology.oneOffTaskDefinitions > 0 && ot.oneOffTaskRuns.value > 0) {
    const runs = use(ot.oneOffTaskRuns);
    const minutes = use(ot.oneOffTaskMinutes);
    b.add({
      id: 'SBX-40',
      component: 'One-off ECS tasks (bootstrap, migration, in-VPC probes)',
      billingService: 'Amazon Elastic Container Service',
      kind: 'one-time',
      quantity: runs,
      quantityUnit: `runs x ${minutes} min`,
      unitPriceUsd: round(taskRate),
      priceUnit: 'task-hour',
      priceRef: book.fargateVcpuHour.arm64.ref,
      formula: `${runs} x ${minutes}/60 x ${fmt(taskRate)}`,
      usd: (runs * minutes * taskRate) / 60,
      confidence: 'MEDIUM',
      basis: `${ot.oneOffTaskRuns.id}: ${ot.oneOffTaskRuns.basis}`,
    });
  }
  if (topology.fargateServices.length > 0 && ot.extraDeploymentTaskHours.value > 0) {
    const h = use(ot.extraDeploymentTaskHours);
    b.add({
      id: 'SBX-41',
      component: 'Second API task during deployments and the rollback test',
      billingService: 'Amazon Elastic Container Service',
      kind: 'one-time',
      quantity: h,
      quantityUnit: 'task-hours',
      unitPriceUsd: round(taskRate),
      priceUnit: 'task-hour',
      priceRef: book.fargateVcpuHour.arm64.ref,
      formula: `${h} x ${fmt(taskRate)}`,
      usd: h * taskRate,
      confidence: 'MEDIUM',
      basis: `${ot.extraDeploymentTaskHours.id}: ${ot.extraDeploymentTaskHours.basis}`,
    });
  }
  if (
    (topology.containerInsights === 'enhanced' || topology.containerInsights === 'enabled') &&
    ot.containerInsightsMetricHours.value > 0
  ) {
    const mh = use(ot.containerInsightsMetricHours);
    b.add({
      id: 'SBX-42',
      component: 'Container Insights metrics of one-off tasks and deployments',
      billingService: 'AmazonCloudWatch',
      kind: 'one-time',
      quantity: mh,
      quantityUnit: 'metric-hours',
      ...priced(e.containerInsightsEcsMetricMonth),
      formula: `${mh} x ${e.containerInsightsEcsMetricMonth.usd} / ${HOURS_PER_MONTH}`,
      usd: (mh * e.containerInsightsEcsMetricMonth.usd) / HOURS_PER_MONTH,
      confidence: 'MEDIUM',
      basis: `${ot.containerInsightsMetricHours.id}: ${ot.containerInsightsMetricHours.basis}`,
    });
  }
  if (cf && ot.invalidationPaths.value > 0) {
    const paths = use(ot.invalidationPaths);
    b.add({
      id: 'SBX-43',
      component: 'CloudFront invalidations',
      billingService: 'Amazon CloudFront',
      kind: 'one-time',
      quantity: paths,
      quantityUnit: 'paths',
      ...priced(e.cloudfrontInvalidationPath),
      formula: `${paths} x ${e.cloudfrontInvalidationPath.usd}`,
      usd: paths * e.cloudfrontInvalidationPath.usd,
      confidence: 'MEDIUM',
      basis: `${ot.invalidationPaths.id}: ${ot.invalidationPaths.basis}`,
    });
  }
  if (topology.natGateways > 0 && ot.natGb.value > 0) {
    const gb = use(ot.natGb);
    b.add({
      id: 'SBX-44',
      component: 'NAT data for image pulls',
      billingService: 'EC2 - Other (NAT gateway)',
      kind: 'one-time',
      quantity: gb,
      quantityUnit: 'GB',
      ...priced(book.natGb),
      formula: `${gb} x ${book.natGb.usd}`,
      usd: gb * book.natGb.usd,
      confidence: 'LOW',
      basis: `${ot.natGb.id}: ${ot.natGb.basis}`,
    });
  }
  if (ot.s3Put.value > 0) {
    const n = use(ot.s3Put);
    b.add({
      id: 'SBX-45',
      component: 'S3 uploads (CDK assets, SPA, issuer documents)',
      billingService: 'Amazon Simple Storage Service',
      kind: 'one-time',
      quantity: n,
      quantityUnit: 'PUT',
      ...priced(e.s3PutPer1k),
      formula: `${n} x ${e.s3PutPer1k.usd} / 1000`,
      usd: (n * e.s3PutPer1k.usd) / 1000,
      confidence: 'HIGH',
      basis: `${ot.s3Put.id}: ${ot.s3Put.basis}`,
    });
  }
  if (ot.assetsGb.value > 0) {
    const gb = use(ot.assetsGb);
    b.add({
      id: 'SBX-46',
      component: 'CDK file assets in the bootstrap staging bucket (1 month)',
      billingService: 'Amazon Simple Storage Service',
      kind: 'one-time',
      quantity: gb,
      quantityUnit: 'GB-month',
      ...priced(book.s3GbMonth),
      formula: `${gb} x ${book.s3GbMonth.usd}`,
      usd: gb * book.s3GbMonth.usd,
      confidence: 'HIGH',
      basis: `${ot.assetsGb.id}: ${ot.assetsGb.basis}`,
    });
  }
  b.add({
    id: 'SBX-47',
    component: 'Route 53 hosted zones (not prorated)',
    billingService: 'Amazon Route 53',
    kind: 'one-time',
    quantity: topology.hostedZones,
    quantityUnit: 'zones',
    ...priced(e.route53HostedZoneMonth),
    formula: `${topology.hostedZones} x ${e.route53HostedZoneMonth.usd}`,
    usd: topology.hostedZones * e.route53HostedZoneMonth.usd,
    confidence: 'HIGH',
    basis: src,
  });
  if (topology.wafWebAcls > 0) {
    notes.push(`UNPRICED: ${topology.wafWebAcls} WAF web ACL(s) (the contract says no WAF)`);
  }
  for (const t of topology.unpricedTypes) notes.push(`UNPRICED resource type in the synth: ${t}`);

  // ── Residual after teardown (first 30 days) ─────────────────────────────────────────────
  const residual: ResidualItem[] = [];
  const keyHour = book.kmsKeyMonth.usd / HOURS_PER_MONTH;
  const deletedKeys = topology.kmsKeys - topology.kmsRetainedKeys;
  const kmsNote = book.notes.kmsKeyPendingDeletion;
  if (deletedKeys > 0) {
    const windowHours = (topology.kmsPendingWindowDays + 1) * 24;
    residual.push({
      id: 'RES-L1',
      item: `${deletedKeys} KMS key(s) in PendingDeletion for ${topology.kmsPendingWindowDays} days (+ up to 24 h)`,
      likelyUsd: 0,
      worstUsd: round(deletedKeys * keyHour * windowHours),
      basis: `likely: ${kmsNote.repoQuote} (${kmsNote.quotedIn}); price snapshot status: ${kmsNote.status}; worst: billed as active for ${windowHours} h (UNVERIFIED)`,
    });
  }
  if (topology.kmsRetainedKeys > 0) {
    const usd = round(topology.kmsRetainedKeys * keyHour * 30 * 24);
    residual.push({
      id: 'RES-L2',
      item: `${topology.kmsRetainedKeys} KMS key(s) with DeletionPolicy Retain (stay ENABLED)`,
      likelyUsd: usd,
      worstUsd: usd,
      basis: 'billed until a human schedules deletion; not expected in the sandbox',
    });
  }
  if (topology.secrets > 0) {
    const s = book.notes.secretPendingDeletion;
    residual.push({
      id: 'RES-L3',
      item: `${topology.secrets} secret(s) scheduled for deletion (recovery window up to 30 days)`,
      likelyUsd: 0,
      worstUsd: round(
        (topology.secrets * book.secretMonth.usd * 30 * 24) / SECRETS_HOURS_PER_MONTH,
      ),
      basis: `likely: ${s.repoQuote} (${s.quotedIn}); worst: billed for a 30-day window (UNVERIFIED)`,
    });
  }
  if (topology.dynamodbPitrTables > 0) {
    const d = book.notes.dynamodbSystemBackup;
    residual.push({
      id: 'RES-L4',
      item: `${topology.dynamodbPitrTables} DynamoDB system backup(s) of deleted PITR tables (35 days)`,
      likelyUsd: 0,
      worstUsd: 0,
      basis: `${d.repoQuote} (${d.quotedIn})`,
    });
  }
  for (const db of topology.rds) {
    const backupMonth = book.rdsBackupGbMonth.usd;
    if (db.snapshotOnDelete) {
      residual.push({
        id: 'RES-L5',
        item: `RDS final snapshot of ${db.logicalId} (DeletionPolicy Snapshot)`,
        likelyUsd: round(Math.min(2, db.storageGiB) * backupMonth),
        worstUsd: round(db.storageGiB * backupMonth),
        basis: `${Math.min(2, db.storageGiB)} GiB likely / ${db.storageGiB} GiB worst x ${backupMonth} per GB-month (no free allocation without a running instance); not expected in the sandbox (destroy)`,
      });
    }
    if (db.retainsAutomatedBackups) {
      residual.push({
        id: 'RES-L6',
        item: `RDS retained automated backups of ${db.logicalId} (DeleteAutomatedBackups false)`,
        likelyUsd: round((Math.min(2, db.storageGiB) * backupMonth * 2) / 30),
        worstUsd: round((db.storageGiB * backupMonth * 2) / 30),
        basis:
          'kept until the retention period ends (about 1 day in dev; 2 days priced); not expected in the sandbox (automated backups deleted)',
      });
    }
  }
  residual.push({
    id: 'RES-L7',
    item: 'CDK bootstrap stack starter-cdk-toolkit, if kept (staging bucket assets)',
    likelyUsd: round(0.05 * book.s3GbMonth.usd),
    worstUsd: round(0.05 * book.s3GbMonth.usd),
    basis:
      'no customer key assumed (bootstrap without --bootstrap-customer-key); removing it is a separate decision',
  });

  return { items: b.items, residual, notes, assumptions: [...used.values()] };
}

/** Total estimated workload cost for a lifetime of `hours`. */
export function totalForHours(
  totals: { perHourUsd: number; oneTimeUsd: number; partialHourRoundingUsd: number },
  hours: number,
): number {
  return totals.oneTimeUsd + totals.partialHourRoundingUsd + totals.perHourUsd * hours;
}

export function estimate(
  topology: Topology,
  book: PriceBook,
  options: EstimateOptions = {},
): Estimate {
  const usage = usageFor(topology.phase);
  const { items, residual, notes, assumptions } = priceTopology(topology, book, usage);
  const sum = (f: (i: LineItem) => boolean, k: 'usdPerHour' | 'oneTimeUsd') =>
    items.filter(f).reduce((acc, i) => acc + i[k], 0);
  const perHourFixedUsd = sum(
    (i) => i.kind === 'hourly' || i.kind === 'hourly-partial',
    'usdPerHour',
  );
  const perHourUsageUsd = sum((i) => i.kind === 'usage', 'usdPerHour');
  const perHourUsd = perHourFixedUsd + perHourUsageUsd;
  const oneTimeUsd = sum((i) => i.kind === 'one-time', 'oneTimeUsd');
  const partialHourRoundingUsd = sum((i) => i.kind === 'hourly-partial', 'usdPerHour');

  const budgetUsd = options.budgetUsd ?? DEFAULTS.budgetUsd;
  const stopUsd = options.stopUsd ?? DEFAULTS.stopUsd;
  const spentUsd = options.spentUsd ?? 0;
  const marginPercent = options.marginPercent ?? DEFAULTS.marginPercent;
  const taxRatePercent = options.taxRatePercent ?? DEFAULTS.taxRatePercent;
  const accountLevelUsd = options.accountLevelUsd ?? usage.accountLevel.highUsd;
  const timeBoxHours = options.timeBoxHours ?? usage.timeBoxHours.value;
  const tax = 1 + taxRatePercent / 100;
  const margin = 1 + marginPercent / 100;
  const residualWorst = residual.reduce((a, r) => a + r.worstUsd, 0);
  const residualLikely = residual.reduce((a, r) => a + r.likelyUsd, 0);

  const hoursList = [...new Set([...(options.hours ?? DEFAULTS.hours)])].sort((x, y) => x - y);
  const totalsBase = { perHourUsd, oneTimeUsd, partialHourRoundingUsd };
  const byHours: HoursTotal[] = hoursList.map((h) => {
    const workload = totalForHours(totalsBase, h);
    return {
      hours: h,
      workloadUsd: round(workload),
      withAccountLevelUsd: round(workload + accountLevelUsd),
      withAccountLevelAndTaxUsd: round((workload + accountLevelUsd) * (1 + taxRatePercent / 100)),
    };
  });

  // The margin covers the workload estimate (usage lines are LOW/MEDIUM confidence); the
  // account-level allowance and the residual are already upper bounds; tax applies to all.
  const allowed = (stopUsd - spentUsd) / tax;
  const fixedNoAccount = (oneTimeUsd + partialHourRoundingUsd) * margin + residualWorst;
  const fixedUsd = fixedNoAccount + accountLevelUsd;
  // Capped at one year so the value stays a finite JSON number when nothing bills by the hour.
  const hoursFor = (fixed: number) =>
    perHourUsd > 0
      ? Math.min(
          MAX_HOURS,
          Math.max(0, Math.floor(((allowed - fixed) / (perHourUsd * margin)) * 10) / 10),
        )
      : MAX_HOURS;
  const maxRuntimeHours = hoursFor(fixedUsd);
  const effective = Math.min(maxRuntimeHours, timeBoxHours);

  const stopRule: StopRuleResult = {
    budgetUsd,
    stopUsd,
    spentUsd,
    marginPercent,
    taxRatePercent,
    accountLevelUsd,
    allowedEstimateUsd: round(allowed),
    fixedUsd: round(fixedUsd),
    maxRuntimeHours,
    maxRuntimeHoursWithoutAccountLevel: hoursFor(fixedNoAccount),
    timeBoxHours,
    timeBoxBasis: `${usage.timeBoxHours.id}: ${usage.timeBoxHours.basis}`,
    effectiveMaxRuntimeHours: effective,
    bindingLimit: effective < maxRuntimeHours ? 'time-box' : 'stop-rule',
    teardownHours: usage.teardownHours.value,
    formula:
      'max h: ((oneTime + partialHourRounding + perHour x h) x (1 + margin) + accountLevel + residualWorst30d) x (1 + tax) <= stop - spent; effective = min(max h, time box)',
  };

  const allNotes = [...topology.notes, ...notes];
  if (topology.basis.kind === 'contract') {
    allNotes.push(
      'Built from the contract resource list, not from a synthesized template: re-run with --synth <cdk.out> when available.',
    );
  }
  allNotes.push(
    `Residual likely ${round(residualLikely, 4)} / worst ${round(residualWorst, 4)} USD in the first 30 days; the worst case is in the stop-rule fixed part.`,
  );

  return {
    kind: 'starter-aws-sandbox/estimate',
    schemaVersion: 1,
    generatedAt: (options.now ?? new Date()).toISOString(),
    phase: topology.phase,
    disclaimer: DISCLAIMER,
    priceBasis: {
      snapshot: book.snapshot.version,
      snapshotCapturedAt: book.snapshot.capturedAt,
      supplement: book.supplement.version,
      supplementCapturedAt: book.supplement.capturedAt,
      region: book.snapshot.region,
      currency: 'USD',
      hoursPerMonth: HOURS_PER_MONTH,
      notLivePricing: true,
    },
    topology,
    assumptions: [...assumptions, usage.timeBoxHours, usage.teardownHours].sort((x, y) =>
      x.id.localeCompare(y.id),
    ),
    lineItems: items,
    totals: {
      perHourUsd: round(perHourUsd),
      perHourFixedUsd: round(perHourFixedUsd),
      perHourUsageUsd: round(perHourUsageUsd),
      oneTimeUsd: round(oneTimeUsd),
      partialHourRoundingUsd: round(partialHourRoundingUsd),
      byHours,
    },
    accountLevel: {
      status: 'UNKNOWN',
      lowUsd: usage.accountLevel.lowUsd,
      highUsd: usage.accountLevel.highUsd,
      usedUsd: accountLevelUsd,
      basis: usage.accountLevel.basis,
    },
    residual: {
      horizon: 'first 30 days after teardown',
      items: residual,
      likelyUsd: round(residualLikely),
      worstUsd: round(residualWorst),
      kmsPendingDeletionCharge: book.notes.kmsKeyPendingDeletion,
    },
    stopRule,
    notes: allNotes,
  };
}

/** Fixed hourly cost a CloudFormation resource adds while it exists (0 = usage-based or free). */
export function resourceHourlyUsd(
  type: string,
  book: PriceBook,
  context: {
    readonly albPublicIpv4PerAlb?: number;
    readonly rdsClass?: string;
    readonly rdsMultiAz?: boolean;
    readonly rdsStorageGiB?: number;
    readonly rdsStorageType?: string;
    readonly serviceTaskHourUsd?: number;
    readonly containerInsightsMetrics?: number;
  } = {},
): number {
  switch (type) {
    case 'AWS::EC2::NatGateway':
      return book.natHour.usd;
    case 'AWS::EC2::EIP':
      return book.publicIpv4Hour.usd;
    case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
      return (
        book.albHour.usd +
        book.albLcuHour.usd +
        (context.albPublicIpv4PerAlb ?? 2) * book.publicIpv4Hour.usd
      );
    case 'AWS::RDS::DBInstance': {
      const inst = book.rdsInstanceHour(
        context.rdsClass ?? 'db.t4g.micro',
        context.rdsMultiAz ?? false,
      );
      const st = book.rdsStorageGbMonth(
        context.rdsStorageType ?? 'gp3',
        context.rdsMultiAz ?? false,
      );
      return (inst?.usd ?? 0) + ((context.rdsStorageGiB ?? 20) * (st?.usd ?? 0)) / HOURS_PER_MONTH;
    }
    case 'AWS::ECS::Service':
      return context.serviceTaskHourUsd ?? taskHour(book, 0.25, 0.5, 'arm64');
    case 'AWS::ECS::Cluster':
      return (
        ((context.containerInsightsMetrics ?? 0) * book.extra.containerInsightsEcsMetricMonth.usd) /
        HOURS_PER_MONTH
      );
    case 'AWS::KMS::Key':
      return book.kmsKeyMonth.usd / HOURS_PER_MONTH;
    case 'AWS::SecretsManager::Secret':
      return book.secretMonth.usd / SECRETS_HOURS_PER_MONTH;
    case 'AWS::CloudWatch::Alarm':
    case 'AWS::CloudWatch::CompositeAlarm':
      return book.alarmMonth.usd / HOURS_PER_MONTH;
    case 'AWS::CloudWatch::Dashboard':
      return book.extra.cloudwatchDashboardMonth.usd / HOURS_PER_MONTH;
    case 'AWS::EC2::VPCEndpoint':
      return 0; // gateway endpoints are free; interface endpoints are priced in the estimate
    default:
      return 0;
  }
}

export { taskHour };
