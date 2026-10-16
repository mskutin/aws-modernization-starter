/**
 * Usage assumptions of the sandbox estimate — EXPLICIT GUESSES, NOT MEASUREMENTS. The profile is
 * "one complete test cycle per hour of lifetime" (conservative: an idle hour only incurs the
 * time-based lines). Replace them with measured values after a run (reconcile).
 */
import type { Phase } from './topology.js';

export interface Assumption {
  readonly id: string;
  readonly value: number;
  readonly unit: string;
  readonly basis: string;
}

export interface UsageProfile {
  readonly phase: Phase;
  /** Per hour of lifetime. */
  readonly perHour: {
    readonly cloudfrontRequests: Assumption;
    readonly cloudfrontFunctionRuns: Assumption;
    readonly cloudfrontDtoGb: Assumption;
    readonly cloudfrontToOriginGb: Assumption;
    readonly natGb: Assumption;
    readonly logIngestGb: Assumption;
    readonly sfnTransitions: Assumption;
    readonly lambdaInvocations: Assumption;
    readonly lambdaGbSeconds: Assumption;
    readonly ddbWru: Assumption;
    readonly ddbRru: Assumption;
    readonly xrayTraces: Assumption;
    readonly kmsRequests: Assumption;
    readonly s3Put: Assumption;
    readonly s3Get: Assumption;
    readonly dtoInternetGb: Assumption;
    readonly interAzGb: Assumption;
    readonly secretsApi: Assumption;
    readonly scheduledInvocations: Assumption;
  };
  /** Time-based quantities that are not resources. */
  readonly level: {
    readonly albLcu: Assumption;
    readonly customMetrics: Assumption;
    readonly containerInsightsMetrics: Assumption;
    readonly ecrGb: Assumption;
    readonly s3StorageGb: Assumption;
    readonly ddbStorageGb: Assumption;
    readonly logStoredGb: Assumption;
  };
  /** One-time per deploy/test/destroy cycle. */
  readonly oneTime: {
    readonly oneOffTaskRuns: Assumption;
    readonly oneOffTaskMinutes: Assumption;
    readonly extraDeploymentTaskHours: Assumption;
    readonly containerInsightsMetricHours: Assumption;
    readonly invalidationPaths: Assumption;
    readonly natGb: Assumption;
    readonly s3Put: Assumption;
    readonly assetsGb: Assumption;
  };
  /**
   * Account-level services the experiment can make bill this account (AWS Config items, Security
   * Hub, GuardDuty, Inspector, CloudTrail, Macie, Detective). UNKNOWN for this account.
   */
  readonly accountLevel: {
    readonly lowUsd: number;
    readonly highUsd: number;
    readonly basis: string;
  };
  /** Runtime limit carried over from the planning estimate. */
  readonly timeBoxHours: Assumption;
  /** Time a teardown takes, for the "start teardown by" deadline. */
  readonly teardownHours: Assumption;
}

const a = (id: string, value: number, unit: string, basis: string): Assumption => ({
  id,
  value,
  unit,
  basis,
});

const PREFLIGHT = 'planning estimate';

