/**
 * Machine-readable output contracts of the tool (validated before anything is written, and
 * published as JSON Schema under schema/ with `starter-aws-sandbox schema --write`).
 */
import { z } from 'zod';

const usd = z.number();
const isoTime = z.string().min(10);
const masked = z.string().regex(/^\*{8}\d{4}$/, 'masked account (********NNNN)');

export const guardRecordSchema = z
  .object({
    time: z.string(),
    label: z.string(),
    account: masked,
    principalArn: z.string(),
    principalType: z.string(),
    region: z.string(),
    executionProfile: z.literal('personal-sandbox'),
  })
  .strict();

/** Account-guard verifications; maxAgeSeconds > 0 is an operator opt-in (contract deviation). */
const guardSchema = z
  .object({
    checks: z.array(guardRecordSchema),
    refusal: z.string().nullable(),
    maxAgeSeconds: z.number().nonnegative(),
  })
  .strict();

const toolInfo = z
  .object({
    /** Paths are repository-relative or `~/…` (no operator home directory in evidence). */
    awsCli: z
      .object({ path: z.string(), sha256: z.string(), version: z.string().nullable() })
      .strict()
      .nullable(),
    guardCli: z.object({ path: z.string(), sha256: z.string().nullable() }).strict(),
    awsCalls: z.array(
      z
        .object({
          service: z.string(),
          operation: z.string(),
          iamAction: z.string(),
          ok: z.boolean(),
          errorCode: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

// ── verify-clean ─────────────────────────────────────────────────────────────────────────────

export const FINDING_CLASSES = [
  'remaining',
  'pending-deletion',
  'retained-by-design',
  'not-owned',
] as const;

/** How far a verify-clean category could be proven (see sweep/common.ts CategoryStatus). */
export const CATEGORY_STATUSES = [
  'ok',
  'error',
  'fallback',
  'unverifiable-with-this-role',
  'not-used-by-experiment',
] as const;

export const findingSchema = z
  .object({
    class: z.enum(FINDING_CLASSES),
    scope: z.enum(['experiment', 'bootstrap']),
    service: z.string(),
    resourceType: z.string(),
    id: z.string(),
    arn: z.string().optional(),
    name: z.string().optional(),
    state: z.string().optional(),
    createdAt: isoTime.optional(),
    deletionDate: isoTime.optional(),
    match: z.array(z.string()).min(1),
    note: z.string().optional(),
    hourlyUsdIfLeft: usd.optional(),
    residualLikelyUsd: usd.optional(),
    residualWorstUsd: usd.optional(),
  })
  .strict();
export type Finding = z.infer<typeof findingSchema>;

export const verifyReportSchema = z
  .object({
    kind: z.literal('starter-aws-sandbox/verify-clean'),
    schemaVersion: z.literal(1),
    generatedAt: isoTime,
    runId: z.string(),
    region: z.string(),
    account: masked.nullable(),
    executionProfile: z.literal('personal-sandbox'),
    readOnly: z.literal(true),
    deletesNothing: z.literal(true),
    includeBootstrap: z.boolean(),
    strict: z.boolean(),
    baseline: z.object({ file: z.string(), entries: z.number().int() }).strict().nullable(),
    since: isoTime.nullable(),
    /** Where `since` came from: the --since flag, or the inventory's first stack creation. */
    sinceSource: z.enum(['flag', 'inventory']).nullable(),
    inventory: z.object({ file: z.string(), runId: z.string() }).strict().nullable(),
    status: z.enum([
      'clean',
      'clean-with-unverifiable',
      'not-clean',
      'incomplete',
      'guard-refused',
      'error',
    ]),
    statusReason: z.string(),
    summary: z
      .object({
        remaining: z.number().int(),
        pendingDeletion: z.number().int(),
        retainedByDesign: z.number().int(),
        notOwned: z.number().int(),
        bootstrapReported: z.number().int(),
        remainingUsdPerHour: usd,
        residualLikelyUsd: usd,
        residualWorstUsd: usd,
        pendingDeletionUntil: isoTime.nullable(),
        incomplete: z.boolean(),
        unverifiable: z.array(
          z
            .object({
              category: z.string(),
              status: z.enum(CATEGORY_STATUSES),
              evidence: z.array(z.string()),
            })
            .strict(),
        ),
      })
      .strict(),
    coverage: z.array(
      z
        .object({
          service: z.string(),
          operations: z.array(z.string()),
          status: z.enum(CATEGORY_STATUSES),
          errors: z.array(
            z
              .object({
                operation: z.string(),
                kind: z.string(),
                code: z.string(),
                message: z.string(),
              })
              .strict(),
          ),
          denied: z.array(z.string()),
          evidence: z.array(z.string()),
          justification: z.string().optional(),
        })
        .strict(),
    ),
    deletionEvidence: z
      .object({
        available: z.boolean(),
        note: z.string(),
        stacks: z.array(
          z
            .object({ name: z.string(), status: z.string(), deletedAt: isoTime.optional() })
            .strict(),
        ),
        resources: z.array(
          z
            .object({
              stack: z.string(),
              logicalId: z.string(),
              type: z.string(),
              physicalId: z.string().optional(),
              status: z.string(),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
    findings: z.array(findingSchema),
    bootstrap: z.array(findingSchema),
    tagIndexOnly: z.array(
      z
        .object({
          arn: z.string(),
          service: z.string(),
          covered: z.boolean(),
          blocking: z.boolean(),
          note: z.string(),
        })
        .strict(),
    ),
    guard: guardSchema,
    tool: toolInfo,
    notes: z.array(z.string()),
  })
  .strict();
export type VerifyReport = z.infer<typeof verifyReportSchema>;

// ── inventory ────────────────────────────────────────────────────────────────────────────────

export const inventoryResourceSchema = z
  .object({
    logicalId: z.string(),
    type: z.string(),
    physicalId: z.string().nullable(),
    status: z.string().nullable(),
    createdAt: isoTime.nullable(),
    lastUpdatedAt: isoTime.nullable(),
    hourlyUsd: usd,
    nestedStack: z.string().optional(),
  })
  .strict();

export const inventoryStackSchema = z
  .object({
    name: z.string(),
    id: z.string().nullable(),
    status: z.string().nullable(),
    createdAt: isoTime.nullable(),
    lastUpdatedAt: isoTime.nullable(),
    terminationProtection: z.boolean(),
    tags: z.record(z.string(), z.string()),
    resources: z.array(inventoryResourceSchema),
    hourlyUsd: usd,
  })
  .strict();

export const inventorySchema = z
  .object({
    kind: z.literal('starter-aws-sandbox/inventory'),
    schemaVersion: z.literal(1),
    generatedAt: isoTime,
    runId: z.string(),
    phase: z.union([z.literal(1), z.literal(2)]),
    region: z.string(),
    account: masked.nullable(),
    executionProfile: z.literal('personal-sandbox'),
    readOnly: z.literal(true),
    status: z.enum(['ok', 'incomplete', 'no-stacks', 'guard-refused', 'error']),
    statusReason: z.string(),
    stacks: z.array(inventoryStackSchema),
    bootstrap: inventoryStackSchema.nullable(),
    /** Ids verify-clean can use after the stacks are gone (masked like the rest). */
    experimentResources: z
      .object({
        kmsKeys: z.array(
          z
            .object({
              stack: z.string(),
              logicalId: z.string(),
              keyId: z.string(),
              arn: z.string().nullable(),
            })
            .strict(),
        ),
        secrets: z.array(
          z.object({ stack: z.string(), logicalId: z.string(), arn: z.string() }).strict(),
        ),
        logGroups: z.array(
          z.object({ stack: z.string(), logicalId: z.string(), name: z.string() }).strict(),
        ),
      })
      .strict(),
    otherRunStacks: z.array(z.object({ name: z.string(), runId: z.string().nullable() }).strict()),
    cost: z
      .object({
        disclaimer: z.string(),
        estimateBasis: z.enum(['contract', 'synth']),
        priceBasis: z.string(),
        resourcesUsdPerHour: usd,
        otherUsdPerHour: usd,
        totalUsdPerHour: usd,
        oneTimeUsd: usd,
        partialHourRoundingUsd: usd,
        accountLevelUsd: usd,
        startedAt: isoTime.nullable(),
        elapsedHours: z.number().nullable(),
        estimatedSpendSoFarUsd: usd.nullable(),
      })
      .strict(),
    runtime: z
      .object({
        stopUsd: usd,
        spentUsd: usd,
        marginPercent: z.number(),
        taxRatePercent: z.number(),
        maxRuntimeHours: z.number(),
        timeBoxHours: z.number(),
        effectiveMaxRuntimeHours: z.number(),
        bindingLimit: z.enum(['time-box', 'stop-rule']),
        teardownStartBy: isoTime.nullable(),
        allDeletedBy: isoTime.nullable(),
        expiresAtTag: z.string().nullable(),
        basis: z.string(),
      })
      .strict(),
    teardown: z
      .object({
        owner: z.string(),
        command: z.string(),
        verifyCommand: z.string(),
        notes: z.array(z.string()),
      })
      .strict(),
    guard: guardSchema,
    tool: toolInfo,
    errors: z.array(
      z
        .object({ operation: z.string(), kind: z.string(), code: z.string(), message: z.string() })
        .strict(),
    ),
    notes: z.array(z.string()),
  })
  .strict();
export type Inventory = z.infer<typeof inventorySchema>;

// ── estimate ─────────────────────────────────────────────────────────────────────────────────

const assumptionSchema = z
  .object({ id: z.string(), value: z.number(), unit: z.string(), basis: z.string() })
  .strict();

export const estimateSchema = z
  .object({
    kind: z.literal('starter-aws-sandbox/estimate'),
    schemaVersion: z.literal(1),
    generatedAt: isoTime,
    phase: z.union([z.literal(1), z.literal(2)]),
    disclaimer: z.string(),
    priceBasis: z
      .object({
        snapshot: z.string(),
        snapshotCapturedAt: z.string(),
        supplement: z.string(),
        supplementCapturedAt: z.string(),
        region: z.string(),
        currency: z.literal('USD'),
        hoursPerMonth: z.number(),
        notLivePricing: z.literal(true),
      })
      .strict(),
    topology: z.looseObject({
      phase: z.union([z.literal(1), z.literal(2)]),
      basis: z
        .object({
          kind: z.enum(['contract', 'synth']),
          ref: z.string(),
          stacks: z.array(z.string()),
        })
        .strict(),
    }),
    assumptions: z.array(assumptionSchema),
    lineItems: z.array(
      z
        .object({
          id: z.string(),
          component: z.string(),
          billingService: z.string(),
          kind: z.enum(['hourly', 'hourly-partial', 'usage', 'one-time']),
          quantity: z.number(),
          quantityUnit: z.string(),
          unitPriceUsd: usd,
          priceUnit: z.string(),
          priceRef: z.string(),
          formula: z.string(),
          usdPerHour: usd,
          oneTimeUsd: usd,
          confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
          basis: z.string(),
        })
        .strict(),
    ),
    totals: z
      .object({
        perHourUsd: usd,
        perHourFixedUsd: usd,
        perHourUsageUsd: usd,
        oneTimeUsd: usd,
        partialHourRoundingUsd: usd,
        byHours: z.array(
          z
            .object({
              hours: z.number(),
              workloadUsd: usd,
              withAccountLevelUsd: usd,
              withAccountLevelAndTaxUsd: usd,
            })
            .strict(),
        ),
      })
      .strict(),
    accountLevel: z
      .object({
        status: z.literal('UNKNOWN'),
        lowUsd: usd,
        highUsd: usd,
        usedUsd: usd,
        basis: z.string(),
      })
      .strict(),
    residual: z
      .object({
        horizon: z.literal('first 30 days after teardown'),
        items: z.array(
          z
            .object({
              id: z.string(),
              item: z.string(),
              likelyUsd: usd,
              worstUsd: usd,
              basis: z.string(),
            })
            .strict(),
        ),
        likelyUsd: usd,
        worstUsd: usd,
        kmsPendingDeletionCharge: z
          .object({
            status: z.string(),
            repoQuote: z.string(),
            quotedIn: z.string(),
            treatment: z.string(),
          })
          .strict(),
      })
      .strict(),
    stopRule: z
      .object({
        budgetUsd: usd,
        stopUsd: usd,
        spentUsd: usd,
        marginPercent: z.number(),
        taxRatePercent: z.number(),
        accountLevelUsd: usd,
        allowedEstimateUsd: usd,
        fixedUsd: usd,
        maxRuntimeHours: z.number(),
        maxRuntimeHoursWithoutAccountLevel: z.number(),
        timeBoxHours: z.number(),
        timeBoxBasis: z.string(),
        effectiveMaxRuntimeHours: z.number(),
        bindingLimit: z.enum(['time-box', 'stop-rule']),
        teardownHours: z.number(),
        formula: z.string(),
      })
      .strict(),
    notes: z.array(z.string()),
  })
  .strict();

// ── reconciliation ───────────────────────────────────────────────────────────────────────────

/** Filled in by the finance / account owner from the Billing console (never by an API call). */
export const billedInputSchema = z
  .object({
    kind: z.literal('starter-aws-sandbox/billed-input'),
    schemaVersion: z.literal(1),
    runId: z.string(),
    phase: z.union([z.literal(1), z.literal(2)]),
    source: z.enum(['billing-console', 'cost-explorer-console', 'invoice']),
    readAt: isoTime,
    readBy: z.string().min(1),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    resourcesCreatedAt: isoTime,
    teardownCompletedAt: isoTime,
    baselineUsdPerDay: usd.nonnegative(),
    accountTotalUsd: usd.nonnegative(),
    taxIncluded: z.boolean(),
    byService: z.record(z.string(), usd),
    notes: z.string().optional(),
  })
  .strict();
export type BilledInput = z.infer<typeof billedInputSchema>;

export const reconciliationSchema = z
  .object({
    kind: z.literal('starter-aws-sandbox/reconciliation'),
    schemaVersion: z.literal(1),
    generatedAt: isoTime,
    runId: z.string(),
    phase: z.union([z.literal(1), z.literal(2)]),
    status: z.enum([
      'PROVISIONAL',
      'INCONCLUSIVE',
      'WITHIN_ESTIMATE',
      'ABOVE_ESTIMATE',
      'BELOW_ESTIMATE',
      'STOP_RULE_REACHED',
    ]),
    statusReason: z.string(),
    hoursRun: z.number(),
    hoursSinceTeardown: z.number(),
    estimate: z
      .object({
        basis: z.string(),
        priceBasis: z.string(),
        workloadUsd: usd,
        withAccountLevelHighUsd: usd,
        accountLevelLowUsd: usd,
        accountLevelHighUsd: usd,
      })
      .strict(),
    billed: z
      .object({
        source: z.string(),
        readAt: isoTime,
        readBy: z.string(),
        periodDays: z.number(),
        accountTotalUsd: usd,
        baselineUsd: usd,
        attributableUsd: usd,
        taxIncluded: z.boolean(),
      })
      .strict(),
    varianceUsd: usd,
    variancePercent: z.number().nullable(),
    stopRule: z.object({ stopUsd: usd, reached: z.boolean() }).strict(),
    byService: z.array(
      z
        .object({
          service: z.string(),
          estimatedUsd: usd,
          billedUsd: usd.nullable(),
          differenceUsd: usd.nullable(),
        })
        .strict(),
    ),
    checkpoints: z.array(z.object({ id: z.string(), due: isoTime, what: z.string() }).strict()),
    notes: z.array(z.string()),
  })
  .strict();
export type Reconciliation = z.infer<typeof reconciliationSchema>;

export const SCHEMAS = {
  inventory: inventorySchema,
  'verify-clean': verifyReportSchema,
  estimate: estimateSchema,
  'billed-input': billedInputSchema,
  reconciliation: reconciliationSchema,
} as const;
export type SchemaName = keyof typeof SCHEMAS;

export function jsonSchemaFor(name: SchemaName): Record<string, unknown> {
  return {
    title: `starter-aws-sandbox ${name}`,
    ...(z.toJSONSchema(SCHEMAS[name], { target: 'draft-2020-12' }) as Record<string, unknown>),
  };
}
