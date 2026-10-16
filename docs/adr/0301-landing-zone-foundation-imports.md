# ADR 0301 — Landing-zone foundation resources are imported, never created (sandbox is opt-in)

- Status: Accepted

## Context

Accounts in a governed AWS environment come with a landing zone: VPC and subnets, central KMS keys, DNS,
certificates, WAF, logging buckets, a mandatory permissions boundary and
mandatory tags. The application must consume these without owning them, must
synthesize offline (no `fromLookup`), and must not silently fall back to AWS
defaults that do not meet the landing zone's requirements.

## Decision

- `ILandingZoneFoundation` (`infra/constructs/foundation/types.ts`) is the only way
  stacks reach landing-zone resources. `ImportedLandingZoneFoundation` imports each item
  by explicit ID/ARN (`Vpc.fromVpcAttributes`, `Key.fromKeyArn`,
  `Certificate.fromCertificateArn`, `ManagedPolicy.fromManagedPolicyArn`, …).
  No context lookups exist in the codebase; a test asserts the cloud assembly
  has no missing context.
- A `FoundationProvider` gives each stack its own import (pure literals, no
  exports and no dependency cycles).
- `SandboxFoundation` (VPC with ingress/app/data tiers, flow logs, gateway
  endpoints, two rotating CMKs, an access-log bucket) is selected only with
  `-c foundationMode=sandbox`, and the schema rejects it for staging and prod.
  Consumers see its keys and bucket re-imported per stack, i.e. with exactly the
  semantics of real imported resources.
- Because CDK cannot modify imported key/bucket policies, the app never relies on
  resource-policy grants for foundation resources: IAM statements are explicit
  (e.g. `kms:Decrypt` via Secrets Manager for the ECS execution role), and the
  required key/bucket policies are documented in `docs/landing-zone-adaptation.md`.

## Consequences

- Real deployments need the inputs listed in landing-zone-adaptation.md §1; placeholders
  are syntactically valid so synth and tests run offline.
- The sandbox is useful for personal experiments only; it is not a landing zone.
- Explicit AZs (no `availability-zones` lookup) are configured for the sandbox VPC.
