# ADR 0230 — Claim check: minimal workflow input, documents loaded from PostgreSQL

- Status: Accepted

## Context

Until spec 1.1.0 the API passed the submitted document (`payload: { title, content, options }`)
and the idempotency key (for derived keys a SHA-256 of the content) in the Step Functions
execution input. Step Functions keeps execution input, every state's input/output and error causes
in the execution history for 90 days — outside the retention and access controls of the data
stores — and writes them to CloudWatch Logs when execution-data logging is on. The processor also
returned its full analysis through `$.processing.resultJson`, so derived data took the same
path, and a step-level idempotency item cached it in DynamoDB.

## Decision

1. **Spec 2.0.0.** `ProcessingExecutionInput = { jobId, contractVersion, submittedAt }`.
   `assertExecutionInput`/`serializeExecutionInput` (spec) refuse anything else before
   `StartExecution` (Step Functions adapter, local simulator, fakes); the handlers' parser is
   strict (`Unrecognized key: "payload"` → permanent `JobValidationError`). The ASL forwards
   field by field exactly `TASK_EVENT_KEYS` (input + `executionArn`).
2. **Claim check from the system of record.** PostgreSQL already holds the document, so no copy
   is made (no S3 or DynamoDB staging). Validator and processor call
   `DocumentSource.load(jobId)` (`@starter/documents`), backed by
   `SELECT * FROM load_job_document($1)` as `starter_processor`: no table grant, one row, only for a
   job inside a 1-hour processing window (a SECURITY DEFINER function). The stored SHA-256 is
   verified after every load. "No row" (missing, purged, out of window), a purge marker or a hash
   mismatch is `DocumentUnavailableError` — permanent, never retried, non-sensitive message.
   Database errors are classified by `@starter/db` (`classifyDbError`): transient ones become
   `TransientDependencyError` (retried by the spec), everything else `DocumentSourceError`
   (not retried).
3. **Results never travel through Step Functions.** The processor stores the analysis on the
   job-state item itself (`storeResult`, at most once, only while PROCESSING); `RecordSuccess`
   only completes the transition and requires the stored result
   (`attribute_exists(resultJson)`); every FAILED transition removes it. Lambda task results are
   discarded (`ResultPath: null`) and contain only metadata (they still appear in the task
   history events). The step-level idempotency item (`IDEMPOTENCY#step:…`) is no longer written:
   duplicate deliveries are absorbed through the job-state item (and a stored result must match
   the document's hash). Derived results therefore live only in the job item and in API responses to the
   owner (the step item would be allowed too; it is simply no longer needed).
4. **Connections.** On AWS the Lambdas use RDS IAM authentication (a token per new
   connection, `@starter/db`), TLS `verify-full` against the RDS CA bundle copied into each function
   asset, a pool of one connection, and reserved concurrency in every environment sized so that
   validator + processor stay within `database.connectionLimits.processor` (minus 2). Client
   timeouts come from `STEP_CLIENT_SETTINGS`; spec tests assert that one attempt (cold start +
   connect + query + DynamoDB calls at their timeouts) fits inside each task timeout, so a slow
   dependency fails with a classified error rather than `States.Timeout`. ValidateJob's task
   timeout rose from 15 s to 20 s; the worst case is 511 s < 600 s execution timeout. RDS Proxy is
   the documented alternative for higher fan-out.
5. **Logs, errors, traces.** `title` (and `document`) are redacted by default
   (`@starter/observability`); workflow loggers also redact `payload`, `result`, `resultJson`,
   `topTerms`. Steps log rule ids and versions, never word counts or sizes. Error messages carry
   job ids, error codes and — for business-rule rejections shown to the submitter — counts (words,
   bytes, a control character's code point), never document text. No X-Ray SDK is used (no
   annotations or metadata).
6. **Attribution.** Workflow and reconciler transitions correlate to the submitter through
   `jobId` → `owner_id` in PostgreSQL; the input carries no principal.
7. **Rollout.** Nothing was ever deployed, so the first deployment has no input skew and
   the strict parser is safe. Future input changes follow expand/contract: handlers accept the old
   and the new shape for one release before the old one is dropped.

## Consequences

- The execution history, step outputs and execution logs contain job ids, timestamps, metadata
  and error causes only. Proof: synthesized ASL of every stage and the mini-stack, the API →
  workflow input (capturing port), canary runs through the API with the local simulation over
  real PostgreSQL + DynamoDB Local (logs, every DynamoDB item), Lambda step tests, and a fixture-
  tested history scanner used by the opt-in AWS suite.
- The Lambdas now depend on RDS: they run in the VPC, need egress to the database on 5432, and a
  database outage fails jobs after the spec's retries (transient errors are retried; the job is
  recorded FAILED otherwise). A document purged or older than the window can no longer be
  processed — by design.
- Error causes stored by `RecordFailure` may still include Lambda stack traces (code paths only).
- **Validated on AWS only once**, in a disposable sandbox deployment (IAM authentication,
  verify-full against the RDS bundle, execution histories scanned for document data). Not measured:
  IAM token generation and RDS IAM auth throughput, `load_job_document` latency. The mini-stack
  substitutes a test document table (ADR 0232).
