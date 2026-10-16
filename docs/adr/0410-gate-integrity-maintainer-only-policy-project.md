# 0410 — Gate integrity: a Maintainer-only policy project via `ci_config_path`

- Status: Accepted (optional hardening)

## Context

On GitLab CE an MR controls every file that defines its own gates: the CI YAML, `components.yaml`,
`tools/impact`, the gate scripts, exception registers, the gitleaks config. CE has no protected CI
configuration, no compliance pipelines or frameworks, no enforced CODEOWNERS, no approval rules and
no push rules. A YAML-only "integrity job" inside the repository can be deleted by the same MR.

## Decision

1. **Mechanism (CE, Free tier).** A project's CI/CD configuration file is
   `projects/<slug>/gate-policy.yml@<group>/ci-policy`. The policy project is visible to every signed-in
   user (`internal`), so the pipeline user can read it; only Maintainers can push to its protected
   `main`. The entry file:
   - includes the project's own `.gitlab-ci.yml` from `$CI_COMMIT_SHA`, so MR pipelines still run
     the MR's jobs;
   - adds `policy:gate-integrity`, a bridge job whose child pipeline is compiled **only** from
     the policy project (`trigger:include:project`).
     In the bridge the policy pins `stage: .pre`, `needs: []`, `rules`, `allow_failure: false`,
     `inherit: false`, `strategy: depend` and `forward: false/false`. MR overrides of the bridge's keys
     (`allow_failure`, `variables`, `trigger:include`, `strategy`, `forward`) had no effect; attacker
     variables never reached the child (verified on a sandbox project).
2. **The check.** The child job (pinned node image, the project's default runner: untagged unless the
   policy was installed with `--runner-tag`) runs a POSIX script from the
   policy under `env -i`. It hashes `git ls-tree --full-tree HEAD -- <path>` (mode, type, object id)
   for every gate-defining path into a state id. It passes only if the id equals the default branch's
   **reference** state or a state a Maintainer **approved** for an open MR. Both are embedded in the
   child config. The verdict depends on no network answer and no MR-controlled file; the clone itself
   is content-addressed. A failed check fails the pipeline. `impact` needs the bridge (optionally, so
   pipelines without the policy still work) and every check needs `impact`, so all checks are
   skipped. Only the status reporters with `needs: []` still run. "Pipelines
   must succeed" then refuses the merge. The check does not stop MR code from running in MR
   pipelines (it always can); it stops a changed gate from counting as passed.
3. **Gate-defining paths** (in the policy, not the repo):
   - pipeline definition: `.gitlab-ci.yml`, `.gitlab/` (CI YAML, generated rules, SAST and Trivy
     exceptions, license policy, the adopter's `cosign.pub`), `components.yaml`, `tools/impact`,
     `tools/ci`;
   - scanner configs and policies: `.gitleaks.toml`, `.hadolint.yaml`, `policies/`,
     `infra/lib/policy-hook.ts`, `infra/lib/policy-options.ts`, `tools/finops/thresholds.yaml`,
     `tests/security`;
   - root configs: `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `eslint.config.js`,
     `.prettierignore`, `tsconfig.base.json`.
4. **Maintainer procedure** (`tools/ci/scripts/gate-admin.sh <command> --project P --policy-project G`,
   the GitLab API driver `tools/ci/src/gate-admin.ts` over `node tools/ci/src/cli.ts gate-policy`, run
   from a trusted checkout of `main` with the Maintainer's own token read from `GITLAB_TOKEN_FILE`;
   `GITLAB_URL` names the instance; the token is never printed or put on a command line):
   - `approve --project P --mr N --rerun`, after reviewing the MR's gate-path diff, records the MR
     head's state in the policy project and starts a new MR pipeline. A retried job keeps the old
     embedded policy, so a new pipeline is required.
   - `sync --project P`, after a merge, re-pins the reference to the default branch and drops
     approvals of merged or closed MRs. A revert to a superseded state is then blocked again.
   - `install --project P --set-ci-config-path` sets the project up.
   - `sync --adopt-default-paths --expect-head <sha>` switches to the path list committed at the
     reviewed default-branch commit. `--expect-head` is **required** (refused without it, and when
     the branch moved); removing a path needs `--allow-path-removal`; all approvals are dropped.
   - `status` shows the current state.
5. **Exception approvals** (`check-exceptions --approvals`): `gate-admin exceptions --file …` stores Maintainer-approved digests in the policy project and in
   the project file variable `STARTER_EXCEPTION_APPROVALS`, which `policy:<infra>` passes to
   `check-exceptions`.

## Proof (sandbox project, MRs by a Developer account)

In each MR the child pipeline failed, every job behind `impact` was skipped, and the MR showed `ci_must_pass`:

- the original demo: gitleaks `allow_failure: true`;
- (a) delete a gate job;
- (b) a gate script `exit 0`;
- (c) drop a component;
- (d) a self-approved exception;
- (e) replace the published signing key `cosign.pub`;
- (f) override the bridge job.

A benign gate change passes after `approve`. A non-gate change passes untouched. Unit tests run the
rendered script and assert the same results, including a blocked downgrade.

## What remains MR-controllable (honest limits)

- Everything outside the path list: application code and tests, per-package `package.json` scripts
  (e.g. `test:unit`), `vitest` configs. A Maintainer review at merge covers these; "pipeline must
  succeed" only proves that the MR's own definitions passed.
- The approval is a single Maintainer action. GitLab CE cannot require a second person, and a small
  team may have a single Maintainer. It is an out-of-band control, not four-eyes.
- Between a merge and the next `sync`, an MR that exactly restores the previous reference state
  would pass. Run `sync` after every merge of a gate change (part of the merge checklist).
- A Maintainer can change `ci_config_path` back. That is a Maintainer setting outside the MR, and it
  shows in the project's audit events.
- The child job runs on the project's default runner (MR pipelines have no other runner). It makes
  no network call for its verdict; its clone is content-addressed, so a tampered clone source can
  change the verdict only by serving the reviewed objects. Runner hardening is the operator's
  responsibility (ADR 0110).
