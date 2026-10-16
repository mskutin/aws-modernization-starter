/**
 * Environment configuration schema. Every environment (dev, staging, prod) is
 * described by the same shape and validated here before any construct is
 * created, so the same constructs run everywhere and only data differs.
 *
 * The opt-in `sandbox` environment (live validation) uses the same schema. It deploys the
 * reference app to an ordinary, dedicated AWS account and is NOT a governed environment: every relaxation it needs is
 * a field below that is rejected for dev/staging/prod (`sandboxOnly` in the refinement).
 *
 * Invalid configuration fails synth with a message that names the offending
 * path (see `formatConfigError`).
 */
import { z } from 'zod';
import { DEFAULT_AWS_REGION, isAwsRegionSyntax, validateAwsRegion } from '../lib/region.js';

/** The governed environments: synthesized by default (no `-c envs`). */
export const ENVIRONMENT_NAMES = ['dev', 'staging', 'prod'] as const;
export type GovernedEnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

/**
 * The live-validation environment: an ordinary AWS sandbox account, NOT a governed environment.
 * Opt-in only:
 * synthesized when named in `-c envs` (e.g. `-c envs=sandbox`), never by default.
 */
export const SANDBOX_ENVIRONMENT_NAME = 'sandbox' as const;
export const OPT_IN_ENVIRONMENT_NAMES = [SANDBOX_ENVIRONMENT_NAME] as const;
/** Every environment the app can synthesize (governed environments first). */
export const ALL_ENVIRONMENT_NAMES = [...ENVIRONMENT_NAMES, ...OPT_IN_ENVIRONMENT_NAMES] as const;
export type EnvironmentName = (typeof ALL_ENVIRONMENT_NAMES)[number];

/** Stage construct ids; deploy one environment with e.g. `cdk deploy 'Prod/*'`. */
export const STAGE_IDS: Readonly<Record<EnvironmentName, string>> = {
  dev: 'Dev',
  staging: 'Staging',
  prod: 'Prod',
  sandbox: 'Sandbox',
};

/** Experiment tag value of the live validation (`starter:experiment`). */
export const SANDBOX_EXPERIMENT = 'live-validation' as const;
/** Sandbox run id: `sbx-<6 hex>`. */
export const SANDBOX_RUN_ID_PATTERN = /^sbx-[0-9a-f]{6}$/;

/**
 * Deployment region: `region` in each environment config, default DEFAULT_AWS_REGION
 * (`ap-southeast-1`, defined once in `@starter/config/region`). Any region of the `aws`
 * partition is accepted; region-specific values (subnets/AZs, KMS keys, ACM certificate,
 * origin-facing prefix list) must belong to it. See lib/region.ts for the CDK context.
 */
export { DEFAULT_AWS_REGION } from '../lib/region.js';

/** Tag keys every resource must carry (enforced by `@starter/policies`). */
export const REQUIRED_TAG_KEYS = [
  'Project',
  'Environment',
  'Owner',
  'CostCentre',
  'DataClassification',
  'ManagedBy',
] as const;
export type RequiredTagKey = (typeof REQUIRED_TAG_KEYS)[number];

/**
 * Connections of the `starter_processor` CONNECTION LIMIT (`database.connectionLimits.processor`)
 * kept free of the validator + processor reserved concurrency (connection recycling overlaps).
 */
export const STARTER_PROCESSOR_CONNECTION_HEADROOM = 2;
/** Workflow execution timeout (600 s) + 60 s grace = `RECONCILIATION.minimumStaleAfterSeconds`. */
export const STARTER_RECONCILER_MIN_STALE_AFTER_SECONDS = 660;

/** Placeholder account ID used in committed configs. Never deployable. */
export const PLACEHOLDER_ACCOUNT_ID = '000000000000';

/** Valid CloudWatch Logs retention periods (days). */
export const LOG_RETENTION_DAYS = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288,
  3653,
] as const;

const hex = (prefix: string) =>
  z
    .string()
    .regex(
      new RegExp(`^${prefix}-[0-9a-f]{8,17}$`),
      `must look like ${prefix}-xxxxxxxx (8-17 hex chars)`,
    );

const accountId = z.string().regex(/^\d{12}$/, 'must be a 12-digit AWS account ID');
const availabilityZone = z
  .string()
  .regex(
    /^[a-z]{2}-[a-z]+-\d{1,2}[a-z]$/,
    'must be an availability zone name such as ap-southeast-1a',
  );
const cidr = z
  .string()
  .regex(/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/, 'must be an IPv4 CIDR block such as 10.0.0.0/16');
const domainName = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'must be a DNS name');
const email = z.email();

const kmsKeyArn = z
  .string()
  .regex(
    /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/(mrk-[0-9a-f]{32}|[0-9a-f-]{36})$/,
    'must be a KMS key ARN (arn:aws:kms:<region>:<account>:key/<id>)',
  );
const acmCertificateArn = z
  .string()
  .regex(
    /^arn:aws[a-z-]*:acm:[a-z0-9-]+:\d{12}:certificate\/[0-9a-f-]{36}$/,
    'must be an ACM certificate ARN',
  );
