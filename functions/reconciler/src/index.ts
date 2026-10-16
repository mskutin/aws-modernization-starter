/** Library entry (no side effects): reconciler core for the Lambda and the API's local loop. */
export { decide, type Decision } from './decide.js';
export {
  StepFunctionsExecutions,
  UnknownExecutionStatusError,
  safeErrorName,
  type ExecutionLookup,
  type ExecutionStateSource,
  type ExecutionStatus,
  type SfnDescribeLike,
} from './executions.js';
export { emfRecord, emitMetrics } from './metrics.js';
export {
  RECONCILER_ACTOR,
  reconcileStaleJobs,
  validateOptions,
  type ReconcileOptions,
  type ReconcileSummary,
  type ReconcilerDeps,
  type ReconcilerStore,
} from './reconcile.js';
export {
  SAFETY_MARGIN_MS,
  createHandler,
  type ReconcilerContext,
  type ReconcilerHandler,
  type ReconcilerHandlerDeps,
} from './runtime.js';
