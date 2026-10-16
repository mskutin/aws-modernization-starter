import { RECONCILER_METRICS } from '@starter/workflow-processing';
import { Aws, Duration, Stack, type CfnElement, type RemovalPolicy } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as sns from 'aws-cdk-lib/aws-sns';
import type * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import { grantReconcilerTableAccess } from '../lib/grants.js';
import { DEPS_LOCK_FILE, REPO_ROOT } from '../lib/paths.js';
import { acknowledgeRule } from '../lib/policy-hook.js';
import { LIVE_ALIAS } from './processing-workflow.js';

/** Exactly one reconciler runs at a time; overlapping runs would only cause conflicts. */
export const RECONCILER_RESERVED_CONCURRENCY = 1;
/** Headroom between the run budget and the Lambda timeout (summary, metrics, flush). */
const TIMEOUT_HEADROOM_SECONDS = 15;

export interface ReconcilerSettingsProps {
  readonly staleAfterSeconds: number;
  readonly batchSize: number;
  readonly dryRun: boolean;
  readonly maxRuntimeSeconds: number;
}

export interface JobReconcilerProps {
  readonly resourcePrefix: string;
  readonly entry: string;
  readonly table: dynamodb.ITable;
  readonly tableKey?: kms.IKey;
  /** ARN of the job table's status index (`gsi1`). */
  readonly statusIndexArn: string;
  /** The processing state machine whose executions are described. */
  readonly stateMachine: sfn.StateMachine;
  readonly logsKey: kms.IKey;
  readonly logRetention: logs.RetentionDays;
  readonly logRemovalPolicy: RemovalPolicy;
  readonly versionRemovalPolicy: RemovalPolicy;
  readonly logLevel: string;
  readonly environmentName: string;
  readonly appVersion?: string;
  readonly settings: ReconcilerSettingsProps;
  /**
   * EventBridge schedule (minutes between runs). Omit to deploy without a schedule (the AWS
   * integration mini-stack invokes the function directly).
   */
  readonly scheduleMinutes?: number;
  /**
   * Reserve exactly one concurrent execution (default). The mini-stack (sandbox account,
   * possibly a low concurrency quota) may opt out.
   * @default true
   */
  readonly reserveConcurrency?: boolean;
  /** Place the function's ENIs in these subnets (landing-zone egress controls). */
  readonly network?: { readonly vpc: ec2.IVpc; readonly subnets: ec2.SubnetSelection };
}

/**
 * The ONE stale-job reconciler of an environment (ADR 0231): a scheduled
 * Lambda (reserved concurrency 1) with read access to the status index, conditional writes to
 * JOB# items and `states:DescribeExecution` on this state machine's executions — no
 * StartExecution, no KMS access to the state machine key (DescribeExecution METADATA_ONLY), no
 * database access.
 */
