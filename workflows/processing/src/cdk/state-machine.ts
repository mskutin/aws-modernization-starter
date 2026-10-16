import { Duration, type RemovalPolicy } from 'aws-cdk-lib';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import { PROCESSING_WORKFLOW } from '../spec.js';
import { buildProcessingDefinition, type ProcessingDefinitionProps } from './definition.js';

export interface ProcessingStateMachineProps extends ProcessingDefinitionProps {
  /** Physical name; must be unique per account/region. */
  readonly stateMachineName?: string;
  /** Encrypted log group that receives execution history (level ALL). */
  readonly logGroup: logs.ILogGroup;
  /**
   * Include execution input/output in logs. Since spec 2.0.0 they carry no document data, but
   * error causes still reach the log; production configs keep this disabled.
   * @default false
   */
  readonly includeExecutionData?: boolean;
  /** @default true */
  readonly tracingEnabled?: boolean;
  /**
   * Customer-managed key for the definition, execution history and inputs. Since spec 2.0.0
   * the input is a job reference only; the CMK stays as defence in depth (error causes,
   * metadata). Callers of StartExecution additionally need `kms:GenerateDataKey` on it.
   * @default - AWS-owned key
   */
  readonly encryptionKey?: kms.IKey;
  readonly removalPolicy?: RemovalPolicy;
  /**
   * SHORTENS the execution timeout below the spec's `PROCESSING_WORKFLOW.executionTimeoutSeconds`.
   * AWS INTEGRATION MINI-STACK ONLY: a short ceiling makes the uncatchable execution timeout
   * observable in a real-AWS test (TIMED_OUT, job left non-terminal, closed by the reconciler).
   * Environment stages never set it: below `worstCaseExecutionSeconds()` a slow job can end
   * without RecordFailure. Task timeouts, retries and catches are unchanged.
   * @default PROCESSING_WORKFLOW.executionTimeoutSeconds
   */
  readonly executionTimeoutSeconds?: number;
}

/** The execution timeout of a state machine: the spec's value unless a shorter one is given. */
export function resolveExecutionTimeoutSeconds(override?: number): number {
  if (override === undefined) return PROCESSING_WORKFLOW.executionTimeoutSeconds;
  if (
    !Number.isInteger(override) ||
    override < 1 ||
    override > PROCESSING_WORKFLOW.executionTimeoutSeconds
  ) {
    throw new RangeError(
      `executionTimeoutSeconds must be an integer between 1 and the spec's ${PROCESSING_WORKFLOW.executionTimeoutSeconds} (it may only shorten the execution timeout)`,
    );
  }
  return override;
}

/**
 * STANDARD Step Functions state machine for the processing workflow. The
 * definition, task timeouts, retries and execution timeout all come from
 * `PROCESSING_WORKFLOW` in the shared spec (the execution timeout can only be shortened, for the
 * AWS integration mini-stack's timeout test).
 */
export class ProcessingStateMachine extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: ProcessingStateMachineProps) {
    super(scope, id);

    const definition = buildProcessingDefinition(this, props);

    this.stateMachine = new sfn.StateMachine(this, 'Resource', {
      stateMachineName: props.stateMachineName,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.seconds(resolveExecutionTimeoutSeconds(props.executionTimeoutSeconds)),
      comment: `${PROCESSING_WORKFLOW.name} v${PROCESSING_WORKFLOW.version}`,
      tracingEnabled: props.tracingEnabled ?? true,
      ...(props.encryptionKey
        ? {
            encryptionConfiguration: new sfn.CustomerManagedEncryptionConfiguration(
              props.encryptionKey,
            ),
          }
        : {}),
      logs: {
        destination: props.logGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: props.includeExecutionData ?? false,
      },
      removalPolicy: props.removalPolicy,
    });
  }
}
