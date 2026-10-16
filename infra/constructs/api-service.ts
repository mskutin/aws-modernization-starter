import { Duration, Stack, type RemovalPolicy } from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import { API_TABLE_ACTIONS, grantTableItems } from '../lib/grants.js';
import { acknowledgeRule } from '../lib/policy-hook.js';
import {
  NODE_BINARY,
  addHardenedNodeContainer,
  databaseEnvironment,
  databaseSecrets,
  grantSecretKeyDecrypt,
  type DatabaseConnection,
} from './node-container.js';

export const API_CONTAINER_NAME = 'api';
export const API_CONTAINER_PORT = 8080;
export const READINESS_PATH = '/health/ready';
export const LIVENESS_PATH = '/health/live';
/** Liveness probe shipped in the image (`apps/api/dist/healthcheck.js`, probes /health/live). */
export const API_HEALTHCHECK_COMMAND = ['CMD', NODE_BINARY, 'dist/healthcheck.js'];
/** ECS stopTimeout; the API drains within SHUTDOWN_TIMEOUT_MS (20 s) below it. */
export const STOP_TIMEOUT_SECONDS = 30;
export const SHUTDOWN_TIMEOUT_MS = 20_000;
/**
 * Trusted X-Forwarded-For hops in front of the task: CloudFront (VPC origin) and the ALB.
 * The task security group admits only the ALB, the precondition for trusting
 * hops at all.
 */
export const TRUST_PROXY_HOPS = 2;

/**
 * Header CloudFront adds to every origin request of the sandbox-only `public-alb-http` origin; the
 * ALB forwards only requests that carry the per-run value (ALB header matching is
 * case-insensitive, so the value must be long and random, e.g. 64 hex characters).
 */
export const ORIGIN_VERIFY_HEADER = 'X-Origin-Verify';
/** Listener rule priority of the origin-verify forward rule (public-alb-http). */
export const ORIGIN_VERIFY_RULE_PRIORITY = 10;

/**
 * How CloudFront reaches the API (environment config `api.originMode`):
 * - `vpc-origin-https` (governed environments, default): internal HTTPS:443 ALB in the app subnets behind a CloudFront
 *   VPC origin; needs the ALB certificate.
 * - `public-alb-http` (SANDBOX ONLY, live validation, not a governed environment): internet-facing HTTP:80 ALB in
 *   the public subnets; security group ingress only from the CloudFront origin-facing prefix list;
 *   the listener answers 403 unless `X-Origin-Verify` carries `verifyHeaderValue`.
 */
export type ApiOrigin =
  | { readonly mode: 'vpc-origin-https' }
  | {
      readonly mode: 'public-alb-http';
      /** Public ingress subnets of the internet-facing ALB. */
      readonly subnets: ec2.SubnetSelection;
      /** Per-run secret CloudFront sends in `X-Origin-Verify` (CDK context `originVerifySecret`). */
      readonly verifyHeaderValue: string;
    };

/** End-user authentication of `/v1` (identity; environment config `auth`). */
export interface ApiAuthSettings {
  /** Exact `iss`; https only (the local http relaxation is never deployed). */
  readonly issuer: string;
  /** `aud` of access tokens for the API (never the SPA client id). */
  readonly audience: string;
  readonly jwksUri?: string | undefined;
  readonly algorithms: readonly string[];
  /** Maximum token age after `iat` (AUTH_MAX_TOKEN_AGE_SECONDS). */
  readonly maxTokenAgeSeconds: number;
  readonly scopes: { readonly read: string; readonly write: string };
  /** azp/client_id allow-list (e.g. the SPA client). */
  readonly allowedClientIds: readonly string[];
  readonly rateLimit: {
    readonly windowSeconds: number;
    readonly readMax: number;
    readonly writeMax: number;
    readonly unauthenticatedMax: number;
  };
}

