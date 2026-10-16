import { RECONCILER_METRICS } from '@starter/workflow-processing';
import { RemovalPolicy } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { describe, expect, it } from 'vitest';
import {
  JobReconciler,
  RECONCILER_RESERVED_CONCURRENCY,
  ReconcilerAlarms,
} from '../constructs/job-reconciler.js';
import { JobStateTable } from '../constructs/job-state-table.js';
import { LIVE_ALIAS, ProcessingWorkflow } from '../constructs/processing-workflow.js';
import {
  FIXTURE_ENTRIES,
  importedFoundation,
  nagViolations,
  resourcesOf,
  testStack,
} from './helpers.js';

const SETTINGS = { staleAfterSeconds: 900, batchSize: 25, dryRun: false, maxRuntimeSeconds: 45 };

function build(
  opts: { schedule?: boolean; reserve?: boolean; network?: boolean; alarms?: boolean } = {},
) {
  const stack = testStack();
  const f = importedFoundation(stack);
  const table = new JobStateTable(stack, 'Jobs', {
    encryptionKey: f.dataKey,
    deletionProtection: true,
    removalPolicy: RemovalPolicy.RETAIN,
    pitrRecoveryPeriodDays: 35,
  });
  const docs = new dynamodb.Table(stack, 'Docs', {
    partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
  });
  // Same construct id as the stacks: the register entry SUP-0301 names its logical id.
  const workflow = new ProcessingWorkflow(stack, 'ProcessingWorkflow', {
    resourcePrefix: 'starter-test',
    entries: FIXTURE_ENTRIES,
    table: table.table,
    tableKey: f.dataKey,
    logsKey: f.logsKey,
    logRetention: logs.RetentionDays.ONE_MONTH,
    logRemovalPolicy: RemovalPolicy.RETAIN,
    versionRemovalPolicy: RemovalPolicy.RETAIN,
    logLevel: 'info',
    environmentName: 'test',
    memoryMiB: 512,
    logExecutionData: false,
    documents: { kind: 'test-table', table: docs },
  });
  const reconciler = new JobReconciler(stack, 'Reconciler', {
    resourcePrefix: 'starter-test',
    entry: FIXTURE_ENTRIES.reconciler,
    table: table.table,
    tableKey: f.dataKey,
    statusIndexArn: table.statusIndexArn,
    stateMachine: workflow.stateMachine,
    logsKey: f.logsKey,
    logRetention: logs.RetentionDays.ONE_MONTH,
    logRemovalPolicy: RemovalPolicy.RETAIN,
    versionRemovalPolicy: RemovalPolicy.RETAIN,
    logLevel: 'info',
    environmentName: 'test',
    appVersion: 'abc1234',
    settings: SETTINGS,
    ...(opts.schedule === false ? {} : { scheduleMinutes: 5 }),
    ...(opts.reserve === false ? { reserveConcurrency: false } : {}),
    ...(opts.network === false ? {} : { network: { vpc: f.vpc, subnets: f.appSubnets } }),
  });
  if (opts.alarms) {
    new ReconcilerAlarms(stack, 'Alarms', {
      resourcePrefix: 'starter-test',
      environmentName: 'test',
      reconciler,
      topic: new sns.Topic(stack, 'Topic'),
      scheduleMinutes: 5,
    });
  }
  return { stack, f, table, workflow, reconciler, template: Template.fromStack(stack) };
}

type Statement = {
  Sid?: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, unknown>;
};

function roleStatements(template: Template, roleLogicalIdPrefix: string): Statement[] {
  return resourcesOf(template, 'AWS::IAM::Policy')
    .filter(([, p]) => JSON.stringify(p.Roles).includes(roleLogicalIdPrefix))
    .flatMap(([, p]) => (p.PolicyDocument as { Statement: Statement[] }).Statement);
}

