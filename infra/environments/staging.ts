import { DEFAULT_AWS_REGION } from '../lib/region.js';
import { placeholderAuth, placeholderImportedFoundation } from './placeholders.js';
import { PLACEHOLDER_ACCOUNT_ID, type EnvironmentConfigInput } from './schema.js';

/** staging — production-like, imports the landing zone, smaller sizes. */
export const stagingConfig = (region: string = DEFAULT_AWS_REGION): EnvironmentConfigInput => ({
  name: 'staging',
  account: PLACEHOLDER_ACCOUNT_ID, // PLACEHOLDER — override with -c account.staging=<id> or STARTER_ACCOUNT_ID_STAGING
  region,
  resourcePrefix: 'starter-stg',
  cdkBootstrapQualifier: 'starter',
  tags: {
    Project: 'aws-modernization-starter',
    Environment: 'staging',
    Owner: 'platform-team',
    CostCentre: 'CC-PLACEHOLDER',
    DataClassification: 'Internal',
    ManagedBy: 'aws-cdk',
  },
  foundation: placeholderImportedFoundation('5a', 'staging', region),
  api: {
    ecr: { mode: 'create' },
    cpu: 512,
    memoryMiB: 1024,
    desiredCount: 2,
    minCapacity: 2,
    maxCapacity: 4,
    cpuTargetUtilizationPercent: 60,
    logLevel: 'info',
    useFargateSpot: false,
    corsAllowedOrigins: [],
    albDeletionProtection: true,
  },
  workflow: {
    lambdaMemoryMiB: 512,
    // 2 × 8 starter_processor connections ≤ database.connectionLimits.processor (20) − 2.
    reservedConcurrency: 8,
    logLevel: 'info',
    placeInVpc: true,
    logExecutionData: false,
    reconciler: { scheduleMinutes: 5, staleAfterSeconds: 900, batchSize: 25, dryRun: false },
  },
  database: {
    engineVersion: '17.9',
    instanceType: 't4g.medium',
    multiAz: false,
    allocatedStorageGiB: 50,
    maxAllocatedStorageGiB: 200,
    backupRetentionDays: 7,
    deletionProtection: true,
    removalPolicy: 'retain',
    performanceInsights: true,
    monitoringIntervalSeconds: 60,
    databaseName: 'starterapp',
    masterUsername: 'starteradmin',
    // Master secret: bootstrap task only, read at runtime, so rotation needs no task restart.
    rotation: { enabled: true, intervalDays: 30 },
  },
  jobTable: { deletionProtection: true, removalPolicy: 'retain', pitrRecoveryPeriodDays: 35 },
  // PLACEHOLDER — the organization IdP registration (identity); https only.
  auth: placeholderAuth('staging'),
  frontend: { priceClass: 'PriceClass_200', geoAllowlist: [] },
  observability: {
    logRetentionDays: 90,
    alarmEmails: [],
    thresholds: {
      alb5xxPerMinute: 5,
      ecsCpuPercent: 85,
      ecsMemoryPercent: 85,
      lambdaErrorsPer5Min: 3,
      rdsCpuPercent: 85,
      rdsFreeStorageGiB: 5,
    },
  },
  budget: {
    monthlyLimitUsd: 400,
    actualThresholdsPercent: [50, 80, 100],
    forecastThresholdPercent: 100,
    notificationEmails: [],
  },
});

/** staging in the default region (`stagingConfig(region)` builds it for another one). */
export const staging: EnvironmentConfigInput = stagingConfig();
