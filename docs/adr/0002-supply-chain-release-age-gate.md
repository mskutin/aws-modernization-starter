# 0002 — Minimum release age for npm dependencies

- Status: Accepted

## Context

Compromised npm releases are typically detected and yanked within hours to days.
pnpm supports refusing versions younger than a configured age.

## Decision

`pnpm-workspace.yaml` sets `minimumReleaseAge: 4320` (3 days). Dependencies are
pinned to exact versions that satisfy it; the gate is never disabled to unblock work.
Build scripts are denied by default and allow-listed explicitly (`allowBuilds`).

## Consequences

- - Lowers exposure to freshly published malicious versions.
- − Urgent security patches younger than 3 days need an explicit, reviewed
  `minimumReleaseAgeExclude` entry with a justification in the MR.
