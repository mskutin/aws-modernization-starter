import type { ProcessingExecutionInput } from '@starter/workflow-processing';

export interface StartResult {
  executionArn: string;
  /** The execution for this job already existed (idempotent start). */
  alreadyStarted: boolean;
}

/** Port for starting the processing workflow; adapters: Step Functions, local simulator. */
export interface WorkflowPort {
  readonly kind: 'stepfunctions' | 'local';
  start(input: ProcessingExecutionInput): Promise<StartResult>;
  /** Waits (bounded) for in-flight work during graceful shutdown. */
  drain(timeoutMs: number): Promise<void>;
}

/** Step Functions rejects execution input above 256 KiB. */
export const MAX_EXECUTION_INPUT_BYTES = 256 * 1024;
