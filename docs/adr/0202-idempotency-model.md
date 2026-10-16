# ADR 0202 — Layered idempotency for job submission and workflow steps

- Status: Accepted

## Context

Clients retry on timeouts, ALB/CloudFront may retry, and Step Functions/Lambda
deliver at least once. A retried submission must not create a second job, and a
duplicate step delivery must not corrupt state.

## Decision

1. **API key.** `Idempotency-Key` header (8–128 URL-safe chars) or, when absent,
   `derived:v1:<sha256(canonical JSON of the parsed request)>`. A request
   fingerprint (same hash) detects key reuse with a different body → `422`.
2. **Claim.** A conditional put of `IDEMPOTENCY#<key>` in DynamoDB (TTL 24 h,
   expired-but-undeleted records are treated as absent) assigns the job id.
3. **Durable guard.** PostgreSQL `jobs.idempotency_key` is unique; when the
   DynamoDB record has expired the API resolves the existing job from PostgreSQL
   and repairs the record.
4. **Resumable creation.** Business record insert (`ON CONFLICT DO NOTHING`),
   PENDING state (`attribute_not_exists`), workflow start (deterministic
   execution name) are each idempotent, so a retry after any partial failure
   (e.g. `503` from StartExecution) resumes the same job. Replays answer `200`
   with `Idempotent-Replayed: true`; first creation answers `202`.
5. **Steps.** State transitions are conditional on legal predecessors (and
   optionally `version`); re-entering the current status is a no-op. ProcessJob
   caches its result under `IDEMPOTENCY#step:<jobId>:ProcessJob` and returns it
   on duplicate delivery. Handlers therefore never need to throw
   `DuplicateExecutionError`.

## Consequences

- Without a header, identical documents with identical options map to one job —
  clients that want a re-run send a fresh `Idempotency-Key`.
- Server-generated keys contain `:` which the header pattern forbids, so client
  keys cannot collide with them.
