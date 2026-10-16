import { RemovalPolicy } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { describe, expect, it } from 'vitest';
import {
  API_CONTAINER_PORT,
  API_HEALTHCHECK_COMMAND,
  ApiService,
  LIVENESS_PATH,
  STOP_TIMEOUT_SECONDS,
  TRUST_PROXY_HOPS,
  authEnvironment,
  type ApiAuthSettings,
} from '../constructs/api-service.js';
import { ImageRepository } from '../constructs/image-repository.js';
import { JobStateTable } from '../constructs/job-state-table.js';
import { NODE_CONTAINER_USER } from '../constructs/node-container.js';
import { RelationalDatabase } from '../constructs/relational-database.js';
import { API_TABLE_ACTIONS } from '../lib/grants.js';
import {
  TEST_DIGEST,
  importedFoundation,
  nagViolations,
  resourcesOf,
  testStack,
} from './helpers.js';

const AUTH: ApiAuthSettings = {
  issuer: 'https://idp.test.starter.example.com/realms/starter',
  audience: 'api://starter-test-jobs',
  algorithms: ['RS256', 'ES256'],
  maxTokenAgeSeconds: 3600,
  scopes: { read: 'jobs:read', write: 'jobs:write' },
  allowedClientIds: ['starter-test-web'],
  rateLimit: { windowSeconds: 60, readMax: 120, writeMax: 20, unauthenticatedMax: 30 },
};

function build(importedRepositoryArn?: string) {
  const stack = testStack();
  const f = importedFoundation(stack);
  const table = new JobStateTable(stack, 'Jobs', {
    encryptionKey: f.dataKey,
    deletionProtection: true,
    removalPolicy: RemovalPolicy.RETAIN,
    pitrRecoveryPeriodDays: 35,
  });
  const db = new RelationalDatabase(stack, 'Db', {
    resourcePrefix: 'starter-test',
    vpc: f.vpc,
    subnets: f.dataSubnets,
    encryptionKey: f.dataKey,
    logsKey: f.logsKey,
    logRetention: logs.RetentionDays.ONE_MONTH,
    engineVersion: '17.9',
    instanceType: 't4g.micro',
    multiAz: false,
    allocatedStorageGiB: 20,
    maxAllocatedStorageGiB: 50,
    backupRetentionDays: 1,
    deletionProtection: false,
    removalPolicy: RemovalPolicy.SNAPSHOT,
    performanceInsights: false,
    monitoringIntervalSeconds: 0,
    databaseName: 'starterapp',
    masterUsername: 'starteradmin',
    rotation: { enabled: true, intervalDays: 30 },
  });
  const stateMachine = sfn.StateMachine.fromStateMachineArn(
    stack,
    'Sm',
    'arn:aws:states:ap-southeast-1:000000000000:stateMachine:starter-test-job-processing',
  );
  const repository = importedRepositoryArn
    ? ecr.Repository.fromRepositoryArn(stack, 'Repo', importedRepositoryArn)
    : new ImageRepository(stack, 'Images', {
        repositoryName: 'starter-test/api',
        encryptionKey: f.dataKey,
      }).repository;
  const cluster = new ecs.Cluster(stack, 'Cluster', {
    vpc: f.vpc,
    containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    enableFargateCapacityProviders: true,
  });
  const api = new ApiService(stack, 'Api', {
    resourcePrefix: 'starter-test',
    vpc: f.vpc,
    subnets: f.appSubnets,
    cluster,
    certificate: f.albCertificate,
    originIngressPrefixListId: f.cloudFrontOriginFacingPrefixListId,
    accessLogsBucket: f.accessLogsBucket,
    logsKey: f.logsKey,
    logRetention: logs.RetentionDays.ONE_MONTH,
    logRemovalPolicy: RemovalPolicy.RETAIN,
    repository,
    imageDigest: TEST_DIGEST,
    cpu: 512,
    memoryMiB: 1024,
    desiredCount: 2,
    minCapacity: 2,
    maxCapacity: 6,
    cpuTargetUtilizationPercent: 60,
    useFargateSpot: false,
    albDeletionProtection: true,
    logLevel: 'info',
    corsAllowedOrigins: [],
    auth: AUTH,
    environmentName: 'test',
    appVersion: 'abc1234',
    // Same wiring as ApiStack: starter_app with RDS IAM authentication (ADR 0221).
    database: db.iamConnection('starter_app', { poolMax: 5 }),
    jobTable: { table: table.table, key: f.dataKey },
    stateMachine,
  });
  db.allowFrom(api.service, 'api');
  return { stack, f, api, db, table, stateMachine, template: Template.fromStack(stack) };
}

