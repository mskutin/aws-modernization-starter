import { CfnOutput } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { ApiService } from '../constructs/api-service.js';
import { CostGuardrails } from '../constructs/cost-guardrails.js';
import { Observability } from '../constructs/observability.js';
import type { ProcessingWorkflow } from '../constructs/processing-workflow.js';
import type { RelationalDatabase } from '../constructs/relational-database.js';
import { WorkloadStack, type WorkloadStackProps } from './workload-stack.js';

export interface ObservabilityStackProps extends Omit<
  WorkloadStackProps,
  'suffix' | 'description'
> {
  readonly api: ApiService;
  readonly workflow: ProcessingWorkflow;
  readonly database: RelationalDatabase;
}

/** Alarms, dashboard, alarm topic and cost guardrails for one environment. */
export class ObservabilityStack extends WorkloadStack {
  public readonly observability: Observability;
  public readonly costGuardrails: CostGuardrails;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, {
      ...props,
      suffix: 'observability',
      description: 'AWS modernization starter: observability and cost guardrails',
    });
    const { config } = this;

    this.observability = new Observability(this, 'Observability', {
      resourcePrefix: config.resourcePrefix,
      alarmEmails: config.observability.alarmEmails,
      thresholds: config.observability.thresholds,
      loadBalancer: props.api.loadBalancer,
      targetGroup: props.api.targetGroup,
      service: props.api.service,
      functions: {
        validator: props.workflow.validator.fn,
        processor: props.workflow.processor.fn,
      },
      stateMachine: props.workflow.stateMachine,
      database: props.database.instance,
      teardown: config.teardown,
    });

    this.costGuardrails = new CostGuardrails(this, 'CostGuardrails', {
      resourcePrefix: config.resourcePrefix,
      monthlyLimitUsd: config.budget.monthlyLimitUsd,
      actualThresholdsPercent: config.budget.actualThresholdsPercent,
      forecastThresholdPercent: config.budget.forecastThresholdPercent,
      notificationEmails: config.budget.notificationEmails,
      topic: this.observability.topic,
      tagFilter: { Project: config.tags.Project, Environment: config.tags.Environment },
    });

    new CfnOutput(this, 'AlarmTopicArn', { value: this.observability.topic.topicArn });
    new CfnOutput(this, 'DashboardName', { value: this.observability.dashboard.dashboardName });
  }
}
