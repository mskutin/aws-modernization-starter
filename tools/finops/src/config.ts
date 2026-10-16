/**
 * Versioned, schema-validated FinOps inputs: price table, usage assumptions,
 * approval thresholds. All three are plain YAML files reviewed in MRs.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

export const FINOPS_ROOT = fileURLToPath(new URL('../', import.meta.url));
/**
 * Default deployment region. Mirrors DEFAULT_AWS_REGION of `@starter/config/region` (the single
 * source of truth; this tool does not depend on it) and is pinned to it by tests.
 */
export const DEFAULT_REGION = 'ap-southeast-1';
/** One price table per region: `pricing/<region>.yaml`. */
export const PRICING_DIR = join(FINOPS_ROOT, 'pricing');
export const DEFAULT_PRICES = join(PRICING_DIR, `${DEFAULT_REGION}.yaml`);
export const DEFAULT_USAGE = join(FINOPS_ROOT, 'assumptions', 'usage.yaml');
export const DEFAULT_THRESHOLDS = join(FINOPS_ROOT, 'thresholds.yaml');

export const ENVIRONMENTS = ['dev', 'staging', 'prod'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

const usd = z.number().nonnegative();
const byArch = z.object({ x86_64: usd, arm64: usd }).strict();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const priceTableSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().min(1),
    region: z.string().min(1),
    currency: z.literal('USD'),
    capturedAt: isoDate,
    source: z.string().min(10),
    services: z
      .object({
        lambda: z.object({
          offerPublished: z.string(),
          requestPerMillion: usd,
          gbSecond: byArch,
          provisionedConcurrencyGbSecond: byArch,
          provisionedDurationGbSecond: byArch,
        }),
        fargate: z.object({ offerPublished: z.string(), vcpuHour: byArch, gbHour: byArch }),
        rds: z.object({
          offerPublished: z.string(),
          postgresInstanceHour: z.record(z.string(), z.object({ singleAz: usd, multiAz: usd })),
          storageGbMonth: z.record(z.string(), z.object({ singleAz: usd, multiAz: usd })),
          backupGbMonth: usd,
        }),
        dynamodb: z.object({
          offerPublished: z.string(),
          onDemandReadPerMillion: usd,
          onDemandWritePerMillion: usd,
          provisionedRcuHour: usd,
          provisionedWcuHour: usd,
          storageGbMonth: usd,
          pitrGbMonth: usd,
        }),
        cloudfront: z.object({
          offerPublished: z.string(),
          dataTransferOutGb: usd,
          httpsRequestsPer10k: usd,
        }),
        elb: z.object({ offerPublished: z.string(), albHour: usd, albLcuHour: usd }),
        vpc: z.object({
          offerPublished: z.string(),
          natGatewayHour: usd,
          natGatewayDataGb: usd,
          interfaceEndpointHourPerAz: usd,
          interfaceEndpointDataGb: usd,
          publicIpv4Hour: usd,
        }),
        cloudwatch: z.object({
          offerPublished: z.string(),
          logIngestGb: usd,
          logStorageGbMonth: usd,
          alarmStandardMonth: usd,
        }),
        kms: z.object({ offerPublished: z.string(), keyMonth: usd, requestsPer10k: usd }),
        secretsManager: z.object({ offerPublished: z.string(), secretMonth: usd }),
        s3: z.object({ offerPublished: z.string(), standardGbMonth: usd }),
        stepFunctions: z.object({
          offerPublished: z.string(),
          standardTransitionPer1k: usd,
          expressRequestPerMillion: usd,
          expressGbSecond: usd,
        }),
      })
      .strict(),
  })
  .strict();
export type PriceTable = z.infer<typeof priceTableSchema>;

const n = z.number().nonnegative();
export const usageSchema = z
  .object({
    lambda: z.object({ invocationsPerMonth: n, avgDurationMs: n }).strict(),
    stepFunctions: z
      .object({
        executionsPerMonth: n,
        stateTransitionsPerExecution: n,
        expressAvgDurationMs: n,
        expressMemoryMb: n,
      })
      .strict(),
    dynamodb: z
      .object({ readRequestUnitsPerMonth: n, writeRequestUnitsPerMonth: n, storageGb: n })
      .strict(),
    cloudfront: z.object({ dataTransferOutGbPerMonth: n, requestsPerMonth: n }).strict(),
    alb: z.object({ averageLcu: n }).strict(),
    natGateway: z.object({ dataProcessedGbPerMonth: n }).strict(),
    vpcEndpoint: z.object({ dataProcessedGbPerMonth: n }).strict(),
    logs: z
      .object({
        ingestGbPerMonthPerLogGroup: n,
        storedCompressionRatio: z.number().min(0).max(1),
        assumedRetentionDaysWhenUnset: n,
      })
      .strict(),
    s3: z.object({ storageGbPerBucket: n }).strict(),
    fargate: z.object({ spotDiscountPercent: z.number().min(0).max(100) }).strict(),
  })
  .strict();
