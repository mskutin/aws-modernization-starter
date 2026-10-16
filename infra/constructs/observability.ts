import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as rds from 'aws-cdk-lib/aws-rds';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import type * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';

export interface AlarmThresholds {
  readonly alb5xxPerMinute: number;
  readonly ecsCpuPercent: number;
  readonly ecsMemoryPercent: number;
  readonly lambdaErrorsPer5Min: number;
  readonly rdsCpuPercent: number;
  readonly rdsFreeStorageGiB: number;
}

export interface ObservabilityProps {
  readonly resourcePrefix: string;
  readonly alarmEmails: readonly string[];
  readonly thresholds: AlarmThresholds;
  readonly loadBalancer: elbv2.IApplicationLoadBalancer;
  readonly targetGroup: elbv2.IApplicationTargetGroup;
  readonly service: ecs.BaseService;
  /** Functions to alarm on, keyed by a short name used in alarm names. */
  readonly functions: Readonly<Record<string, lambda.IFunction>>;
  readonly stateMachine: sfn.IStateMachine;
  readonly database: rds.IDatabaseInstance;
  /**
   * `destroy` (sandbox only): the alarm-topic key is scheduled for deletion (7 days) with the
   * stack.
   * @default 'retain'
   */
  readonly teardown?: 'retain' | 'destroy';
}

/**
 * Alarms (ALB, ECS, Lambda, Step Functions, RDS), a dashboard and an
 * encrypted SNS alarm topic. The topic key is dedicated because CloudWatch
 * and AWS Budgets need key-policy grants that cannot be added to imported
 * foundation keys.
 */
export class Observability extends Construct {
  public readonly topic: sns.Topic;
  public readonly topicKey: kms.Key;
  public readonly alarms: cloudwatch.Alarm[] = [];
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);
    const { thresholds: t, resourcePrefix } = props;

    this.topicKey = new kms.Key(this, 'AlarmTopicKey', {
      alias: `alias/${resourcePrefix}/alarms`,
      description: `${resourcePrefix} SNS alarm topic`,
      enableKeyRotation: true,
      ...(props.teardown === 'destroy'
        ? { removalPolicy: RemovalPolicy.DESTROY, pendingWindow: Duration.days(7) }
        : { removalPolicy: RemovalPolicy.RETAIN }),
    });
    for (const service of ['cloudwatch.amazonaws.com', 'budgets.amazonaws.com']) {
      this.topicKey.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: `Allow${service.split('.')[0]}Publish`,
          principals: [new iam.ServicePrincipal(service)],
          actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
          resources: ['*'],
        }),
      );
    }
    this.topic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${resourcePrefix}-alarms`,
      displayName: `${resourcePrefix} alarms`,
      masterKey: this.topicKey,
      enforceSSL: true,
    });
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowBudgetsPublish',
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.topic.topicArn],
      }),
    );
    for (const email of props.alarmEmails) {
      this.topic.addSubscription(new subs.EmailSubscription(email));
    }

    const action = new cwActions.SnsAction(this.topic);
    const alarm = (
      id: string,
      metric: cloudwatch.IMetric,
      threshold: number,
      description: string,
      opts: Partial<cloudwatch.CreateAlarmOptions> = {},
    ) => {
      const a = new cloudwatch.Alarm(this, id, {
        alarmName: `${resourcePrefix}-${id}`,
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        ...opts,
      });
      a.addAlarmAction(action);
      a.addOkAction(action);
      this.alarms.push(a);
      return a;
    };

    const minute = Duration.minutes(1);
    const fiveMin = Duration.minutes(5);

    // ALB / API
    const alb5xx = props.loadBalancer.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
      period: minute,
      statistic: 'Sum',
    });
    const target5xx = props.targetGroup.metrics.httpCodeTarget(
      elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
      { period: minute, statistic: 'Sum' },
    );
    const unhealthy = props.targetGroup.metrics.unhealthyHostCount({
      period: minute,
      statistic: 'Maximum',
    });
    alarm('alb-5xx', alb5xx, t.alb5xxPerMinute, 'ALB-generated 5xx responses');
    alarm('target-5xx', target5xx, t.alb5xxPerMinute, 'API (target) 5xx responses');
    alarm('target-unhealthy', unhealthy, 1, 'At least one API task failing /health/ready', {
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
    });

    // ECS
    const ecsCpu = props.service.metricCpuUtilization({ period: fiveMin });
    const ecsMem = props.service.metricMemoryUtilization({ period: fiveMin });
    alarm('ecs-cpu', ecsCpu, t.ecsCpuPercent, 'API service CPU utilisation high');
    alarm('ecs-memory', ecsMem, t.ecsMemoryPercent, 'API service memory utilisation high');

    // Lambda
    const functions = Object.entries(props.functions);
    functions.forEach(([name, fn]) => {
      alarm(
        `${name}-errors`,
        fn.metricErrors({ period: fiveMin, statistic: 'Sum' }),
        t.lambdaErrorsPer5Min,
        `${name} Lambda errors`,
      );
      alarm(
        `${name}-throttles`,
        fn.metricThrottles({ period: fiveMin, statistic: 'Sum' }),
        1,
        `${name} Lambda throttles`,
      );
    });

    // Step Functions
    alarm(
      'sfn-failed',
      props.stateMachine.metricFailed({ period: fiveMin, statistic: 'Sum' }),
      1,
      'Processing workflow executions failed',
      { datapointsToAlarm: 1, evaluationPeriods: 1 },
    );
    alarm(
      'sfn-timed-out',
      props.stateMachine.metricTimedOut({ period: fiveMin, statistic: 'Sum' }),
      1,
      'Processing workflow executions timed out',
      { datapointsToAlarm: 1, evaluationPeriods: 1 },
    );

    // RDS
    alarm(
      'rds-cpu',
      props.database.metricCPUUtilization({ period: fiveMin }),
      t.rdsCpuPercent,
      'PostgreSQL CPU utilisation high',
    );
    alarm(
      'rds-free-storage',
      props.database.metricFreeStorageSpace({ period: fiveMin, statistic: 'Minimum' }),
      t.rdsFreeStorageGiB * 1024 ** 3,
      'PostgreSQL free storage low',
      {
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      },
    );

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${resourcePrefix}-overview`,
      defaultInterval: Duration.hours(3),
    });
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'API 5xx', left: [alb5xx, target5xx], width: 8 }),
      new cloudwatch.GraphWidget({
        title: 'API latency (p90) / requests',
        left: [props.targetGroup.metrics.targetResponseTime({ statistic: 'p90' })],
        right: [props.targetGroup.metrics.requestCount()],
        width: 8,
      }),
      new cloudwatch.GraphWidget({ title: 'ECS CPU / memory', left: [ecsCpu, ecsMem], width: 8 }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda errors / throttles',
        left: functions.map(([, fn]) => fn.metricErrors()),
        right: functions.map(([, fn]) => fn.metricThrottles()),
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Workflow executions',
        left: [
          props.stateMachine.metricSucceeded(),
          props.stateMachine.metricFailed(),
          props.stateMachine.metricTimedOut(),
        ],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'RDS CPU / free storage',
        left: [props.database.metricCPUUtilization()],
        right: [props.database.metricFreeStorageSpace()],
        width: 8,
      }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({ title: 'Alarms', alarms: this.alarms, width: 24 }),
    );
  }
}
