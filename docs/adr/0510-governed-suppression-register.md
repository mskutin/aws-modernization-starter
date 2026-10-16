# ADR 0510 — Governed suppression register for in-code policy acknowledgements

- Status: Accepted
- Related: ADR 0303 (cdk-nag 3 policy hook), ADR 0501 (policy engines),
  `docs/policy-as-code.md` ("Suppression register")

## Context

cdk-nag 3 findings are suppressed with `Validations.of(construct).acknowledge()`. A plain
`acknowledgeRule()` helper with a free-text reason, called on L2 constructs, has two problems:

1. **No governance.** Acknowledgement calls have no owner, review date or approval, while
   BASE-\* deviations go through `exceptions.yaml`; a full audit of the template suppressions
   cannot pass, so CI could only audit the baseline scope.
2. **Too broad.** cdk-nag treats an acknowledgement on a construct as covering every resource below
   it, and its metadata writer copies it into each of them. An `IAM5[Resource::*]` acknowledgement
   on a role also covered any later statement on `*` in that role; `RDS11` on the instance construct
   landed on the secret, the attachment and the subnet group.

The constructs are maintained separately from the policy pack, and their unit tests call `nagViolations()` without a synth,
so acknowledgements must still be applied while the construct is built.

## Decision

1. **A register of suppressions** (`policies/exceptions/suppressions.yaml`, schema in
   `policies/src/exceptions/suppressions.ts`). Each entry names the rule id with the cdk-nag finding,
   the **class** of the construct whose code acknowledges, the **exact resources** as paths relative
   to that construct, the environments, a justification, an owner, `reviewedAt` and `reviewBy`
   (≤ 180 days; after it the suppression no longer applies), and for `AwsSolutions-IAM5[Resource::*]`
   the exact actions allowed on `Resource: "*"` (each must be in the BASE-IAM-002 allowlist).
   BASE-\* findings stay governed exceptions (`exceptions.yaml`) and cannot be acknowledged in code.
2. **Resolution at the call site, by class and relative path.** `acknowledgeRule()` keeps its
   signature (no construct file changes). It resolves the one active entry for the rule whose class
   is an ancestor of the acknowledged construct and whose resources exist below it, then acknowledges
   **only those resources**. No entry, several entries, an overdue review or an environment the entry
   does not list throws. Class plus relative path works in the deployable apps and in construct unit
   tests with arbitrary construct ids; construct paths would not.
3. **Three independent checks:**
   - `BaselineSuppressionAudit`, a CDK validation plugin registered by `applyPolicyChecks()`, audits every
     acknowledgement in the construct tree at synth, including direct `Validations.acknowledge()`
     calls. It reports severity `fatal`, which CDK never lets an acknowledgement suppress.
   - `check-exceptions --templates infra/cdk.out` audits the `cdk_nag` metadata of every template.
     The default scope is `all`, so the CI job `policy:infra` runs the full audit.
   - `infra/test/acknowledgments.test.ts`: 1:1 raw findings ↔ acknowledgements on the exact resource
     across all deployable variants, no stale entries, no unused IAM5 actions.

## Consequences

- Subtree-wide suppressions become resource-exact ones, each backed by a register entry with an
  owner; `--audit-scope all` passes.
- Authors must add an entry in the same MR as a new `acknowledgeRule()` call; the thrown error prints
  a ready-to-fill entry. Renaming a construct id or class breaks its entry, by design.
- Review dates are hard for project entries: after `reviewBy`, synth fails until the owner renews
  the entry. CI warns 30 days ahead.
- Matching uses JavaScript class names. aws-cdk-lib renames decorated classes (`Topic` → `Topic2`),
  so library classes are also matched by their jsii type name. Minified infra code would break class
  matching; infra is not minified.
- The template audit can only check a path suffix, because templates carry no class names. The
  synth-time tree audit is exact.
- **Not a control against a malicious MR.** In GitLab CE an MR can edit the register and the checker.
  The Maintainer's merge is the approval. An entry in the MR is not one (approvals recorded outside the
  repository: `check-exceptions --approvals`, see `docs/policy-as-code.md`).

## Note: entry status

Both registers distinguish three kinds of entry (`docs/policy-as-code.md`, "Register entries"):

- `status: reference` — a deviation of the starter's own reference design. It is part of the code:
  undated, no approver, never expires, never scoped to the sandbox, names exact resources, and is
  pinned by the SHA-256 of its content in `policies/src/exceptions/reference-pins.ts`; an unpinned or
  edited reference entry fails (`UNPINNED_REFERENCE_ENTRY`) and waives nothing.
- project entries (no `status`) — an adopter's own waivers, dated, expiring and approvable as
  described above.
- `status: example` — shipped examples (the sandbox relaxations under
  `policies/exceptions/examples/sandbox/`) that nothing loads; a loaded example fails until a project
  adopts it as a dated project entry.
