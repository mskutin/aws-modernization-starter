/**
 * Price book for the sandbox estimate: the repo's FinOps price snapshot (tools/finops, dated,
 * manually maintained) plus a small supplement with the prices that snapshot does not carry,
 * transcribed from the public AWS Price List (see the supplement's `source`). NEITHER IS LIVE
 * PRICING: every line item names the table, its version and capture date.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  DEFAULT_REGION,
  loadPriceTable,
  pricedRegions,
  priceTableFileFor,
  type PriceTable,
} from '@starter/tool-finops';
import { z } from 'zod';

export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** One supplement per region: `pricing/supplement.<region>.json`. */
export const SUPPLEMENT_DIR = join(PACKAGE_ROOT, 'pricing');
export const DEFAULT_SUPPLEMENT = join(SUPPLEMENT_DIR, `supplement.${DEFAULT_REGION}.json`);

/** Regions with a committed supplement, sorted. */
export function supplementRegions(dir = SUPPLEMENT_DIR): string[] {
  return readdirSync(dir)
    .map((f) => /^supplement\.(.+)\.json$/.exec(f)?.[1])
    .filter((r): r is string => r !== undefined)
    .sort();
}

/**
 * Regions the sandbox tooling runs in: those with BOTH a FinOps price table and a supplement.
 * Every command refuses any other region (its cost estimate would be impossible), and region
 * names come from committed file names, never from a pattern.
 */
export function sandboxRegions(): string[] {
  const supplements = new Set(supplementRegions());
  return pricedRegions().filter((r) => supplements.has(r));
}

/**
 * The supplement file of `region`. FAILS CLOSED for a region without one: prices are never taken
 * from another region or invented.
 */
export function supplementFileFor(region: string, dir = SUPPLEMENT_DIR): string {
  if (!supplementRegions(dir).includes(region)) {
    throw new PriceBookError(
      `no sandbox price supplement for region ${JSON.stringify(region.slice(0, 40))}: tools/aws-sandbox/pricing/supplement.${region.slice(0, 40)}.json does not exist ` +
        `(supplements exist for: ${supplementRegions(dir).join(', ') || 'none'}). Add one transcribed from the public AWS Price List offer files of that region ` +
        `(same schema as supplement.${DEFAULT_REGION}.json), next to tools/finops/pricing/<region>.yaml; estimates never use another region's prices.`,
    );
  }
  return join(dir, `supplement.${region}.json`);
}

/** Hours per month used by AWS for prorated monthly prices (and by tools/finops). */
export const HOURS_PER_MONTH = 730;
/** Secrets Manager prorates by hours of a 30-day month (pricing-page example: 0.40 x h / 720). */
export const SECRETS_HOURS_PER_MONTH = 720;

const supplementPrice = z
  .object({
    usd: z.number().nonnegative(),
    unit: z.string().min(1),
    offer: z.string().min(1),
    offerVersion: z.string().regex(/^\d{14}$/),
    sku: z.string().min(1),
    usageType: z.string().min(1),
  })
  .strict();

const billingNote = z
  .object({
    status: z.string().min(1),
    repoQuote: z.string().min(1),
    quotedIn: z.string().min(1),
    treatment: z.string().min(1),
  })
  .strict();

export const SUPPLEMENT_KEYS = [
  'cloudfrontFunctionsPerMillion',
  'cloudfrontToOriginGb',
  'cloudfrontInvalidationPath',
  'cloudwatchDashboardMonth',
  'cloudwatchCustomMetricMonth',
  'containerInsightsEcsMetricMonth',
  'xrayTracesPerMillion',
  'ecrStorageGbMonth',
  'dataTransferOutInternetGb',
  'dataTransferInterAzGb',
  's3PutPer1k',
  's3GetPer10k',
  'secretsManagerApiPer10k',
  'eventbridgeScheduledInvocationPerMillion',
  'rdsT4gCpuCreditVcpuHour',
  'route53HostedZoneMonth',
] as const;
export type SupplementKey = (typeof SUPPLEMENT_KEYS)[number];

export const supplementSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('starter-aws-sandbox/price-supplement'),
    version: z.string().min(1),
    region: z.string().min(1),
    currency: z.literal('USD'),
    capturedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    notLivePricing: z.string().min(10),
    source: z.string().min(10),
    prices: z.object(
      Object.fromEntries(SUPPLEMENT_KEYS.map((k) => [k, supplementPrice])) as Record<
        SupplementKey,
        typeof supplementPrice
      >,
    ),
    billingNotes: z
      .object({
        kmsKeyPendingDeletion: billingNote,
        secretPendingDeletion: billingNote,
        dynamodbSystemBackup: billingNote,
      })
      .strict(),
  })
  .strict();
export type Supplement = z.infer<typeof supplementSchema>;

