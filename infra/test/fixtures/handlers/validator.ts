/**
 * Test fixture standing in for functions/validator/src/handler.ts. It only
 * exists so infra tests and offline synth can bundle a real entry point.
 */
import { WorkflowError, type ProcessingExecutionInput } from '@starter/workflow-processing';

export async function handler(
  event: ProcessingExecutionInput & { executionArn: string },
): Promise<{ valid: true; jobId: string }> {
  // Spec 2.0.0: the event is a job reference; the output is metadata only.
  if (typeof event.jobId !== 'string' || event.jobId.length === 0) {
    const err = new Error('jobId is required');
    err.name = WorkflowError.Validation;
    throw err;
  }
  return { valid: true, jobId: event.jobId };
}
