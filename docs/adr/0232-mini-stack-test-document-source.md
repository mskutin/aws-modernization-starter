# ADR 0232 — The integration mini-stack reads synthetic documents from a test table

- Status: Accepted

## Context

Since spec 2.0.0 (ADR 0230) the handlers load documents by job id from PostgreSQL. The ephemeral
AWS integration mini-stack (`infra/bin/integration.ts`, ADR 0600) has no RDS: adding an instance,
a VPC with endpoints, a role bootstrap and a seeding path the CI runner could reach would make every
run slow and costly, and exposing the database to the runner is not acceptable.

## Decision

- The mini-stack deploys a **TEST-ONLY** DynamoDB table (`<prefix>-test-documents`, ephemeral CMK,
  destroyed with the stack) and **separate handler entry modules**
  (`functions/{validator,processor}/src/integration-handler.ts`, selected by
  `resolveHandlerEntries(…, 'integration')`). They run the same step code with
  `DynamoDbTestDocumentSource` (`@starter/documents/test-table`), which applies the same purge and
  SHA-256 verification as the PostgreSQL source. The AWS tests seed synthetic documents there.
- The environment stages never deploy that table or those entries: infra tests assert that no
  stage function carries `TEST_DOCUMENTS_TABLE_NAME` and that the stages' functions use
  `DB_USER=starter_processor`, `DB_AUTH=iam`, `DB_SSL=verify-full`.

## Consequences

- The AWS suite exercises the minimal input, the ASL, IAM to DynamoDB/Step Functions, packaging and
  the leakage of the execution history (canary scan of `GetExecutionHistory`) — not RDS document
  retrieval (IAM auth, verify-full, `load_job_document`, the security-group path). Those are first
  exercised by a sandbox **stage** deployment; the AWS sandbox test plan must include them.
- The test table holds synthetic canary data only; it is a copy by design, of test data.
