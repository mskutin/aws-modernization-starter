import { Stack, Stage, type StageProps } from 'aws-cdk-lib';
import type * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import {
  ImportedFoundationProvider,
  SandboxFoundationProvider,
  SandboxFoundationStack,
  type FoundationProvider,
} from '../constructs/foundation/index.js';
import { ReconcilerAlarms } from '../constructs/job-reconciler.js';
import { SANDBOX_ENVIRONMENT_NAME, type EnvironmentConfig } from '../environments/schema.js';
import { applyLogGroupCompliance } from '../lib/aspects.js';
import { PLACEHOLDER_IMAGE_DIGEST } from '../lib/image.js';
import type { WorkflowHandlerEntries } from '../lib/lambda-entries.js';
import {
  PLACEHOLDER_ORIGIN_VERIFY_SECRET,
  guardSandboxPlaceholders,
  sandboxPlaceholders,
} from '../lib/sandbox-inputs.js';
import { applyRequiredTags, runTags } from '../lib/tagging.js';
import { ApiStack, type IssuerEndpoints } from '../stacks/api-stack.js';
import { DataStack } from '../stacks/data-stack.js';
import { FrontendStack } from '../stacks/frontend-stack.js';
import { workloadStackProps } from '../stacks/workload-stack.js';
import { MigrationsStack } from '../stacks/migrations-stack.js';
import { ObservabilityStack } from '../stacks/observability-stack.js';
import { PlatformStack } from '../stacks/platform-stack.js';
import { TestIssuerStack } from '../stacks/test-issuer-stack.js';
import { WorkflowStack } from '../stacks/workflow-stack.js';
import { addSandboxOutputs } from './sandbox-outputs.js';

export { STAGE_IDS } from '../environments/schema.js';

export interface WorkloadStageProps extends StageProps {
  readonly config: EnvironmentConfig;
  /** Immutable API image digest (`sha256:...`). */
  readonly imageDigest: string;
  readonly handlerEntries: WorkflowHandlerEntries;
  /** `APP_VERSION` for the API, migration task and Lambdas (e.g. git SHA). */
  readonly appVersion?: string;
  /**
   * Per-run secret CloudFront sends in `X-Origin-Verify` to the sandbox-only `public-alb-http` ALB
   * (CDK context `originVerifySecret`); required for that origin mode, unused otherwise.
   */
  readonly originVerifySecret?: string;
}

/**
 * One deployable environment. The same stacks and constructs are used for
 * dev, staging and prod; only the validated config differs.
 *
 * Stacks and their deploy-order dependencies:
 *   Platform (ECS cluster, ECR), Data (RDS, DynamoDB)   [+ Foundation first in sandbox mode]
 *   Workflow       <- Data (job table; RDS endpoint, SG and IAM auth for document loading)
 *   Migrations     <- Platform, Data
 *   Api            <- Platform, Data, Workflow, Migrations
 *   Frontend       <- Api
 *   Observability  <- Platform, Api, Workflow, Data
 *
 * Pipeline: deploy Platform + Data + Workflow + Migrations, run the migration
 * task, then deploy Api, Frontend and Observability (docs/architecture.md §7).
 *
 * The opt-in sandbox (not a governed environment) adds `TestIssuer` (Foundation only; Api and Frontend take
 * the issuer from it), names its stacks `Sandbox-<Id>`, tags every resource with the ephemeral
 * run identity and adds the outputs the lifecycle scripts read (`addSandboxOutputs`).
 */
export class WorkloadStage extends Stage {
  public readonly config: EnvironmentConfig;
  public readonly foundationStack?: SandboxFoundationStack;
  /** Sandbox only (`auth.testIssuer`): the stage-hosted test issuer. */
  public readonly testIssuer?: TestIssuerStack;
  public readonly platform: PlatformStack;
  public readonly migrations: MigrationsStack;
  public readonly data: DataStack;
  public readonly workflow: WorkflowStack;
  public readonly api: ApiStack;
  public readonly frontend: FrontendStack;
  public readonly observability: ObservabilityStack;

