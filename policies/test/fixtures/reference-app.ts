/**
 * L2 CDK fixture stacks that mirror the reference architecture (SPA on S3 +
 * CloudFront, ECS Fargate API, Step Functions + Lambda, RDS PostgreSQL,
 * DynamoDB) — used to prove the baseline is satisfiable with idiomatic CDK
 * and to exercise cdk-nag + exceptions end to end. The real infrastructure lives in
 * `infra/`; these fixtures exist only for policy tests.
 */
import {
  Duration,
  RemovalPolicy,
  Stack,
  Stage,
  Tags,
  type App,
  type StackProps,
} from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import type { Environment } from '../../src/types.js';

export interface ReferenceStackProps extends StackProps {
  environment: Environment;
}

const ENV = { account: '111122223333', region: 'ap-southeast-1' };

/** A stack that satisfies every baseline rule for the given environment. */
export class CompliantReferenceStack extends Stack {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: ReferenceStackProps) {
    super(scope, id, { env: ENV, ...props });
    const protect = props.environment !== 'dev';
    const removalPolicy = protect ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    const key = new kms.Key(this, 'DataKey', { enableKeyRotation: true, removalPolicy });
    key.grantEncryptDecrypt(new iam.ServicePrincipal(`logs.${ENV.region}.amazonaws.com`));
    const logGroup = (name: string) =>
      new logs.LogGroup(this, name, {
        retention: logs.RetentionDays.ONE_MONTH,
        encryptionKey: key,
        removalPolicy: RemovalPolicy.DESTROY,
      });

    // ── SPA hosting: private bucket + CloudFront OAC ──
    const bucketProps = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy,
    };
    this.bucket = new s3.Bucket(this, 'SpaBucket', bucketProps);
    const logBucket = new s3.Bucket(this, 'EdgeLogs', {
      ...bucketProps,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
    });
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    });
    const certificate = protect
      ? acm.Certificate.fromCertificateArn(
          this,
          'Cert',
          'arn:aws:acm:us-east-1:111122223333:certificate/00000000-0000-0000-0000-000000000000',
        )
      : undefined;
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
      },
      additionalBehaviors: {
        '/v1/*': {
          origin: new origins.HttpOrigin('api.internal.example.com', {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          responseHeadersPolicy: headers,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
      },
      enableLogging: true,
      logBucket,
      ...(certificate
        ? {
            certificate,
            domainNames: [`${props.environment}.app.example.com`],
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
          }
        : {}),
    });

    // ── Network ──
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    // ── API on ECS Fargate ──
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    const dbSecret = new rds.DatabaseSecret(this, 'DbSecret', { username: 'app' });
    const task = new ecs.FargateTaskDefinition(this, 'ApiTask', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    task.addContainer('api', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:24-alpine'),
      user: '1000:1000',
      readonlyRootFilesystem: true,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'api', logGroup: logGroup('ApiLogs') }),
      // Deployed target (ADRs 0221, 0222 and 0511): IAM database auth with verified TLS; the
      // master secret stays with the database (credentials below), never in the task.
      environment: {
        PORT: '8080',
        DB_HOST: 'db.internal',
        DB_AUTH: 'iam',
        DB_SSL: 'verify-full',
        AUTH_ISSUER: 'https://idp.example.com',
        AUTH_AUDIENCE: 'api://starter-jobs',
        AUTH_ALLOWED_CLIENT_IDS: 'starter-web',
      },
      portMappings: [{ containerPort: 8080 }],
    });
    new ecs.FargateService(this, 'ApiService', {
      cluster,
      taskDefinition: task,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // ── Workflow: Lambda + Step Functions ──
    this.fn = new lambda.Function(this, 'Validator', {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async (e) => e;'),
      timeout: Duration.seconds(15),
      reservedConcurrentExecutions: 5,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: logGroup('ValidatorLogs'),
    });
    new sfn.StateMachine(this, 'Workflow', {
      definitionBody: sfn.DefinitionBody.fromChainable(
        new tasks.LambdaInvoke(this, 'ValidateJob', { lambdaFunction: this.fn }),
      ),
      logs: { destination: logGroup('WorkflowLogs'), level: sfn.LogLevel.ERROR },
      tracingEnabled: true,
    });

    // ── Data ──
    const table = new dynamodb.Table(this, 'JobsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: key,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: props.environment === 'prod',
      removalPolicy,
    });
    table.grantReadWriteData(task.taskRole);
    table.grantReadWriteData(this.fn);

    new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      credentials: rds.Credentials.fromSecret(dbSecret),
      storageEncrypted: true,
      storageEncryptionKey: key,
      deletionProtection: protect,
      backupRetention: Duration.days(protect ? 7 : 1),
      removalPolicy: protect ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
    });
  }
}

/** A deliberately non-compliant stack built from L2 defaults. */
export class NonCompliantStack extends Stack {
  constructor(scope: Construct, id: string, props: ReferenceStackProps) {
    super(scope, id, { env: ENV, ...props });
    new s3.Bucket(this, 'OpenBucket', {
      blockPublicAccess: new s3.BlockPublicAccess({ blockPublicPolicy: false }),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new lambda.Function(this, 'LegacyFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => 1;'),
    });
    new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}

export const TAGS = (environment: Environment) => ({
  Project: 'aws-modernization-starter',
  Environment: environment,
  Owner: 'platform-team',
  CostCentre: 'CC-0000',
  DataClassification: 'internal',
  ManagedBy: 'aws-cdk',
});

/** Mirrors the expected infra layout: one Stage per environment, tags applied at Stage level. */
export function addStage(app: App, environment: Environment, build: (stage: Stage) => void): Stage {
  const stage = new Stage(app, environment.charAt(0).toUpperCase() + environment.slice(1), {
    env: ENV,
  });
  build(stage);
  for (const [k, v] of Object.entries(TAGS(environment))) Tags.of(stage).add(k, v);
  return stage;
}