export class JobReconciler extends Construct {
  public readonly fn: NodejsFunction;
  public readonly alias: lambda.Alias;
  public readonly role: iam.Role;
  public readonly logGroup: logs.LogGroup;
  public readonly schedule?: events.Rule;
  public readonly securityGroup?: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: JobReconcilerProps) {
    super(scope, id);

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/starter/${props.resourcePrefix}/lambda/reconciler`,
      retention: props.logRetention,
      encryptionKey: props.logsKey,
      removalPolicy: props.logRemovalPolicy,
    });

    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `${props.resourcePrefix} stale-job reconciler Lambda execution role`,
    });
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteOwnLogGroup',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [this.logGroup.logGroupArn],
      }),
    );
    grantReconcilerTableAccess(this.role, {
      table: props.table,
      statusIndexArn: props.statusIndexArn,
      key: props.tableKey,
    });
    // Executions of THIS state machine only. Built from pseudo-parameters and the machine's Name
    // attribute so the cdk-nag finding (and its register entry) is identical in every stage and
    // every mini-stack run.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DescribeOwnExecutions',
        actions: ['states:DescribeExecution'],
        resources: [
          `arn:${Aws.PARTITION}:states:${Aws.REGION}:${Aws.ACCOUNT_ID}:execution:${props.stateMachine.stateMachineName}:*`,
        ],
      }),
    );
    if (props.network) {
      this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
        vpc: props.network.vpc,
        description: `${props.resourcePrefix} reconciler Lambda (egress HTTPS to AWS APIs only)`,
        allowAllOutbound: false,
      });
      this.securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS to AWS APIs');
      this.role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'VpcNetworkInterfaces',
          actions: [
            'ec2:CreateNetworkInterface',
            'ec2:DescribeNetworkInterfaces',
            'ec2:DescribeSubnets',
            'ec2:DeleteNetworkInterface',
            'ec2:AssignPrivateIpAddresses',
            'ec2:UnassignPrivateIpAddresses',
          ],
          resources: ['*'],
        }),
      );
    }

    const s = props.settings;
    this.fn = new NodejsFunction(this, 'Function', {
      entry: props.entry,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(s.maxRuntimeSeconds + TIMEOUT_HEADROOM_SECONDS),
      ...((props.reserveConcurrency ?? true)
        ? { reservedConcurrentExecutions: RECONCILER_RESERVED_CONCURRENCY }
        : {}),
      description: `${props.resourcePrefix} stale-job reconciler (one per environment)`,
      role: this.role,
      logGroup: this.logGroup,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        JOBS_TABLE_NAME: props.table.tableName,
        STATE_MACHINE_ARN: props.stateMachine.stateMachineArn,
        LOG_LEVEL: props.logLevel,
        APP_ENVIRONMENT: props.environmentName,
        ...(props.appVersion ? { APP_VERSION: props.appVersion } : {}),
        RECONCILER_STALE_AFTER_SECONDS: String(s.staleAfterSeconds),
        RECONCILER_BATCH_SIZE: String(s.batchSize),
        RECONCILER_DRY_RUN: String(s.dryRun),
        RECONCILER_MAX_RUNTIME_SECONDS: String(s.maxRuntimeSeconds),
        NODE_OPTIONS: '--enable-source-maps',
      },
      ...(props.network && this.securityGroup
        ? {
            vpc: props.network.vpc,
            vpcSubnets: props.network.subnets,
            securityGroups: [this.securityGroup],
          }
        : {}),
      projectRoot: REPO_ROOT,
      depsLockFilePath: DEPS_LOCK_FILE,
      bundling: {
        forceDockerBundling: false,
        format: OutputFormat.ESM,
        target: 'node24',
        mainFields: ['module', 'main'],
        minify: true,
        sourceMap: true,
        sourcesContent: false,
        externalModules: [],
        banner:
          "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      },
      currentVersionOptions: { removalPolicy: props.versionRemovalPolicy },
    });
    this.alias = new lambda.Alias(this, 'LiveAlias', {
      aliasName: LIVE_ALIAS,
      version: this.fn.currentVersion,
      description: 'Points at the version published by the latest deploy',
      // The next scheduled run is the retry: no asynchronous retries of a failed run.
      retryAttempts: 0,
      maxEventAge: Duration.minutes(10),
    });

    if (props.scheduleMinutes !== undefined) {
      this.schedule = new events.Rule(this, 'Schedule', {
        ruleName: `${props.resourcePrefix}-reconciler`,
        description: `${props.resourcePrefix} stale-job reconciler (every ${props.scheduleMinutes} min)`,
        schedule: events.Schedule.rate(Duration.minutes(props.scheduleMinutes)),
        targets: [new targets.LambdaFunction(this.alias, { retryAttempts: 0 })],
      });
    }

    acknowledgeRule(
      this.role,
      'AwsSolutions-IAM5[Resource::*]',
      props.network
        ? 'X-Ray PutTraceSegments/PutTelemetryRecords and Lambda VPC ENI management do not support resource-level permissions.'
        : 'X-Ray PutTraceSegments/PutTelemetryRecords do not support resource-level permissions.',
    );
    acknowledgeRule(
      this.role,
      describeExecutionsFinding(props.stateMachine),
      'DescribeExecution is authorised per execution ARN; execution names are per job, so the resource is every execution of this one state machine.',
    );
  }
}

/** The cdk-nag IAM5 finding id of the `DescribeOwnExecutions` statement (register SUP-0301). */
export function describeExecutionsFinding(stateMachine: sfn.StateMachine): string {
  const cfn = stateMachine.node.defaultChild as CfnElement;
  const logicalId = Stack.of(cfn).resolve(Stack.of(cfn).getLogicalId(cfn)) as string;
  return `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:states:<AWS::Region>:<AWS::AccountId>:execution:<${logicalId}.Name>:*]`;
}

/** The reconciler's metric (Embedded Metric Format) for one environment. */
export function reconcilerMetric(
  name: (typeof RECONCILER_METRICS.names)[keyof typeof RECONCILER_METRICS.names],
  environmentName: string,
  period: Duration = Duration.minutes(15),
): cloudwatch.Metric {
  return new cloudwatch.Metric({
    namespace: RECONCILER_METRICS.namespace,
    metricName: name,
    dimensionsMap: { [RECONCILER_METRICS.dimension]: environmentName },
    statistic: 'Sum',
    period,
  });
}

export interface ReconcilerAlarmsProps {
  readonly resourcePrefix: string;
  readonly environmentName: string;
  readonly reconciler: JobReconciler;
  readonly topic: sns.ITopic;
  readonly scheduleMinutes: number;
}

/**
 * Alarms on the reconciler, created in the scope of the observability stack (where the alarm
 * topic lives): the function failing, a dependency outage on consecutive runs, anomalies to
 * investigate, and the reconciler not running at all.
 */
export class ReconcilerAlarms extends Construct {
  public readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: ReconcilerAlarmsProps) {
    super(scope, id);
    const action = new cwActions.SnsAction(props.topic);
    const window = Duration.minutes(props.scheduleMinutes * 3);
    const add = (
      name: string,
      metric: cloudwatch.IMetric,
      description: string,
      options: Partial<cloudwatch.AlarmProps> = {},
    ) => {
      const alarm = new cloudwatch.Alarm(this, name, {
        alarmName: `${props.resourcePrefix}-${name}`,
        alarmDescription: description,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        ...options,
      });
      alarm.addAlarmAction(action);
      alarm.addOkAction(action);
      this.alarms.push(alarm);
    };
    add(
      'reconciler-errors',
      props.reconciler.fn.metricErrors({ period: window, statistic: 'Sum' }),
      'Stale-job reconciler Lambda failed (configuration or code error)',
    );
    add(
      'reconciler-dependency-errors',
      reconcilerMetric(RECONCILER_METRICS.names.dependencyErrors, props.environmentName, window),
      'Stale-job reconciler could not reach DynamoDB or Step Functions (no job was changed)',
      { threshold: 2 },
    );
    add(
      'reconciler-anomalies',
      reconcilerMetric(RECONCILER_METRICS.names.anomalies, props.environmentName, window),
      'Stale-job reconciler found inconsistent job/execution states (investigate)',
    );
    add(
      'reconciler-not-running',
      props.reconciler.fn.metricInvocations({ period: window, statistic: 'Sum' }),
      'Stale-job reconciler has not run within three schedule periods',
      {
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      },
    );
  }
}