  constructor(scope: Construct, id: string, props: WorkloadStageProps) {
    const { config } = props;
    super(scope, id, { ...props, env: { account: config.account, region: config.region } });
    this.config = config;

    let foundation: FoundationProvider;
    if (config.foundation.mode === 'import') {
      foundation = new ImportedFoundationProvider(config.foundation);
    } else {
      this.foundationStack = new SandboxFoundationStack(this, 'Foundation', {
        ...workloadStackProps(
          config,
          'foundation',
          'AWS modernization starter: SANDBOX foundation (not for governed environments)',
          'Foundation',
        ),
        config: config.foundation,
        resourcePrefix: config.resourcePrefix,
        logRetention: config.observability.logRetentionDays as logs.RetentionDays,
        operatorPrincipalArn: config.operatorPrincipalArn,
        // The sandbox only (the dev sandbox-foundation variant stays as it is).
        stepFunctionsLogDelivery: config.name === SANDBOX_ENVIRONMENT_NAME,
      });
      foundation = new SandboxFoundationProvider(this.foundationStack);
    }

    const common = { config, foundation };
    let identity: IssuerEndpoints;
    if (config.auth.testIssuer) {
      this.testIssuer = new TestIssuerStack(this, 'TestIssuer', common);
      identity = {
        issuer: this.testIssuer.issuer.issuerUrl,
        jwksUri: this.testIssuer.issuer.jwksUri,
      };
    } else {
      if (!config.auth.issuer) throw new Error('WorkloadStage: auth.issuer is required');
      identity = { issuer: config.auth.issuer, jwksUri: config.auth.jwksUri };
    }
    if (config.api.originMode === 'public-alb-http' && !props.originVerifySecret) {
      throw new Error('WorkloadStage: originMode public-alb-http needs originVerifySecret');
    }

    this.platform = new PlatformStack(this, 'Platform', common);
    this.data = new DataStack(this, 'Data', common);
    this.workflow = new WorkflowStack(this, 'Workflow', {
      ...common,
      jobTable: this.data.jobTable,
      database: this.data.database,
      handlerEntries: props.handlerEntries,
      appVersion: props.appVersion,
    });
    this.migrations = new MigrationsStack(this, 'Migrations', {
      ...common,
      cluster: this.platform.cluster,
      imageDigest: props.imageDigest,
      database: this.data.database,
      appVersion: props.appVersion,
      images: this.platform,
    });
    this.api = new ApiStack(this, 'Api', {
      ...common,
      cluster: this.platform.cluster,
      database: this.data.database,
      jobTable: this.data.jobTable,
      stateMachine: this.workflow.workflow.stateMachine,
      imageDigest: props.imageDigest,
      appVersion: props.appVersion,
      images: this.platform,
      identity,
      originVerifySecret: props.originVerifySecret,
    });
    // Schema changes are applied (migration task) before the API rolls out.
    this.api.addStackDependency(this.migrations, 'database migrations run before the API');
    this.frontend = new FrontendStack(this, 'Frontend', {
      ...common,
      apiLoadBalancer: this.api.api.loadBalancer,
      identity,
      originVerifySecret: props.originVerifySecret,
    });
    this.observability = new ObservabilityStack(this, 'Observability', {
      ...common,
      api: this.api.api,
      workflow: this.workflow.workflow,
      database: this.data.database,
    });
    // Reconciler alarms live next to the alarm topic (Observability already depends on Workflow).
    new ReconcilerAlarms(this.observability, 'ReconcilerAlarms', {
      resourcePrefix: config.resourcePrefix,
      environmentName: config.name,
      reconciler: this.workflow.reconciler,
      topic: this.observability.observability.topic,
      scheduleMinutes: config.workflow.reconciler.scheduleMinutes,
    });

    if (config.name === SANDBOX_ENVIRONMENT_NAME) {
      addSandboxOutputs(this);
      // Placeholder inputs make every stack of the stage undeployable.
      guardSandboxPlaceholders(
        this.node.children.filter((c): c is Stack => Stack.isStack(c)),
        sandboxPlaceholders(config, {
          originVerifySecret: props.originVerifySecret ?? PLACEHOLDER_ORIGIN_VERIFY_SECRET,
          imageDigestIsPlaceholder: props.imageDigest === PLACEHOLDER_IMAGE_DIGEST,
        }),
      );
    }

    applyRequiredTags(this, config.tags, {
      ...config.foundation.mandatoryTags,
      ...runTags(config),
    });
    applyLogGroupCompliance(this);
  }
}
