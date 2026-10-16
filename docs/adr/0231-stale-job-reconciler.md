# ADR 0231 — Bounded stale-job reconciler

- Status: Accepted

## Context

A job can stay non-terminal forever: `RecordFailure` itself fails (`RecordingFailed`), the API
crashes between creating the PENDING item and `StartExecution`, or an execution is aborted or
expires from the history. Clients would poll such a job indefinitely. The status index (`gsi1`,
`STATUS#<status>` / `<updatedAt>#<jobId>`) had no reader.

## Decision

1. **Exactly one reconciler per AWS environment:** a scheduled Lambda (`@starter/fn-reconciler`,
   EventBridge rate, default every 5 min, live alias, reserved concurrency 1, no asynchronous
   retries). The API runs an in-process loop **only** with `WORKFLOW_MODE=local` and a local/CI
   runtime (`RECONCILER_LOCAL_INTERVAL_SECONDS`, default 0 = off; configuration rejects it
   otherwise); it uses the simulator as the execution state and is correct for a single API
   process only.
2. **Candidates** are non-terminal jobs (PENDING, VALIDATING, PROCESSING) whose last transition is
   older than `RECONCILER_STALE_AFTER_SECONDS` (≥ 660 = execution timeout 600 s + 60 s grace;
   default 900), read oldest first from `gsi1` with a projection of id/status/time only, bounded by
   `RECONCILER_BATCH_SIZE` across statuses and by `RECONCILER_MAX_RUNTIME_SECONDS`. The index is
   only a candidate list.
3. **Per candidate:** consistent `GetItem` (skip if it moved on or became terminal) →
   authoritative execution state: `DescribeExecution` with `includedData: METADATA_ONLY` (no input,
   output or `kms:Decrypt`) by the recorded ARN of this state machine, else by the deterministic
   execution name → decision → `UpdateItem` conditioned on the observed **status and version**.
4. **Decisions** (one test each): RUNNING / PENDING_REDRIVE → never touched; FAILED / TIMED_OUT /
   ABORTED → FAILED (`ExecutionFailed` / `ExecutionTimedOut` / `ExecutionAborted`); PENDING without
   a recorded execution and none under the deterministic name → FAILED `WorkflowNotStarted` —
   **no restart** (no `StartExecution` or state-machine key permissions, no
   `ExecutionAlreadyExists` edge cases); no execution otherwise → FAILED `ExecutionNotFound`;
   SUCCEEDED with a PROCESSING item that holds the stored result → completed to SUCCEEDED (what
   `RecordSuccess` does; counted as an anomaly); SUCCEEDED otherwise → FAILED
   `ExecutionStateMismatch` (anomaly). Error names are fixed identifiers, messages fixed templates;
   the API shows clients its generic `ProcessingError` for all of them.
5. **Dependency failures:** any DynamoDB or Step Functions error or throttle stops the run with no
   transition, a `DependencyErrors` metric and an error log; the next scheduled run retries. Unknown
   execution statuses are treated the same way.
6. **Observability:** structured logs per decision with `actor: "system:reconciler"`, the job id,
   observed status/version and execution status — never document data; one CloudWatch Embedded
   Metric Format record per run (`Workload/Reconciler`, dimension `Environment`). Alarms:
   function errors, dependency errors on consecutive runs, anomalies, and "not running" (no
   invocation in three periods). `RECONCILER_DRY_RUN` reports decisions without writing.
7. **Least privilege:** `dynamodb:Query` on `gsi1`; `GetItem`/`UpdateItem` on the table restricted
   to `JOB#*` partition keys (`dynamodb:LeadingKeys`); KMS via DynamoDB only;
   `states:DescribeExecution` on this state machine's executions only; no database access. The
   execution-ARN wildcard is a governed suppression (SUP-0301).

## Consequences

- Writes are idempotent and safe under concurrency (a second run or a racing workflow loses the
  conditional write and is counted as a conflict); verified with the in-memory twin and against
  DynamoDB Local (real index query and conditional writes).
- Known limitation: `gsi1` puts each status into one partition key. The reader is small and bounded
  (non-terminal partitions only, `Limit` = batch); the write amplification of the index is
  unchanged. Sharding the key needs a spec change of the native record states and a backfill.
- A stuck job is closed at the earliest after the threshold plus one schedule period.
- **Not validated on AWS:** EMF extraction, the IAM conditions (`LeadingKeys`), `METADATA_ONLY`
  sufficing without `kms:Decrypt`, and the alarm behaviour. The opt-in AWS test
  (`tests/aws-integration/src/reconciler.aws.test.ts`) has not been run against AWS.
