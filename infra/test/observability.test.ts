import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { COST_ALLOCATION_TAG_KEYS, CostGuardrails } from '../constructs/cost-guardrails.js';
import { nagViolations, resourcesOf, synthStage, testStack } from './helpers.js';

describe('Observability (prod stage)', () => {
  const { templates, config, stage } = synthStage('prod');
  const t = templates.Observability;

  it('alarms cover ALB, ECS, Lambda, Step Functions and RDS', () => {
    const metrics = resourcesOf(t, 'AWS::CloudWatch::Alarm').map(
      ([, p]) => `${String(p.Namespace)}:${String(p.MetricName)}`,
    );
    expect(metrics).toEqual(
      expect.arrayContaining([
        'AWS/ApplicationELB:HTTPCode_ELB_5XX_Count',
        'AWS/ApplicationELB:HTTPCode_Target_5XX_Count',
        'AWS/ApplicationELB:UnHealthyHostCount',
        'AWS/ECS:CPUUtilization',
        'AWS/ECS:MemoryUtilization',
        'AWS/Lambda:Errors',
        'AWS/Lambda:Throttles',
        'AWS/States:ExecutionsFailed',
        'AWS/States:ExecutionsTimedOut',
        'AWS/RDS:CPUUtilization',
        'AWS/RDS:FreeStorageSpace',
      ]),
    );
    // 2 Lambda functions x (errors + throttles) + 4 reconciler alarms (ReconcilerAlarms, placed
    // in this stack by the stage next to the alarm topic).
    expect(metrics).toHaveLength(17);
    expect(metrics).toEqual(
      expect.arrayContaining([
        'Workload/Reconciler:DependencyErrors',
        'Workload/Reconciler:Anomalies',
        'AWS/Lambda:Invocations',
      ]),
    );
  });

  it('thresholds come from the environment config', () => {
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'HTTPCode_ELB_5XX_Count',
      Threshold: config.observability.thresholds.alb5xxPerMinute,
    });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'FreeStorageSpace',
      ComparisonOperator: 'LessThanOrEqualToThreshold',
      Threshold: config.observability.thresholds.rdsFreeStorageGiB * 1024 ** 3,
    });
  });

  it('every alarm notifies the encrypted, SSL-only alarm topic', () => {
    for (const [, alarm] of resourcesOf(t, 'AWS::CloudWatch::Alarm')) {
      expect(alarm.AlarmActions).toEqual([{ Ref: expect.stringMatching(/AlarmTopic/) }]);
      expect(alarm.OKActions).toHaveLength(1);
    }
    t.hasResourceProperties('AWS::SNS::Topic', {
      KmsMasterKeyId: Match.anyValue(),
      TopicName: `${config.resourcePrefix}-alarms`,
    });
    t.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: 'cloudwatch.amazonaws.com' } }),
          Match.objectLike({ Principal: { Service: 'budgets.amazonaws.com' } }),
        ]),
      },
    });
  });

  it('dashboard exists', () => {
    t.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: `${config.resourcePrefix}-overview`,
    });
  });

  it('monthly budget with ACTUAL + FORECASTED notifications from config', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: config.budget.monthlyLimitUsd, Unit: 'USD' },
        FilterExpression: {
          And: [
            { Tags: { Key: 'Project', Values: [config.tags.Project], MatchOptions: ['EQUALS'] } },
            { Tags: { Key: 'Environment', Values: ['prod'], MatchOptions: ['EQUALS'] } },
          ],
        },
      }),
    });
    const [, budget] = resourcesOf(t, 'AWS::Budgets::Budget')[0]!;
    const notifications = (
      budget.NotificationsWithSubscribers as {
        Notification: { NotificationType: string; Threshold: number };
      }[]
    ).map((n) => `${n.Notification.NotificationType}:${n.Notification.Threshold}`);
    expect(notifications).toEqual([
      ...config.budget.actualThresholdsPercent.map((p) => `ACTUAL:${p}`),
      `FORECASTED:${config.budget.forecastThresholdPercent}`,
    ]);
  });

  it('passes cdk-nag', () => {
    expect(nagViolations(stage.observability)).toEqual([]);
  });
});

describe('CostGuardrails', () => {
  it('requires at least one subscriber', () => {
    expect(
      () =>
        new CostGuardrails(testStack(), 'Cost', {
          resourcePrefix: 'x',
          monthlyLimitUsd: 10,
          actualThresholdsPercent: [100],
          forecastThresholdPercent: 100,
          notificationEmails: [],
          tagFilter: { Project: 'p', Environment: 'dev' },
        }),
    ).toThrow(/at least one subscriber/);
  });

  it('documents the tags that must be activated for cost allocation', () => {
    expect(COST_ALLOCATION_TAG_KEYS).toEqual(['Project', 'Environment', 'CostCentre']);
    const stack = testStack();
    new CostGuardrails(stack, 'Cost', {
      resourcePrefix: 'x',
      monthlyLimitUsd: 10,
      actualThresholdsPercent: [80],
      forecastThresholdPercent: 100,
      notificationEmails: ['finops@example.com'],
      tagFilter: { Project: 'p', Environment: 'dev' },
    });
    Template.fromStack(stack).hasResourceProperties('AWS::Budgets::Budget', {
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'finops@example.com' }],
        }),
      ]),
    });
  });
});
