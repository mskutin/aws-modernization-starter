# ADR 0501 — Policy-as-code engines: cdk-nag pack + CloudFormation Guard

- Status: Accepted (for this reference implementation)
- Related: `docs/policy-as-code.md`, `docs/finops.md`, ADR 0502

## Context

The reference needs a security and compliance baseline that is enforced
before deployment, testable offline (no AWS credentials in CI), and honest
about its status: it is a **proposed baseline**, not an approved control set
of any organization or regulator. The infrastructure applies cdk-nag `AwsSolutionsChecks` through
`infra/lib/policy-hook.ts`; we need project-specific rules on top, with a
governed exception process.

Candidates evaluated against aws-cdk-lib 2.272/2.273, cdk-nag 3.0.2 and
cfn-guard 3.2.1 (the current releases when the decision was made):

| Option                                                                                                                         | Strengths                                                                                                                                                                               | Weaknesses                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Native CDK validation** (`Validations`, built-in `CloudFormationValidatePlugin`, `@aws/cloudformation-validate` WASM engine) | Runs on every synth; cfn-lint-style schema/semantic checks; can host custom Rego/CEL/Guard rules in-process; acknowledgements built in                                                  | Default rule set is schema/semantics, not security policy; errors are downgraded to warnings unless a feature flag is set; embedded Guard evaluator is a different build from the `cfn-guard` CLI |
| **cdk-nag 3.x custom `NagPack`**                                                                                               | Construct paths, CDK acknowledgements (`Validations.of().acknowledge`), environment context, synth-time feedback for developers; same mechanism C already uses                          | Only sees CDK apps; in-code acknowledgements could bypass governance; v3 changed APIs (validation plugin, no `NagSuppressions`)                                                                   |
| **CloudFormation Guard (CLI)**                                                                                                 | Engine-independent, evaluates the _synthesized_ templates exactly as deployed; also covers non-CDK templates; unit-test runner (`cfn-guard test`); single static binary for linux/arm64 | DSL subtleties (empty filters skip, `or` messages); no construct context; needs a pinned binary in CI                                                                                             |
| **OPA / Rego (conftest)**                                                                                                      | General-purpose, rich language                                                                                                                                                          | Third language and toolchain for no extra coverage here; no CloudFormation-specific test harness; duplicate of Guard's role                                                                       |

## Decision

1. **Rules are implemented once in TypeScript** as pure functions over the
   synthesized CloudFormation JSON (`policies/src/rules/*.ts`) and wrapped as
   the cdk-nag v3 pack **`BaselineChecks`**, registered through
   `applyBaselinePolicies()` (or C's `applyPolicyChecks({ additionalPacks })`).
   Evaluating the rendered template (not L2/L1 props) means tags added by
   Aspects, escape-hatch overrides and resolved tokens are all visible.
2. **CloudFormation Guard 3.2.1** re-implements the same rule IDs
   (`policies/guard/rules/*.guard`, 42 of 43 rules) and runs in CI over
   `infra/cdk.out/**/*.template.json` as an **independent second line**. It
   ignores in-code acknowledgements and applies only governed exceptions
   from `policies/exceptions/exceptions.yaml`, so an ungoverned
   `Validations.acknowledge()` still fails CI.
3. **Shared fixtures** (`policies/test/fixtures/cases.ts`) drive TS rule
   tests, cdk-nag tests (via `CfnInclude`), generated `cfn-guard test` suites
   and a **parity test** that requires both engines to agree on every rule
   for every fixture and on real CDK-synthesized templates.
4. Keep CDK's built-in `CloudFormationValidatePlugin` at its defaults (C's
   decision); we do **not** load our Guard rules into it, to avoid double
   reporting and to keep the second line on the independently released CLI.
5. **OPA/Rego is not used.**

## Consequences

- Two implementations per rule (TS + Guard) — mitigated by shared fixtures
  and the parity test; constants (IAM allowlist, runtimes, tagged types) are
  checked for drift between engines.
- BASE-IAM-004 (permissions boundary) is cdk-nag only because the boundary
  ARN is deployment configuration.
- CI must install a pinned, SHA-256-verified `cfn-guard` binary
  (`policies/scripts/install-cfn-guard.sh`; static aarch64 Linux build).
- cdk-nag 3 reports through CDK's validation report
  (`cdk.out/validation-report.json`) rather than annotations; low-severity
  rules are warnings and do not fail synth.
- `@starter/policies` must use the same exact `aws-cdk-lib` version as `infra`
  (two CDK copies at synth time break construct checks).
