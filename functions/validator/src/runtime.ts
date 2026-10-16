/**
 * Lambda wiring kept separate from the entry module so it can be unit tested
 * with injected dependencies.
 */
import { describeError, peekJobId } from '@starter/domain';
import { lambdaCorrelation, type LambdaContextLike } from '@starter/observability';
import { validateStep, type StepDeps, type ValidationSummary } from './step.js';

export type ValidatorHandler = (
  event: unknown,
  context: LambdaContextLike,
) => Promise<ValidationSummary>;

export function createHandler(getDeps: () => StepDeps): ValidatorHandler {
  return async (event, context) => {
    const deps = getDeps();
    const logger = deps.logger.child(lambdaCorrelation(context, { jobId: peekJobId(event) }));
    try {
      return await validateStep(event, { ...deps, logger });
    } catch (error) {
      const { name, message } = describeError(error);
      // Expected business rejections are info; everything else is an error.
      const level = name === 'JobValidationError' ? 'info' : 'error';
      logger[level]({ errorName: name, errorMessage: message }, 'ValidateJob failed');
      throw error;
    }
  };
}
