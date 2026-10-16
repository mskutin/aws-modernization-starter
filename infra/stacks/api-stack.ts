import { DB_ROLES } from '@starter/db/roles';
import { CfnOutput } from 'aws-cdk-lib';
import type * as ecs from 'aws-cdk-lib/aws-ecs';
import type * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import type { Construct } from 'constructs';
import { API_CONTAINER_NAME, ApiService, type ApiOrigin } from '../constructs/api-service.js';
import type { JobStateTable } from '../constructs/job-state-table.js';
import type { RelationalDatabase } from '../constructs/relational-database.js';
import { WorkloadStack, type WorkloadStackProps } from './workload-stack.js';
import type { ImageSource } from './platform-stack.js';

/** The OIDC issuer the API trusts: from the config, or from the sandbox test-issuer stack. */
export interface IssuerEndpoints {
  /** Exact `iss` (https; may be a CloudFormation token for the sandbox test issuer). */
  readonly issuer: string;
  /** JWKS URL override; otherwise OIDC discovery. */
  readonly jwksUri?: string | undefined;
}

export interface ApiStackProps extends Omit<WorkloadStackProps, 'suffix' | 'description'> {
  readonly cluster: ecs.ICluster;
  /** API image repository (PlatformStack: created, or imported into this stack). */
  readonly images: ImageSource;
  readonly database: RelationalDatabase;
  readonly jobTable: JobStateTable;
  readonly stateMachine: sfn.IStateMachine;
  /** Immutable image digest (`sha256:...`). */
  readonly imageDigest: string;
  readonly appVersion?: string;
  /** Issuer and JWKS URL (stage-resolved: `config.auth`, or the sandbox test issuer). */
  readonly identity: IssuerEndpoints;
  /**
   * Per-run X-Origin-Verify value; required for the sandbox-only `public-alb-http` origin.
   */
  readonly originVerifySecret?: string;
}

/** API tier: ECS Fargate service, task definition and the internal ALB. */
export class ApiStack extends WorkloadStack {
  public readonly api: ApiService;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, {
      ...props,
      suffix: 'api',
      description: 'AWS modernization starter: API service',
    });
    const { config, foundation } = this;
    const api = config.api;
    let origin: ApiOrigin = { mode: 'vpc-origin-https' };
    if (api.originMode === 'public-alb-http') {
      if (!foundation.ingressSubnets || !props.originVerifySecret) {
        throw new Error('ApiStack: public-alb-http needs ingress subnets and originVerifySecret');
      }
      origin = {
        mode: 'public-alb-http',
        subnets: foundation.ingressSubnets,
        verifyHeaderValue: props.originVerifySecret,
      };
    }

    this.api = new ApiService(this, 'ApiService', {
      resourcePrefix: config.resourcePrefix,
      vpc: foundation.vpc,
      subnets: foundation.appSubnets,
      cluster: props.cluster,
      certificate: foundation.albCertificate,
      originIngressPrefixListId: foundation.cloudFrontOriginFacingPrefixListId,
      origin,
      accessLogsBucket: foundation.accessLogsBucket,
      logsKey: foundation.logsKey,
      logRetention: this.logRetention,
      logRemovalPolicy: this.logRemovalPolicy,
      repository: props.images.repositoryFor(this),
      imageDigest: props.imageDigest,
      cpu: api.cpu,
      memoryMiB: api.memoryMiB,
      desiredCount: api.desiredCount,
      minCapacity: api.minCapacity,
      maxCapacity: api.maxCapacity,
      cpuTargetUtilizationPercent: api.cpuTargetUtilizationPercent,
      useFargateSpot: api.useFargateSpot,
      albDeletionProtection: api.albDeletionProtection,
      logLevel: api.logLevel,
      corsAllowedOrigins: api.corsAllowedOrigins,
      // Identity: the organization's IdP registration from the environment config (sandbox: the
      // stage's test issuer).
      auth: {
        ...config.auth,
        issuer: props.identity.issuer,
        jwksUri: props.identity.jwksUri,
        allowedClientIds: config.auth.allowedClientIds ?? [config.auth.spaClientId],
      },
      environmentName: config.name,
      appVersion: props.appVersion,
      // starter_app with RDS IAM authentication: no database secret in the task (ADR 0221).
      database: props.database.iamConnection(DB_ROLES.app, {
        poolMax: config.database.apiPoolMax,
      }),
      jobTable: { table: props.jobTable.table, key: props.jobTable.encryptionKey },
      stateMachine: props.stateMachine,
      // The workflow encrypts its state machine with the same data CMK as the job table.
      stateMachineKey: props.jobTable.encryptionKey,
    });
    // Security groups: ALB -> tasks -> DB only. The DB ingress rule is placed
    // in this stack (consumer side) to avoid a cross-stack dependency cycle.
    props.database.allowFrom(this.api.service, 'API tasks to PostgreSQL');
    // rds-db:connect as starter_app only (dbuser:<DbiResourceId>/starter_app).
    props.database.grantConnect(this.api.taskRole, DB_ROLES.app);

    new CfnOutput(this, 'ServiceName', { value: this.api.service.serviceName });
    new CfnOutput(this, 'TaskDefinitionFamily', { value: this.api.taskDefinition.family });
    new CfnOutput(this, 'ContainerName', { value: API_CONTAINER_NAME });
    new CfnOutput(this, 'InternalAlbDnsName', {
      value: this.api.loadBalancer.loadBalancerDnsName,
    });
  }
}
