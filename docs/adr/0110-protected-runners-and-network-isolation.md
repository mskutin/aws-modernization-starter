# 0110 — Runner roles are optional tags; one generic runner by default

- Status: Accepted (amended: portable runner selection)

## Context

The pipeline must run on any GitLab (self-managed or GitLab.com) with one generic Docker-executor
runner and no project configuration. At the same time, two risks of a single shared runner remain real
for a project that signs releases or deploys to AWS:

- **Protected variables are ref-scoped, not runner-scoped** (ADR 0111): anything a protected-ref job
  can read, every job of that pipeline can read on any runner.
- **Service-alias impersonation.** When a runner puts every job on one user-defined network
  (`network_mode`), any job may start a service with `alias: gitlab` or `alias: registry`, and a
  concurrent job or helper can resolve the impostor. A stock Docker executor (links, or
  `FF_NETWORK_PER_BUILD`) scopes service aliases to the job.

An earlier reference platform solved both with three fixed runner roles on dedicated networks and
static host pins. That platform is not part of this repository; nothing in the pipeline may depend on
its runner names, networks, host pins or mounts.

GitLab expands CI/CD variables in `tags` with one level of substitution: a defined empty variable is
dropped (the job becomes untagged), an undefined one stays a literal `$NAME` tag that no runner has,
and a nested reference (`A: $B`) is not expanded (checked with a GitLab 19.4 pipeline dry run).

## Decision

1. **Runner selection by optional variables**, each defined in `.gitlab-ci.yml` with the empty
   default so it never stays a literal:

   | Variable                       | Jobs                                                                            |
   | ------------------------------ | ------------------------------------------------------------------------------- |
   | `STARTER_RUNNER_TAG`           | `default: tags`; explicitly the MiniStack jobs and `security:protected-secrets` |
   | `STARTER_RELEASE_RUNNER_TAG`   | image build chain (build, scan, SBOM, provenance)                               |
   | `STARTER_PROTECTED_RUNNER_TAG` | protected-ref-only jobs: publish, verify, chain report, schedule tasks, `aws:*` |
   | `STARTER_SIGNER_RUNNER_TAG`    | `container:sign` only                                                           |

   With nothing set every job is untagged and runs on the generic runner. `workflow:rules` set no
   tag (nested references would not expand). To build releases on a protected runner while MR
   builds stay on the default runner, `STARTER_RELEASE_RUNNER_TAG` is set as a **protected** project
   variable: GitLab then only provides it to protected-ref pipelines.

2. **Jobs that run MR code or services stay on the default runner explicitly**, never on a
   protected or signer tag (those runners may hold mounted credentials and should run no services).
3. **Opt-in hardening for adopters who sign or deploy** (docs/ci-cd.md §11): a signer runner
   and a protected runner registered as _Protected_ (`ref_protected`), locked to the project, not
   running untagged jobs, digest-pinned `allowed_images`, no services on the signer, a fresh volume per
   job. Those are runner-operator settings; the pipeline does not assume them, but the release chain
   report fails unless every chain job carried one of the configured protected tags.
4. **No bespoke runner assumptions in CI YAML.** No runner names, `network_mode`, `extra_hosts`,
   `allowed_services` expectations, privileged mode, sockets or runner-mounted paths outside the opt-in
   jobs; `tools/ci/test/ci-portability.test.ts` fails on any of them.

## Consequences and residual risk

- With one generic runner, MR jobs and protected-ref jobs share it. That is acceptable only because
  no secret exists in the default configuration: signing and AWS are opt-in and bound to their own
  runners (ADR 0111), and `security:protected-secrets` proves no signing/AWS variable name or
  runner-scoped mount reaches default-runner jobs.
- The `resource_group`s of service-backed jobs remain as a safety net for runners that share one job
  network; on a stock Docker executor they only serialise those jobs.
- Runner isolation (separate hosts or engines per role, network separation of runner managers) is the
  operator's responsibility and outside this repository.