export const PHASE2_USAGE: UsageProfile = {
  phase: 2,
  perHour: {
    cloudfrontRequests: a(
      'L2-U01',
      5200,
      'HTTPS requests/h',
      `5,000 SPA + API (smoke, security suite, Playwright; ${PREFLIGHT}) + 200 test-issuer discovery/JWKS [ASSUMPTION]`,
    ),
    cloudfrontFunctionRuns: a('L2-U02', 2500, 'function runs/h', `${PREFLIGHT}`),
    cloudfrontDtoGb: a('L2-U03', 0.1, 'GB/h', `${PREFLIGHT} (SPA bundle 104 KB gzip)`),
    cloudfrontToOriginGb: a('L2-U04', 0.005, 'GB/h', `${PREFLIGHT}`),
    natGb: a(
      'L2-U05',
      0.02,
      'GB/h',
      `${PREFLIGHT} (no interface endpoints; logs, KMS, Secrets Manager, Step Functions, JWKS via NAT)`,
    ),
    logIngestGb: a(
      'L2-U06',
      0.02,
      'GB/h',
      `2 x ${PREFLIGHT}: live security suite, rate-limit test and log-leak scans; VPC flow logs [ASSUMPTION]`,
    ),
    sfnTransitions: a('L2-U07', 400, 'transitions/h', `${PREFLIGHT} (20 executions x 20)`),
    lambdaInvocations: a('L2-U08', 62, 'invocations/h', `${PREFLIGHT} (50 + 12 reconciler)`),
    lambdaGbSeconds: a('L2-U09', 43.5, 'GB-s/h', `${PREFLIGHT}`),
    ddbWru: a('L2-U10', 1000, 'WRU/h', `${PREFLIGHT}`),
    ddbRru: a('L2-U11', 2000, 'RRU/h', `${PREFLIGHT}`),
    xrayTraces: a('L2-U12', 200, 'traces/h', `${PREFLIGHT}`),
    kmsRequests: a('L2-U13', 2000, 'requests/h', `${PREFLIGHT}`),
    s3Put: a('L2-U14', 60, 'PUT/h', `${PREFLIGHT} (access logs)`),
    s3Get: a('L2-U15', 100, 'GET/h', `${PREFLIGHT}`),
    dtoInternetGb: a('L2-U16', 0.02, 'GB/h', `${PREFLIGHT}`),
    interAzGb: a('L2-U17', 0.02, 'GB/h each direction', `${PREFLIGHT}`),
    secretsApi: a('L2-U18', 2, 'requests/h', `${PREFLIGHT}`),
    scheduledInvocations: a(
      'L2-U19',
      12,
      'invocations/h',
      'reconciler rate(5 minutes) [TEMPLATE dev]',
    ),
  },
  level: {
    albLcu: a('L2-L01', 1, 'LCU (average)', `${PREFLIGHT}`),
    customMetrics: a('L2-L02', 10, 'metrics', `reconciler EMF metrics (${PREFLIGHT})`),
    containerInsightsMetrics: a(
      'L2-L03',
      137,
      'metrics',
      `Container Insights enhanced: cluster 29 + service 30 + task definition, task, container 26 each (${PREFLIGHT}); also used as the upper bound for "enabled"`,
    ),
    ecrGb: a('L2-L04', 0.6, 'GB', `${PREFLIGHT} (3 pushes x <= 0.2 GB)`),
    s3StorageGb: a('L2-L05', 0.05, 'GB', `${PREFLIGHT}`),
    ddbStorageGb: a('L2-L06', 0.002, 'GB', `${PREFLIGHT}`),
    logStoredGb: a(
      'L2-L07',
      0.5,
      'GB',
      '1-day retention keeps at most one day of ingestion [CONTRACT §4] [ASSUMPTION]',
    ),
  },
  oneTime: {
    oneOffTaskRuns: a(
      'L2-O01',
      6,
      'task runs',
      'DB bootstrap, migration, DB TLS probe, least-privilege probe, retention dry-run, 1 rerun [ASSUMPTION]',
    ),
    oneOffTaskMinutes: a('L2-O02', 10, 'minutes per task run', `${PREFLIGHT}`),
    extraDeploymentTaskHours: a(
      'L2-O03',
      1,
      'task-hours',
      '4 deployments (baseline, unhealthy revision, circuit-breaker rollback, redeploy) x 15 min with a second task [ASSUMPTION]',
    ),
    containerInsightsMetricHours: a(
      'L2-O04',
      780,
      'metric-hours',
      `10 extra tasks x 78 task-level metrics for >= 1 h each (${PREFLIGHT})`,
    ),
    invalidationPaths: a('L2-O05', 10, 'paths', `${PREFLIGHT} (no free tier applied)`),
    natGb: a(
      'L2-O06',
      0.5,
      'GB',
      'API image layer pulls in case they do not use the S3 gateway endpoint [ASSUMPTION]',
    ),
    s3Put: a('L2-O07', 200, 'PUT', 'SPA upload + issuer documents + CDK file assets [ASSUMPTION]'),
    assetsGb: a('L2-O08', 0.05, 'GB-month', 'CDK file assets in the staging bucket [ASSUMPTION]'),
  },
  accountLevel: {
    lowUsd: 1.73,
    highUsd: 6.27,
    basis:
      'Account-level security and audit services per deploy/destroy cycle, full stack (AWS Config, Security Hub, GuardDuty, Inspector, CloudTrail, Macie, Detective): UNKNOWN for this account; pass --account-level-usd 0 only if the account owner confirms none of them bills here',
  },
  timeBoxHours: a(
    'L2-T01',
    8,
    'hours of resource lifetime',
    'planning time box for the full stack (teardown start <= T0 + 6 h, all deleted <= T0 + 8 h)',
  ),
  teardownHours: a('L2-T02', 2, 'hours', 'planning time box (T0 + 6 h start, T0 + 8 h done)'),
};

