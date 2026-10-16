import * as budgets from 'aws-cdk-lib/aws-budgets';
import type * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/** Tag keys that must be activated as cost allocation tags in the payer account. */
export const COST_ALLOCATION_TAG_KEYS = ['Project', 'Environment', 'CostCentre'] as const;

export interface CostGuardrailsProps {
  readonly resourcePrefix: string;
  readonly monthlyLimitUsd: number;
  readonly actualThresholdsPercent: readonly number[];
  readonly forecastThresholdPercent: number;
  readonly notificationEmails: readonly string[];
  readonly topic?: sns.ITopic;
  /** Cost scope; values of the cost allocation tags. */
  readonly tagFilter: { readonly Project: string; readonly Environment: string };
}

/**
 * Monthly AWS Budget filtered to this project/environment's cost allocation
 * tags, with ACTUAL and FORECASTED notifications to SNS and email.
 * Budgets only see tagged spend after the tags are ACTIVATED as cost
 * allocation tags (a payer-account action; see docs/landing-zone-adaptation.md).
 */
export class CostGuardrails extends Construct {
  public readonly budget: budgets.CfnBudget;

  constructor(scope: Construct, id: string, props: CostGuardrailsProps) {
    super(scope, id);
    const subscribers: budgets.CfnBudget.SubscriberProperty[] = [
      ...(props.topic ? [{ subscriptionType: 'SNS', address: props.topic.topicArn }] : []),
      ...props.notificationEmails.map((address) => ({ subscriptionType: 'EMAIL', address })),
    ];
    if (subscribers.length === 0) {
      throw new Error('CostGuardrails needs at least one subscriber (SNS topic or email)');
    }
    const notification = (notificationType: 'ACTUAL' | 'FORECASTED', threshold: number) => ({
      notification: {
        notificationType,
        comparisonOperator: 'GREATER_THAN',
        threshold,
        thresholdType: 'PERCENTAGE',
      },
      subscribers,
    });

    this.budget = new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `${props.resourcePrefix}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.monthlyLimitUsd, unit: 'USD' },
        filterExpression: {
          and: [
            {
              tags: { key: 'Project', values: [props.tagFilter.Project], matchOptions: ['EQUALS'] },
            },
            {
              tags: {
                key: 'Environment',
                values: [props.tagFilter.Environment],
                matchOptions: ['EQUALS'],
              },
            },
          ],
        },
      },
      notificationsWithSubscribers: [
        ...props.actualThresholdsPercent.map((p) => notification('ACTUAL', p)),
        notification('FORECASTED', props.forecastThresholdPercent),
      ],
    });
  }
}
