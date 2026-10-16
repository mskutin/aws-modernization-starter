# ADR 0300 — CDK app structure: one Stage per environment, config-driven, strong references

- Status: Accepted

## Context

The reference must deploy the same architecture to dev, staging and prod in
separate landing-zone accounts, synthesize offline in CI (no credentials) and stay
reviewable. Environment differences (sizes, Multi-AZ, retention, protection,
alarms, budgets) must not leak into construct code.

## Decision

- One `WorkloadStage` per environment (`Dev`, `Staging`, `Prod`) in a single
  CDK app (`infra/bin/app.ts`); `-c envs=` limits synthesis. Deploy with
  `cdk deploy '<Stage>/*'` from a pre-synthesized assembly.
- Seven stacks per stage, split by lifecycle and blast radius: `platform` (ECS
  cluster + ECR, deployed before any image reference), `data` (stateful),
  `workflow`, `migrations` (one-off schema migration task, run by the pipeline
  before the API rolls out), `api`, `frontend`, `observability`. References are
  passed explicitly as construct props.
- Environment configuration is plain TypeScript data validated by a zod schema
  with cross-field rules (`infra/environments/schema.ts`); invalid config fails
  synth with the offending path. Staging/prod guard rails live in the schema,
  not in constructs.
- Cross-stack references use classic CloudFormation exports
  (`@aws-cdk/core:defaultCrossStackReferences = "strong"`) instead of the newer
  recommended `"weak"` (`Fn::GetStackOutput`): exports block deleting a producer
  (e.g. the data stack) while consumers exist, and template-level policy tools
  understand `Fn::ImportValue`.
- All other CDK feature flags are the library's `recommended-feature-flags.json`
  for aws-cdk-lib 2.272.0, copied into `infra/cdk.json`; tests load the same
  context so they synthesize exactly like the CLI.
- Every stack sets `DefaultStackSynthesizer({ qualifier })` from config, explicit
  stack names (`<prefix>-<stack>`), stack-level tags (required with
  `explicitStackTags`) and termination protection outside dev.

## Consequences

- Changing an exported value (e.g. replacing the ALB) needs a two-step deploy;
  acceptable for a reference, documented in architecture.md.
- `cdk synth` always builds all three environments by default (≈ 5 s); CI can
  scope with `-c envs=`.
- ESM (`"type": "module"`) works with aws-cdk-lib and cdk-nag; the app runs as
  compiled JS (`node dist/bin/app.js`), so no ts-node/tsx is needed at deploy time.