const iamPolicyArn = z
  .string()
  .regex(/^arn:aws[a-z-]*:iam::\d{12}:policy\/[\w+=,.@/-]+$/, 'must be an IAM managed policy ARN');
/** IAM role ARN including its path (IAM Identity Center roles live under /aws-reserved/...). */
const iamRoleArn = z
  .string()
  .regex(
    /^arn:aws[a-z-]*:iam::\d{12}:role\/([\w+=,.@-]+\/)*[\w+=,.@-]{1,64}$/,
    'must be an IAM role ARN with its path (arn:aws:iam::<account>:role/<path/>name), not an STS assumed-role ARN',
  );

/** Placeholder operator role for offline synth. Never deployable (`requireDeployInputs`). */
export const PLACEHOLDER_OPERATOR_PRINCIPAL_ARN =
  `arn:aws:iam::${'0'.repeat(12)}:role/PLACEHOLDER-sandbox-operator` as const;
const wafWebAclArn = z
  .string()
  .regex(
    /^arn:aws[a-z-]*:wafv2:us-east-1:\d{12}:global\/webacl\/[\w-]+\/[0-9a-f-]{36}$/,
    'must be a CLOUDFRONT-scope WAFv2 web ACL ARN (region us-east-1, global/webacl/...)',
  );
const ecrRepositoryArn = z
  .string()
  .regex(
    /^arn:aws[a-z-]*:ecr:[a-z0-9-]+:\d{12}:repository\/[a-z0-9._/-]+$/,
    'must be an ECR repository ARN',
  );
const bucketName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be an S3 bucket name');
const tagValue = z
  .string()
  .min(1, 'must not be empty')
  .max(256)
  .regex(/^[\p{L}\p{Z}\p{N}_.:/=+\-@]*$/u, 'contains characters not allowed in AWS tag values');

const regionOfArn = (arn: string): string | undefined => arn.split(':')[3];

// --- Identity ---------------------------------------------------------------------------------------------
/** Asymmetric JWS algorithms the API accepts (mirrors @starter/config; a test cross-checks). */
export const AUTH_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;
/** https URL without credentials, query or fragment. CDK never deploys an http issuer. */
const httpsIdentityUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}, 'must be an https URL without credentials, query or fragment');
const oauthToken = z
  .string()
  .regex(/^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/, 'must be one OAuth scope token');
const clientId = z
  .string()
  .regex(/^[\x21-\x7e]{1,256}$/, 'must be a client id (printable, no spaces)');

/**
 * End-user authentication of the API and sign-in of the SPA. Values come from the organization's IdP
 * registration (docs/landing-zone-adaptation.md). https in EVERY stage (dev included): the local
 * AUTH_ALLOW_INSECURE_ISSUER switch and APP_RUNTIME never reach a task definition.
 */
export const AuthSchema = z.object({
  /**
   * OIDC issuer identifier (exact `iss`); discovery at `${issuer}/.well-known/openid-configuration`.
   * Required unless `testIssuer` is set.
   */
  issuer: httpsIdentityUrl.optional(),
  /**
   * SANDBOX ONLY (live validation, not a governed environment): the stage hosts its own test issuer (stack
   * `TestIssuer`: private S3 + CloudFront serving `/.well-known/openid-configuration` and
   * `/jwks.json`, uploaded by the lifecycle script). The API and the SPA take `issuer`
   * (`https://<issuer domain>`) and `jwksUri` from that stack; omit both here.
   */
  testIssuer: z.boolean().default(false),
  /** `aud` of access tokens for this API. Must identify the API, never the SPA client. */
  audience: z.string().min(1).max(512),
  /** Public client id of the SPA (authorization code + PKCE). */
  spaClientId: clientId,
  /** Scopes the SPA requests (must include openid and both API scopes). */
  spaScope: z.string().default('openid jobs:read jobs:write'),
  /** Optional JWKS URL override (https); otherwise OIDC discovery. */
  jwksUri: httpsIdentityUrl.optional(),
  algorithms: z.array(z.enum(AUTH_ALGORITHMS)).min(1).default(['RS256', 'ES256']),
  /** Tokens are accepted until min(exp, iat + this); `iat` required. */
  maxTokenAgeSeconds: z.number().int().min(60).max(86_400).default(3_600),
  scopes: z
    .object({ read: oauthToken, write: oauthToken })
    .default({ read: 'jobs:read', write: 'jobs:write' }),
  /** azp/client_id allow-list; default: the SPA client only. */
  allowedClientIds: z.array(clientId).min(1).optional(),
  /** Per-task application limits (WAF rate-based rule = the edge control). */
  rateLimit: z
    .object({
      windowSeconds: z.number().int().min(1).max(3600).default(60),
      readMax: z.number().int().min(1).default(120),
      writeMax: z.number().int().min(1).default(20),
      unauthenticatedMax: z.number().int().min(1).default(30),
    })
    .default({ windowSeconds: 60, readMax: 120, writeMax: 20, unauthenticatedMax: 30 }),
});
export type AuthConfig = z.output<typeof AuthSchema>;

export const SubnetSchema = z.object({
  subnetId: hex('subnet'),
  availabilityZone,
  routeTableId: hex('rtb'),
});
export type SubnetConfig = z.infer<typeof SubnetSchema>;