/** One unit price and where it came from. */
export interface Price {
  readonly usd: number;
  readonly unit: string;
  /** e.g. `finops 2026.10.13-1 elb.albHour` or `supplement 2026.10.14-1 SKU UXD...`. */
  readonly ref: string;
}

export interface PriceBook {
  readonly snapshot: {
    readonly version: string;
    readonly capturedAt: string;
    readonly region: string;
    readonly file: string;
  };
  readonly supplement: {
    readonly version: string;
    readonly capturedAt: string;
    readonly file: string;
  };
  readonly notes: Supplement['billingNotes'];
  readonly natHour: Price;
  readonly natGb: Price;
  readonly publicIpv4Hour: Price;
  readonly interfaceEndpointHourPerAz: Price;
  readonly albHour: Price;
  readonly albLcuHour: Price;
  readonly rdsBackupGbMonth: Price;
  readonly fargateVcpuHour: Readonly<Record<'arm64' | 'x86_64', Price>>;
  readonly fargateGbHour: Readonly<Record<'arm64' | 'x86_64', Price>>;
  readonly lambdaRequestPerMillion: Price;
  readonly lambdaGbSecondArm: Price;
  readonly ddbWritePerMillion: Price;
  readonly ddbReadPerMillion: Price;
  readonly ddbStorageGbMonth: Price;
  readonly ddbPitrGbMonth: Price;
  readonly cloudfrontDtoGb: Price;
  readonly cloudfrontHttpsPer10k: Price;
  readonly logIngestGb: Price;
  readonly logStorageGbMonth: Price;
  readonly alarmMonth: Price;
  readonly kmsKeyMonth: Price;
  readonly kmsRequestsPer10k: Price;
  readonly secretMonth: Price;
  readonly s3GbMonth: Price;
  readonly sfnTransitionPer1k: Price;
  readonly extra: Readonly<Record<SupplementKey, Price>>;
  /** PostgreSQL instance-hour for a class, or undefined when the snapshot has no row. */
  rdsInstanceHour(instanceClass: string, multiAz: boolean): Price | undefined;
  /** RDS storage GB-month for a storage type (gp2/gp3), or undefined. */
  rdsStorageGbMonth(storageType: string, multiAz: boolean): Price | undefined;
}

export class PriceBookError extends Error {
  override name = 'PriceBookError';
}

export function loadSupplement(file = DEFAULT_SUPPLEMENT): Supplement {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new PriceBookError(
      `price supplement ${file}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const r = supplementSchema.safeParse(raw);
  if (!r.success) {
    throw new PriceBookError(
      `price supplement ${file} is invalid:\n` +
        r.error.issues.map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`).join('\n'),
    );
  }
  return r.data;
}

