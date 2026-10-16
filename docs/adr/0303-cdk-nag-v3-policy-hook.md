# ADR 0303 — cdk-nag 3 as CDK validation plugins; specific, audited acknowledgments

- Status: Accepted

## Context

cdk-nag 3.x (3.0.2) no longer uses Aspects or `NagSuppressions`. Packs implement
CDK's `IPolicyValidationPlugin` and are registered with
`Validations.of(app).addPlugins(...)`; suppressions are
`Validations.of(construct).acknowledge({ id, reason })`. **Any** unacknowledged
finding — warning or error — fails `cdk synth`. Aspects also do not cross Stage
boundaries, which matters for app-level hooks.

## Decision

- `infra/lib/policy-hook.ts#applyPolicyChecks(app, { additionalPacks })` registers
  `AwsSolutionsChecks` plus any extra packs (instances or `scope => pack`
  factories — the infra app wires `@starter/policies` here) and adds cdk-nag's
  metadata writer to the app **and every nested Stage**, so templates carry
  `Metadata.cdk_nag.rules_to_suppress` for template-level tools.
- Acknowledgments go through `acknowledgeRule(construct, ruleId, reason)` (one
  rule or one `Rule[finding]`, reason ≥ 20 chars, rejected wildcards),
  `acknowledgeAnnotation` (CDK warnings) and `acknowledgeCfnValidate`
  (CloudFormation Validate codes). Each call is recorded.
- A test builds every deployable variant with acknowledgments disabled and
  requires a 1:1 match between raw findings and recorded acknowledgments — no
  unacknowledged findings and no stale suppressions.

## Consequences

- Policy packs written for cdk-nag 2 (Aspects, `NagSuppressions`) do not work;
  `@starter/policies` must extend cdk-nag 3's `NagPack` (`checkResource`,
  `applyRule`).
- Findings fail fast at synth in every pipeline job that synthesizes.
