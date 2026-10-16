import { JobStateTable as Spec } from '@starter/workflow-processing';
import { RemovalPolicy } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { JobStateTable } from '../constructs/job-state-table.js';
import { importedFoundation, nagViolations, testStack } from './helpers.js';

describe('JobStateTable', () => {
  const build = (protect: boolean) => {
    const stack = testStack();
    const foundation = importedFoundation(stack);
    const table = new JobStateTable(stack, 'Jobs', {
      tableName: 'jobs',
      encryptionKey: foundation.dataKey,
      deletionProtection: protect,
      removalPolicy: protect ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      pitrRecoveryPeriodDays: 35,
    });
    return { stack, table, template: Template.fromStack(stack), foundation };
  };

  it('uses the spec key layout, GSI and TTL attribute', () => {
    const { template } = build(true);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: Spec.partitionKey, KeyType: 'HASH' },
        { AttributeName: Spec.sortKey, KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: Spec.statusIndex.name,
          KeySchema: [
            { AttributeName: Spec.statusIndex.partitionKey, KeyType: 'HASH' },
            { AttributeName: Spec.statusIndex.sortKey, KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      TimeToLiveSpecification: { AttributeName: Spec.ttlAttribute, Enabled: true },
    });
  });

  it('is on-demand, PITR-enabled and encrypted with the customer-managed key', () => {
    const { template, foundation } = build(true);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
        RecoveryPeriodInDays: 35,
      },
      SSESpecification: {
        SSEEnabled: true,
        SSEType: 'KMS',
        KMSMasterKeyId: foundation.dataKey.keyArn,
      },
    });
  });

  it('protected tables have deletion protection and RETAIN', () => {
    build(true).template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: Match.objectLike({ DeletionProtectionEnabled: true }),
    });
    build(false).template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ DeletionProtectionEnabled: false }),
    });
  });

  it('exposes the status index ARN and passes cdk-nag', () => {
    const { stack, table } = build(true);
    expect(stack.resolve(table.statusIndexArn)).toEqual({
      'Fn::Join': [
        '',
        [{ 'Fn::GetAtt': [expect.any(String), 'Arn'] }, `/index/${Spec.statusIndex.name}`],
      ],
    });
    expect(nagViolations(stack)).toEqual([]);
  });
});
