# ADR 0600 — Test layering: local workflow simulation plus an ephemeral real-AWS mini-stack

- Status: Accepted

## Context

The processing workflow runs on AWS Step Functions with Lambda tasks and native DynamoDB
service integrations. Developers and CI need fast, credential-free feedback, but nothing local
can execute Amazon States Language, IAM or the DynamoDB service integration faithfully.
Emulators (Step Functions Local, LocalStack) add a third behaviour that is neither the
production service nor the code under test, are not maintained at the same pace as the
service, and would make "green locally" mean "green in an emulator".

## Decision

1. The API's `WORKFLOW_MODE=local` adapter (in-process, same spec/handlers) is the only workflow
   used by the local stack, the integration suite and E2E. These suites are explicitly labelled
   as proving business behaviour and data layout, **not** Step Functions behaviour.
2. Real Step Functions behaviour is proven by `tests/aws-integration` against a per-run,
   TTL-tagged CDK mini-stack (`infra/bin/integration.ts`), opt-in via
   `AWS_INTEGRATION_ENABLED=true`, deployed/verified/destroyed by scripts with interruption
   traps, and backed by a scheduled sweeper that deletes expired `starter:ephemeral=true` stacks.
3. DynamoDB Local is used for local/CI state assertions; tests that touch eventually consistent
   behaviour (GSI) poll with deadlines so they hold on both DynamoDB Local and the service.
4. No Step Functions/LocalStack emulator is introduced.

## Consequences

- Fast local/CI suites with zero cloud cost; a clear, documented gap that only the AWS suite
  closes (ASL wiring, IAM, packaging, execution-name idempotency).
- The AWS suite costs a few cents per run and needs an OIDC role; it runs nightly, manually and
  on workflow/infra changes, not on every MR.
- Leaks are bounded by TTL tags + sweeper; `cleanup-status.json` makes every run auditable.
