import { CfnOutput, Fn } from 'aws-cdk-lib';
import type * as ecs from 'aws-cdk-lib/aws-ecs';
import type { Construct } from 'constructs';
import { DB_ROLES } from '@starter/db/roles';
import {
  BOOTSTRAP_CONTAINER_NAME,
  DatabaseBootstrapTask,
  DatabaseMigrationTask,
  DatabaseRetentionTask,
  MIGRATION_CONTAINER_NAME,
  RETENTION_CONTAINER_NAME,
} from '../constructs/database-migration-task.js';
import type { RelationalDatabase } from '../constructs/relational-database.js';
import { WorkloadStack, type WorkloadStackProps } from './workload-stack.js';
import type { ImageSource } from './platform-stack.js';

export interface MigrationsStackProps extends Omit<WorkloadStackProps, 'suffix' | 'description'> {
  readonly cluster: ecs.ICluster;
  /** API image repository (PlatformStack: created, or imported into this stack). */
  readonly images: ImageSource;
  readonly imageDigest: string;
  readonly database: RelationalDatabase;
  readonly appVersion?: string;
}

/**
 * One-off database tasks on the API image digest (ADR 0220/0221). Deploy order, enforced by the
 * pipeline (runbook):
 *
 *   1. deploy data + this stack
 *   2. `ecs run-task` DatabaseBootstrap (master secret, read at runtime; once per environment and
 *      after role-model changes)  -> exit 0
 *   3. `ecs run-task` DatabaseMigration (starter_migrator, IAM auth)          -> exit 0
 *   4. deploy the API stack (starter_app, IAM auth), then the rest.
 */
export class MigrationsStack extends WorkloadStack {
  public readonly migration: DatabaseMigrationTask;
  /** Break-glass bootstrap: the ONLY task that may read the RDS master secret. */
  public readonly bootstrap: DatabaseBootstrapTask;
  /** Content retention (disabled by default, not scheduled). */
  public readonly retention: DatabaseRetentionTask;

  constructor(scope: Construct, id: string, props: MigrationsStackProps) {
    super(scope, id, {
      ...props,
      suffix: 'migrations',
      description: 'AWS modernization starter: database bootstrap and migration tasks',
    });
    const { config, foundation } = this;
    const common = {
      resourcePrefix: config.resourcePrefix,
      vpc: foundation.vpc,
      repository: props.images.repositoryFor(this),
      imageDigest: props.imageDigest,
      logsKey: foundation.logsKey,
      logRetention: this.logRetention,
      logRemovalPolicy: this.logRemovalPolicy,
      logLevel: config.api.logLevel,
      environmentName: config.name,
      appVersion: props.appVersion,
    };

    const limits = config.database.connectionLimits;
    this.bootstrap = new DatabaseBootstrapTask(this, 'DatabaseBootstrap', {
      ...common,
      database: props.database.bootstrapConnection(),
      connectionLimits: {
        [DB_ROLES.migrator]: limits.migrator,
        // Rolling deployments run up to twice the maximum task count (maxHealthyPercent 200).
        [DB_ROLES.app]: 2 * config.api.maxCapacity * config.database.apiPoolMax,
        [DB_ROLES.processor]: limits.processor,
        [DB_ROLES.retention]: limits.retention,
      },
    });
    this.migration = new DatabaseMigrationTask(this, 'DatabaseMigration', {
      ...common,
      database: props.database.iamConnection(DB_ROLES.migrator),
    });
    props.database.grantConnect(this.migration.taskRole, DB_ROLES.migrator);
    this.retention = new DatabaseRetentionTask(this, 'DatabaseRetention', {
      ...common,
      database: props.database.iamConnection(DB_ROLES.retention),
      policy: config.database.retention,
    });
    props.database.grantConnect(this.retention.taskRole, DB_ROLES.retention);
    // Ingress rules live in this (consumer) stack: no cross-stack cycle.
    props.database.allowFrom(
      this.bootstrap.securityGroup,
      'DB bootstrap (break-glass) to PostgreSQL',
    );
    props.database.allowFrom(this.migration.securityGroup, 'DB migrations to PostgreSQL');
    props.database.allowFrom(this.retention.securityGroup, 'DB retention job to PostgreSQL');

    const subnets = foundation.vpc.selectSubnets(foundation.appSubnets).subnetIds;
    new CfnOutput(this, 'MigrationClusterName', { value: props.cluster.clusterName });
    new CfnOutput(this, 'MigrationSubnetIds', { value: Fn.join(',', subnets) });
    new CfnOutput(this, 'BootstrapTaskDefinitionArn', {
      value: this.bootstrap.taskDefinition.taskDefinitionArn,
    });
    new CfnOutput(this, 'BootstrapContainerName', { value: BOOTSTRAP_CONTAINER_NAME });
    new CfnOutput(this, 'BootstrapSecurityGroupId', {
      value: this.bootstrap.securityGroup.securityGroupId,
    });
    new CfnOutput(this, 'BootstrapLogGroupName', { value: this.bootstrap.logGroup.logGroupName });
    new CfnOutput(this, 'MigrationTaskDefinitionArn', {
      value: this.migration.taskDefinition.taskDefinitionArn,
    });
    new CfnOutput(this, 'MigrationContainerName', { value: MIGRATION_CONTAINER_NAME });
    new CfnOutput(this, 'MigrationSecurityGroupId', {
      value: this.migration.securityGroup.securityGroupId,
    });
    new CfnOutput(this, 'MigrationLogGroupName', { value: this.migration.logGroup.logGroupName });
    new CfnOutput(this, 'RetentionTaskDefinitionArn', {
      value: this.retention.taskDefinition.taskDefinitionArn,
    });
    new CfnOutput(this, 'RetentionContainerName', { value: RETENTION_CONTAINER_NAME });
    new CfnOutput(this, 'RetentionSecurityGroupId', {
      value: this.retention.securityGroup.securityGroupId,
    });
  }
}
