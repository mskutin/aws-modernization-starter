import path from 'node:path';
import { DB_ROLES, type DbLoginRole } from '@starter/db/roles';
import { PROCESSING_WORKFLOW, type TaskSpec } from '@starter/workflow-processing';
import { ProcessingStateMachine } from '@starter/workflow-processing/cdk';
import { Duration, Stack, type RemovalPolicy } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import {
  DYNAMODB_KMS_ACTIONS,
  HANDLER_TABLE_ACTIONS,
  JOB_ITEM_PARTITION_PATTERN,
  TEST_DOCUMENT_TABLE_ACTIONS,
  grantTableItems,
} from '../lib/grants.js';
import type { WorkflowHandlerEntries } from '../lib/lambda-entries.js';
import { DEPS_LOCK_FILE, REPO_ROOT } from '../lib/paths.js';
import { acknowledgeRule } from '../lib/policy-hook.js';
import { databaseEnvironment, type DatabaseConnection } from './node-container.js';

/** Alias every deploy repoints to the newly published version. */
export const LIVE_ALIAS = 'live';

/** Where the RDS CA bundle lands inside each function asset (`DB_SSL_ROOT_CERT`). */
export const LAMBDA_TASK_ROOT = '/var/task';

/**
 * The database construct as the workflow uses it (`RelationalDatabase`, relational-database.ts):
 * IAM connection settings, `rds-db:connect` for exactly one login role, the 5432 network path.
 */
export interface WorkflowDatabase {
  iamConnection(
    user: DbLoginRole,
    options?: { poolMax?: number; sslRootCertPath?: string },
  ): DatabaseConnection;
  grantConnect(grantee: iam.IGrantable, dbUser: DbLoginRole): iam.Grant;
  allowFrom(peer: ec2.IConnectable, description: string): void;
}

/**
 * Where the handlers load documents from (claim check, ADR 0230).
 *
 * - `postgres` (every environment stage): `load_job_document()` as `starter_processor` with RDS IAM
 *   authentication over TLS `verify-full`; the functions run in the VPC with egress to the
 *   database on 5432 only (plus HTTPS to AWS APIs).
 * - `test-table` (AWS integration mini-stack ONLY, ADR 0232): a TEST-ONLY DynamoDB table of
 *   synthetic documents seeded by the AWS tests; the mini-stack has no PostgreSQL.
 */
export type WorkflowDocumentAccess =
  | {
      readonly kind: 'postgres';
      readonly database: WorkflowDatabase;
      /** Absolute path of the RDS CA bundle (`rdsCaBundlePath()` of `@starter/db`); copied into the assets. */
      readonly caBundlePath: string;
    }
  | {
      readonly kind: 'test-table';
      readonly table: dynamodb.ITable;
      readonly key?: kms.IKey;
    };

export interface ProcessingWorkflowProps {
  readonly resourcePrefix: string;
  /** Absolute entry files of the validator and processor handlers. */
  readonly entries: Pick<WorkflowHandlerEntries, 'validator' | 'processor'>;
  readonly table: dynamodb.ITable;
  readonly tableKey?: kms.IKey;
  readonly logsKey: kms.IKey;
  readonly logRetention: logs.RetentionDays;
  readonly logRemovalPolicy: RemovalPolicy;
  /** Removal policy for superseded Lambda versions (RETAIN keeps rollback targets). */
  readonly versionRemovalPolicy: RemovalPolicy;
  readonly logLevel: string;
  /** `APP_ENVIRONMENT` log field (environment name). */
  readonly environmentName: string;
  /** `APP_VERSION` log field (e.g. git SHA); omitted when unknown. */
  readonly appVersion?: string;
  readonly memoryMiB: number;
  /**
   * Reserved concurrency per function. Required when the functions hold database connections
   * (`documents.kind === 'postgres'`): one connection per warm execution environment, so
   * 2 × this value must fit the `starter_processor` CONNECTION LIMIT.
   */
  readonly reservedConcurrency?: number;
  readonly logExecutionData: boolean;
  /** Place the functions' ENIs in these subnets (landing-zone egress controls). */
  readonly network?: { readonly vpc: ec2.IVpc; readonly subnets: ec2.SubnetSelection };
  readonly documents: WorkflowDocumentAccess;
  /**
   * Retention of STEP# audit items in days (`JOB_AUDIT_TTL_DAYS`). Undefined (default) = no
   * expiry; enable only under an approved retention policy (ADR 0233).
   */
  readonly auditRetentionDays?: number;
  /**
   * Shortens the state machine's execution timeout (`ProcessingStateMachine`). AWS INTEGRATION
   * MINI-STACK ONLY (execution-timeout test); environment stages never set it.
   * @default the spec's PROCESSING_WORKFLOW.executionTimeoutSeconds
   */
  readonly executionTimeoutSeconds?: number;
}

