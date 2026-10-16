import { JobStateTable as Spec } from '@starter/workflow-processing';
import type { RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface JobStateTableProps {
  /** Physical table name. @default - generated */
  readonly tableName?: string;
  /**
   * Customer-managed key. Omit only for ephemeral stacks; named environments
   * always pass the foundation data key.
   */
  readonly encryptionKey?: kms.IKey;
  readonly deletionProtection: boolean;
  readonly removalPolicy: RemovalPolicy;
  /** PITR window (1-35 days). */
  readonly pitrRecoveryPeriodDays: number;
}

/**
 * DynamoDB single-table store for workflow and idempotency state. Key layout,
 * GSI and TTL attribute come from the shared workflow spec.
 */
export class JobStateTable extends Construct {
  public readonly table: dynamodb.Table;
  public readonly statusIndexName: string = Spec.statusIndex.name;
  public readonly encryptionKey?: kms.IKey;

  constructor(scope: Construct, id: string, props: JobStateTableProps) {
    super(scope, id);
    this.encryptionKey = props.encryptionKey;

    this.table = new dynamodb.Table(this, 'Table', {
      tableName: props.tableName,
      partitionKey: { name: Spec.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: Spec.sortKey, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: Spec.ttlAttribute,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
        recoveryPeriodInDays: props.pitrRecoveryPeriodDays,
      },
      ...(props.encryptionKey
        ? {
            encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
            encryptionKey: props.encryptionKey,
          }
        : { encryption: dynamodb.TableEncryption.AWS_MANAGED }),
      deletionProtection: props.deletionProtection,
      removalPolicy: props.removalPolicy,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: Spec.statusIndex.name,
      partitionKey: { name: Spec.statusIndex.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: Spec.statusIndex.sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }

  /** ARN of the status GSI (for least-privilege `Query` grants). */
  public get statusIndexArn(): string {
    return `${this.table.tableArn}/index/${this.statusIndexName}`;
  }
}