describe('JobReconciler', () => {
  const { template, stack } = build();
  const fn = resourcesOf(template, 'AWS::Lambda::Function').find(([id]) =>
    id.startsWith('ReconcilerFunction'),
  )![1];
  const statements = roleStatements(template, 'ReconcilerRole');

  it('is one Node.js 24 arm64 function with reserved concurrency 1 and active tracing', () => {
    expect(RECONCILER_RESERVED_CONCURRENCY).toBe(1);
    expect(fn).toMatchObject({
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      ReservedConcurrentExecutions: 1,
      TracingConfig: { Mode: 'Active' },
      Timeout: SETTINGS.maxRuntimeSeconds + 15,
    });
  });

  it('gets its settings explicitly, and no database or document access', () => {
    const vars = (fn.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(vars).toMatchObject({
      JOBS_TABLE_NAME: expect.anything(),
      STATE_MACHINE_ARN: expect.anything(),
      RECONCILER_STALE_AFTER_SECONDS: '900',
      RECONCILER_BATCH_SIZE: '25',
      RECONCILER_DRY_RUN: 'false',
      RECONCILER_MAX_RUNTIME_SECONDS: '45',
      APP_ENVIRONMENT: 'test',
    });
    expect(Object.keys(vars).filter((k) => k.startsWith('DB_') || k === 'APP_RUNTIME')).toEqual([]);
    expect(JSON.stringify(statements)).not.toContain('rds-db:connect');
  });

  it('runs every 5 minutes through the live alias, with no asynchronous retries', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(5 minutes)',
      State: 'ENABLED',
      Targets: [
        Match.objectLike({
          Arn: Match.objectLike({ Ref: Match.stringLikeRegexp('^ReconcilerLiveAlias') }),
          RetryPolicy: { MaximumRetryAttempts: 0 },
        }),
      ],
    });
    template.hasResourceProperties('AWS::Lambda::Alias', { Name: LIVE_ALIAS });
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 0,
      FunctionName: { Ref: Match.stringLikeRegexp('^ReconcilerFunction') },
    });
  });

  it('has exactly the least-privilege statements: index Query, JOB# Get/Update, KMS via DynamoDB, DescribeExecution', () => {
    const bySid = Object.fromEntries(statements.map((s) => [s.Sid ?? '(none)', s]));
    expect(Object.keys(bySid).sort()).toEqual(
      [
        'DescribeOwnExecutions',
        'JobStateItems',
        'JobTableKmsViaDynamoDb',
        'StatusIndexQuery',
        'VpcNetworkInterfaces',
        'WriteOwnLogGroup',
        '(none)', // X-Ray (added by Lambda tracing)
      ].sort(),
    );
    expect(bySid.StatusIndexQuery).toMatchObject({ Action: 'dynamodb:Query' });
    expect(JSON.stringify(stack.resolve(bySid.StatusIndexQuery!.Resource))).toContain(
      '/index/gsi1',
    );
    expect(bySid.JobStateItems).toMatchObject({
      Action: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
      Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['JOB#*'] } },
    });
    expect(bySid.JobTableKmsViaDynamoDb).toMatchObject({
      Condition: { StringEquals: { 'kms:ViaService': 'dynamodb.ap-southeast-1.amazonaws.com' } },
    });
    expect(bySid.DescribeOwnExecutions).toMatchObject({ Action: 'states:DescribeExecution' });
    expect(JSON.stringify(bySid.DescribeOwnExecutions!.Resource)).toMatch(
      /:execution:.*ProcessingWorkflowStateMachine.*:\*/,
    );
    const actions = statements.flatMap((s) => [s.Action].flat());
    for (const forbidden of [
      'states:StartExecution',
      'kms:Decrypt',
      'dynamodb:PutItem',
      'dynamodb:DeleteItem',
      'dynamodb:Scan',
      'dynamodb:BatchWriteItem',
    ]) {
      if (forbidden === 'kms:Decrypt') {
        // Only through DynamoDB (kms:ViaService), never for the state machine key directly.
        const direct = statements.filter(
          (s) =>
            [s.Action].flat().includes(forbidden) &&
            !JSON.stringify(s.Condition ?? {}).includes('ViaService'),
        );
        expect(direct).toEqual([]);
      } else {
        expect(actions).not.toContain(forbidden);
      }
    }
  });

  it('passes cdk-nag (governed suppressions SUP-0300/0301)', () => {
    const { reconciler } = build();
    expect(nagViolations(reconciler)).toEqual([]);
  });

  it('can be deployed without a schedule or a reservation (integration mini-stack)', () => {
    const bare = build({ schedule: false, reserve: false, network: false }).template;
    bare.resourceCountIs('AWS::Events::Rule', 0);
    const [, f] = resourcesOf(bare, 'AWS::Lambda::Function').find(([id]) =>
      id.startsWith('ReconcilerFunction'),
    )!;
    expect(f.ReservedConcurrentExecutions).toBeUndefined();
  });
});

describe('ReconcilerAlarms', () => {
  it('alarms on errors, dependency outages, anomalies and a missing heartbeat', () => {
    const { template } = build({ alarms: true });
    const alarms = resourcesOf(template, 'AWS::CloudWatch::Alarm').map(([, a]) => a);
    expect(alarms.map((a) => a.AlarmName).sort()).toEqual([
      'starter-test-reconciler-anomalies',
      'starter-test-reconciler-dependency-errors',
      'starter-test-reconciler-errors',
      'starter-test-reconciler-not-running',
    ]);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'starter-test-reconciler-dependency-errors',
      Namespace: RECONCILER_METRICS.namespace,
      MetricName: 'DependencyErrors',
      Dimensions: [{ Name: 'Environment', Value: 'test' }],
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'starter-test-reconciler-not-running',
      MetricName: 'Invocations',
      ComparisonOperator: 'LessThanThreshold',
      TreatMissingData: 'breaching',
    });
    for (const a of alarms) expect(a.AlarmActions).toHaveLength(1);
  });
});
