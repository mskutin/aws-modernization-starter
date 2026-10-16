import { rdsCaBundlePath } from '@starter/db';
import { CfnOutput } from 'aws-cdk-lib';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import { JobReconciler } from '../constructs/job-reconciler.js';
import type { JobStateTable } from '../constructs/job-state-table.js';
import { ProcessingWorkflow } from '../constructs/processing-workflow.js';
import type { RelationalDatabase } from '../constructs/relational-database.js';
import type { WorkflowHandlerEntries } from '../lib/lambda-entries.js';
import { WorkloadStack, type WorkloadStackProps } from './workload-stack.js';

export interface WorkflowStackProps extends Omit<WorkloadStackProps, 'suffix' | 'description'> {
  readonly jobTable: JobStateTable;
  /** System of record the handlers load documents from (claim check, ADR 0230). */
  readonly database: RelationalDatabase;
  readonly handlerEntries: WorkflowHandlerEntries;
  readonly appVersion?: string;
}

/**
 * `ProcessingWorkflow` requires a reserved concurrency for PostgreSQL document access. The
 * sandbox may run unreserved (`workflow.reservedConcurrency: null`, sandbox-only, for an
 * account whose concurrency quota cannot cover any reservation): the stack builds the functions
 * with this placeholder and then removes the property. The database-side bound stays (the
 * starter_processor CONNECTION LIMIT); see the schema. A first-class opt-out in `ProcessingWorkflow`
 * (workflow owner) would replace this.
 */
const UNRESERVED_PLACEHOLDER = 1;

function removeReservedConcurrency(fns: readonly lambda.IFunction[]): void {
  for (const fn of fns) {
    (fn.node.defaultChild as lambda.CfnFunction).reservedConcurrentExecutions = undefined;
  }
}

/**
 * Processing workflow: validator/processor Lambdas + Step Functions, and the ONE scheduled
 * stale-job reconciler of the environment.
 */
export class WorkflowStack extends WorkloadStack {
  public readonly workflow: ProcessingWorkflow;
  public readonly reconciler: JobReconciler;

  constructor(scope: Construct, id: string, props: WorkflowStackProps) {
    super(scope, id, {
      ...props,
      suffix: 'workflow',
      description: 'AWS modernization starter: processing workflow',
    });
    const { config, foundation } = this;
    const network = config.workflow.placeInVpc
      ? { vpc: foundation.vpc, subnets: foundation.appSubnets }
      : undefined;
    const reserved = config.workflow.reservedConcurrency;

    this.workflow = new ProcessingWorkflow(this, 'ProcessingWorkflow', {
      resourcePrefix: config.resourcePrefix,
      entries: props.handlerEntries,
      table: props.jobTable.table,
      tableKey: props.jobTable.encryptionKey,
      logsKey: foundation.logsKey,
      logRetention: this.logRetention,
      logRemovalPolicy: this.logRemovalPolicy,
      versionRemovalPolicy: this.teardownRemovalPolicy,
      logLevel: config.workflow.logLevel,
      environmentName: config.name,
      appVersion: props.appVersion,
      memoryMiB: config.workflow.lambdaMemoryMiB,
      reservedConcurrency: reserved ?? UNRESERVED_PLACEHOLDER,
      logExecutionData: config.workflow.logExecutionData,
      network,
      // load_job_document() as starter_processor: IAM auth, verify-full, 5432 path, CA in the assets.
      documents: { kind: 'postgres', database: props.database, caBundlePath: rdsCaBundlePath() },
      auditRetentionDays: config.jobTable.auditRetentionDays ?? undefined,
    });
    if (reserved === null) {
      removeReservedConcurrency([this.workflow.validator.fn, this.workflow.processor.fn]);
    }

    const reconciler = config.workflow.reconciler;
    this.reconciler = new JobReconciler(this, 'Reconciler', {
      resourcePrefix: config.resourcePrefix,
      entry: props.handlerEntries.reconciler,
      table: props.jobTable.table,
      tableKey: props.jobTable.encryptionKey,
      statusIndexArn: props.jobTable.statusIndexArn,
      stateMachine: this.workflow.stateMachine,
      logsKey: foundation.logsKey,
      logRetention: this.logRetention,
      logRemovalPolicy: this.logRemovalPolicy,
      versionRemovalPolicy: this.teardownRemovalPolicy,
      logLevel: config.workflow.logLevel,
      environmentName: config.name,
      appVersion: props.appVersion,
      // Unreserved only together with the workflow functions (sandbox, small quota).
      reserveConcurrency: reserved !== null,
      settings: {
        staleAfterSeconds: reconciler.staleAfterSeconds,
        batchSize: reconciler.batchSize,
        dryRun: reconciler.dryRun,
        maxRuntimeSeconds: reconciler.maxRuntimeSeconds,
      },
      scheduleMinutes: reconciler.scheduleMinutes,
      network,
    });

    new CfnOutput(this, 'StateMachineArn', { value: this.workflow.stateMachine.stateMachineArn });
    new CfnOutput(this, 'ValidatorAliasArn', { value: this.workflow.validator.alias.functionArn });
    new CfnOutput(this, 'ProcessorAliasArn', { value: this.workflow.processor.alias.functionArn });
    new CfnOutput(this, 'ReconcilerFunctionName', { value: this.reconciler.fn.functionName });
  }
}
