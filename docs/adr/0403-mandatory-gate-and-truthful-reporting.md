# ADR 0403 — Mandatory gate with success markers; nothing unconfigured passes as a check

- Status: Accepted (amended: status reports of unconfigured opt-ins are green)

## Context

With impact-selected jobs, "all jobs in the pipeline passed" is not the same as "every
job this change requires passed". Several jobs depend on optional configuration
(AWS credentials, Cosign key, registry, LLM endpoint) and must not look successful
when they did nothing.

## Decision

- Gated jobs extend `.gated`: on success `after_script` writes a dotenv marker
  `GATE_<CI_JOB_ID>=<CI_JOB_NAME>`. `gates:mandatory` (generated) `needs` all gated jobs
  with `optional: true` and runs `tools/impact gate`, which fails if any job required
  by the runtime impact analysis has no marker (matrix jobs must report every instance).
- Integration tests, publication, AI review and the human approval run after the gate.
- Optional capabilities (AWS jobs, release signing, AI review) are **opt-in**. When not
  configured their check jobs do not exist, so nothing can pass in their name. A status job
  (`aws:status`, `release:status`) states it in plain words ("aws: not configured — not
  executed", "signing: not configured — published images are UNSIGNED") and is green: reporting
  is its whole job. A fresh project therefore has no warnings for features it never asked for.
- Opted in but incomplete is never green: a warning with a dedicated exit code and
  `allow_failure:exit_codes` (78; `tool-drift` 3) where the capability is advisory
  (`review:ai-status`), a failure where it must not be mistaken for a pass (`release:status`
  with signing enabled but its runners or registry missing; sign/verify without key or anchor).
- A deliberate coverage reduction (`STARTER_CONTAINER_BUILD=false`) is always a warning and a
  notice in the impact report and the gate.
- Status artifacts list which variables are missing (names only; non-secret switches and runner
  tags with their values).

## Consequences

- A fresh project's pipeline is green while optional features are unconfigured, and every
  pipeline says which ones are; "passed with warnings" means something was opted in but is
  incomplete, or coverage was reduced on purpose.
- Gated jobs must not override `after_script` (documented in the template).
