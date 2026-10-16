import { DEFAULT_AWS_REGION, defaultAvailabilityZones } from '../lib/region.js';
import { placeholderOriginFacingPrefixListId } from './placeholders.js';
import {
  PLACEHOLDER_ACCOUNT_ID,
  PLACEHOLDER_OPERATOR_PRINCIPAL_ARN,
  type EnvironmentConfigInput,
} from './schema.js';

/**
 * PLACEHOLDER run identity for offline synth and tests. A deploy passes the real one
 * (`-c runId=sbx-<6 hex> -c expiresAt=<ISO>`) and `-c requireDeployInputs=true` refuses these
 * values. The expiry is deliberately in the past: anything ever deployed with it is "expired" to
 * the sweeper.
 */
export const PLACEHOLDER_SANDBOX_RUN = {
  runId: 'sbx-000000',
  expiresAt: '2000-01-01T00:00:00.000Z',
} as const;

/**
 * sandbox — LIVE VALIDATION of the reference app in an ordinary, dedicated AWS sandbox
 * account (default region ap-southeast-1; `-c region` / `-c region.sandbox`), torn down
 * afterwards. NOT a governed environment: it does not demonstrate landing-zone compliance and
 * must never be used as a governed profile.
 *
 * Opt-in only: synthesized with `-c envs=sandbox`; the default synth stays dev, staging, prod.
 * Every relaxation below is a sandbox-only schema option (rejected for dev/staging/prod) and a
 * recorded deviation:
 *  - own minimal foundation (VPC 2 AZs, 1 NAT, S3 + DynamoDB gateway endpoints, REJECT-only flow
 *    logs, two CMKs), no access-log bucket and no access logging;
 *  - internet-facing HTTP:80 ALB (CloudFront origin-facing prefix list + X-Origin-Verify header)
 *    instead of the internal HTTPS ALB behind a CloudFront VPC origin; no WAF, no custom domain,
 *    no ACM certificate (CloudFront default certificate);
 *  - a stage-hosted test issuer (S3 + CloudFront) instead of an organization IdP;
 *  - everything is deleted with the stacks (RDS without final snapshot and automated backups,
 *    DynamoDB, buckets and ECR emptied, KMS keys scheduled for deletion after 7 days); 1-day logs;
 *  - the operator's role is named in the key policies of the data CMK (via DynamoDB and Step
 *    Functions only) and the logs CMK (decrypt via CloudWatch Logs only) so the live checks can
 *    read the encrypted job table, execution history and log groups;
 *  - the data CMK lets CloudWatch log delivery decrypt Step Functions log data keys;
 *  - a higher unauthenticated rate limit for the security suite's negative-auth matrix.
 */
export const sandboxConfig = (region: string = DEFAULT_AWS_REGION): EnvironmentConfigInput => ({
  name: 'sandbox',
  account: PLACEHOLDER_ACCOUNT_ID, // PLACEHOLDER — the sandbox account: -c account.sandbox=<id>
  region,
  resourcePrefix: 'starter-sbx',
  cdkBootstrapQualifier: 'starter', // toolkit stack starter-cdk-toolkit
  tags: {
    Project: 'aws-modernization-starter',
    Environment: 'sandbox',
    Owner: 'sandbox-operator',
    CostCentre: 'sandbox',
    DataClassification: 'Synthetic',
    ManagedBy: 'aws-cdk',
  },
  foundation: {
    mode: 'sandbox',
    vpcCidr: '10.42.0.0/16',
    availabilityZones: defaultAvailabilityZones(region),
    natGateways: 1,
    edge: {
      // com.amazonaws.global.cloudfront.origin-facing in the region: the id confirmed by the
      // read-only discovery of a sandbox account (ap-southeast-1, lib/region.ts), otherwise a
      // PLACEHOLDER the deploy guard refuses (-c sandbox.originPrefixListId=pl-… from discovery).
      cloudFrontOriginFacingPrefixListId: placeholderOriginFacingPrefixListId(region),
    },
    accessLogs: false,
    flowLogs: 'reject',
    mandatoryTags: {},
  },
  teardown: 'destroy',
  run: { ...PLACEHOLDER_SANDBOX_RUN },
  // PLACEHOLDER — the operator's permission-set role: -c operatorPrincipalArn=<role ARN with path>
  operatorPrincipalArn: PLACEHOLDER_OPERATOR_PRINCIPAL_ARN,
  api: {
    ecr: { mode: 'create' },
    cpu: 256,
    memoryMiB: 512,
    desiredCount: 1,
    minCapacity: 1,
    // 2 lets a rolling deployment (minHealthy 100 %, maxHealthy 200 %) start the new task first.
    maxCapacity: 2,
    cpuTargetUtilizationPercent: 70,
    logLevel: 'info',
    // On-demand Fargate (arm64), as the contract fixes: no Spot interruptions during the run.
    useFargateSpot: false,
    corsAllowedOrigins: [],
    albDeletionProtection: false,
    originMode: 'public-alb-http',
  },
  workflow: {
    lambdaMemoryMiB: 512,
    // 2 + 2 + reconciler 1 = 5 reserved: needs an account concurrency quota >= 105 (100 must stay
    // unreserved). For a smaller quota synth with -c sandbox.reservedConcurrency=none (unreserved).
    // 2 × 2 starter_processor connections <= database.connectionLimits.processor (20) − 2.
    reservedConcurrency: 2,
    logLevel: 'info',
    placeInVpc: true,
    logExecutionData: false,
    reconciler: { scheduleMinutes: 5, staleAfterSeconds: 900, batchSize: 25, dryRun: false },
  },
  database: {
    engineVersion: '17.9',
    instanceType: 't4g.micro',
    multiAz: false,
    allocatedStorageGiB: 20,
    // RDS needs max >= 110 % of allocated when storage autoscaling is on; never reached here.
    maxAllocatedStorageGiB: 25,
    backupRetentionDays: 1,
    deletionProtection: false,
    removalPolicy: 'destroy',
    deleteAutomatedBackups: true,
    performanceInsights: false,
    monitoringIntervalSeconds: 0,
    databaseName: 'starterapp',
    masterUsername: 'starteradmin',
    // Kept on (validated end to end): the bootstrap task reads the master secret at connect time.
    // Fallback if the hosted-rotation transform cannot deploy: -c sandbox.masterSecretRotation=off
    rotation: { enabled: true, intervalDays: 30 },
  },
  jobTable: { deletionProtection: false, removalPolicy: 'destroy', pitrRecoveryPeriodDays: 1 },
  auth: {
    // Issuer and JWKS URL come from the Sandbox-TestIssuer stack (https://<issuer domain>).
    testIssuer: true,
    audience: 'starter-jobs-api-sandbox',
    spaClientId: 'starter-web-sandbox',
    algorithms: ['ES256'],
    // The security suite's negative-auth matrix sends ~50-60 failed authentications per minute
    // from one address; 250 (<= its 300-request exhaustion probe) keeps that test meaningful.
    rateLimit: { windowSeconds: 60, readMax: 120, writeMax: 20, unauthenticatedMax: 250 },
  },
  frontend: { priceClass: 'PriceClass_200', geoAllowlist: [] },
  observability: {
    logRetentionDays: 1,
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
    // Experiment budget USD 25; the stop line USD 13 is 52 %.
    monthlyLimitUsd: 25,
    actualThresholdsPercent: [40, 52, 100],
    forecastThresholdPercent: 100,
    notificationEmails: [],
  },
});

/** sandbox in the default region (`sandboxConfig(region)` builds it for another one). */
export const sandbox: EnvironmentConfigInput = sandboxConfig();
