import { DEFAULT_AWS_REGION, defaultAvailabilityZones } from '../lib/region.js';
import { placeholderAuth, placeholderEdge, placeholderImportedFoundation } from './placeholders.js';
import {
  PLACEHOLDER_ACCOUNT_ID,
  type EnvironmentConfigInput,
  type SandboxFoundationSchema,
} from './schema.js';
import type { z } from 'zod';

/**
 * dev — development account. Imports the landing zone like every other
 * environment; `-c foundationMode=sandbox` swaps in `devSandboxFoundation`
 * for an isolated personal sandbox account (never for staging/prod).
 *
 * Built for a region (default DEFAULT_AWS_REGION; `-c region` / `-c region.dev` /
 * STARTER_REGION_DEV): the region-specific placeholders follow it. Real landing-zone values are
 * specific to one region; the schema refuses them in any other.
 */
export const devConfig = (region: string = DEFAULT_AWS_REGION): EnvironmentConfigInput => ({
  name: 'dev',
  account: PLACEHOLDER_ACCOUNT_ID, // PLACEHOLDER — override with -c account.dev=<id> or STARTER_ACCOUNT_ID_DEV
  region,
  resourcePrefix: 'starter-dev',
  cdkBootstrapQualifier: 'starter',
  tags: {
    Project: 'aws-modernization-starter',
    Environment: 'dev',
    Owner: 'platform-team',
    CostCentre: 'CC-PLACEHOLDER',
    DataClassification: 'Internal',
    ManagedBy: 'aws-cdk',
  },
  foundation: placeholderImportedFoundation('de', 'dev', region),
  api: {
    ecr: { mode: 'create' },
    cpu: 256,
    memoryMiB: 512,
    desiredCount: 1,
    minCapacity: 1,
    maxCapacity: 2,
    cpuTargetUtilizationPercent: 70,
    logLevel: 'debug',
    useFargateSpot: true,
    corsAllowedOrigins: [],
    albDeletionProtection: false,
  },
  workflow: {
    lambdaMemoryMiB: 512,
    // The account needs a concurrency quota ≥ 10 unreserved + all reservations.
    // 2 × 4 starter_processor connections ≤ database.connectionLimits.processor (20) − 2.
    reservedConcurrency: 4,
    logLevel: 'debug',
    placeInVpc: true,
    logExecutionData: true,
    reconciler: { scheduleMinutes: 5, staleAfterSeconds: 900, batchSize: 25, dryRun: false },
  },
  database: {
    engineVersion: '17.9',
    instanceType: 't4g.micro',
    multiAz: false,
    allocatedStorageGiB: 20,
    maxAllocatedStorageGiB: 50,
    backupRetentionDays: 1,
    deletionProtection: false,
    removalPolicy: 'snapshot',
    performanceInsights: false,
    monitoringIntervalSeconds: 0,
    databaseName: 'starterapp',
    masterUsername: 'starteradmin',
    // Master secret: bootstrap task only, read at runtime, so rotation needs no task restart.
    rotation: { enabled: true, intervalDays: 30 },
  },
  jobTable: { deletionProtection: false, removalPolicy: 'destroy', pitrRecoveryPeriodDays: 7 },
  // PLACEHOLDER — the organization IdP registration (identity); https only.
  auth: placeholderAuth('dev'),
  frontend: { priceClass: 'PriceClass_200', geoAllowlist: [] },
  observability: {
    logRetentionDays: 30,
    alarmEmails: [],
    thresholds: {
      alb5xxPerMinute: 10,
      ecsCpuPercent: 90,
      ecsMemoryPercent: 90,
      lambdaErrorsPer5Min: 5,
      rdsCpuPercent: 90,
      rdsFreeStorageGiB: 2,
    },
  },
  budget: {
    monthlyLimitUsd: 150,
    actualThresholdsPercent: [50, 80, 100],
    forecastThresholdPercent: 100,
    notificationEmails: [],
  },
});

/** dev in the default region. */
export const dev: EnvironmentConfigInput = devConfig();

/** Opt-in isolated sandbox foundation (creates a minimal VPC + KMS keys) in `region`. */
export const devSandboxFoundationFor = (
  region: string = DEFAULT_AWS_REGION,
): z.input<typeof SandboxFoundationSchema> => ({
  mode: 'sandbox',
  vpcCidr: '10.42.0.0/16',
  availabilityZones: defaultAvailabilityZones(region),
  natGateways: 1,
  edge: { ...placeholderEdge('de', 'dev', region), wafWebAclArn: undefined },
  mandatoryTags: {},
});

/** The dev sandbox foundation in the default region. */
export const devSandboxFoundation: z.input<typeof SandboxFoundationSchema> =
  devSandboxFoundationFor();
