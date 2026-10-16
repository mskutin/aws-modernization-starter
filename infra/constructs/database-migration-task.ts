import { Stack, type RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { acknowledgeRule } from '../lib/policy-hook.js';
import {
  addHardenedNodeContainer,
  databaseEnvironment,
  databaseSecrets,
  type DatabaseConnection,
} from './node-container.js';

export const MIGRATION_CONTAINER_NAME = 'migrate';
/** Arguments to the image ENTRYPOINT (`/nodejs/bin/node`): apply pending migrations. */
export const MIGRATION_COMMAND = ['dist/migrate.js', 'up'];
export const BOOTSTRAP_CONTAINER_NAME = 'db-bootstrap';
/** Arguments to the image ENTRYPOINT: converge roles, ownership and database privileges. */
export const BOOTSTRAP_COMMAND = ['dist/db-bootstrap.js'];
export const RETENTION_CONTAINER_NAME = 'retention';
/** Arguments to the image ENTRYPOINT: the content retention job (disabled unless configured). */
export const RETENTION_COMMAND = ['dist/retention.js'];

interface DatabaseOneOffTaskProps {
  readonly resourcePrefix: string;
  readonly vpc: ec2.IVpc;
  /** Same repository and digest as the API service: one image, several entry commands. */
  readonly repository: ecr.IRepository;
  readonly imageDigest: string;
  readonly logsKey: kms.IKey;
  readonly logRetention: logs.RetentionDays;
  readonly logRemovalPolicy: RemovalPolicy;
  readonly logLevel: string;
  readonly environmentName: string;
  readonly appVersion?: string;
  readonly database: DatabaseConnection;
}

/**
 * Shared shape of the one-off database tasks: hardened container on the API image, its own
 * encrypted log group, a security group with no ingress (HTTPS egress here, 5432 added by the
 * database's `allowFrom`) and a task role for exactly what the task needs.
 */
abstract class DatabaseOneOffTask extends Construct {
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly logGroup: logs.LogGroup;
  /** Application permissions of the task (IAM token signing or reading the master secret). */
  public readonly taskRole: iam.Role;

  protected constructor(
    scope: Construct,
    id: string,
    props: DatabaseOneOffTaskProps,
    spec: {
      family: string;
      logName: string;
      description: string;
      containerName: string;
      command: string[];
      environment: Record<string, string>;
    },
  ) {
    super(scope, id);
    const region = Stack.of(this).region;

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/starter/${props.resourcePrefix}/ecs/${spec.logName}`,
      retention: props.logRetention,
      encryptionKey: props.logsKey,
      removalPolicy: props.logRemovalPolicy,
    });

    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: `${props.resourcePrefix} ${spec.description} (no ingress)`,
      allowAllOutbound: false,
    });
    this.securityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS to AWS APIs (ECR, Logs, STS, Secrets Manager)',
    );

    this.taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `${props.resourcePrefix} ${spec.description} (database access only)`,
    });

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: spec.family,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole: this.taskRole,
    });
    addHardenedNodeContainer(this.taskDefinition, {
      containerName: spec.containerName,
      image: ecs.ContainerImage.fromEcrRepository(props.repository, props.imageDigest),
      logGroup: this.logGroup,
      streamPrefix: spec.logName,
      command: spec.command,
      environment: {
        NODE_ENV: 'production',
        LOG_LEVEL: props.logLevel,
        AWS_REGION: region,
        APP_ENVIRONMENT: props.environmentName,
        ...(props.appVersion ? { APP_VERSION: props.appVersion } : {}),
        ...databaseEnvironment(props.database),
        ...spec.environment,
      },
      secrets: databaseSecrets(props.database),
    });

    const executionRole = this.taskDefinition.obtainExecutionRole();
    acknowledgeRule(
      this.taskDefinition,
      'AwsSolutions-ECS2',
      'Only non-secret configuration is passed as environment variables; no database credential is in the task definition.',
    );
    acknowledgeRule(
      executionRole,
      'AwsSolutions-IAM5[Resource::*]',
      'ecr:GetAuthorizationToken does not support resource-level permissions; image pull actions are scoped to the repository.',
    );
  }
}

export type DatabaseMigrationTaskProps = DatabaseOneOffTaskProps;

/**
 * One-off Fargate task that runs the API image's versioned SQL migrations
 * (`node dist/migrate.js up`, forward-only, expand/contract) as `starter_migrator` with RDS IAM
 * authentication; the runner acts through `SET ROLE starter_owner` (ADR 0220). The pipeline starts it
 * with `ecs run-task` AFTER the bootstrap task and BEFORE rolling out a new API version, and fails
 * the deployment on a non-zero exit code. Its task role holds only `rds-db:connect` for
 * `starter_migrator` (granted by the stack through `RelationalDatabase.grantConnect`).
 */
export class DatabaseMigrationTask extends DatabaseOneOffTask {
  constructor(scope: Construct, id: string, props: DatabaseMigrationTaskProps) {
    if (props.database.auth.mode !== 'iam') {
      throw new Error('DatabaseMigrationTask: the migrator authenticates with IAM only');
    }
    super(scope, id, props, {
      family: `${props.resourcePrefix}-db-migrate`,
      logName: 'db-migrate',
      description: 'DB migration task',
      containerName: MIGRATION_CONTAINER_NAME,
      command: MIGRATION_COMMAND,
      environment: {},
    });
  }
}

export interface DatabaseBootstrapTaskProps extends DatabaseOneOffTaskProps {
  /** CONNECTION LIMIT per login role. */
  readonly connectionLimits: Readonly<Record<string, number>>;
}

/** Env-name stem per login role (`DB_BOOTSTRAP_<STEM>_CONNECTION_LIMIT`, @starter/config). */
const CONNECTION_LIMIT_STEMS: Record<string, string> = {
  starter_migrator: 'MIGRATOR',
  starter_app: 'APP',
  starter_processor: 'PROCESSOR',
  starter_retention: 'RETENTION',
};

/**
 * One-off, break-glass Fargate task that converges the database role model
 * (`node dist/db-bootstrap.js`, idempotent; ADR 0220) as the RDS MASTER user. It is the only task
 * that may use the master secret: `@starter/db` reads it from Secrets Manager when the connection
 * opens (`DB_AUTH=secrets-manager`, `DB_SECRET_ARN`), so a rotated master password is always
 * current and no credential is in the task definition. Login roles get `rds_iam`
 * (`DB_BOOTSTRAP_LOGIN_AUTH=iam`). Runs once per environment and after role-model changes, before
 * the migration task; never as a service, never scheduled. Governed exception EXC-0005
 * (BASE-ECS-009) covers exactly this task definition. Not validated on AWS.
 */
export class DatabaseBootstrapTask extends DatabaseOneOffTask {
  constructor(scope: Construct, id: string, props: DatabaseBootstrapTaskProps) {
    const { auth } = props.database;
    if (auth.mode !== 'secrets-manager') {
      throw new Error('DatabaseBootstrapTask: the bootstrap reads the master secret at runtime');
    }
    const limits = Object.fromEntries(
      Object.entries(props.connectionLimits).map(([role, limit]) => {
        const stem = CONNECTION_LIMIT_STEMS[role];
        if (!stem) throw new Error(`DatabaseBootstrapTask: unknown login role ${role}`);
        return [`DB_BOOTSTRAP_${stem}_CONNECTION_LIMIT`, String(limit)];
      }),
    );
    super(scope, id, props, {
      family: `${props.resourcePrefix}-db-bootstrap`,
      logName: 'db-bootstrap',
      description: 'DB bootstrap task (break-glass, master secret)',
      containerName: BOOTSTRAP_CONTAINER_NAME,
      command: BOOTSTRAP_COMMAND,
      environment: { DB_BOOTSTRAP_LOGIN_AUTH: 'iam', ...limits },
    });
    // Read exactly the master secret, at runtime, with the task role (not the execution role).
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadMasterSecretAtRuntime',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [auth.secret.secretArn],
      }),
    );
    if (props.database.secretKey) {
      this.taskRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'DecryptMasterSecretViaSecretsManager',
          actions: ['kms:Decrypt'],
          resources: [props.database.secretKey.keyArn],
          conditions: {
            StringEquals: {
              'kms:ViaService': `secretsmanager.${Stack.of(this).region}.amazonaws.com`,
            },
          },
        }),
      );
    }
  }
}

/** Retention policy of the environment (`database.retention`; ADR 0223). */
export type RetentionTaskPolicy =
  | { readonly mode: 'disabled' }
  | {
      readonly mode: 'dry-run' | 'apply';
      readonly contentDays: number;
      /** Required for `apply`: reference of the APPROVED retention policy. */
      readonly approvalRef?: string;
      readonly batchSize: number;
      readonly maxBatches: number;
    };

export interface DatabaseRetentionTaskProps extends DatabaseOneOffTaskProps {
  readonly policy: RetentionTaskPolicy;
}

/**
 * One-off Fargate task for the content retention job (`node dist/retention.js`; ADR 0223) as
 * `starter_retention` with RDS IAM authentication. DISABLED by default: with `RETENTION_MODE=disabled`
 * the job logs that no approved policy exists and touches nothing. `apply` requires the reference
 * of an approved policy (enforced by the environment schema and the CLI). Not scheduled: a
 * schedule is added only together with an approved policy (ADR 0223).
 */
export class DatabaseRetentionTask extends DatabaseOneOffTask {
  constructor(scope: Construct, id: string, props: DatabaseRetentionTaskProps) {
    if (props.database.auth.mode !== 'iam') {
      throw new Error('DatabaseRetentionTask: the retention job authenticates with IAM only');
    }
    const { policy } = props;
    if (policy.mode === 'apply' && !policy.approvalRef) {
      throw new Error('DatabaseRetentionTask: apply requires the reference of an approved policy');
    }
    super(scope, id, props, {
      family: `${props.resourcePrefix}-db-retention`,
      logName: 'db-retention',
      description: 'DB retention task (disabled by default)',
      containerName: RETENTION_CONTAINER_NAME,
      command: RETENTION_COMMAND,
      environment:
        policy.mode === 'disabled'
          ? { RETENTION_MODE: 'disabled' }
          : {
              RETENTION_MODE: policy.mode,
              RETENTION_CONTENT_DAYS: String(policy.contentDays),
              RETENTION_BATCH_SIZE: String(policy.batchSize),
              RETENTION_MAX_BATCHES: String(policy.maxBatches),
              ...(policy.approvalRef ? { RETENTION_APPROVAL_REF: policy.approvalRef } : {}),
            },
    });
  }
}