export type Usage = z.infer<typeof usageSchema>;

const deepPartial = <T extends z.ZodObject>(schema: T) =>
  z.object(
    Object.fromEntries(
      Object.entries(schema.shape).map(([k, v]) => [k, (v as z.ZodObject).partial().optional()]),
    ),
  );

export const usageFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().min(1),
    hoursPerMonth: z.number().positive(),
    defaults: usageSchema,
    environments: z.partialRecord(z.enum(ENVIRONMENTS), deepPartial(usageSchema)).default({}),
  })
  .strict();
export type UsageFile = z.infer<typeof usageFileSchema>;

const thresholdValues = z.object({
  monthlyIncreaseUsd: z.number().nonnegative(),
  monthlyIncreasePercent: z.number().nonnegative(),
});

export const thresholdsSchema = z
  .object({
    schemaVersion: z.literal(1),
    currency: z.literal('USD'),
    approval: thresholdValues
      .extend({
        perEnvironment: z
          .partialRecord(z.enum(ENVIRONMENTS), thresholdValues.partial())
          .default({}),
        /** Destructive changes ALWAYS require approval; the schema does not allow false. */
        destructiveChangesRequireApproval: z.literal(true),
        newResourceTypesRequiringApproval: z.array(z.string().regex(/^AWS::\w+::\w+$/)).default([]),
      })
      .strict(),
    approvalSignals: z
      .object({
        mergeRequestLabel: z.string().min(1),
        /** Opt-in: only safe when the variable can be set by Maintainers alone (protected env). */
        approvalVariable: z
          .string()
          .regex(/^[A-Z_][A-Z0-9_]*$/)
          .optional(),
      })
      .strict(),
  })
  .strict();
export type Thresholds = z.infer<typeof thresholdsSchema>;

export class ConfigError extends Error {}

function loadYaml<T>(file: string, schema: z.ZodType<T>, what: string): T {
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${what} ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new ConfigError(
      `${what} ${file} is invalid:\n` +
        r.error.issues.map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`).join('\n'),
    );
  }
  return r.data;
}

export const loadPriceTable = (file = DEFAULT_PRICES) =>
  loadYaml(file, priceTableSchema, 'Price table');

/** Regions with a committed price table (`pricing/<region>.yaml`), sorted. */
export function pricedRegions(dir = PRICING_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .sort();
}

/**
 * The price table file of `region`. FAILS CLOSED: a region without a committed table is refused
 * (prices are never borrowed from another region or invented). The region is matched against the
 * directory listing, so no other path can be built from it.
 */
export function priceTableFileFor(region: string, dir = PRICING_DIR): string {
  const known = pricedRegions(dir);
  if (!known.includes(region)) {
    throw new ConfigError(
      `no FinOps price table for region ${JSON.stringify(region.slice(0, 40))}: tools/finops/pricing/${region.slice(0, 40)}.yaml does not exist ` +
        `(price tables exist for: ${known.join(', ') || 'none'}). Add one transcribed from the public AWS Price List offer files of that region, ` +
        `with the same schema, version, capturedAt and source fields as pricing/${DEFAULT_REGION}.yaml; estimates never use another region's prices.`,
    );
  }
  return join(dir, `${region}.yaml`);
}

/** A loaded price table must be the table of the region it is used for. */
export function assertPriceTableRegion(
  table: PriceTable,
  region: string,
  file: string,
): PriceTable {
  if (table.region !== region) {
    throw new ConfigError(
      `Price table ${file} is for region ${table.region}, but the templates are in ${region}`,
    );
  }
  return table;
}

/** Loads the committed price table of `region` (fails closed, see `priceTableFileFor`). */
export function loadPriceTableForRegion(region: string, dir = PRICING_DIR): PriceTable {
  const file = priceTableFileFor(region, dir);
  return assertPriceTableRegion(loadPriceTable(file), region, file);
}
export const loadUsage = (file = DEFAULT_USAGE) =>
  loadYaml(file, usageFileSchema, 'Usage assumptions');
export const loadThresholds = (file = DEFAULT_THRESHOLDS) =>
  loadYaml(file, thresholdsSchema, 'Thresholds');

/** Usage for an environment: defaults deep-merged with the environment block. */
export function usageFor(file: UsageFile, env: Environment | undefined): Usage {
  const override = env ? file.environments[env] : undefined;
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(file.defaults)) {
    merged[k] = {
      ...(v as object),
      ...((override as Record<string, object> | undefined)?.[k] ?? {}),
    };
  }
  return usageSchema.parse(merged);
}

export function thresholdsFor(t: Thresholds, env: Environment | undefined) {
  const o = env ? t.approval.perEnvironment[env] : undefined;
  return {
    monthlyIncreaseUsd: o?.monthlyIncreaseUsd ?? t.approval.monthlyIncreaseUsd,
    monthlyIncreasePercent: o?.monthlyIncreasePercent ?? t.approval.monthlyIncreasePercent,
  };
}
