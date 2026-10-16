/**
 * `@starter/workflow-processing/cdk` — AWS CDK definition of the processing
 * workflow. Import the runtime-safe spec from `@starter/workflow-processing`
 * instead when you do not need `aws-cdk-lib`.
 */
export {
  CONDITIONAL_CHECK_FAILED,
  FAILURE_DEFAULTS,
  RECORD_PREDECESSORS,
  RECORD_STATE_RETRY,
  StatePaths,
  TASK_EVENT_PARAMETERS,
  buildProcessingDefinition,
  toAslRetrier,
  toRetryProps,
  type ProcessingDefinitionProps,
} from './definition.js';
export {
  ProcessingStateMachine,
  resolveExecutionTimeoutSeconds,
  type ProcessingStateMachineProps,
} from './state-machine.js';