/**
 * Edge/identity inputs that always come from outside this repo (landing-zone
 * foundation or, for sandboxes, bring-your-own): DNS, certificates, WAF,
 * CloudFront origin-facing prefix list.
 */
export const EdgeSchema = z.object({
  /** Name CloudFront uses to reach the internal ALB (must match the ALB certificate). */
  apiOriginDomainName: domainName,
  /** Regional ACM certificate (same region as the stack) for the internal ALB. */
  albCertificateArn: acmCertificateArn,
  /** Public name of the SPA (CloudFront alternate domain name). */
  webDomainName: domainName.optional(),
  /** ACM certificate in us-east-1 covering `webDomainName` (CloudFront requirement). */
  cloudFrontCertificateArn: acmCertificateArn.optional(),
  /** Public hosted zone for alias records; omit to manage DNS outside CDK. */
  hostedZone: z
    .object({ hostedZoneId: z.string().regex(/^Z[A-Z0-9]{8,32}$/), zoneName: domainName })
    .optional(),
  /** CLOUDFRONT-scope WAF web ACL managed by the landing-zone foundation / security team. */
  wafWebAclArn: wafWebAclArn.optional(),
  /**
   * Managed prefix list `com.amazonaws.global.cloudfront.origin-facing` in the
   * stack region. Used for the ALB security group ingress rule.
   */
  cloudFrontOriginFacingPrefixListId: hex('pl'),
});
export type EdgeConfig = z.infer<typeof EdgeSchema>;

/**
 * Edge inputs of the sandbox foundation: the ALB certificate and the origin name are needed only
 * for the HTTPS CloudFront VPC origin (`api.originMode: vpc-origin-https`, checked below).
 */
export const SandboxEdgeSchema = EdgeSchema.partial({
  apiOriginDomainName: true,
  albCertificateArn: true,
});
export type SandboxEdgeConfig = z.infer<typeof SandboxEdgeSchema>;

export const ImportedFoundationSchema = z.object({
  mode: z.literal('import'),
  vpc: z.object({
    vpcId: hex('vpc'),
    vpcCidrBlock: cidr,
    /** Private application tier (ECS tasks, Lambda ENIs, internal ALB). */
    appSubnets: z.array(SubnetSchema).min(2, 'need at least two app subnets (multi-AZ)'),
    /** Isolated data tier (RDS). */
    dataSubnets: z.array(SubnetSchema).min(2, 'need at least two data subnets (multi-AZ)'),
  }),
  kms: z.object({
    /** CMK for data at rest (RDS, DynamoDB, Secrets Manager, ECR). */
    dataKeyArn: kmsKeyArn,
    /** CMK for CloudWatch Logs; key policy must allow logs.<region>.amazonaws.com. */
    logsKeyArn: kmsKeyArn,
  }),
  /** Mandatory permissions boundary attached to every IAM role this app creates. */
  permissionsBoundaryPolicyArn: iamPolicyArn,
  logging: z.object({
    /** Existing bucket for S3 server access, ALB and CloudFront standard logs. */
    accessLogsBucketName: bucketName,
  }),
  edge: EdgeSchema,
  /** Extra tags mandated by the landing zone (merged with the required tags). */
  mandatoryTags: z.record(z.string(), tagValue).default({}),
});
export type ImportedFoundationConfig = z.infer<typeof ImportedFoundationSchema>;

export const SandboxFoundationSchema = z.object({
  mode: z.literal('sandbox'),
  vpcCidr: cidr.default('10.42.0.0/16'),
  /** Explicit AZs (no `availability-zones` context lookup, so synth stays offline). */
  /** In the configured region (no default: AZ names are region-specific). */
  availabilityZones: z.array(availabilityZone).min(2).max(3),
  natGateways: z.number().int().min(1).max(3).default(1),
  permissionsBoundaryPolicyArn: iamPolicyArn.optional(),
  edge: SandboxEdgeSchema,
  /**
   * Access-log bucket for S3 server access, ALB and CloudFront standard logs. `false` is
   * SANDBOX-ONLY (live validation, not a governed environment): no log bucket and no access logging, so nothing
   * (late log deliveries included) survives `cdk destroy`.
   */
  accessLogs: z.boolean().default(true),
  /**
   * VPC flow logs to CloudWatch Logs: `all` traffic, or only `reject`ed flows (SANDBOX-ONLY: a few
   * records of the traffic the security groups drop, at negligible ingestion cost).
   */
  flowLogs: z.enum(['all', 'reject']).default('all'),
  mandatoryTags: z.record(z.string(), tagValue).default({}),
});
export type SandboxFoundationConfig = z.infer<typeof SandboxFoundationSchema>;

export const FoundationSchema = z.discriminatedUnion('mode', [
  ImportedFoundationSchema,
  SandboxFoundationSchema,
]);
export type FoundationConfig = z.infer<typeof FoundationSchema>;

