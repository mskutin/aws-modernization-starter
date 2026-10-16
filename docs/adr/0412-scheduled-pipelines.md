# 0412 — Scheduled pipelines: rescan, stale resources, drift, sweep

- Status: Accepted (amended: generic runners, opt-in signing)

## Context

No schedule existed. New CVEs in shipped images went unnoticed between changes, and leftovers
(merged branches, unexpiring artifacts, old registry tags) accumulated unseen.

## Decision

Five pipeline schedules on the default branch, a protected ref; task jobs run on the runner selected
by `STARTER_PROTECTED_RUNNER_TAG` (the generic runner when empty). Each sets `SCHEDULE_TASK` (none for
the nightly full pipeline). Schedules are opt-in: a fresh project has none.

| Schedule                | Cron (UTC)    | `SCHEDULE_TASK` | Jobs                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starter: nightly full` | `0 1 * * *`   | —               | every job: full-history gitleaks, all tests, the release chain                                                                                                                                                                                                                                            |
| `starter: rescan`       | `0 2 * * *`   | `rescan`        | needs release signing: `container:rescan-verify:<id>` (signature + CycloneDX attestation of `:<default branch>` with the trust anchor; fails with "signing: not configured" otherwise) → `container:rescan:<id>` (Trivy on the image and on the SBOM attestation, today's DB; fixable HIGH/CRITICAL fail) |
| `starter: stale`        | `0 3 * * 1`   | `stale`         | `scheduled:stale-resources`: merged-but-undeleted and inactive branches, stale open MRs, artifacts without expiry, old registry tags; **report only**; findings exit 79 (allowed warning)                                                                                                                 |
| `starter: drift`        | `0 4 * * *`   | `drift`         | `aws:drift` only with `AWS_JOBS_ENABLED=true` and runner-mounted credentials; otherwise only `aws:status` ("not configured — not executed", a green report)                                                                                                                                               |
| `starter: sweep`        | `0 */6 * * *` | `sweep`         | `aws:sweeper` (dry run unless `SWEEP_APPLY=true`), same switch; otherwise only `aws:status`                                                                                                                                                                                                               |

Task pipelines run nothing else (`.rules:always` and the generated rules never run on a task). With
the gate policy installed, they also run the gate-integrity child. The stale report uses only the
job's own token, which can read the project's branches, MRs, jobs and registry (verified). Untagged
registry manifests are not visible through the API; the report says so.

## Consequences

- The nightly full pipeline is heavy (about 60 jobs) and should run when the runners are idle.
- Rescans fail when `:<default branch>` is not validly signed, i.e. when the last release chain did
  not complete. That failure is a finding in its own right.
- Schedules belong to the user who created them, and their pipelines run with that user's
  job-token permissions.
