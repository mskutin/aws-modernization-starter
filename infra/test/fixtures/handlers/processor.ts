/**
 * Test fixture standing in for functions/processor/src/handler.ts. It only
 * exists so infra tests and offline synth can bundle a real entry point.
 * Spec 2.0.0: the event is a job reference; the output is metadata only.
 */
import type { ProcessingExecutionInput } from '@starter/workflow-processing';

export async function handler(
  event: ProcessingExecutionInput & { executionArn: string },
): Promise<{ jobId: string; resultStored: true }> {
  return { jobId: event.jobId, resultStored: true };
}
