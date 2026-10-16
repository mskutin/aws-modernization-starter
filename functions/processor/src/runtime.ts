/**
 * Lambda wiring kept separate from the entry module so it can be unit tested
 * with injected dependencies.
 */
import { describeError, peekJobId } from '@starter/domain';
import { lambdaCorrelation, type LambdaContextLike } from '@starter/observability';
import { processStep, type ProcessingOutput, type StepDeps } from './step.js';

export type ProcessorHandler = (
  event: unknown,
  context: LambdaContextLike,
) => Promise<ProcessingOutput>;

export function createHandler(getDeps: () => StepDeps): ProcessorHandler {
  return async (event, context) => {
    const deps = getDeps();
    const logger = deps.logger.child(lambdaCorrelation(context, { jobId: peekJobId(event) }));
    try {
      return await processStep(event, { ...deps, logger });
    } catch (error) {
      const { name, message } = describeError(error);
      logger.error({ errorName: name, errorMessage: message }, 'ProcessJob failed');
      throw error;
    }
  };
}
