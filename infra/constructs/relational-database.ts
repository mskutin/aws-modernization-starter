import { DB_LOGIN_ROLES, type DbLoginRole } from '@starter/db/roles';
import { Duration, RemovalPolicy, Stack, ArnFormat } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { acknowledgeRule } from '../lib/policy-hook.js';
import { IMAGE_RDS_CA_BUNDLE_PATH, type DatabaseConnection } from './node-container.js';

export const POSTGRES_PORT = 5432;
export const POSTGRES_MAJOR = '17';
/** RDS log types exported to CloudWatch Logs. */
export const POSTGRES_LOG_EXPORTS = ['postgresql', 'upgrade'] as const;

export interface RelationalDatabaseProps {
  readonly resourcePrefix: string;
  readonly vpc: ec2.IVpc;
  /** Isolated data-tier subnets. */
  readonly subnets: ec2.SubnetSelection;
  readonly encryptionKey: kms.IKey;
  readonly logsKey: kms.IKey;
  readonly logRetention: logs.RetentionDays;
  /** Full engine version, e.g. `17.9`. */
  readonly engineVersion: string;
  readonly instanceType: string;
  readonly multiAz: boolean;
  readonly allocatedStorageGiB: number;
  readonly maxAllocatedStorageGiB: number;
  readonly backupRetentionDays: number;
  readonly deletionProtection: boolean;
  readonly removalPolicy: RemovalPolicy;
  /** Delete automated backups with the instance (sandbox only). @default false */
  readonly deleteAutomatedBackups?: boolean;
  readonly performanceInsights: boolean;
  /** 0 disables enhanced monitoring. */
  readonly monitoringIntervalSeconds: number;
  readonly databaseName: string;
  /** RDS master user: used ONLY by the one-off bootstrap task (ADR 0220). */
  readonly masterUsername: string;
  /** Hosted rotation of the master secret (only the bootstrap task reads it, at runtime). */
  readonly rotation: { readonly enabled: boolean; readonly intervalDays: number };
  /** Subnets for the hosted rotation Lambda (needs Secrets Manager + DB reachability). */
  readonly rotationSubnets?: ec2.SubnetSelection;
}

/**
 * RDS for PostgreSQL 17 in isolated subnets: CMK-encrypted storage, generated master credentials
 * in Secrets Manager, SSL forced, IAM database authentication, CloudWatch log exports into
 * pre-created encrypted log groups, environment-driven protection settings.
 *
 * Identities (ADR 0220/0221): runtime tasks and Lambdas log in as least-privilege roles with RDS IAM
 * authentication — wire them with {@link iamConnection}, {@link grantConnect} and
 * {@link allowFrom}. The master secret is for the one-off bootstrap task only
 * ({@link bootstrapConnection}).
 */
export class RelationalDatabase extends Construct {
  public readonly instance: rds.DatabaseInstance;
  /** The RDS MASTER secret: never for runtime tasks or Lambdas. */
  public readonly secret: secretsmanager.ISecret;
  public readonly masterUsername: string;
  /** `DbiResourceId` (`db-...`), the resource part of `rds-db:connect` ARNs. */
  public readonly instanceResourceId: string;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly databaseName: string;
  public readonly port = POSTGRES_PORT;
  public readonly instanceIdentifier: string;
  /** CMK for storage, Performance Insights and the credentials secret. */
  public readonly encryptionKey: kms.IKey;

