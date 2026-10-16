/**
 * ValidateJob step logic — shared by the Lambda handler and the API's local
 * workflow simulator. Callers bind correlation fields (jobId, requestId) on
 * `deps.logger`.
 *
 * Spec 2.0.0 (ADR 0230): the event carries a job reference only. The step loads
 * the document from the system of record through `deps.documents` (claim check),
 * evaluates the business rules in memory and returns non-sensitive metadata.
 * Neither the document nor anything derived from it (word counts, sizes) is
 * logged, returned or written to the job-state store; rule violations are
 * reported by rule id (audit) and by content-free messages (JobValidationError).
 */
import {
  BUSINESS_RULES_VERSION,
  JobStateConflictError,
  JobValidationError,
  evaluateBusinessRules,
  parseExecutionInput,
  summarizeViolations,
} from '@starter/domain';
import type { DocumentSource } from '@starter/documents';
import { asWorkflowError, type JobStateStore, type StepOutcome } from '@starter/job-state';
import type { Logger } from '@starter/observability';
import { ProcessingState, WorkflowStatus } from '@starter/workflow-processing';

export interface StepDeps {
  store: JobStateStore;
  /** System of record of the submitted documents (PostgreSQL as `starter_processor`). */
  documents: DocumentSource;
  logger: Logger;
  now?: () => Date;
}

/** Step output: non-sensitive metadata only (discarded by the state machine). */
export interface ValidationSummary {
  jobId: string;
  valid: true;
  rulesVersion: string;
  /** True when this delivery was a duplicate of an already-validated job. */
  duplicate: boolean;
}

async function call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw asWorkflowError(error, operation);
  }
}

export async function validateStep(rawInput: unknown, deps: StepDeps): Promise<ValidationSummary> {
  const now = deps.now ?? (() => new Date());
  const input = parseExecutionInput(rawInput);
  const { jobId } = input;

  const audit = async (outcome: StepOutcome, detail?: string) => {
    try {
      await deps.store.appendStep({
        jobId,
        state: ProcessingState.Validate,
        at: now().toISOString(),
        outcome,
        detail,
      });
    } catch (error) {
      deps.logger.warn({ err: error }, 'step audit write failed (non-fatal)');
    }
  };

  const transition = await call('transition', () =>
    deps.store.transition(jobId, WorkflowStatus.Validating, now().toISOString()),
  );
  if (transition.kind === 'rejected') {
    const status = transition.state?.status;
    if (status === WorkflowStatus.Processing || status === WorkflowStatus.Succeeded) {
      // Validation already passed for this job: a late duplicate delivery. Nothing to load.
      await audit('duplicate');
      deps.logger.info({ duplicate: true }, 'document already validated');
      return { jobId, valid: true, rulesVersion: BUSINESS_RULES_VERSION, duplicate: true };
    }
    throw new JobStateConflictError(`cannot validate job ${jobId}: ${transition.reason}`);
  }
  const duplicate = transition.kind === 'noop';

  // Claim check: the document never travels with the workflow (DocumentUnavailableError is
  // permanent; TransientDependencyError is retried per spec).
  const document = await deps.documents.load(jobId);
  const evaluation = evaluateBusinessRules(document);

  if (!evaluation.ok) {
    const rules = evaluation.violations.map((v) => v.rule);
    await audit('failed', rules.join(','));
    deps.logger.info(
      { rules, rulesVersion: evaluation.rulesVersion },
      'document rejected by business rules',
    );
    throw new JobValidationError(summarizeViolations(evaluation.violations), evaluation.violations);
  }

  await audit(duplicate ? 'duplicate' : 'succeeded');
  deps.logger.info({ duplicate, rulesVersion: evaluation.rulesVersion }, 'document validated');
  return { jobId, valid: true, rulesVersion: evaluation.rulesVersion, duplicate };
}
