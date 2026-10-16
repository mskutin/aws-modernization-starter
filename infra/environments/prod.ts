import { DEFAULT_AWS_REGION } from '../lib/region.js';
import { placeholderAuth, placeholderImportedFoundation } from './placeholders.js';
import { PLACEHOLDER_ACCOUNT_ID, type EnvironmentConfigInput } from './schema.js';

/** prod — Multi-AZ, deletion protection, RETAIN, long log retention. */
export const prodConfig = (region: string = DEFAULT_AWS_REGION): EnvironmentConfigInput => ({
  name: 'prod',
  account: PLACEHOLDER_ACCOUNT_ID, // PLACEHOLDER — override with -c account.prod=<id> or STARTER_ACCOUNT_ID_PROD
  region,
  resourcePrefix: 'starter-prd',
  cdkBootstrapQualifier: 'starter',
  tags: {
    Project: 'aws-modernization-starter',
    Environment: 'prod',
    Owner: 'platform-team',
    CostCentre: 'CC-PLACEHOLDER',
    DataClassification: 'Internal',
    ManagedBy: 'aws-cdk',
  },
  foundation: placeholderImportedFoundation('f0', 'prod', region),
  api: {
    ecr: { mode: 'create' },
    cpu: 1024,
    memoryMiB: 2048,
    desiredCount: 3,
    minCapacity: 3,
    maxCapacity: 9,
    cpuTargetUtilizationPercent: 60,
    logLevel: 'info',
    useFargateSpot: false,
    corsAllowedOrigins: [],
    albDeletionProtection: true,
  },
  workflow: {
    lambdaMemoryMiB: 1024,
    // 2 × 9 starter_processor connections ≤ database.connectionLimits.processor (20) − 2.
    reservedConcurrency: 9,
    logLevel: 'info',
    placeInVpc: true,
    logExecutionData: false,
    reconciler: { scheduleMinutes: 5, staleAfterSeconds: 900, batchSize: 25, dryRun: false },
  },
  database: {
    engineVersion: '17.9',
    instanceType: 'm7g.large',
    multiAz: true,
    allocatedStorageGiB: 100,
    maxAllocatedStorageGiB: 500,
    backupRetentionDays: 35,
    deletionProtection: true,
    removalPolicy: 'retain',
    performanceInsights: true,
    monitoringIntervalSeconds: 15,
    databaseName: 'starterapp',
    masterUsername: 'starteradmin',
    // Master secret: bootstrap task only, read at runtime, so rotation needs no task restart.
    rotation: { enabled: true, intervalDays: 30 },
  },
  jobTable: { deletionProtection: true, removalPolicy: 'retain', pitrRecoveryPeriodDays: 35 },
  // PLACEHOLDER — the organization IdP registration (identity); https only.
  auth: placeholderAuth('prod'),
  frontend: { priceClass: 'PriceClass_200', geoAllowlist: [] },
  observability: {
    logRetentionDays: 365,
    alarmEmails: [],
    thresholds: {
      alb5xxPerMinute: 5,
      ecsCpuPercent: 80,
      ecsMemoryPercent: 80,
      lambdaErrorsPer5Min: 1,
      rdsCpuPercent: 80,
      rdsFreeStorageGiB: 20,
    },
  },
  budget: {
    monthlyLimitUsd: 1500,
    actualThresholdsPercent: [50, 80, 100],
    forecastThresholdPercent: 100,
    notificationEmails: [],
  },
});

/** prod in the default region (`prodConfig(region)` builds it for another one). */
export const prod: EnvironmentConfigInput = prodConfig();