const removalPolicy = z.enum(['retain', 'snapshot', 'destroy']);
export type RemovalPolicyName = z.infer<typeof removalPolicy>;
const logLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/** API origin behind CloudFront. */
export const API_ORIGIN_MODES = ['vpc-origin-https', 'public-alb-http'] as const;
export type ApiOriginMode = (typeof API_ORIGIN_MODES)[number];

/** ISO-8601 UTC timestamp, e.g. 2026-10-16T06:00:00.000Z (sweeper expiry tag). */
const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, 'must be an ISO-8601 UTC time')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'is not a valid time');

export const EnvironmentConfigSchema = z
  .object({
    name: z.enum(ALL_ENVIRONMENT_NAMES),
    account: accountId,
    /** Deployment region (aws partition); every region-specific value must belong to it. */
    region: z
      .string()
      .default(DEFAULT_AWS_REGION)
      .superRefine((value, ctx) => {
        if (!isAwsRegionSyntax(value)) {
          ctx.addIssue({
            code: 'custom',
            message: `must be an AWS region such as ${DEFAULT_AWS_REGION}`,
          });
          return;
        }
        try {
          validateAwsRegion(value);
        } catch (e) {
          ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : String(e) });
        }
      }),
    /** Prefix for physical names, e.g. `starter-dev`. */
    resourcePrefix: z.string().regex(/^[a-z][a-z0-9-]{2,20}$/, 'lowercase, 3-21 chars'),
    /** CDK bootstrap qualifier agreed with the platform team. */
    cdkBootstrapQualifier: z.string().regex(/^[a-z0-9]{1,10}$/, 'lowercase alphanumeric, max 10'),
    tags: z
      .object({
        Project: tagValue,
        Environment: tagValue,
        Owner: tagValue,
        CostCentre: tagValue,
        DataClassification: tagValue,
        ManagedBy: tagValue,
      })
      .strict(),
    foundation: FoundationSchema,
    /**
     * What stack deletion does to stateful resources. `retain` (governed environments): buckets, the ECR repository,
     * the alarm-topic key and (outside dev) log groups survive `cdk destroy`. `destroy` is
     * SANDBOX-ONLY (live validation, not a governed environment): everything is deleted with its stack — buckets
     * and the ECR repository emptied first, KMS keys scheduled for deletion (7 days), Lambda
     * versions and log groups removed. RDS and DynamoDB follow their own `removalPolicy`.
     */
    teardown: z.enum(['retain', 'destroy']).default('retain'),
    /**
     * SANDBOX-ONLY ephemeral run identity (`starter:ephemeral`, `starter:run-id`, `starter:expires-at`,
     * `starter:experiment` tags on every resource). Injected from CDK context (`runId`, `expiresAt`).
     */
    run: z
      .object({
        runId: z.string().regex(SANDBOX_RUN_ID_PATTERN, 'must look like sbx-<6 hex>'),
        expiresAt: isoTimestamp,
        experiment: z.literal(SANDBOX_EXPERIMENT).default(SANDBOX_EXPERIMENT),
      })
      .strict()
      .optional(),
    /**
     * SANDBOX-ONLY: the IAM role of the human operator who runs the live checks (CDK context
     * `operatorPrincipalArn`, the permission-set role ARN with its path). The sandbox data CMK
     * names it in its key policy, for use through DynamoDB and Step Functions only, and the logs
     * CMK for decryption through CloudWatch Logs only, so the operator can read the encrypted job
     * table, execution history and log groups (the operator's own IAM policies carry no KMS
     * actions). Governed-environment keys never name a human principal.
     */
    operatorPrincipalArn: iamRoleArn.optional(),
    api: z.object({
      ecr: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('create') }),
        z.object({ mode: z.literal('import'), repositoryArn: ecrRepositoryArn }),
      ]),
      cpu: z.union([
        z.literal(256),
        z.literal(512),
        z.literal(1024),
        z.literal(2048),
        z.literal(4096),
      ]),
      memoryMiB: z.number().int().min(512).max(30720),
      desiredCount: z.number().int().min(1),
      minCapacity: z.number().int().min(1),
      maxCapacity: z.number().int().min(1),
      cpuTargetUtilizationPercent: z.number().int().min(10).max(90),
      logLevel,
      useFargateSpot: z.boolean(),
      corsAllowedOrigins: z.array(z.url()).default([]),
      albDeletionProtection: z.boolean(),
      /**
       * How CloudFront reaches the API. `vpc-origin-https` (governed environments): internal HTTPS ALB in the
       * app subnets behind a CloudFront VPC origin. `public-alb-http` is SANDBOX-ONLY (live
       * validation; no certificate or domain needed): internet-facing HTTP:80 ALB in the
       * public subnets whose security group admits only the CloudFront origin-facing prefix list
       * and whose listener answers 403 unless the `X-Origin-Verify` header carries the per-run
       * secret (CDK context `originVerifySecret`).
       */
      originMode: z.enum(API_ORIGIN_MODES).default('vpc-origin-https'),
    }),
    workflow: z.object({
      lambdaMemoryMiB: z.number().int().min(128).max(10240),
      /**
       * Reserved concurrency per workflow function (validator, processor) — required in every
       * environment: each warm execution environment holds one PostgreSQL
       * connection as starter_processor, so 2 × this value must stay within that role's CONNECTION
       * LIMIT (`database.connectionLimits.processor`, checked below). It also caps the blast radius
       * of a retry storm. Reserving needs the account's unreserved concurrency to stay at or above
       * 100; RDS Proxy is the alternative for higher
       * fan-out.
       *
       * `null` is SANDBOX-ONLY (live validation, not a governed environment), for an account whose concurrency
       * quota cannot cover any reservation: the functions (and the reconciler) run unreserved, and
       * the connection bound is the database side alone — the `starter_processor` CONNECTION LIMIT
       * (`database.connectionLimits.processor`) refuses connections beyond it, and the state
       * machine retries the failed step. The single-reconciler guarantee then rests on its
       * 5-minute schedule and idempotent conditional writes only.
       */
      reservedConcurrency: z.number().int().min(1).max(1000).nullable(),
      logLevel,
      /** Place Lambda ENIs in the app subnets (egress through landing-zone controls). */
      placeInVpc: z.boolean(),
      /**
       * Log execution input/output. Since spec 2.0.0 they carry a job reference only, but error
       * causes reach the log; staging/prod keep it off.
       */
      logExecutionData: z.boolean(),
      /** The ONE scheduled stale-job reconciler (ADR 0231; reserved concurrency 1). */
      reconciler: z
        .object({
          /** Minutes between runs (EventBridge rate). */
          scheduleMinutes: z.number().int().min(1).max(60).default(5),
          /** A non-terminal job is stale after this long (≥ execution timeout + grace). */
          staleAfterSeconds: z
            .number()
            .int()
            .min(STARTER_RECONCILER_MIN_STALE_AFTER_SECONDS)
            .max(7 * 86_400)
            .default(900),
          batchSize: z.number().int().min(1).max(100).default(25),
          /** Explicit per environment: decide and report only, write nothing. */
          dryRun: z.boolean(),
          maxRuntimeSeconds: z.number().int().min(5).max(840).default(45),
        })
        .strict(),
    }),
    database: z.object({
      /** Full PostgreSQL engine version, major 17. */
      engineVersion: z.string().regex(/^17\.\d+$/, 'must be a PostgreSQL 17 minor, e.g. 17.9'),
      instanceType: z.string().regex(/^[a-z0-9]+\.[a-z0-9]+$/, 'e.g. t4g.micro'),
      multiAz: z.boolean(),
      allocatedStorageGiB: z.number().int().min(20),
      maxAllocatedStorageGiB: z.number().int().min(20),
      backupRetentionDays: z.number().int().min(1).max(35),
      deletionProtection: z.boolean(),
      removalPolicy,
      /**
       * Delete the automated backups together with the instance. SANDBOX-ONLY (live
       * validation): governed environments keep them for their retention period.
       */
      deleteAutomatedBackups: z.boolean().default(false),
      performanceInsights: z.boolean(),
      /** Enhanced monitoring interval; 0 disables. */
      monitoringIntervalSeconds: z.union([
        z.literal(0),
        z.literal(1),
        z.literal(5),
        z.literal(10),
        z.literal(15),
        z.literal(30),
        z.literal(60),
      ]),
      databaseName: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
      /** RDS master user: one-off bootstrap task only (ADR 0220); never a runtime identity. */
      masterUsername: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,15}$/)
        .refine(
          (name) => !name.startsWith('starter_'),
          'must not use the starter_ prefix of the managed roles',
        ),
      /**
       * Hosted rotation of the MASTER secret. Only the bootstrap task uses it, and it reads the
       * secret when it connects, so rotation never strands a running task (ADR 0221).
       */
      rotation: z.object({
        enabled: z.boolean(),
        intervalDays: z.number().int().min(1).max(365).default(30),
      }),
      /** DB_POOL_MAX per API task; the starter_app CONNECTION LIMIT is derived from it. */
      apiPoolMax: z.number().int().min(1).max(50).default(5),
      /**
       * CONNECTION LIMIT per login role, applied by the bootstrap task. starter_app is
       * derived: 2 x api.maxCapacity x apiPoolMax (rolling deployments run up to twice the tasks).
       */
      connectionLimits: z
        .object({
          migrator: z.number().int().min(1).max(100).default(3),
          /** Size for the reserved concurrency of the DB-connected Lambdas (pool max 1 each). */
          processor: z.number().int().min(1).max(1000).default(20),
          retention: z.number().int().min(1).max(100).default(2),
        })
        .default({ migrator: 3, processor: 20, retention: 2 }),
      /**
       * Content retention job (ADR 0223). `disabled` until the
       * organization approves a policy; `apply` requires that approval's reference.
       */
      retention: z
        .discriminatedUnion('mode', [
          z.object({ mode: z.literal('disabled') }),
          z.object({
            mode: z.enum(['dry-run', 'apply']),
            contentDays: z.number().int().min(1).max(3650),
            approvalRef: z.string().trim().min(3).max(200).optional(),
            batchSize: z.number().int().min(1).max(1000).default(100),
            maxBatches: z.number().int().min(1).max(1000).default(50),
          }),
        ])
        .default({ mode: 'disabled' }),
    }),
    jobTable: z.object({
      deletionProtection: z.boolean(),
      removalPolicy,
      pitrRecoveryPeriodDays: z.number().int().min(1).max(35),
      /**
       * Retention of STEP# audit items in days (`JOB_AUDIT_TTL_DAYS`, DynamoDB TTL). `null`
       * (default) = audit items never expire: enable only under an approved retention policy
       * (ADR 0233).
       */
      auditRetentionDays: z.number().int().min(1).max(3650).nullable().default(null),
    }),
    auth: AuthSchema,
    frontend: z.object({
      priceClass: z.enum(['PriceClass_100', 'PriceClass_200', 'PriceClass_All']),
      /** ISO 3166-1 alpha-2 allowlist; empty = no geo restriction. */
      geoAllowlist: z.array(z.string().regex(/^[A-Z]{2}$/)).default([]),
    }),
    observability: z.object({
      logRetentionDays: z
        .number()
        .refine((d) => (LOG_RETENTION_DAYS as readonly number[]).includes(d), {
          message: `must be one of ${LOG_RETENTION_DAYS.join(', ')}`,
        }),
      alarmEmails: z.array(email).default([]),
      thresholds: z.object({
        alb5xxPerMinute: z.number().int().min(1),
        ecsCpuPercent: z.number().min(1).max(100),
        ecsMemoryPercent: z.number().min(1).max(100),
        lambdaErrorsPer5Min: z.number().int().min(1),
        rdsCpuPercent: z.number().min(1).max(100),
        rdsFreeStorageGiB: z.number().min(1),
      }),
    }),
    budget: z.object({
      monthlyLimitUsd: z.number().positive(),
      /** ACTUAL-spend notification thresholds (percent of limit). */
      actualThresholdsPercent: z.array(z.number().positive().max(1000)).min(1),
      /** FORECASTED-spend notification threshold (percent of limit). */
      forecastThresholdPercent: z.number().positive().max(1000),
      notificationEmails: z.array(email).max(9).default([]),
    }),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const regulated = cfg.name === 'staging' || cfg.name === 'prod';
    /** An AZ name is its region plus one letter (`availabilityZone`). */
    const inRegion = (az: string) => az.slice(0, -1) === cfg.region;

    if (cfg.tags.Environment !== cfg.name) {
      issue(['tags', 'Environment'], `must equal the environment name "${cfg.name}"`);
    }

    // --- Sandbox (live validation, not governed): its relaxations never reach dev/staging/prod.
    const sandbox = cfg.name === SANDBOX_ENVIRONMENT_NAME;
    const sandboxOnly = (path: (string | number)[], used: boolean, what: string) => {
      if (used && !sandbox) {
        issue(
          path,
          `${what} is sandbox-only (live validation, not a governed environment); not allowed in ${cfg.name}`,
        );
      }
    };
    sandboxOnly(['teardown'], cfg.teardown === 'destroy', 'teardown "destroy"');
    sandboxOnly(['run'], cfg.run !== undefined, 'an ephemeral run identity');
    sandboxOnly(
      ['api', 'originMode'],
      cfg.api.originMode === 'public-alb-http',
      'originMode "public-alb-http"',
    );
    sandboxOnly(
      ['database', 'deleteAutomatedBackups'],
      cfg.database.deleteAutomatedBackups,
      'deleting automated backups',
    );
    sandboxOnly(
      ['workflow', 'reservedConcurrency'],
      cfg.workflow.reservedConcurrency === null,
      'unreserved workflow concurrency (null)',
    );
    sandboxOnly(
      ['observability', 'logRetentionDays'],
      cfg.observability.logRetentionDays < 7,
      'log retention below 7 days',
    );
    sandboxOnly(['auth', 'testIssuer'], cfg.auth.testIssuer, 'the stage-hosted test issuer');
    sandboxOnly(
      ['operatorPrincipalArn'],
      cfg.operatorPrincipalArn !== undefined,
      'an operator principal in a key policy',
    );
    if (cfg.foundation.mode === 'sandbox') {
      if (cfg.foundation.availabilityZones.some((az) => !inRegion(az))) {
        issue(['foundation', 'availabilityZones'], `must be availability zones of ${cfg.region}`);
      }
      sandboxOnly(
        ['foundation', 'accessLogs'],
        !cfg.foundation.accessLogs,
        'disabling access logs',
      );
      sandboxOnly(
        ['foundation', 'flowLogs'],
        cfg.foundation.flowLogs !== 'all',
        'reject-only flow logs',
      );
    }
    if (sandbox) {
      if (cfg.foundation.mode !== 'sandbox') {
        issue(
          ['foundation', 'mode'],
          'the sandbox creates its own foundation (mode "sandbox"); it never imports a landing zone',
        );
      }
      if (cfg.teardown !== 'destroy') {
        issue(['teardown'], 'the sandbox is ephemeral: teardown must be "destroy"');
      }
      if (!cfg.run) {
        issue(['run'], 'is required for the sandbox (starter:run-id and starter:expires-at tags)');
      }
      const operator = cfg.operatorPrincipalArn;
      if (!operator) {
        issue(['operatorPrincipalArn'], 'is required for the sandbox (operator key access)');
      } else if (
        operator !== PLACEHOLDER_OPERATOR_PRINCIPAL_ARN &&
        operator.split(':')[4] !== cfg.account
      ) {
        issue(['operatorPrincipalArn'], `must be a role in the sandbox account ${cfg.account}`);
      }
    }

    // --- Foundation: staging/prod must import the landing zone. -----------
    if (regulated && cfg.foundation.mode !== 'import') {
      issue(
        ['foundation', 'mode'],
        `${cfg.name} must import landing-zone foundation resources (mode "import"); the sandbox foundation is only allowed for dev`,
      );
    }
    const edge = cfg.foundation.edge;
    if (cfg.api.originMode === 'vpc-origin-https') {
      if (!edge.apiOriginDomainName) {
        issue(
          ['foundation', 'edge', 'apiOriginDomainName'],
          'is required for the CloudFront VPC origin (originMode "vpc-origin-https")',
        );
      }
      if (!edge.albCertificateArn) {
        issue(
          ['foundation', 'edge', 'albCertificateArn'],
          'is required for the HTTPS ALB (originMode "vpc-origin-https")',
        );
      }
    } else if (cfg.foundation.mode !== 'sandbox') {
      issue(
        ['api', 'originMode'],
        'public-alb-http needs the public subnets of the sandbox foundation',
      );
    }
    if (edge.albCertificateArn && regionOfArn(edge.albCertificateArn) !== cfg.region) {
      issue(
        ['foundation', 'edge', 'albCertificateArn'],
        `ALB certificate must be in ${cfg.region}`,
      );
    }
    if (
      edge.cloudFrontCertificateArn &&
      regionOfArn(edge.cloudFrontCertificateArn) !== 'us-east-1'
    ) {
      issue(
        ['foundation', 'edge', 'cloudFrontCertificateArn'],
        'CloudFront certificates must be issued in us-east-1',
      );
    }
    if (Boolean(edge.webDomainName) !== Boolean(edge.cloudFrontCertificateArn)) {
      issue(
        ['foundation', 'edge', 'webDomainName'],
        'webDomainName and cloudFrontCertificateArn must be set together',
      );
    }
    if (cfg.foundation.mode === 'import') {
      if (!edge.webDomainName) {
        issue(
          ['foundation', 'edge', 'webDomainName'],
          'required when importing a landing-zone foundation',
        );
      }
      const { vpc } = cfg.foundation;
      for (const tier of ['appSubnets', 'dataSubnets'] as const) {
        const azs = vpc[tier].map((s) => s.availabilityZone);
        if (new Set(azs).size !== azs.length) {
          issue(
            ['foundation', 'vpc', tier],
            'must contain exactly one subnet per availability zone',
          );
        }
        if (azs.some((az) => !inRegion(az))) {
          issue(['foundation', 'vpc', tier], `subnets must be in ${cfg.region}`);
        }
      }
      for (const key of ['dataKeyArn', 'logsKeyArn'] as const) {
        if (regionOfArn(cfg.foundation.kms[key]) !== cfg.region) {
          issue(['foundation', 'kms', key], `must be a KMS key in ${cfg.region}`);
        }
      }
      const appAzs = [...vpc.appSubnets.map((s) => s.availabilityZone)].sort().join(',');
      const dataAzs = [...vpc.dataSubnets.map((s) => s.availabilityZone)].sort().join(',');
      if (appAzs !== dataAzs) {
        issue(['foundation', 'vpc', 'dataSubnets'], 'app and data subnets must span the same AZs');
      }
    }
    if (regulated && !edge.wafWebAclArn) {
      issue(
        ['foundation', 'edge', 'wafWebAclArn'],
        `${cfg.name} requires a CLOUDFRONT-scope WAF web ACL`,
      );
    }

    // --- Capacity --------------------------------------------------------
    const { api } = cfg;
    if (!(api.minCapacity <= api.desiredCount && api.desiredCount <= api.maxCapacity)) {
      issue(['api', 'desiredCount'], 'must satisfy minCapacity <= desiredCount <= maxCapacity');
    }
    if (cfg.database.maxAllocatedStorageGiB < cfg.database.allocatedStorageGiB) {
      issue(['database', 'maxAllocatedStorageGiB'], 'must be >= allocatedStorageGiB');
    }

    // --- Stateful protection --------------------------------------------
    if (cfg.database.removalPolicy === 'destroy' && !sandbox) {
      issue(
        ['database', 'removalPolicy'],
        'named environments must keep at least a final snapshot',
      );
    }
    if (regulated) {
      const requireTrue = (path: (string | number)[], value: boolean, what: string) => {
        if (!value) issue(path, `${cfg.name} requires ${what}`);
      };
      requireTrue(
        ['database', 'deletionProtection'],
        cfg.database.deletionProtection,
        'RDS deletion protection',
      );
      requireTrue(
        ['jobTable', 'deletionProtection'],
        cfg.jobTable.deletionProtection,
        'DynamoDB deletion protection',
      );
      requireTrue(
        ['api', 'albDeletionProtection'],
        api.albDeletionProtection,
        'ALB deletion protection',
      );
      if (cfg.database.removalPolicy !== 'retain') {
        issue(['database', 'removalPolicy'], `${cfg.name} requires "retain"`);
      }
      if (cfg.jobTable.removalPolicy !== 'retain') {
        issue(['jobTable', 'removalPolicy'], `${cfg.name} requires "retain"`);
      }
      if (cfg.database.backupRetentionDays < 7) {
        issue(['database', 'backupRetentionDays'], `${cfg.name} requires at least 7 days`);
      }
      if (api.useFargateSpot) {
        issue(['api', 'useFargateSpot'], `${cfg.name} must not run the API on Fargate Spot`);
      }
    }
    // --- Identity: an SPA client id as API audience would admit the SPA's ID tokens. --
    if (cfg.auth.testIssuer) {
      if (cfg.auth.issuer || cfg.auth.jwksUri) {
        issue(['auth', 'issuer'], 'omit issuer and jwksUri: the test issuer stack provides both');
      }
    } else if (!cfg.auth.issuer) {
      issue(['auth', 'issuer'], 'is required (the organization IdP issuer, https)');
    }
    if (cfg.auth.audience === cfg.auth.spaClientId) {
      issue(['auth', 'audience'], 'must identify the API and differ from auth.spaClientId');
    }
    if ((cfg.auth.allowedClientIds ?? []).includes(cfg.auth.audience)) {
      issue(['auth', 'allowedClientIds'], 'must not contain the API audience');
    }
    const requested = cfg.auth.spaScope.split(' ');
    for (const scope of ['openid', cfg.auth.scopes.read, cfg.auth.scopes.write]) {
      if (!requested.includes(scope)) {
        issue(['auth', 'spaScope'], `must include ${scope}`);
      }
    }

    // --- Workflow -------------------------------------------------------------
    // Unreserved (null, sandbox only): the CONNECTION LIMIT alone bounds the connections.
    const dbConnections = 2 * (cfg.workflow.reservedConcurrency ?? 0);
    const processorLimit = cfg.database.connectionLimits.processor;
    if (dbConnections > processorLimit - STARTER_PROCESSOR_CONNECTION_HEADROOM) {
      issue(
        ['workflow', 'reservedConcurrency'],
        `validator + processor may hold ${dbConnections} starter_processor connections; database.connectionLimits.processor is ${processorLimit} (keep ${STARTER_PROCESSOR_CONNECTION_HEADROOM} free) — lower the concurrency, raise the limit, or use RDS Proxy`,
      );
    }
    if (!cfg.workflow.placeInVpc) {
      issue(
        ['workflow', 'placeInVpc'],
        'must be true: the workflow Lambdas load documents from RDS in the VPC (claim check)',
      );
    }
    const reconciler = cfg.workflow.reconciler;
    if (reconciler.scheduleMinutes * 60 <= reconciler.maxRuntimeSeconds + 15) {
      issue(
        ['workflow', 'reconciler', 'scheduleMinutes'],
        'must leave each run (maxRuntimeSeconds + 15 s) inside one schedule period',
      );
    }
    if (cfg.name !== 'dev' && cfg.workflow.logExecutionData) {
      // Execution input/output carries the submitted document (classified data).
      issue(['workflow', 'logExecutionData'], `${cfg.name} must not log execution payloads`);
    }
    const retention = cfg.database.retention;
    if (retention.mode === 'apply' && !retention.approvalRef) {
      issue(
        ['database', 'retention', 'approvalRef'],
        'is required when the retention mode is "apply" (reference of the approved policy)',
      );
    }
    if (!cfg.database.rotation.enabled && !sandbox) {
      // Every governed environment (SMG4 has no governed-environment suppression). The sandbox alone may switch it off
      // (context sandbox.masterSecretRotation=off) if the rotation transform cannot deploy there.
      issue(['database', 'rotation', 'enabled'], 'master secret rotation is required');
    }
    if (cfg.name === 'prod') {
      if (!cfg.database.multiAz) issue(['database', 'multiAz'], 'prod requires Multi-AZ RDS');
      if (api.minCapacity < 2) issue(['api', 'minCapacity'], 'prod requires at least 2 tasks');
      if (cfg.observability.logRetentionDays < 365) {
        issue(['observability', 'logRetentionDays'], 'prod requires at least 365 days');
      }
    }
  });

export type EnvironmentConfigInput = z.input<typeof EnvironmentConfigSchema>;
export type EnvironmentConfig = z.output<typeof EnvironmentConfigSchema>;

export class ConfigValidationError extends Error {
  public override readonly name = 'ConfigValidationError';
}

export function formatConfigError(envName: string, error: z.ZodError): string {
  const lines = error.issues.map((i) => {
    const path = i.path.length > 0 ? i.path.join('.') : '<root>';
    return `  - ${path}: ${i.message}`;
  });
  return `Invalid configuration for environment "${envName}":\n${lines.join('\n')}`;
}

/** Validates raw config; throws `ConfigValidationError` with every issue listed. */
export function parseEnvironmentConfig(envName: string, raw: unknown): EnvironmentConfig {
  const result = EnvironmentConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigValidationError(formatConfigError(envName, result.error));
  }
  return result.data;
}
