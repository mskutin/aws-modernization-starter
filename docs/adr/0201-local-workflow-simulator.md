# ADR 0201 — In-process local workflow simulator instead of Step Functions Local

- Status: Accepted

## Context

Developers and the local E2E environment need the full submit → validate →
process → status loop without AWS. AWS Step Functions Local is unmaintained,
does not track current ASL features and still needs Lambda emulation; LocalStack
adds a heavy dependency and a licence question.

## Decision

`apps/api` has a `WorkflowPort` with two adapters:

- `StepFunctionsWorkflow` — `StartExecution` with the deterministic
  `executionNameFor(jobId)`; `ExecutionAlreadyExists` is treated as an
  idempotent start.
- `LocalWorkflowSimulator` (`WORKFLOW_MODE=local`) — runs the **same step code**
  the Lambdas run (`validateStep`, `processStep`), applies the spec's
  `TimeoutSeconds`, `Retry` (interval, back-off, max delay, FULL jitter,
  `MaxAttempts`) and catch-all, and writes RecordSuccess/RecordFailure with the
  same DynamoDB attributes as the state machine's native integration.

It logs `LOCAL SIMULATION — not AWS Step Functions` at start-up and for every
execution, and tags lines with `simulation: true`.

## Consequences

- Fast local loop and deterministic tests; business logic is exercised exactly.
- The simulator is **not evidence** of Step Functions behaviour: no durable
  history, no exactly-once state transitions, no Lambda service errors, no IAM,
  no ASL path/intrinsic evaluation. An execution in flight is lost on API restart
  (the job stays VALIDATING/PROCESSING). Deployed behaviour is verified by the
  CDK definition's tests and AWS integration tests, not by this adapter.
