import { CfnOutput } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { JobStateTable } from '../constructs/job-state-table.js';
import { RelationalDatabase } from '../constructs/relational-database.js';
import { acknowledgeRule } from '../lib/policy-hook.js';
import { toNonSnapshotRemovalPolicy, toRemovalPolicy } from '../lib/removal.js';
import { WorkloadStack, type WorkloadStackProps } from './workload-stack.js';

export type DataStackProps = Omit<WorkloadStackProps, 'suffix' | 'description'>;

/** Stateful tier: RDS PostgreSQL (system of record) and the DynamoDB job-state table. */
export class DataStack extends WorkloadStack {
  public readonly jobTable: JobStateTable;
  public readonly database: RelationalDatabase;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, {
      ...props,
      suffix: 'data',
      description: 'AWS modernization starter: data tier',
    });
    const { config, foundation } = this;

    this.jobTable = new JobStateTable(this, 'JobStateTable', {
      tableName: `${config.resourcePrefix}-job-state`,
      encryptionKey: foundation.dataKey,
      deletionProtection: config.jobTable.deletionProtection,
      removalPolicy: toNonSnapshotRemovalPolicy(config.jobTable.removalPolicy),
      pitrRecoveryPeriodDays: config.jobTable.pitrRecoveryPeriodDays,
    });

    const db = config.database;
    this.database = new RelationalDatabase(this, 'Database', {
      resourcePrefix: config.resourcePrefix,
      vpc: foundation.vpc,
      subnets: foundation.dataSubnets,
      rotationSubnets: foundation.appSubnets,
      encryptionKey: foundation.dataKey,
      logsKey: foundation.logsKey,
      logRetention: this.logRetention,
      engineVersion: db.engineVersion,
      instanceType: db.instanceType,
      multiAz: db.multiAz,
      allocatedStorageGiB: db.allocatedStorageGiB,
      maxAllocatedStorageGiB: db.maxAllocatedStorageGiB,
      backupRetentionDays: db.backupRetentionDays,
      deletionProtection: db.deletionProtection,
      removalPolicy: toRemovalPolicy(db.removalPolicy),
      deleteAutomatedBackups: db.deleteAutomatedBackups,
      performanceInsights: db.performanceInsights,
      monitoringIntervalSeconds: db.monitoringIntervalSeconds,
      databaseName: db.databaseName,
      masterUsername: db.masterUsername,
      rotation: db.rotation,
    });

    if (!db.rotation.enabled) {
      // Only the sandbox can get here (the schema requires rotation in every governed
      // environment); the register entry is sandbox-only, so anything else fails closed.
      acknowledgeRule(
        // The generated DatabaseSecret (`database.secret` is its target attachment).
        this.database.instance.node.findChild('Secret'),
        'AwsSolutions-SMG4',
        'SANDBOX (live validation, not a governed environment): rotation switched off because the hosted-rotation transform could not deploy in the sandbox account.',
      );
    }

    new CfnOutput(this, 'JobsTableName', { value: this.jobTable.table.tableName });
    new CfnOutput(this, 'DatabaseEndpoint', {
      value: this.database.instance.dbInstanceEndpointAddress,
    });
    new CfnOutput(this, 'DatabaseSecretArn', { value: this.database.secret.secretArn });
  }
}
