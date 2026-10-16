import { DefaultStackSynthesizer, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { FoundationProvider, ILandingZoneFoundation } from '../constructs/foundation/index.js';
import {
  SANDBOX_ENVIRONMENT_NAME,
  STAGE_IDS,
  type EnvironmentConfig,
} from '../environments/schema.js';
import { runTags } from '../lib/tagging.js';

export interface WorkloadStackProps {
  readonly config: EnvironmentConfig;
  readonly foundation: FoundationProvider;
  /** Stack name suffix: `<resourcePrefix>-<suffix>`. */
  readonly suffix: string;
  readonly description: string;
}

/** Stacks whose resources are deleted with them: dev, and the sandbox (`teardown: destroy`). */
export function isDisposable(config: EnvironmentConfig): boolean {
  return config.name === 'dev' || config.teardown === 'destroy';
}

/**
 * CloudFormation stack name: `<resourcePrefix>-<suffix>` in the governed environments; the
 * sandbox uses `<Stage>-<StackId>` (`Sandbox-Api`).
 */
export function stackNameFor(config: EnvironmentConfig, suffix: string, stackId?: string): string {
  if (config.name !== SANDBOX_ENVIRONMENT_NAME) return `${config.resourcePrefix}-${suffix}`;
  if (!stackId)
    throw new Error(`workloadStackProps: the sandbox stack "${suffix}" needs its stack id`);
  return `${STAGE_IDS[config.name]}-${stackId}`;
}

/** Shared stack settings for one environment: env, bootstrap qualifier, protection, tags. */
export function workloadStackProps(
  config: EnvironmentConfig,
  suffix: string,
  description: string,
  stackId?: string,
): StackProps {
  return {
    env: { account: config.account, region: config.region },
    stackName: stackNameFor(config, suffix, stackId),
    description: `${description} (${config.name})`,
    synthesizer: new DefaultStackSynthesizer({ qualifier: config.cdkBootstrapQualifier }),
    terminationProtection: !isDisposable(config),
    // Stack-level tags propagate to resources CloudFormation creates implicitly.
    tags: { ...config.foundation.mandatoryTags, ...runTags(config), ...config.tags },
  };
}

/** Base class: resolves the foundation for this stack and applies the permissions boundary. */
export abstract class WorkloadStack extends Stack {
  public readonly config: EnvironmentConfig;
  public readonly foundation: ILandingZoneFoundation;

  protected constructor(scope: Construct, id: string, props: WorkloadStackProps) {
    super(scope, id, workloadStackProps(props.config, props.suffix, props.description, id));
    this.config = props.config;
    this.foundation = props.foundation.forStack(this);
    if (this.foundation.permissionsBoundary) {
      iam.PermissionsBoundary.of(this).apply(this.foundation.permissionsBoundary);
    }
  }

  /** Log groups are kept in regulated environments (audit), removed with dev/sandbox stacks. */
  protected get logRemovalPolicy(): RemovalPolicy {
    return isDisposable(this.config) ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
  }

  /** Buckets, the ECR repository, the alarm-topic key, Lambda versions: `teardown`. */
  protected get teardownRemovalPolicy(): RemovalPolicy {
    return this.config.teardown === 'destroy' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
  }

  protected get logRetention(): logs.RetentionDays {
    // Validated against the CloudWatch retention enum by the config schema.
    return this.config.observability.logRetentionDays as logs.RetentionDays;
  }
}
