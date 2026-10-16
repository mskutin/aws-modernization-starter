# ADR 0502 — Offline FinOps gate and opt-in drift detection

- Status: Accepted (for this reference implementation)
- Related: `docs/finops.md`, ADR 0501

## Context

Merge requests must surface cost impact and destructive infrastructure
changes before deployment, in CI without AWS credentials. Drift between
deployed stacks and code can only be observed with credentials.

Options considered for cost: Infracost (no first-class CloudFormation/CDK
support, external pricing API), AWS Pricing API at run time (needs
credentials, non-deterministic), CloudFormation change sets (need a deployed
stack and credentials), and an offline estimator over a pinned price table.

## Decision

- `@starter/tool-finops` diffs base vs head **synthesized templates** offline and
  estimates monthly cost from a **dated, versioned price snapshot**
  (`tools/finops/pricing/ap-southeast-1.yaml`, transcribed from the public AWS
  Price List offer files on 2026-10-13) multiplied by an **explicit usage
  assumptions file**. Results are labelled as estimates, never live prices.
- Destructive changes (stateful removal, replacement-forcing property
  changes, retention weakening, deletion protection disabled) **always**
  require approval; cost increases require approval above per-environment
  absolute/percentage thresholds. Approval = MR label `finops-approved`
  (from `CI_MERGE_REQUEST_LABELS`). An approval variable is supported but not configured (a protected variable never reaches MR pipelines; an unprotected one approves every MR).
- `@starter/tool-drift` runs CloudFormation `DetectStackDrift` only with explicit
  opt-in **and** resolvable credentials; otherwise it reports
  `not-configured` (exit 3) and states that no drift check ran.

## Consequences

- Deterministic, testable, credential-free MR checks; price data must be
  refreshed manually (bump `version`/`capturedAt`).
- Replacement detection uses a curated table, not CloudFormation's change-set
  engine; it is conservative for the listed stateful types and not
  exhaustive.
- The MR label is an audit signal, not an authorization control; restrict
  approvers with GitLab approval rules.