  constructor(scope: Construct, id: string, props: RelationalDatabaseProps) {
    super(scope, id);
    this.databaseName = props.databaseName;
    this.masterUsername = props.masterUsername;
    this.encryptionKey = props.encryptionKey;
    this.instanceIdentifier = `${props.resourcePrefix}-postgres`;

    const engine = rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.of(props.engineVersion, POSTGRES_MAJOR),
    });

    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: `${props.resourcePrefix} PostgreSQL (ingress only from explicitly allowed clients)`,
      allowAllOutbound: false,
    });

    const parameterGroup = new rds.ParameterGroup(this, 'Parameters', {
      engine,
      description: `${props.resourcePrefix} PostgreSQL ${POSTGRES_MAJOR} parameters`,
      parameters: {
        'rds.force_ssl': '1',
        password_encryption: 'scram-sha-256',
        log_min_duration_statement: '1000',
        // Slow-statement and error log lines must not carry bind parameters: titles and document
        // content are parameters of INSERT jobs and would land in the CloudWatch log export.
        log_parameter_max_length: '0',
        log_parameter_max_length_on_error: '0',
        log_connections: '1',
        log_disconnections: '1',
        'pgaudit.log': 'ddl,role',
        shared_preload_libraries: 'pg_stat_statements,pgaudit',
      },
    });

    // Pre-create the export log groups so retention + KMS are under our control.
    const logRemoval =
      props.removalPolicy === RemovalPolicy.DESTROY ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
    const logGroups = POSTGRES_LOG_EXPORTS.map(
      (type) =>
        new logs.LogGroup(this, `${type}Logs`, {
          logGroupName: `/aws/rds/instance/${this.instanceIdentifier}/${type}`,
          retention: props.logRetention,
          encryptionKey: props.logsKey,
          removalPolicy: logRemoval,
        }),
    );

    this.instance = new rds.DatabaseInstance(this, 'Instance', {
      instanceIdentifier: this.instanceIdentifier,
      engine,
      instanceType: new ec2.InstanceType(props.instanceType),
      vpc: props.vpc,
      vpcSubnets: props.subnets,
      securityGroups: [this.securityGroup],
      publiclyAccessible: false,
      port: POSTGRES_PORT,
      credentials: rds.Credentials.fromGeneratedSecret(props.masterUsername, {
        secretName: `${props.resourcePrefix}/rds/master`,
        encryptionKey: props.encryptionKey,
      }),
      databaseName: props.databaseName,
      multiAz: props.multiAz,
      storageType: rds.StorageType.GP3,
      allocatedStorage: props.allocatedStorageGiB,
      maxAllocatedStorage: props.maxAllocatedStorageGiB,
      storageEncrypted: true,
      storageEncryptionKey: props.encryptionKey,
      parameterGroup,
      caCertificate: rds.CaCertificate.RDS_CA_RSA2048_G1,
      iamAuthentication: true,
      backupRetention: Duration.days(props.backupRetentionDays),
      preferredBackupWindow: '17:00-18:00', // UTC
      preferredMaintenanceWindow: 'sat:18:30-sat:19:30', // UTC
      copyTagsToSnapshot: true,
      deleteAutomatedBackups: props.deleteAutomatedBackups ?? false,
      autoMinorVersionUpgrade: true,
      deletionProtection: props.deletionProtection,
      removalPolicy: props.removalPolicy,
      enablePerformanceInsights: props.performanceInsights,
      ...(props.performanceInsights
        ? { performanceInsightEncryptionKey: props.encryptionKey }
        : {}),
      ...(props.monitoringIntervalSeconds > 0
        ? { monitoringInterval: Duration.seconds(props.monitoringIntervalSeconds) }
        : {}),
      cloudwatchLogsExports: [...POSTGRES_LOG_EXPORTS],
    });
    for (const lg of logGroups) this.instance.node.addDependency(lg);

    if (!this.instance.secret) throw new Error('RDS instance secret was not generated');
    this.secret = this.instance.secret;
    if (!this.instance.instanceResourceId) throw new Error('RDS instance has no DbiResourceId');
    this.instanceResourceId = this.instance.instanceResourceId;

    if (props.rotation.enabled) {
      const rotationSg = new ec2.SecurityGroup(this, 'RotationSecurityGroup', {
        vpc: props.vpc,
        description: `${props.resourcePrefix} Secrets Manager hosted rotation`,
        allowAllOutbound: false,
      });
      rotationSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Secrets Manager API');
      this.allowFrom(rotationSg, 'Secrets Manager rotation');
      this.instance.secret.addRotationSchedule('Rotation', {
        automaticallyAfter: Duration.days(props.rotation.intervalDays),
        hostedRotation: secretsmanager.HostedRotation.postgreSqlSingleUser({
          vpc: props.vpc,
          vpcSubnets: props.rotationSubnets ?? props.subnets,
          securityGroups: [rotationSg],
          functionName: `${props.resourcePrefix}-rds-rotation`,
        }),
      });
    }
    // Without rotation cdk-nag reports AwsSolutions-SMG4 and synth fails: there is deliberately no
    // suppression (the environment schema requires rotation everywhere). The sandbox's
    // fallback (rotation off) is acknowledged by its DataStack only, under a sandbox-only entry.

    if (props.monitoringIntervalSeconds > 0) {
      const monitoringRole = this.instance.node.tryFindChild('MonitoringRole');
      if (monitoringRole) {
        acknowledgeRule(
          monitoringRole,
          'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole]',
          'Enhanced monitoring requires the AWS-maintained AmazonRDSEnhancedMonitoringRole service policy (scoped by AWS to the RDSOSMetrics log group).',
        );
      }
    }
    acknowledgeRule(
      this.instance,
      'AwsSolutions-RDS11',
      'The default PostgreSQL port is kept deliberately; access is restricted by security groups to named clients in isolated subnets, and a non-standard port adds no meaningful protection.',
    );
    if (!props.multiAz) {
      acknowledgeRule(
        this.instance,
        'AwsSolutions-RDS3',
        'Single-AZ is a cost decision for non-production environments only; the config schema enforces Multi-AZ in prod.',
      );
    }
    if (!props.deletionProtection) {
      acknowledgeRule(
        this.instance,
        'AwsSolutions-RDS10',
        'Deletion protection is disabled only in dev (a final snapshot is still taken); the config schema enforces it in staging and prod.',
      );
    }
  }

  /** Allows `peer` to reach PostgreSQL (adds both the ingress and the peer egress rule). */
  public allowFrom(peer: ec2.IConnectable, description: string): void {
    peer.connections.allowTo(this.securityGroup, ec2.Port.tcp(POSTGRES_PORT), description);
  }

  /**
   * `rds-db:connect` for exactly one login role on this instance:
   * `arn:<partition>:rds-db:<region>:<account>:dbuser:<DbiResourceId>/<dbUser>`. The master user
   * is refused: it never authenticates with IAM and never runs in a service.
   */
  public grantConnect(grantee: iam.IGrantable, dbUser: DbLoginRole): iam.Grant {
    if (!(DB_LOGIN_ROLES as readonly string[]).includes(dbUser)) {
      throw new Error(`grantConnect: ${dbUser} is not a login role (${DB_LOGIN_ROLES.join(', ')})`);
    }
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['rds-db:connect'],
      resourceArns: [
        Stack.of(this).formatArn({
          service: 'rds-db',
          resource: 'dbuser',
          resourceName: `${this.instanceResourceId}/${dbUser}`,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
    });
  }

  /**
   * Connection settings for a runtime identity with IAM authentication. `sslRootCertPath`
   * defaults to the API image path; Lambda bundles pass the path of their copy of the bundle.
   */
  public iamConnection(
    user: DbLoginRole,
    options: { poolMax?: number; sslRootCertPath?: string } = {},
  ): DatabaseConnection {
    return {
      host: this.instance.dbInstanceEndpointAddress,
      port: this.port,
      name: this.databaseName,
      user,
      auth: { mode: 'iam' },
      ...(options.poolMax !== undefined ? { poolMax: options.poolMax } : {}),
      ...(options.sslRootCertPath ? { sslRootCertPath: options.sslRootCertPath } : {}),
    };
  }

  /** Master-user connection for the one-off bootstrap task ONLY (secret read at runtime). */
  public bootstrapConnection(): DatabaseConnection {
    return {
      host: this.instance.dbInstanceEndpointAddress,
      port: this.port,
      name: this.databaseName,
      user: this.masterUsername,
      auth: { mode: 'secrets-manager', secret: this.secret },
      secretKey: this.encryptionKey,
      sslRootCertPath: IMAGE_RDS_CA_BUNDLE_PATH,
    };
  }
}