/** Synth-time guard (BASE-ECS-008 enforces the same on the template): no http identity URLs. */
function assertHttps(value: string | undefined, what: string): void {
  if (value === undefined) return;
  if (!/^https:\/\//.test(value)) throw new Error(`ApiService: ${what} must be an https URL`);
}

/** Task environment for the auth settings (never AUTH_ALLOW_INSECURE_ISSUER or APP_RUNTIME). */
export function authEnvironment(auth: ApiAuthSettings): Record<string, string> {
  assertHttps(auth.issuer, 'auth.issuer');
  assertHttps(auth.jwksUri, 'auth.jwksUri');
  return {
    AUTH_ISSUER: auth.issuer,
    AUTH_AUDIENCE: auth.audience,
    ...(auth.jwksUri ? { AUTH_JWKS_URI: auth.jwksUri } : {}),
    AUTH_ALGORITHMS: auth.algorithms.join(','),
    AUTH_MAX_TOKEN_AGE_SECONDS: String(auth.maxTokenAgeSeconds),
    AUTH_SCOPE_READ: auth.scopes.read,
    AUTH_SCOPE_WRITE: auth.scopes.write,
    AUTH_ALLOWED_CLIENT_IDS: auth.allowedClientIds.join(','),
    RATE_LIMIT_WINDOW_SECONDS: String(auth.rateLimit.windowSeconds),
    RATE_LIMIT_READ_MAX: String(auth.rateLimit.readMax),
    RATE_LIMIT_WRITE_MAX: String(auth.rateLimit.writeMax),
    RATE_LIMIT_UNAUTHENTICATED_MAX: String(auth.rateLimit.unauthenticatedMax),
    TRUST_PROXY_HOPS: String(TRUST_PROXY_HOPS),
  };
}

export interface ApiServiceProps {
  readonly resourcePrefix: string;
  readonly vpc: ec2.IVpc;
  /** Private app subnets for the internal ALB and the tasks. */
  readonly subnets: ec2.SubnetSelection;
  /** ECS cluster (PlatformStack) with the FARGATE/FARGATE_SPOT capacity providers. */
  readonly cluster: ecs.ICluster;
  /** ALB certificate of the HTTPS listener (required for `vpc-origin-https`). */
  readonly certificate?: acm.ICertificate;
  /** CloudFront origin-facing managed prefix list allowed to reach the ALB. */
  readonly originIngressPrefixListId: string;
  /** How CloudFront reaches the ALB. @default { mode: 'vpc-origin-https' } */
  readonly origin?: ApiOrigin;
  /** ALB access-log destination; omitted only in the sandbox (no access logging). */
  readonly accessLogsBucket?: s3.IBucket;
  readonly logsKey: kms.IKey;
  readonly logRetention: logs.RetentionDays;
  readonly logRemovalPolicy: RemovalPolicy;
  /** Image registry (`ImageRepository` in PlatformStack, or an import). */
  readonly repository: ecr.IRepository;
  /** Immutable image digest (`sha256:...`). */
  readonly imageDigest: string;
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly desiredCount: number;
  readonly minCapacity: number;
  readonly maxCapacity: number;
  readonly cpuTargetUtilizationPercent: number;
  readonly useFargateSpot: boolean;
  readonly albDeletionProtection: boolean;
  readonly logLevel: string;
  readonly corsAllowedOrigins: readonly string[];
  /** Bearer-token authentication and rate limits of `/v1` (identity). */
  readonly auth: ApiAuthSettings;
  /** `APP_ENVIRONMENT` log field. */
  readonly environmentName: string;
  /** `APP_VERSION` log field (e.g. git SHA); omitted when unknown. */
  readonly appVersion?: string;
  readonly database: DatabaseConnection;
  readonly jobTable: { readonly table: dynamodb.ITable; readonly key?: kms.IKey };
  readonly stateMachine: sfn.IStateMachine;
  /** CMK of the state machine; StartExecution callers need kms:GenerateDataKey on it. */
  readonly stateMachineKey?: kms.IKey;
}

/**
 * The API: ECS Fargate (arm64) service behind an INTERNAL HTTPS ALB that only
 * CloudFront (VPC origin) can reach. Images are pinned by digest; deployments
 * use the ECS circuit breaker with automatic rollback. The sandbox alone uses the
 * `public-alb-http` origin instead ({@link ApiOrigin}).
 */
export class ApiService extends Construct {
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly listener: elbv2.ApplicationListener;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  /** Target 5xx during a deployment → ECS rolls the deployment back. */
  public readonly deploymentAlarm: cloudwatch.Alarm;
  public readonly logGroup: logs.LogGroup;
  public readonly taskRole: iam.Role;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly serviceSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: ApiServiceProps) {
    super(scope, id);
    const region = Stack.of(this).region;
    const origin: ApiOrigin = props.origin ?? { mode: 'vpc-origin-https' };
    const publicHttp = origin.mode === 'public-alb-http' ? origin : undefined;
    if (!publicHttp && !props.certificate) {
      throw new Error('ApiService: the HTTPS listener (vpc-origin-https) needs a certificate');
    }
    if (publicHttp && !/^[A-Za-z0-9_-]{32,128}$/.test(publicHttp.verifyHeaderValue)) {
      throw new Error('ApiService: the origin-verify value must be 32-128 chars of [A-Za-z0-9_-]');
    }

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/starter/${props.resourcePrefix}/ecs/api`,
      retention: props.logRetention,
      encryptionKey: props.logsKey,
      removalPolicy: props.logRemovalPolicy,
    });

    // --- Network --------------------------------------------------------
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: props.vpc,
      description: publicHttp
        ? `${props.resourcePrefix} SANDBOX public ALB (HTTP from CloudFront origin-facing prefix list only)`
        : `${props.resourcePrefix} internal ALB (HTTPS from CloudFront VPC origin only)`,
      allowAllOutbound: false,
    });
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(props.originIngressPrefixListId),
      ec2.Port.tcp(publicHttp ? 80 : 443),
      publicHttp
        ? 'HTTP from CloudFront (origin-facing prefix list); X-Origin-Verify checked by the listener'
        : 'HTTPS from CloudFront (origin-facing prefix list)',
    );
    this.serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc: props.vpc,
      description: `${props.resourcePrefix} API tasks (ingress from ALB only)`,
      allowAllOutbound: false,
    });
    // Also carries the OIDC discovery/JWKS fetches to the organization's IdP (identity); whether
    // the app subnets can reach the IdP (NAT / egress proxy) is a landing-zone input.
    this.serviceSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS to AWS APIs (ECR, Logs, Secrets Manager, DynamoDB, Step Functions)',
    );

    // --- Task -----------------------------------------------------------
    this.taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `${props.resourcePrefix} API task role (application permissions)`,
    });
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'StartProcessingWorkflow',
        actions: ['states:StartExecution'],
        resources: [props.stateMachine.stateMachineArn],
      }),
    );
    if (props.stateMachineKey) {
      // Step Functions encrypts the execution input with the CMK on the caller's behalf.
      // Not validated against AWS (no account in this sandbox).
      this.taskRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'StartExecutionWithCmk',
          actions: ['kms:GenerateDataKey'],
          resources: [props.stateMachineKey.keyArn],
          conditions: {
            StringEquals: {
              'kms:EncryptionContext:aws:states:stateMachineArn':
                props.stateMachine.stateMachineArn,
            },
          },
        }),
      );
    }
    grantTableItems(this.taskRole, {
      table: props.jobTable.table,
      actions: API_TABLE_ACTIONS,
      key: props.jobTable.key,
    });

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: `${props.resourcePrefix}-api`,
      cpu: props.cpu,
      memoryLimitMiB: props.memoryMiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole: this.taskRole,
    });

    addHardenedNodeContainer(this.taskDefinition, {
      containerName: API_CONTAINER_NAME,
      image: ecs.ContainerImage.fromEcrRepository(props.repository, props.imageDigest),
      logGroup: this.logGroup,
      streamPrefix: 'api',
      // Image ENTRYPOINT is node; CMD defaults to dist/server.js.
      stopTimeout: Duration.seconds(STOP_TIMEOUT_SECONDS),
      portMappings: [
        { containerPort: API_CONTAINER_PORT, name: 'http', protocol: ecs.Protocol.TCP },
      ],
      // Same check as the image HEALTHCHECK (OCI-format images drop it).
      healthCheck: {
        command: API_HEALTHCHECK_COMMAND,
        interval: Duration.seconds(15),
        timeout: Duration.seconds(3),
        retries: 3,
        startPeriod: Duration.seconds(20),
      },
      environment: {
        PORT: String(API_CONTAINER_PORT),
        NODE_ENV: 'production',
        LOG_LEVEL: props.logLevel,
        AWS_REGION: region,
        APP_ENVIRONMENT: props.environmentName,
        ...(props.appVersion ? { APP_VERSION: props.appVersion } : {}),
        ...databaseEnvironment(props.database),
        JOBS_TABLE_NAME: props.jobTable.table.tableName,
        WORKFLOW_MODE: 'stepfunctions',
        STATE_MACHINE_ARN: props.stateMachine.stateMachineArn,
        CORS_ALLOWED_ORIGINS: props.corsAllowedOrigins.join(','),
        SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
        ...authEnvironment(props.auth),
      },
      secrets: databaseSecrets(props.database),
    });

    // --- Service --------------------------------------------------------
    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: `${props.resourcePrefix}-api`,
      cluster: props.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: props.desiredCount,
      vpcSubnets: props.subnets,
      securityGroups: [this.serviceSecurityGroup],
      assignPublicIp: false,
      circuitBreaker: { enable: true, rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: Duration.seconds(60),
      enableExecuteCommand: false,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.ENABLED,
      capacityProviderStrategies: props.useFargateSpot
        ? [
            { capacityProvider: 'FARGATE', base: 1, weight: 1 },
            { capacityProvider: 'FARGATE_SPOT', weight: 3 },
          ]
        : [{ capacityProvider: 'FARGATE', weight: 1 }],
    });

    const scaling = this.service.autoScaleTaskCount({
      minCapacity: props.minCapacity,
      maxCapacity: props.maxCapacity,
    });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: props.cpuTargetUtilizationPercent,
      scaleInCooldown: Duration.seconds(120),
      scaleOutCooldown: Duration.seconds(60),
    });

    // --- Load balancer --------------------------------------------------
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: `${props.resourcePrefix}-api`,
      vpc: props.vpc,
      vpcSubnets: publicHttp ? publicHttp.subnets : props.subnets,
      internetFacing: Boolean(publicHttp),
      securityGroup: this.albSecurityGroup,
      deletionProtection: props.albDeletionProtection,
      dropInvalidHeaderFields: true,
      http2Enabled: true,
      idleTimeout: Duration.seconds(60),
      desyncMitigationMode: elbv2.DesyncMitigationMode.DEFENSIVE,
    });
    if (props.accessLogsBucket) {
      this.loadBalancer.logAccessLogs(props.accessLogsBucket, 'alb');
    } else {
      acknowledgeRule(
        this.loadBalancer,
        'AwsSolutions-ELB2',
        'SANDBOX (live validation, not a governed environment): the ephemeral sandbox has no access-log bucket, so nothing survives cdk destroy.',
      );
    }

    this.listener = publicHttp
      ? this.loadBalancer.addListener('Http', {
          port: 80,
          protocol: elbv2.ApplicationProtocol.HTTP,
          open: false,
          // Anything without the per-run origin-verify header (i.e. not from this distribution).
          defaultAction: elbv2.ListenerAction.fixedResponse(403, {
            contentType: 'text/plain',
            messageBody: 'Forbidden',
          }),
        })
      : this.loadBalancer.addListener('Https', {
          port: 443,
          protocol: elbv2.ApplicationProtocol.HTTPS,
          certificates: props.certificate ? [props.certificate] : [],
          sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
          open: false,
        });
    this.targetGroup = this.listener.addTargets('Api', {
      ...(publicHttp
        ? {
            priority: ORIGIN_VERIFY_RULE_PRIORITY,
            conditions: [
              elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, [
                publicHttp.verifyHeaderValue,
              ]),
            ],
          }
        : {}),
      port: API_CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        this.service.loadBalancerTarget({
          containerName: API_CONTAINER_NAME,
          containerPort: API_CONTAINER_PORT,
        }),
      ],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        // Liveness, not readiness: ECS replaces tasks that fail the ALB check, so a
        // dependency-aware probe would kill every task during an RDS failover or DynamoDB
        // blip. Requests still fail fast with 503 problem+json while dependencies are down.
        path: LIVENESS_PATH,
        healthyHttpCodes: '200',
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // Deployment guard: the ALB checks liveness, so a release with a broken dependency
    // configuration (secret, IAM/KMS permission, endpoint) would stay "healthy" while answering
    // 503. Target 5xx during a deployment trips this alarm and ECS rolls the deployment back
    // (in addition to the circuit breaker, which only sees failing health checks).
    this.deploymentAlarm = new cloudwatch.Alarm(this, 'DeploymentTarget5xx', {
      alarmName: `${props.resourcePrefix}-api-deployment-target-5xx`,
      alarmDescription: 'API target 5xx during an ECS deployment: the deployment is rolled back.',
      metric: this.targetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
        period: Duration.minutes(1),
        statistic: cloudwatch.Stats.SUM,
      }),
      threshold: 10,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.service.enableDeploymentAlarms([this.deploymentAlarm.alarmName], {
      behavior: ecs.AlarmBehavior.ROLLBACK_ON_ALARM,
    });

    // --- IAM details and policy acknowledgments -------------------------
    const executionRole = this.taskDefinition.obtainExecutionRole();
    if (props.database.secretKey) {
      grantSecretKeyDecrypt(executionRole, props.database.secretKey, region);
    }
    acknowledgeRule(
      this.taskDefinition,
      'AwsSolutions-ECS2',
      'Only non-secret configuration is passed as environment variables; DB credentials are injected from Secrets Manager via ECS secrets.',
    );
    acknowledgeRule(
      executionRole,
      'AwsSolutions-IAM5[Resource::*]',
      'ecr:GetAuthorizationToken does not support resource-level permissions; image pull actions are scoped to the repository.',
    );
  }
}