export function buildPriceBook(
  table: PriceTable,
  supplement: Supplement,
  files: { snapshot: string; supplement: string },
): PriceBook {
  if (table.region !== supplement.region) {
    throw new PriceBookError(
      `price snapshot region ${table.region} differs from the supplement region ${supplement.region}`,
    );
  }
  const s = table.services;
  const fin = (path: string, usd: number, unit: string): Price => ({
    usd,
    unit,
    ref: `finops ${table.version} (captured ${table.capturedAt}) ${path}`,
  });
  const extra = Object.fromEntries(
    SUPPLEMENT_KEYS.map((k) => {
      const p = supplement.prices[k];
      const ref = `supplement ${supplement.version} (captured ${supplement.capturedAt}) ${p.offer} ${p.offerVersion} SKU ${p.sku}`;
      return [k, { usd: p.usd, unit: p.unit, ref } satisfies Price];
    }),
  ) as Record<SupplementKey, Price>;
  return {
    snapshot: {
      version: table.version,
      capturedAt: table.capturedAt,
      region: table.region,
      file: files.snapshot,
    },
    supplement: {
      version: supplement.version,
      capturedAt: supplement.capturedAt,
      file: files.supplement,
    },
    notes: supplement.billingNotes,
    natHour: fin('vpc.natGatewayHour', s.vpc.natGatewayHour, 'NAT gateway-hour'),
    natGb: fin('vpc.natGatewayDataGb', s.vpc.natGatewayDataGb, 'GB processed'),
    publicIpv4Hour: fin('vpc.publicIpv4Hour', s.vpc.publicIpv4Hour, 'public IPv4 address-hour'),
    interfaceEndpointHourPerAz: fin(
      'vpc.interfaceEndpointHourPerAz',
      s.vpc.interfaceEndpointHourPerAz,
      'interface endpoint AZ-hour',
    ),
    albHour: fin('elb.albHour', s.elb.albHour, 'ALB-hour (or partial hour)'),
    albLcuHour: fin('elb.albLcuHour', s.elb.albLcuHour, 'LCU-hour (or partial hour)'),
    rdsBackupGbMonth: fin('rds.backupGbMonth', s.rds.backupGbMonth, 'GB-month'),
    fargateVcpuHour: {
      arm64: fin('fargate.vcpuHour.arm64', s.fargate.vcpuHour.arm64, 'vCPU-hour'),
      x86_64: fin('fargate.vcpuHour.x86_64', s.fargate.vcpuHour.x86_64, 'vCPU-hour'),
    },
    fargateGbHour: {
      arm64: fin('fargate.gbHour.arm64', s.fargate.gbHour.arm64, 'GB-hour'),
      x86_64: fin('fargate.gbHour.x86_64', s.fargate.gbHour.x86_64, 'GB-hour'),
    },
    lambdaRequestPerMillion: fin(
      'lambda.requestPerMillion',
      s.lambda.requestPerMillion,
      'million requests',
    ),
    lambdaGbSecondArm: fin('lambda.gbSecond.arm64', s.lambda.gbSecond.arm64, 'GB-second'),
    ddbWritePerMillion: fin(
      'dynamodb.onDemandWritePerMillion',
      s.dynamodb.onDemandWritePerMillion,
      'million WRU',
    ),
    ddbReadPerMillion: fin(
      'dynamodb.onDemandReadPerMillion',
      s.dynamodb.onDemandReadPerMillion,
      'million RRU',
    ),
    ddbStorageGbMonth: fin('dynamodb.storageGbMonth', s.dynamodb.storageGbMonth, 'GB-month'),
    ddbPitrGbMonth: fin('dynamodb.pitrGbMonth', s.dynamodb.pitrGbMonth, 'GB-month'),
    cloudfrontDtoGb: fin('cloudfront.dataTransferOutGb', s.cloudfront.dataTransferOutGb, 'GB'),
    cloudfrontHttpsPer10k: fin(
      'cloudfront.httpsRequestsPer10k',
      s.cloudfront.httpsRequestsPer10k,
      '10,000 HTTPS requests',
    ),
    logIngestGb: fin('cloudwatch.logIngestGb', s.cloudwatch.logIngestGb, 'GB ingested'),
    logStorageGbMonth: fin(
      'cloudwatch.logStorageGbMonth',
      s.cloudwatch.logStorageGbMonth,
      'GB-month',
    ),
    alarmMonth: fin(
      'cloudwatch.alarmStandardMonth',
      s.cloudwatch.alarmStandardMonth,
      'alarm-month',
    ),
    kmsKeyMonth: fin('kms.keyMonth', s.kms.keyMonth, 'key-month (prorated hourly)'),
    kmsRequestsPer10k: fin('kms.requestsPer10k', s.kms.requestsPer10k, '10,000 requests'),
    secretMonth: fin('secretsManager.secretMonth', s.secretsManager.secretMonth, 'secret-month'),
    s3GbMonth: fin('s3.standardGbMonth', s.s3.standardGbMonth, 'GB-month'),
    sfnTransitionPer1k: fin(
      'stepFunctions.standardTransitionPer1k',
      s.stepFunctions.standardTransitionPer1k,
      '1,000 state transitions',
    ),
    extra,
    rdsInstanceHour(instanceClass, multiAz) {
      const row = s.rds.postgresInstanceHour[instanceClass];
      if (!row) return undefined;
      return fin(
        `rds.postgresInstanceHour.${instanceClass}.${multiAz ? 'multiAz' : 'singleAz'}`,
        multiAz ? row.multiAz : row.singleAz,
        'instance-hour',
      );
    },
    rdsStorageGbMonth(storageType, multiAz) {
      const row = s.rds.storageGbMonth[storageType];
      if (!row) return undefined;
      return fin(
        `rds.storageGbMonth.${storageType}.${multiAz ? 'multiAz' : 'singleAz'}`,
        multiAz ? row.multiAz : row.singleAz,
        'GB-month',
      );
    },
  };
}

/**
 * Loads the snapshot and supplement of `region` (default DEFAULT_REGION), or the given files,
 * which must then be for that region. Fails closed for a region without committed price data.
 */
export function loadPriceBook(
  options: {
    region?: string | undefined;
    snapshotFile?: string | undefined;
    supplementFile?: string | undefined;
  } = {},
): PriceBook {
  const region = options.region ?? DEFAULT_REGION;
  let snapshotFile: string;
  try {
    snapshotFile = options.snapshotFile ?? priceTableFileFor(region);
  } catch (e) {
    throw new PriceBookError(e instanceof ConfigError ? e.message : String(e));
  }
  const table = loadPriceTable(snapshotFile);
  if (table.region !== region) {
    throw new PriceBookError(
      `price snapshot ${snapshotFile} is for ${table.region}, not ${region}`,
    );
  }
  const supplementFile = options.supplementFile ?? supplementFileFor(region);
  return buildPriceBook(table, loadSupplement(supplementFile), {
    snapshot: snapshotFile,
    supplement: supplementFile,
  });
}