export const PHASE1_USAGE: UsageProfile = {
  phase: 1,
  perHour: {
    cloudfrontRequests: a('L1-U01', 0, 'requests/h', 'no CloudFront in the mini-stack'),
    cloudfrontFunctionRuns: a('L1-U02', 0, 'runs/h', 'no CloudFront in the mini-stack'),
    cloudfrontDtoGb: a('L1-U03', 0, 'GB/h', 'no CloudFront in the mini-stack'),
    cloudfrontToOriginGb: a('L1-U04', 0, 'GB/h', 'no CloudFront in the mini-stack'),
    natGb: a('L1-U05', 0, 'GB/h', 'no VPC in the mini-stack'),
    logIngestGb: a('L1-U06', 0.005, 'GB/h', `${PREFLIGHT}`),
    sfnTransitions: a('L1-U07', 250, 'transitions/h', `${PREFLIGHT} (10 executions x 25)`),
    lambdaInvocations: a('L1-U08', 60, 'invocations/h', `${PREFLIGHT}`),
    lambdaGbSeconds: a('L1-U09', 33.75, 'GB-s/h', `${PREFLIGHT}`),
    ddbWru: a('L1-U10', 200, 'WRU/h', `${PREFLIGHT}`),
    ddbRru: a('L1-U11', 500, 'RRU/h', `${PREFLIGHT}`),
    xrayTraces: a('L1-U12', 100, 'traces/h', `${PREFLIGHT}`),
    kmsRequests: a('L1-U13', 500, 'requests/h', `${PREFLIGHT}`),
    s3Put: a('L1-U14', 0, 'PUT/h', 'no bucket in the mini-stack'),
    s3Get: a('L1-U15', 0, 'GET/h', 'no bucket in the mini-stack'),
    dtoInternetGb: a('L1-U16', 0.02, 'GB/h', `${PREFLIGHT}`),
    interAzGb: a('L1-U17', 0, 'GB/h', 'no VPC in the mini-stack'),
    secretsApi: a('L1-U18', 0, 'requests/h', 'no secret in the mini-stack'),
    scheduledInvocations: a('L1-U19', 0, 'invocations/h', 'no schedule in the mini-stack'),
  },
  level: {
    albLcu: a('L1-L01', 0, 'LCU', 'no ALB'),
    customMetrics: a('L1-L02', 10, 'metrics', `reconciler EMF metrics (${PREFLIGHT})`),
    containerInsightsMetrics: a('L1-L03', 0, 'metrics', 'no ECS'),
    ecrGb: a('L1-L04', 0, 'GB', 'no ECR'),
    s3StorageGb: a('L1-L05', 0, 'GB', 'no bucket'),
    ddbStorageGb: a('L1-L06', 0.002, 'GB', `${PREFLIGHT}`),
    logStoredGb: a('L1-L07', 0.01, 'GB', `${PREFLIGHT}`),
  },
  oneTime: {
    oneOffTaskRuns: a('L1-O01', 0, 'task runs', 'no ECS'),
    oneOffTaskMinutes: a('L1-O02', 0, 'minutes', 'no ECS'),
    extraDeploymentTaskHours: a('L1-O03', 0, 'task-hours', 'no ECS'),
    containerInsightsMetricHours: a('L1-O04', 0, 'metric-hours', 'no ECS'),
    invalidationPaths: a('L1-O05', 0, 'paths', 'no CloudFront'),
    natGb: a('L1-O06', 0, 'GB', 'no NAT'),
    s3Put: a('L1-O07', 10, 'PUT', `CDK file assets (${PREFLIGHT})`),
    assetsGb: a('L1-O08', 0.01, 'GB-month', `CDK file assets (${PREFLIGHT})`),
  },
  accountLevel: {
    lowUsd: 0.21,
    highUsd: 0.92,
    basis:
      'Account-level security and audit services per deploy/destroy cycle, mini-stack: UNKNOWN for this account; pass --account-level-usd 0 only if the account owner confirms none of them bills here',
  },
  timeBoxHours: a(
    'L1-T01',
    4,
    'hours of resource lifetime per cycle',
    'planning time box (planned 2 h, hard limit 4 h per cycle)',
  ),
  teardownHours: a('L1-T02', 0.5, 'hours', 'cdk destroy of the mini-stack [ASSUMPTION]'),
};

export const usageFor = (phase: Phase): UsageProfile => (phase === 1 ? PHASE1_USAGE : PHASE2_USAGE);
