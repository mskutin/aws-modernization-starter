import { Stack } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';

/**
 * Item-level actions the workflow Lambda handlers use on the job table
 * (`@starter/job-state`: Get for reads/idempotency lookups, Put for step audit and
 * idempotency claims, Update for conditional status transitions).
 */
export const HANDLER_TABLE_ACTIONS = [
  'dynamodb:GetItem',
  'dynamodb:PutItem',
  'dynamodb:UpdateItem',
] as const;

/**
 * Item-level actions the API uses on the job table (create PENDING state and
 * idempotency records, attach the execution ARN, read one job, BatchGet for
 * lists merged with PostgreSQL). Add `dynamodb:Query` + the `gsi1` ARN only if
 * the API starts querying the status index.
 */
export const API_TABLE_ACTIONS = [
  'dynamodb:GetItem',
  'dynamodb:BatchGetItem',
  'dynamodb:PutItem',
  'dynamodb:UpdateItem',
] as const;

/**
 * Item-level action the mini-stack's handlers use on its TEST-ONLY document table (ADR 0232;
 * never granted in the environment stages).
 */
export const TEST_DOCUMENT_TABLE_ACTIONS = ['dynamodb:GetItem'] as const;

/**
 * The reconciler (ADR 0231): `Query` on the status index only; consistent `GetItem` and
 * conditional `UpdateItem` on JOB# items only (`dynamodb:LeadingKeys`). No Put/Delete/Scan/Batch.
 */
export const RECONCILER_INDEX_ACTIONS = ['dynamodb:Query'] as const;
export const RECONCILER_ITEM_ACTIONS = ['dynamodb:GetItem', 'dynamodb:UpdateItem'] as const;
export const JOB_ITEM_PARTITION_PATTERN = 'JOB#*';

/** KMS actions needed to read/write items of a CMK-encrypted DynamoDB table. */
export const DYNAMODB_KMS_ACTIONS = [
  'kms:Decrypt',
  'kms:Encrypt',
  'kms:GenerateDataKey',
  'kms:DescribeKey',
] as const;

export interface TableItemGrant {
  readonly table: dynamodb.ITable;
  readonly actions: readonly string[];
  /** Extra resources such as GSI ARNs. */
  readonly indexArns?: readonly string[];
  /** CMK protecting the table; access is limited to use via DynamoDB. */
  readonly key?: kms.IKey;
  /** Statement id (unique per policy) of the item statement. @default JobTableItemAccess */
  readonly sid?: string;
  /**
   * Partition-key patterns the item actions are limited to (`dynamodb:LeadingKeys`), e.g. the
   * workflow handlers only ever touch `JOB#<id>` items.
   */
  readonly leadingKeys?: readonly string[];
}

/** Least-privilege item access: explicit actions, explicit ARNs, kms:ViaService. */
export function grantTableItems(grantee: iam.IGrantable, grant: TableItemGrant): void {
  const sid = grant.sid ?? 'JobTableItemAccess';
  grantee.grantPrincipal.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid,
      actions: [...grant.actions],
      resources: [grant.table.tableArn, ...(grant.indexArns ?? [])],
      ...(grant.leadingKeys
        ? {
            conditions: {
              'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [...grant.leadingKeys] },
            },
          }
        : {}),
    }),
  );
  if (grant.key) {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: grant.sid ? `${grant.sid}KmsViaDynamoDb` : 'JobTableKmsViaDynamoDb',
        actions: [...DYNAMODB_KMS_ACTIONS],
        resources: [grant.key.keyArn],
        conditions: {
          StringEquals: {
            'kms:ViaService': `dynamodb.${Stack.of(grant.table).region}.amazonaws.com`,
          },
        },
      }),
    );
  }
}

export interface ReconcilerTableGrant {
  readonly table: dynamodb.ITable;
  /** ARN of the status index (`gsi1`). */
  readonly statusIndexArn: string;
  readonly key?: kms.IKey;
}

/**
 * The reconciler's table access: Query on the status index; GetItem + UpdateItem on the table
 * restricted to `JOB#*` partition keys (never idempotency records); KMS via DynamoDB only.
 */
export function grantReconcilerTableAccess(
  grantee: iam.IGrantable,
  grant: ReconcilerTableGrant,
): void {
  grantee.grantPrincipal.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'StatusIndexQuery',
      actions: [...RECONCILER_INDEX_ACTIONS],
      resources: [grant.statusIndexArn],
    }),
  );
  grantee.grantPrincipal.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'JobStateItems',
      actions: [...RECONCILER_ITEM_ACTIONS],
      resources: [grant.table.tableArn],
      conditions: {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [JOB_ITEM_PARTITION_PATTERN] },
      },
    }),
  );
  if (grant.key) {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'JobTableKmsViaDynamoDb',
        actions: [...DYNAMODB_KMS_ACTIONS],
        resources: [grant.key.keyArn],
        conditions: {
          StringEquals: {
            'kms:ViaService': `dynamodb.${Stack.of(grant.table).region}.amazonaws.com`,
          },
        },
      }),
    );
  }
}
