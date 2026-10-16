/**
 * ProcessJob step logic — shared by the Lambda handler and the API's local
 * workflow simulator. Callers bind correlation fields on `deps.logger`.
 *
 * Spec 2.0.0 (ADR 0230): the event carries a job reference only. The step loads
 * the document through `deps.documents` (claim check, SHA-256 verified),
 * computes the deterministic analysis in memory and stores the result on the
 * job-state item itself (`storeResult`, at most once). Neither the document nor
 * the result passes through Step Functions: the step returns non-sensitive
 * metadata, and RecordSuccess (native DynamoDB integration on AWS) only
 * completes the transition — conditional on the stored result.
 *
 * Duplicate deliveries are absorbed through the job-state item: an already
 * stored result is kept (and checked against the document's hash), a job that
 * already SUCCEEDED is reported as a duplicate.
 */
import { JobResultSchema } from '@starter/contracts';
import {
  ANALYSIS_ALGORITHM_VERSION,
  JobStateConflictError,
  analyzeDocument,
  parseExecutionInput,
} from '@starter/domain';
import type { DocumentSource, StoredDocument } from '@starter/documents';
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
export interface ProcessingOutput {
  jobId: string;
  /** The result is stored on the job-state item (always true when the step returns). */
  resultStored: true;
  algorithmVersion: string;
  /** True when an earlier delivery had already stored the result (or completed the job). */
  duplicate: boolean;
}

async function call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw asWorkflowError(error, operation);
  }
}

/** A stored result must belong to this very document (same SHA-256 of the content). */
function assertResultMatches(jobId: string, resultJson: string, document: StoredDocument): void {
  let checksum: string | undefined;
  try {
    const parsed = JobResultSchema.safeParse(JSON.parse(resultJson));
    checksum = parsed.success ? parsed.data.checksumSha256 : undefined;
  } catch {
    checksum = undefined;
  }
  if (checksum !== document.contentSha256) {
    throw new JobStateConflictError(`stored result of job ${jobId} does not match its document`);
  }
}

export async function processStep(rawInput: unknown, deps: StepDeps): Promise<ProcessingOutput> {
  const now = deps.now ?? (() => new Date());
  const input = parseExecutionInput(rawInput);
  const { jobId } = input;
  const output = (duplicate: boolean): ProcessingOutput => ({
    jobId,
    resultStored: true,
    algorithmVersion: ANALYSIS_ALGORITHM_VERSION,
    duplicate,
  });

  const audit = async (outcome: StepOutcome) => {
    try {
      await deps.store.appendStep({
        jobId,
        state: ProcessingState.Process,
        at: now().toISOString(),
        outcome,
      });
    } catch (error) {
      deps.logger.warn({ err: error }, 'step audit write failed (non-fatal)');
    }
  };
  const duplicateDelivery = async (why: string) => {
    deps.logger.info({ duplicate: true }, why);
    await audit('duplicate');
    return output(true);
  };

  // 1. Enter PROCESSING (no-op when a retry re-enters it).
  const transition = await call('transition', () =>
    deps.store.transition(jobId, WorkflowStatus.Processing, now().toISOString()),
  );
  if (transition.kind === 'rejected') {
    if (transition.state?.status === WorkflowStatus.Succeeded) {
      return duplicateDelivery('duplicate ProcessJob delivery; job already succeeded');
    }
    throw new JobStateConflictError(`cannot process job ${jobId}: ${transition.reason}`);
  }

  // 2. Claim check: load and verify the document (never logged or returned).
  const document = await deps.documents.load(jobId);

  // 3. An earlier delivery already stored the result: keep it.
  if (transition.state.resultJson !== undefined) {
    assertResultMatches(jobId, transition.state.resultJson, document);
    return duplicateDelivery('duplicate ProcessJob delivery; result already stored');
  }

  // 4. Deterministic analysis (pure), stored on the job-state item at most once.
  const resultJson = JSON.stringify(analyzeDocument(document.content, document.options));
  const stored = await call('storeResult', () => deps.store.storeResult(jobId, resultJson));
  if (stored.kind === 'rejected') {
    throw new JobStateConflictError(`cannot store the result of job ${jobId}: ${stored.reason}`);
  }
  if (stored.kind === 'exists') {
    // A concurrent delivery won the conditional write; its result must be for the same document.
    assertResultMatches(jobId, stored.state.resultJson ?? '', document);
    return duplicateDelivery('concurrent ProcessJob delivery stored the result first');
  }

  await audit('succeeded');
  deps.logger.info(
    { algorithmVersion: ANALYSIS_ALGORITHM_VERSION, duplicate: false },
    'document processed; result stored',
  );
  return output(false);
}
