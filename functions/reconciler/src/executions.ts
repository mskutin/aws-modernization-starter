/**
 * Authoritative execution state for the reconciler. On AWS: Step Functions `DescribeExecution`
 * (metadata only — no input/output, so no `kms:Decrypt` and no data), by the ARN recorded on the
 * job, or by the deterministic execution name when none was recorded. Locally: the in-process
 * simulator (see apps/api/src/reconciler-loop.ts).
 *
 * Any error other than "this execution does not exist" is RETHROWN: the reconciler treats it as a
 * dependency failure and makes no transition.
 */
import { DescribeExecutionCommand, type DescribeExecutionCommandOutput } from '@aws-sdk/client-sfn';
import { executionArnFor, executionNameFor } from '@starter/workflow-processing';

export type ExecutionStatus =
  'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'ABORTED' | 'PENDING_REDRIVE' | 'NOT_FOUND';

export interface ExecutionLookup {
  status: ExecutionStatus;
  /** Error name the execution ended with, when it is a plain identifier (never the cause). */
  error?: string | undefined;
  /** The job's recorded ARN belongs to another state machine and was not used. */
  foreignArn?: boolean | undefined;
}

export interface ExecutionStateSource {
  describe(job: { jobId: string; executionArn?: string | undefined }): Promise<ExecutionLookup>;
}

/** The subset of SFNClient used (lets tests inject a fake). */
export interface SfnDescribeLike {
  send(command: DescribeExecutionCommand): Promise<DescribeExecutionCommandOutput>;
}

/** A status the reconciler does not know: never acted upon (treated as a dependency failure). */
export class UnknownExecutionStatusError extends Error {
  override readonly name = 'UnknownExecutionStatusError';
}

const KNOWN: ReadonlySet<string> = new Set([
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'ABORTED',
  'PENDING_REDRIVE',
]);
const SAFE_ERROR_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

export function safeErrorName(error: string | undefined): string | undefined {
  return error !== undefined && SAFE_ERROR_NAME.test(error) ? error : undefined;
}

export class StepFunctionsExecutions implements ExecutionStateSource {
  private readonly prefix: string;

  constructor(private readonly options: { client: SfnDescribeLike; stateMachineArn: string }) {
    this.prefix = executionArnFor(options.stateMachineArn, '');
  }

  async describe(job: {
    jobId: string;
    executionArn?: string | undefined;
  }): Promise<ExecutionLookup> {
    const recorded = job.executionArn;
    const own = recorded !== undefined && recorded.startsWith(this.prefix);
    const foreignArn = recorded !== undefined && !own ? { foreignArn: true } : {};
    const executionArn = own
      ? recorded
      : executionArnFor(this.options.stateMachineArn, executionNameFor(job.jobId));
    let out: DescribeExecutionCommandOutput;
    try {
      out = await this.options.client.send(
        new DescribeExecutionCommand({ executionArn, includedData: 'METADATA_ONLY' }),
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'ExecutionDoesNotExist') {
        return { status: 'NOT_FOUND', ...foreignArn };
      }
      throw error;
    }
    const status = out.status ?? 'UNKNOWN';
    if (!KNOWN.has(status)) {
      throw new UnknownExecutionStatusError(`unknown execution status ${status.slice(0, 32)}`);
    }
    return {
      status: status as ExecutionStatus,
      error: safeErrorName(out.error),
      ...foreignArn,
    };
  }
}
