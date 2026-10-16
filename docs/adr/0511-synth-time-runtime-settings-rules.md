# ADR 0511 — Synth-time rules for deployed runtime settings, per-stage permissions boundaries

- Status: Accepted
- Related: ADR 0221 (RDS IAM authentication), ADR 0222 (PostgreSQL TLS), ADR 0510

## Context

Local compose and CI need relaxations a deployed workload must never have: an `http:` test issuer,
database TLS off, password database authentication. The runtime configuration gates all of them on
`APP_RUNTIME` (`aws` by default; CDK never sets it). We want proof at synth time
that no task definition or Lambda carries a relaxation, `DB_PASSWORD` or the RDS master secret.

The database bootstrap task is the one exception. It runs once as break-glass and reads the master
secret at runtime (`DB_AUTH=secrets-manager`, `DB_SECRET_ARN`).

Separately, BASE-IAM-004 was enforced with "any boundary" (`'*'`), and only when every selected stage
had one. A single boundary-less sandbox stage switched the check off for staging and prod in the same
synth.

## Decision

1. **Four baseline rules, in both engines** (cdk-nag pack and Guard), with fixtures and parity tests:
   - BASE-ECS-008 and BASE-LMB-007: no local/CI relaxations. Each flags:
     - `APP_RUNTIME` other than `aws`;
     - `AUTH_ALLOW_INSECURE_ISSUER`;
     - an `http:` issuer or JWKS URI;
     - `DB_SSL` other than `verify-full`, or missing next to `DB_HOST`;
     - `DB_PASSWORD` in the environment or in secrets.

     These rules have **no exemptions**.

   - BASE-ECS-009 and BASE-LMB-008: IAM database authentication. Each flags:
     - `DB_AUTH` other than `iam`, or missing next to `DB_HOST`;
     - a `DB_*SECRET*` variable;
     - a `DB_*` value injected from Secrets Manager.

     Only the bootstrap task may be exempted, and only by a governed exception on exactly its task
     definition.

   Severity `high` (blocking): exceptions need an owner and a ticket. An approver is required only
   for critical rules, and automation cannot supply one.

2. **A CDK test that traces the master secret** (`infra/test/baseline-policies.test.ts`).
   - It finds every `rds.DatabaseInstance` secret in the construct tree.
   - It follows the secret through in-stack `Ref`/`GetAtt` and cross-stack exports.
   - It fails when anything other than the database construct references it. The one allowed
     exception is a task exempted from BASE-ECS-009, together with its roles and policies.

   This catches references the name-based rules cannot see, such as a secret injected under another
   name or an IAM grant.

3. **Transitional exceptions must keep matching a finding.** When a configuration change has to
   land in steps, temporary governed exceptions waive exactly the findings that remain, with a short
   expiry. A test fails on any exception that no longer waives a finding, so the change that
   resolves a finding must also delete its exception.
4. **BASE-IAM-004 per stage.**
   - `baselinePolicyOptions()` returns `permissionsBoundaryFor`: each role must carry exactly the boundary
     its stage's configuration attaches.
   - A stage without a configured boundary is not applicable for its own roles only.
   - The pack gained the `permissionsBoundaryFor` option; `permissionsBoundaryArn` (`'*'` or a fixed
     ARN) still works for other apps.

## Consequences

- A relaxation added by mistake to any CDK construct fails `cdk synth` (cdk-nag), the Guard job and
  the infra tests, whichever runs first.
- The database and workflow code must set `DB_AUTH=iam` and `DB_SSL=verify-full` explicitly
  wherever they set `DB_HOST`. Relying on defaults is rejected.
- The bootstrap task needs a governed exception for BASE-ECS-009, renewed at least every 180 days.
- `http:` checks see only literal strings. An issuer assembled from intrinsics is not checked at
  template level; the runtime config check (`APP_RUNTIME=aws` requires `https:`) still applies.
- BASE-IAM-004 also catches a role whose boundary differs from the configured one, not only a
  missing boundary.

## Amendment: client allow-list

`APP_RUNTIME=aws` requires `AUTH_ALLOWED_CLIENT_IDS`: an empty list accepts the tokens of every
OAuth client of the issuer. BASE-ECS-008 therefore also requires the variable,
with at least one non-blank comma-separated entry, on every container that verifies tokens
(`AUTH_ISSUER` or `AUTH_AUDIENCE` in its environment). A deployment without it would crash-loop on
start-up; synth fails first. A value CloudFormation resolves at deploy time (an intrinsic, or an
ECS secret from SSM) cannot be evaluated and is accepted; the API's own start-up refusal remains the
backstop. Containers that verify no tokens (migrations, bootstrap, retention) are out of scope.