describe('ApiService', () => {
  const { stack, f, template, stateMachine, table } = build();

  it('ImageRepository: immutable tags, scan on push, KMS, lifecycle, retained', () => {
    template.hasResource('AWS::ECR::Repository', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        RepositoryName: 'starter-test/api',
        ImageTagMutability: 'IMMUTABLE',
        ImageScanningConfiguration: { ScanOnPush: true },
        EncryptionConfiguration: { EncryptionType: 'KMS', KmsKey: f.dataKey.keyArn },
        LifecyclePolicy: Match.objectLike({
          LifecyclePolicyText: Match.stringLikeRegexp('untagged'),
        }),
      }),
    });
  });

  it('can pull from an imported repository instead', () => {
    const imported = build(
      'arn:aws:ecr:ap-southeast-1:000000000000:repository/shared/api',
    ).template;
    imported.resourceCountIs('AWS::ECR::Repository', 0);
    imported.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              'ecr:BatchCheckLayerAvailability',
              'ecr:BatchGetImage',
              'ecr:GetDownloadUrlForLayer',
            ],
            Resource: 'arn:aws:ecr:ap-southeast-1:000000000000:repository/shared/api',
          }),
        ]),
      },
    });
  });

  it('Fargate arm64 task referencing the image by digest', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      RequiresCompatibilities: ['FARGATE'],
      RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
      Cpu: '512',
      Memory: '1024',
    });
    const [, td] = resourcesOf(template, 'AWS::ECS::TaskDefinition')[0]!;
    const image = JSON.stringify((td.ContainerDefinitions as { Image: unknown }[])[0]!.Image);
    expect(image).toContain(`@${TEST_DIGEST}`);
    expect(image).not.toMatch(/:latest/);
  });

  it('hardened container: non-root, read-only root FS, no privilege, ALL caps dropped, stopTimeout', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        Match.objectLike({
          User: NODE_CONTAINER_USER,
          ReadonlyRootFilesystem: true,
          Privileged: false,
          LinuxParameters: { Capabilities: { Drop: ['ALL'] }, InitProcessEnabled: true },
          StopTimeout: STOP_TIMEOUT_SECONDS,
          MountPoints: [{ ContainerPath: '/tmp', SourceVolume: 'tmp', ReadOnly: false }],
          PortMappings: [Match.objectLike({ ContainerPort: API_CONTAINER_PORT })],
          HealthCheck: Match.objectLike({ Command: API_HEALTHCHECK_COMMAND }),
        }),
      ],
    });
  });

  it('environment contract (docs/contracts.md §3); IAM database auth, no DB credential', () => {
    const [, td] = resourcesOf(template, 'AWS::ECS::TaskDefinition')[0]!;
    const container = (
      td.ContainerDefinitions as {
        Environment: { Name: string; Value: unknown }[];
        Secrets?: { Name: string }[];
      }[]
    )[0]!;
    const env = Object.fromEntries(container.Environment.map((e) => [e.Name, e.Value]));
    expect(env).toMatchObject({
      PORT: '8080',
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      AWS_REGION: 'ap-southeast-1',
      DB_PORT: '5432',
      DB_NAME: 'starterapp',
      DB_USER: 'starter_app',
      DB_AUTH: 'iam',
      DB_SSL: 'verify-full',
      DB_SSL_ROOT_CERT: '/app/certs/rds-global-bundle.pem',
      DB_POOL_MAX: '5',
      WORKFLOW_MODE: 'stepfunctions',
      CORS_ALLOWED_ORIGINS: '',
      SHUTDOWN_TIMEOUT_MS: '20000',
      APP_ENVIRONMENT: 'test',
      APP_VERSION: 'abc1234',
    });
    for (const key of ['DB_HOST', 'JOBS_TABLE_NAME', 'STATE_MACHINE_ARN'])
      expect(env[key]).toBeDefined();
    expect(Object.keys(env)).not.toContain('DB_PASSWORD');
    expect(Object.keys(env)).not.toContain('DYNAMODB_ENDPOINT');
    expect(Object.keys(env).filter((k) => /SECRET/.test(k))).toEqual([]);
    expect(container.Secrets).toBeUndefined();
  });

  it('identity: bearer-token settings, two trusted proxy hops, no local relaxation', () => {
    const [, td] = resourcesOf(template, 'AWS::ECS::TaskDefinition')[0]!;
    const container = (
      td.ContainerDefinitions as { Environment: { Name: string; Value: unknown }[] }[]
    )[0]!;
    const env = Object.fromEntries(container.Environment.map((e) => [e.Name, e.Value]));
    expect(env).toMatchObject({
      AUTH_ISSUER: AUTH.issuer,
      AUTH_AUDIENCE: AUTH.audience,
      AUTH_ALGORITHMS: 'RS256,ES256',
      AUTH_MAX_TOKEN_AGE_SECONDS: '3600',
      AUTH_SCOPE_READ: 'jobs:read',
      AUTH_SCOPE_WRITE: 'jobs:write',
      AUTH_ALLOWED_CLIENT_IDS: 'starter-test-web',
      RATE_LIMIT_WINDOW_SECONDS: '60',
      RATE_LIMIT_READ_MAX: '120',
      RATE_LIMIT_WRITE_MAX: '20',
      RATE_LIMIT_UNAUTHENTICATED_MAX: '30',
      TRUST_PROXY_HOPS: '2',
      NODE_ENV: 'production',
    });
    expect(TRUST_PROXY_HOPS).toBe(2);
    // BASE-ECS-008: never the local switches, never an http identity URL.
    expect(Object.keys(env)).not.toContain('AUTH_ALLOW_INSECURE_ISSUER');
    expect(Object.keys(env)).not.toContain('APP_RUNTIME');
    for (const value of Object.values(env)) expect(String(value)).not.toMatch(/^http:/);
  });

  it('refuses an http issuer or JWKS URL at synth time', () => {
    expect(() => authEnvironment({ ...AUTH, issuer: 'http://idp.internal' })).toThrow(/https/);
    expect(() => authEnvironment({ ...AUTH, jwksUri: 'http://idp.internal/jwks' })).toThrow(
      /https/,
    );
    expect(authEnvironment({ ...AUTH, jwksUri: 'https://idp.internal/jwks' }).AUTH_JWKS_URI).toBe(
      'https://idp.internal/jwks',
    );
  });

  it('service: circuit breaker with rollback, 100/200 %, private subnets, autoscaling', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: {
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        MinimumHealthyPercent: 100,
        MaximumPercent: 200,
      },
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }),
      },
      EnableExecuteCommand: false,
    });
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      MinCapacity: 2,
      MaxCapacity: 6,
    });
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterSettings: [{ Name: 'containerInsights', Value: 'enhanced' }],
    });
  });

  it('rolls a deployment back on target 5xx (liveness-only ALB checks miss broken config)', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('-api-deployment-target-5xx$'),
      MetricName: 'HTTPCode_Target_5XX_Count',
      Statistic: 'Sum',
      Threshold: 10,
    });
    template.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({
        Alarms: {
          // Ref of an AWS::CloudWatch::Alarm resolves to its name.
          AlarmNames: [{ Ref: Match.stringLikeRegexp('DeploymentTarget5xx') }],
          Enable: true,
          Rollback: true,
        },
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      }),
    });
  });

  it('internal ALB with HTTPS-only listener, modern TLS policy, access logs, liveness health check', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internal',
      LoadBalancerAttributes: Match.arrayWith([
        { Key: 'deletion_protection.enabled', Value: 'true' },
        { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
        { Key: 'access_logs.s3.enabled', Value: 'true' },
      ]),
    });
    const listeners = resourcesOf(template, 'AWS::ElasticLoadBalancingV2::Listener');
    expect(listeners).toHaveLength(1);
    expect(listeners[0]![1]).toMatchObject({
      Protocol: 'HTTPS',
      Port: 443,
      SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      Certificates: [{ CertificateArn: f.albCertificate.certificateArn }],
    });
    // Liveness: ECS replaces tasks failing the ALB check, so it must not depend on RDS/DynamoDB.
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: LIVENESS_PATH,
      Matcher: { HttpCode: '200' },
      Port: API_CONTAINER_PORT,
      TargetType: 'ip',
    });
  });

  it('security groups: CloudFront prefix list -> ALB -> tasks -> DB, nothing else inbound', () => {
    const ingress = resourcesOf(template, 'AWS::EC2::SecurityGroupIngress').map(([, p]) => p);
    const inlineIngress = resourcesOf(template, 'AWS::EC2::SecurityGroup').flatMap(
      ([, p]) => (p.SecurityGroupIngress as unknown[] | undefined) ?? [],
    );
    expect(inlineIngress).toEqual([]);
    // 4th rule: the master secret's hosted rotation Lambda to PostgreSQL (rotation is required).
    expect(ingress).toHaveLength(4);
    expect(ingress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          SourcePrefixListId: f.cloudFrontOriginFacingPrefixListId,
          FromPort: 443,
        }),
        expect.objectContaining({
          FromPort: API_CONTAINER_PORT,
          SourceSecurityGroupId: expect.anything(),
        }),
        expect.objectContaining({ FromPort: 5432, SourceSecurityGroupId: expect.anything() }),
      ]),
    );
    for (const rule of ingress) {
      expect(rule).not.toHaveProperty('CidrIp');
    }
  });

  it('task role: StartExecution on the state machine, item actions used by the API, KMS via DynamoDB', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Sid: 'StartProcessingWorkflow',
            Action: 'states:StartExecution',
            Effect: 'Allow',
            Resource: stack.resolve(stateMachine.stateMachineArn),
          },
          {
            Sid: 'JobTableItemAccess',
            Action: [...API_TABLE_ACTIONS].sort(),
            Effect: 'Allow',
            Resource: stack.resolve(table.table.tableArn),
          },
          Match.objectLike({
            Sid: 'JobTableKmsViaDynamoDb',
            Condition: {
              StringEquals: { 'kms:ViaService': 'dynamodb.ap-southeast-1.amazonaws.com' },
            },
          }),
        ],
      },
      Roles: [Match.objectLike({ Ref: Match.stringLikeRegexp('TaskRole') })],
    });
  });

  it('no role can read a database secret (IAM auth; rds-db:connect is granted by ApiStack)', () => {
    const statements = resourcesOf(template, 'AWS::IAM::Policy').flatMap(
      ([, p]) => (p.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement,
    );
    const text = JSON.stringify(statements);
    expect(text).not.toContain('secretsmanager:');
    expect(text).not.toContain('DecryptDbSecretViaSecretsManager');
  });

  it('log group encrypted with the logs key and retained', () => {
    template.hasResource('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        LogGroupName: '/starter/starter-test/ecs/api',
        KmsKeyId: f.logsKey.keyArn,
        RetentionInDays: 30,
      }),
    });
  });

  it('passes cdk-nag', () => {
    expect(nagViolations(stack)).toEqual([]);
  });
});