interface HandlerParts {
  readonly fn: NodejsFunction;
  readonly alias: lambda.Alias;
  readonly logGroup: logs.LogGroup;
  readonly role: iam.Role;
}

/**
 * Validator + processor Lambdas (Node.js 24, arm64, esbuild-bundled locally,
 * published versions behind a `live` alias) orchestrated by the STANDARD
 * Step Functions state machine defined in `@starter/workflow-processing/cdk`.
 */
export class ProcessingWorkflow extends Construct {
  public readonly validator: HandlerParts;
  public readonly processor: HandlerParts;
  public readonly stateMachine: sfn.StateMachine;
  public readonly stateMachineLogGroup: logs.LogGroup;
  public readonly securityGroup?: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: ProcessingWorkflowProps) {
    super(scope, id);

    if (props.documents.kind === 'postgres') {
      if (!props.network) {
        throw new Error('ProcessingWorkflow: PostgreSQL document access requires `network` (VPC)');
      }
      if (props.reservedConcurrency === undefined) {
        throw new Error(
          'ProcessingWorkflow: functions holding database connections need reservedConcurrency',
        );
      }
    }

    if (props.network) {
      this.securityGroup = new ec2.SecurityGroup(this, 'FunctionsSecurityGroup', {
        vpc: props.network.vpc,
        description: `${props.resourcePrefix} workflow Lambdas (egress: HTTPS to AWS APIs, PostgreSQL)`,
        allowAllOutbound: false,
      });
      this.securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS to AWS APIs');
      if (props.documents.kind === 'postgres') {
        // Egress to the database security group on 5432 only (+ the matching ingress rule).
        props.documents.database.allowFrom(
          this.securityGroup,
          `${props.resourcePrefix} workflow Lambdas (load_job_document)`,
        );
      }
    }

    const { validate, process } = PROCESSING_WORKFLOW.tasks;
    this.validator = this.handler(
      'Validator',
      'validator',
      props.entries.validator,
      validate,
      props,
    );
    this.processor = this.handler(
      'Processor',
      'processor',
      props.entries.processor,
      process,
      props,
    );

    this.stateMachineLogGroup = new logs.LogGroup(this, 'StateMachineLogs', {
      logGroupName: `/aws/vendedlogs/states/${props.resourcePrefix}-${PROCESSING_WORKFLOW.name}`,
      retention: props.logRetention,
      encryptionKey: props.logsKey,
      removalPolicy: props.logRemovalPolicy,
    });

    const machine = new ProcessingStateMachine(this, 'StateMachine', {
      stateMachineName: `${props.resourcePrefix}-${PROCESSING_WORKFLOW.name}`,
      validateFunction: this.validator.alias,
      processFunction: this.processor.alias,
      table: props.table,
      logGroup: this.stateMachineLogGroup,
      includeExecutionData: props.logExecutionData,
      tracingEnabled: true,
      // Spec 2.0.0: the input is a job reference; the CMK protects history, errors and metadata.
      encryptionKey: props.tableKey,
      removalPolicy: props.logRemovalPolicy,
      ...(props.executionTimeoutSeconds === undefined
        ? {}
        : { executionTimeoutSeconds: props.executionTimeoutSeconds }),
    });
    this.stateMachine = machine.stateMachine;

    if (props.tableKey) {
      this.stateMachine.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'JobTableKmsViaDynamoDb',
          actions: [...DYNAMODB_KMS_ACTIONS],
          resources: [props.tableKey.keyArn],
          conditions: {
            StringEquals: { 'kms:ViaService': `dynamodb.${Stack.of(this).region}.amazonaws.com` },
          },
        }),
      );
    }

    const role = this.stateMachine.role;
    acknowledgeRule(
      role,
      'AwsSolutions-IAM5[Resource::*]',
      'CloudWatch Logs vended-delivery (logs:*LogDelivery*, DescribeLogGroups/ResourcePolicies) and X-Ray (PutTraceSegments, GetSampling*) actions do not support resource-level permissions.',
    );
  }

  private documentEnvironment(props: ProcessingWorkflowProps): Record<string, string> {
    const docs = props.documents;
    if (docs.kind === 'test-table') return { TEST_DOCUMENTS_TABLE_NAME: docs.table.tableName };
    // BASE-LMB-007/008: explicit DB_AUTH=iam and DB_SSL=verify-full; never a
    // password, a secret or APP_RUNTIME (CDK never sets it: it defaults to `aws`).
    return databaseEnvironment(
      docs.database.iamConnection(DB_ROLES.processor, {
        poolMax: 1,
        sslRootCertPath: `${LAMBDA_TASK_ROOT}/${path.basename(docs.caBundlePath)}`,
      }),
    );
  }

  private handler(
    id: string,
    name: string,
    entry: string,
    spec: TaskSpec,
    props: ProcessingWorkflowProps,
  ): HandlerParts {
    const logGroup = new logs.LogGroup(this, `${id}Logs`, {
      logGroupName: `/starter/${props.resourcePrefix}/lambda/${name}`,
      retention: props.logRetention,
      encryptionKey: props.logsKey,
      removalPolicy: props.logRemovalPolicy,
    });

    // Explicit role: no AWS-managed policies, logs limited to this log group.
    const role = new iam.Role(this, `${id}Role`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `${props.resourcePrefix} ${name} Lambda execution role`,
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteOwnLogGroup',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [logGroup.logGroupArn],
      }),
    );
    if (props.network) {
      role.addToPolicy(
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
    grantTableItems(role, {
      table: props.table,
      actions: HANDLER_TABLE_ACTIONS,
      key: props.tableKey,
      // The handlers read and write JOB#<id> items only (state, step audit, result); no
      // idempotency or other partitions.
      leadingKeys: [JOB_ITEM_PARTITION_PATTERN],
    });
    const docs = props.documents;
    if (docs.kind === 'postgres') {
      // RDS IAM authentication as starter_processor only (rds-db:connect on dbuser:<id>/starter_processor).
      docs.database.grantConnect(role, DB_ROLES.processor);
    } else {
      grantTableItems(role, {
        table: docs.table,
        actions: TEST_DOCUMENT_TABLE_ACTIONS,
        key: docs.key,
        sid: 'TestDocumentTableRead',
      });
    }

    const caBundle = docs.kind === 'postgres' ? docs.caBundlePath : undefined;
    const fn = new NodejsFunction(this, id, {
      entry,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: props.memoryMiB,
      ...(props.reservedConcurrency !== undefined
        ? { reservedConcurrentExecutions: props.reservedConcurrency }
        : {}),
      // Equal to the Step Functions task timeout from the spec.
      timeout: Duration.seconds(spec.timeoutSeconds),
      description: `${PROCESSING_WORKFLOW.name} ${spec.state} (spec ${PROCESSING_WORKFLOW.version})`,
      role,
      logGroup,
      tracing: lambda.Tracing.ACTIVE,
      // Contract with functions/* (docs/contracts.md §4); never DYNAMODB_ENDPOINT on AWS.
      environment: {
        JOBS_TABLE_NAME: props.table.tableName,
        LOG_LEVEL: props.logLevel,
        APP_ENVIRONMENT: props.environmentName,
        ...(props.appVersion ? { APP_VERSION: props.appVersion } : {}),
        ...(props.auditRetentionDays !== undefined
          ? { JOB_AUDIT_TTL_DAYS: String(props.auditRetentionDays) }
          : {}),
        ...this.documentEnvironment(props),
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
        // Bundle the lockfile-pinned AWS SDK instead of the runtime-provided one:
        // reproducible, reviewed versions (supply chain) and no runtime drift.
        externalModules: [],
        banner:
          "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
        ...(caBundle
          ? {
              // Ship the RDS CA bundle next to index.mjs (DB_SSL_ROOT_CERT, verify-full).
              commandHooks: {
                beforeBundling: () => [],
                beforeInstall: () => [],
                afterBundling: (inputDir: string, outputDir: string) => [
                  `cp "${path.join(inputDir, path.relative(REPO_ROOT, caBundle))}" "${path.join(outputDir, path.basename(caBundle))}"`,
                ],
              },
            }
          : {}),
      },
      currentVersionOptions: { removalPolicy: props.versionRemovalPolicy },
    });

    const alias = new lambda.Alias(this, `${id}LiveAlias`, {
      aliasName: LIVE_ALIAS,
      version: fn.currentVersion,
      description: 'Points at the version published by the latest deploy',
    });

    acknowledgeRule(
      role,
      'AwsSolutions-IAM5[Resource::*]',
      props.network
        ? 'X-Ray PutTraceSegments/PutTelemetryRecords and Lambda VPC ENI management (ec2:*NetworkInterface*, DescribeSubnets) do not support resource-level permissions.'
        : 'X-Ray PutTraceSegments/PutTelemetryRecords do not support resource-level permissions.',
    );
    return { fn, alias, logGroup, role };
  }
}
