/**
 * AWS Step Functions adapter. The execution name is derived from the job id
 * (`executionNameFor`), so StartExecution is idempotent per job: a retry gets
 * `ExecutionAlreadyExists` (or the original response for an identical running
 * execution) instead of a second execution.
 *
 * Spec 2.0.0: the input is serialised canonically and must be exactly
 * `{ jobId, contractVersion, submittedAt }` — any extra field (a reintroduced
 * `payload`) throws before anything is sent, so document data cannot reach the
 * execution history.
 */
import { StartExecutionCommand, type StartExecutionCommandOutput } from '@aws-sdk/client-sfn';
import type { Logger } from '@starter/observability';
import {
  executionArnFor,
  executionNameFor,
  serializeExecutionInput,
  type ProcessingExecutionInput,
} from '@starter/workflow-processing';
import { MAX_EXECUTION_INPUT_BYTES, type StartResult, type WorkflowPort } from './port.js';

/** The subset of SFNClient we use (lets tests inject a fake). */
export interface SfnLike {
  send(command: StartExecutionCommand): Promise<StartExecutionCommandOutput>;
}

/** Re-exported from the spec (shared with the reconciler). */
export { executionArnFor };

export class StepFunctionsWorkflow implements WorkflowPort {
  readonly kind = 'stepfunctions' as const;

  constructor(
    private readonly options: { client: SfnLike; stateMachineArn: string; logger: Logger },
  ) {}

  async start(input: ProcessingExecutionInput): Promise<StartResult> {
    const body = serializeExecutionInput(input);
    const name = executionNameFor(input.jobId);
    if (Buffer.byteLength(body, 'utf8') > MAX_EXECUTION_INPUT_BYTES) {
      throw new Error(`execution input exceeds ${MAX_EXECUTION_INPUT_BYTES} bytes`);
    }
    try {
      const out = await this.options.client.send(
        new StartExecutionCommand({
          stateMachineArn: this.options.stateMachineArn,
          name,
          input: body,
        }),
      );
      const executionArn = out.executionArn ?? executionArnFor(this.options.stateMachineArn, name);
      this.options.logger.info(
        { jobId: input.jobId, executionArn },
        'Step Functions execution started',
      );
      return { executionArn, alreadyStarted: false };
    } catch (error) {
      if (error instanceof Error && error.name === 'ExecutionAlreadyExists') {
        const executionArn = executionArnFor(this.options.stateMachineArn, name);
        this.options.logger.info(
          { jobId: input.jobId, executionArn },
          'execution already exists; treating start as idempotent',
        );
        return { executionArn, alreadyStarted: true };
      }
      throw error;
    }
  }

  async drain(): Promise<void> {
    // Executions run in AWS; nothing to wait for in-process.
  }
}
