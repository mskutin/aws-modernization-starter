# Supply-chain and CI security

Pipeline mechanics: [ci-cd.md](ci-cd.md). Infrastructure policy-as-code (cdk-nag pack,
CloudFormation Guard, governed exceptions, FinOps): [policy-as-code.md](policy-as-code.md) and [finops.md](finops.md).
Application security (authentication, authorization, database identities, TLS):
[architecture.md](architecture.md) §4 and the ADRs it links. Reporting a vulnerability:
[SECURITY.md](../SECURITY.md).

Design records: ADR [0110](adr/0110-protected-runners-and-network-isolation.md) (runner selection),
[0111](adr/0111-runner-scoped-secrets-and-key-custody.md) (secrets, key custody),
[0410](adr/0410-gate-integrity-maintainer-only-policy-project.md) (gate integrity),
[0411](adr/0411-protected-release-chain-sign-and-verify.md) (release chain, sign, verify),
[0412](adr/0412-scheduled-pipelines.md) (schedules).

## 1. Principles

1. **Deterministic gates are authoritative.** Every blocking decision is made by a reproducible tool
   with a pinned version and pinned rules. AI review, when enabled, is advisory.
2. **Fail safe, fail loud.**
   - Unknown change scope runs everything.
   - An unmapped path, a stale generated configuration or an unpinned image fails.
   - An optional capability that is not configured has no check job at all; a status job says so in
     plain words. An opted-in capability that is incomplete warns or, where it could be mistaken for
     a pass (signing without a key or trust anchor), fails.
3. **Least privilege.**
   - Non-privileged jobs, no container socket, no Docker-in-Docker.
   - Tokens scoped to one purpose.
   - Secrets, when an adopter adds any, are bound to the jobs that need them (runner-mounted files),
     never to every job of a ref.
4. **Exceptions are data with an expiry.** Trivy ignores, license exceptions and SAST register
   waivers carry a justification and an expiry, enforced by `supply-chain:lint`; expired entries
   stop applying, so the finding blocks again. CI image release-age exceptions only bridge the
   14-day window (§2). Reviewed false positives in code are suppressed inline with a rule id and a
   reason instead (§6).

## 2. Pinning

| What                   | How                                                                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI images              | `.gitlab/ci/images.yml`: `<registry>/<repo>:<version>@sha256:<multi-arch index digest>`, each with `linux/amd64` and `linux/arm64`. `supply-chain:lint` fails on any `image:`/`services:` that does not resolve to that form.                                                      |
| Dockerfile base images | `ARG …_IMAGE=<ref>:<tag>@sha256:…` (Node.js 24 build stage, distroless `nodejs24-debian13:nonroot` runtime); linted the same way.                                                                                                                                                  |
| Node.js / pnpm         | Node.js version in `.node-version`, the image tags and `engines` (`pnpm install` refuses another major, `engineStrict`); pnpm from `packageManager` — via corepack in CI images, `npm exec --yes pnpm@12.11.2` locally — recorded with per-platform integrity in `pnpm-lock.yaml`. |
| npm dependencies       | `pnpm install --frozen-lockfile` everywhere; `minimumReleaseAge` (3 days) in `pnpm-workspace.yaml`; install scripts denied except `esbuild`/`lefthook`, and CI installs and the image build run with `--ignore-scripts`.                                                           |
| Downloaded binaries    | cfn-guard (`policies/scripts/install-cfn-guard.sh`, SHA-256 verified). No other binary downloads in jobs.                                                                                                                                                                          |
| Scanner rules          | the GitLab SAST analyzer image digest pins the Semgrep version and the GitLab `sast-rules`; gitleaks default rules come from the pinned gitleaks version plus `.gitleaks.toml`.                                                                                                    |
| Git hooks              | fall back to the **same** pinned images (read from `images.yml`).                                                                                                                                                                                                                  |

Updating a pin: choose a release at least ~2 weeks old, resolve the index digest, confirm both
architectures, update `images.yml` (or the Dockerfile `ARG`), run the pipeline. A younger release
needs an entry in `.gitlab/security/image-age-exceptions.yaml` naming the exact pinned value, its
release date and the approver; `supply-chain:lint` fails if the pin changes under the entry, and the
entry cannot outlive the age rule. An exception is consulted only while the pinned release is younger than 14 days; an entry that
expires while the release is still younger is an error, and once the release is 14 days old the
entry is reported as a warning to delete it — nothing fails merely because time passed. The rule is only
enforced for pins that have such an entry (the lint has no release dates for the others).

## 3. Runners and trust boundaries (ADR 0110)

By default every job runs on **one generic runner**: a Docker executor without privileged mode,
without a container socket and without runner-mounted files. With no secret in the default
configuration, merge-request jobs and default-branch jobs can safely share it.

Runner **roles** exist only for adopters who opt in to release signing or AWS jobs. They are selected
by optional tag variables (all empty by default, so every job is untagged):

| Variable                       | Jobs                                                                                        | Recommended runner settings when used                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STARTER_RUNNER_TAG`           | every ordinary job, explicitly the MiniStack jobs and `security:protected-secrets`          | generic runner; no mounts                                                                                                                                |
| `STARTER_RELEASE_RUNNER_TAG`   | image build chain (build, scan, SBOM, provenance); set as a protected variable for releases | a runner that can run rootless Buildah                                                                                                                   |
| `STARTER_PROTECTED_RUNNER_TAG` | publish, verify, chain report, schedule tasks, `aws:*`                                      | _Protected_, locked to the project, no untagged jobs, digest-pinned `allowed_images`, fresh volumes; mounts the public key (and AWS credentials if used) |
| `STARTER_SIGNER_RUNNER_TAG`    | `container:sign` only                                                                       | _Protected_, locked to the project, cosign image only, no services, fresh volumes; mounts the signing key                                                |

- **Jobs that run merge-request code or start services stay on the default runner** explicitly and
  never use the protected or signer tags, so they never reach a runner that holds a key or
  credentials.
- **No bespoke runner assumptions in CI YAML.** No runner names, `network_mode`, `extra_hosts`,
  privileged mode, sockets or runner-mounted paths outside the opt-in jobs;
  `tools/ci/test/ci-portability.test.ts` fails on any of them.
- **Service-alias impersonation.** On a runner that puts every job on one user-defined network, a
  job could start a service with the alias of another job's service. A stock Docker executor scopes
  aliases to the job; the service-backed jobs also use `resource_group`s as a safety net.
- **Runner isolation** (separate hosts or engines per role, network separation of runner managers,
  kernel and engine hardening) is the operator's responsibility and outside this repository. A
  signature shows that the protected chain saw a digest; it cannot show that the engine running the
  chain was not compromised.

Rootless Buildah needs nothing extra in a job on an engine that allows unprivileged user namespaces
(ADR 0402). Where the engine's seccomp/AppArmor profile blocks them, the build fails with a
diagnosis; the options are in [ci-cd.md](ci-cd.md) §11.

## 4. Secrets: bound to jobs, never to refs (ADR 0111)

- **No secret is a GitLab CI/CD variable** in the default configuration, and signing keys and AWS
  credentials never should be: a protected variable reaches every job of a protected-ref pipeline on
  any runner. When an adopter opts in:
  - the Cosign key and its password are files mounted read-only only into signer-runner jobs;
  - the trust anchor (public key) and AWS credentials are mounted only into protected-runner jobs;
  - both live in an operator-only directory on the runner host (directories 0700, files 0600).
- **Proof.** `security:protected-secrets` runs on the default runner in every pipeline and is
  required by `gates:mandatory`. It fails on any `COSIGN_*`, `AWS_*` (region and the
  `AWS_JOBS_ENABLED` switch excepted) or `STARTER_SIGNING_*` variable name, or on any runner-scoped
  mount, and reports names only. With signing enabled, the chain report records that every chain job
  ran on a configured protected or signer tag.
- **Tokens.** `CI_JOB_TOKEN` is used for clones, artifacts, registry pushes and the read-only API calls
  of the chain and stale reports. Maintainer tooling (gate integrity) reads its API token from a file
  of mode 0600 and never puts it on a command line. The only masked CI/CD variables the pipeline
  knows are the optional AI review tokens (§10).
- **Logs.** Status jobs print variable presence, never values. The signing script never traces
  (`set +x`). The AI review log is not kept as an artifact.
- **OIDC.** GitLab `id_tokens` → AWS STS is preferable to static credentials, but needs an issuer AWS
  can reach. Runner-mounted least-privilege credentials are the documented fallback for a GitLab on a
  private network.
- **Key rotation and revocation:** ADR 0111.

## 5. Image build, SBOM, provenance, signing, verification (ADR 0411)

- **Build** (`container:build:<id>`): Buildah in a non-privileged job,
  `--isolation chroot --storage-driver vfs`, reproducible (`--source-date-epoch` = commit time,
  `--rewrite-timestamp`). The runtime image is distroless, runs as uid 65532 and has no shell or
  package manager; the build fails if `USER` is root.
- **Where.** Merge-request pipelines build, scan and describe an **unsigned** image on the default
  runner and never publish, sign or verify. On protected release refs the chain runs on the runner
  selected by `STARTER_RELEASE_RUNNER_TAG` (the default runner if unset) from a fresh clone.
- **Scan.** Trivy (vulnerabilities and embedded secrets) on the archive; the gate is HIGH/CRITICAL
  with a fix available; the JSON report keeps everything.
- **SBOM.** Syft → CycloneDX JSON and SPDX JSON.
- **Provenance.** An in-toto Statement v1 with a SLSA Provenance v1 predicate whose subject is the
  image digest. The statement is unsigned unless signing is enabled, in which case the signing job
  attests it. No SLSA build level is claimed.
- **Publish** (protected refs with the project registry enabled): `skopeo copy --preserve-digests` to
  `$CI_REGISTRY_IMAGE/<name>:<sha>` plus a moving tag; every tag is re-read and must equal the built
  digest. Without signing, `release:status` reports "signing: not configured — published images are
  UNSIGNED".
- **Sign** (opt-in, `STARTER_RELEASE_SIGNING=true`, signer runner): `cosign sign` of the published
  digest, then `cosign attest` of the SLSA provenance and the CycloneDX SBOM with the runner-mounted
  key. `--tlog-upload=false`: no transparency log; signatures are OCI referrers next to the image.
  Anything missing fails the job.
- **Verify** (opt-in with signing, protected runner, a separate job):
  - trust anchor = the runner-mounted public key, and the committed `.gitlab/security/cosign.pub` must
    match it;
  - the signature covers the built digest, and the `:<sha>` tag resolves to it;
  - both attestations name the built digest, and the provenance names the commit;
  - an unsigned artifact of the same repository and an unrelated key are both rejected (negative
    controls inside the job).
- **Chain report** (opt-in with signing): runner tags and fresh-clone evidence of every chain job.
- **What this does not prove.** Signing in the pipeline proves nothing about enforcement at
  deployment: no ECR policy, deploy gate or admission controller verifies these signatures in this
  repository.

## 6. Scanning and policy gates

| Area            | Tool / job                                | Blocks on                                                                  | Exceptions                                                                                                                                                                                                                                                                                            |
| --------------- | ----------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets         | gitleaks (`secrets:gitleaks`, pre-commit) | any finding                                                                | `.gitleaks.toml`; a test requires any allowlist to be described and rule- and match-scoped                                                                                                                                                                                                            |
| SAST            | GitLab Semgrep analyzer (`sast:semgrep`)  | Critical/High                                                              | inline `// nosemgrep: <rule id> -- <reason>` by the code owner (a test rejects a bare or multi-rule `nosemgrep`); the expiring register `.gitlab/security/sast-exceptions.json` (empty as shipped) binds a waiver to rule + path + **code fingerprint** (whole-file entries fail `supply-chain:lint`) |
| SCA             | Trivy fs on the lockfile (`sca:trivy-fs`) | fixable HIGH/CRITICAL (production and development dependencies)            | `.gitlab/security/trivyignore.yaml` (`expired_at`)                                                                                                                                                                                                                                                    |
| Image           | Trivy image (`container:scan:<id>`)       | fixable HIGH/CRITICAL, secrets                                             | same ignore file                                                                                                                                                                                                                                                                                      |
| Licenses        | `licenses` (pnpm licenses, recursive)     | non-allowlisted or unknown SPDX expressions                                | `.gitlab/security/license-policy.yaml` exceptions (expiry)                                                                                                                                                                                                                                            |
| Dockerfile      | hadolint (`container:lint:<id>`)          | warnings and above                                                         | `.hadolint.yaml`                                                                                                                                                                                                                                                                                      |
| Pinning         | `supply-chain:lint`                       | unpinned images/`FROM`, bad exceptions, whole-file SAST waivers            | —                                                                                                                                                                                                                                                                                                     |
| Secrets binding | `security:protected-secrets`              | any `COSIGN_*`/`AWS_*`/`STARTER_SIGNING_*` name or runner-scoped mount     | —                                                                                                                                                                                                                                                                                                     |
| IaC             | cdk-nag in synth, cfn-guard (`policy:*`)  | errors, blocking Guard findings, expired or unapproved governed exceptions | the registers in `policies/exceptions/` ([policy-as-code.md](policy-as-code.md))                                                                                                                                                                                                                      |
| Cost            | `finops:*`                                | approval-required changes in MR pipelines                                  | MR label `finops-approved` (an audit record, see §8)                                                                                                                                                                                                                                                  |
| Rescan          | `container:rescan:<id>` (schedule)        | fixable HIGH/CRITICAL in the latest signed image or its SBOM               | same ignore file                                                                                                                                                                                                                                                                                      |

Reports are kept as artifacts; the JUnit and Code Quality formats surface them in the merge-request
widget on every GitLab tier (the native security dashboards are a paid-tier feature).

## 7. Gate integrity (optional, ADR 0410)

An MR that edits the pipeline definition can change what "required" means: delete a job, make a
check `allow_failure`, drop a component. With the optional gate policy installed, the project's CI/CD
configuration file is `projects/<slug>/gate-policy.yml@<group>/ci-policy`, a file in a Maintainer-only
project. It runs the project's own pipeline plus a child pipeline compiled only from that policy
project. That child blocks every pipeline whose **gate-defining paths** differ from the default
branch's reference state and from every state a Maintainer approved:

- the CI definition: `.gitlab-ci.yml`, `.gitlab/` (CI YAML, generated rules, SAST and Trivy
  exceptions, license policy, `cosign.pub`), `components.yaml`, `tools/impact`, `tools/ci`;
- scanner configurations and policies: `.gitleaks.toml`, `.hadolint.yaml`, `policies/`,
  `infra/lib/policy-hook.ts`, `infra/lib/policy-options.ts`, `tools/finops/thresholds.yaml`,
  `tests/security`;
- root configurations: `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `eslint.config.js`,
  `.prettierignore`, `tsconfig.base.json`;
- the MiniStack emulator layer: the guard (`infra/lib/emulator-guard.ts` and its CLI), the scripts,
  egress audit and not-applicable baseline in `tests/aws-integration/emulator/`, the code that
  decides the jobs' verdicts (`tests/aws-integration/src/emulator-{ci,gaps,reconcile,results}.ts`)
  and what decides which emulator tests run and how the guard resolves
  (`tests/aws-integration/src/live-harness.ts`, `tests/aws-integration/src/aws-gate.ts`,
  `tests/aws-integration/{package.json,tsconfig.build.json,vitest.config.ts}`,
  `infra/bin/integration.ts`, `infra/package.json`, `infra/tsconfig.json`).

The list is `DEFAULT_GATE_PATHS` in `tools/ci/src/gate-policy.ts`. Each entry is one file or one
directory (never a glob). A live policy keeps the list it was installed with; a changed default list
protects nothing until a Maintainer adopts it ([ci-cd.md](ci-cd.md) §4a).

**Maintainer procedure** (from a trusted checkout of `main`, never from the MR's branch):

1. Review the MR's changes to those paths. The blocked job lists the changed entries.
2. Approve the gate state (`tools/ci/scripts/gate-admin.sh approve --project <path> --policy-project
<group>/ci-policy --mr <iid> --rerun`). This records the approval in the policy project and starts
   a new MR pipeline.
3. After merging: `gate-admin.sh sync`. This re-pins the reference and drops approvals of merged or
   closed MRs.

What the unit tests demonstrate (`tools/ci/test/gate-policy.test.ts`, `gate-admin.test.ts`; the
rendered check runs against each change): an `allow_failure: true` on gitleaks, a deleted gate job, a
gate script that exits 0, a dropped component, a self-approved exception, a replaced `cosign.pub`
and an override of the bridge job are each blocked, while an approved change and a non-gate change
pass.

**Still controllable by an MR:** code and tests outside those paths (including per-package test
scripts). These are covered by the Maintainer's review at merge, not by a technical gate.

## 8. Audit records versus enforced controls

Some controls depend on the GitLab tier. On GitLab Free (and CE) the following are **not available**
and therefore not enforced by this configuration:

- required MR approvals and approval rules;
- CODEOWNERS enforcement (a `CODEOWNERS` file is informational);
- protected environments and deployment approvals;
- compliance frameworks, compliance pipelines and security policies;
- push rules (commit-author checks, signed commits, secret push protection);
- merge trains and external status checks.

**Audit records, not controls:**

- `approval:human` (an MR job that fails when the person who runs it authored the head commit) and
  the `finops-approved` label. Anyone with Developer rights can run manual jobs in MR pipelines and
  set labels, and the author comparison uses the Git author, which the committer chooses. A project
  that does not want the job sets `REQUIRE_HUMAN_APPROVAL=false`.
- In a single-maintainer project a "second person" does not exist.

**Enforced by GitLab or by the CI configuration** (with the recommended project settings):

- a protected `main` (merge by Maintainers only, no force push) and protected release tags;
- "pipelines must succeed" (an MR without a successful pipeline cannot be merged);
- the gate-integrity child pipeline from the Maintainer-only policy project (§7), when installed;
- protected runners, runner-mounted secrets and the protected release chain (§3–§5), when opted in;
- `restrict_user_defined_variables` (only Maintainers set pipeline variables);
- the job-token inbound allowlist.

## 9. Schedules (ADR 0412)

Pipeline schedules on a protected ref (variable `SCHEDULE_TASK`) run the nightly full pipeline,
`rescan` (latest signed image and its SBOM attestation against a fresh vulnerability database; needs
release signing), `stale` (report-only list of stale branches, MRs, artifacts and registry tags),
`drift` and `sweep`. Without AWS configuration, `drift` and `sweep` create only `aws:status`, which
reports "not configured — not executed".

## 10. AI review boundaries

`review:ai` (PR-Agent, pinned in `images.yml`; license in [THIRD_PARTY.md](../THIRD_PARTY.md)) posts
**one advisory MR comment**. It exists only when `AI_REVIEW_ENABLED=true`, and runs only when an
endpoint (`AI_REVIEW_API_BASE`, OpenAI-compatible), a model (`AI_REVIEW_MODEL`) and a token
(`AI_REVIEW_GITLAB_TOKEN`) are configured; enabled but incomplete, `review:ai-status` says what is
missing.

- **Token:** a project access token with role Reporter and scope `api`. Reporter is the lowest role
  that can post notes, but `api` scope is not "comment only": the token can read everything a
  Reporter can read through the project API (code, issues, merge requests, pipelines and job logs)
  and post notes.
- **Data sent:** the MR diff, its title and description, and `AGENTS.md` go to the configured
  endpoint, authenticated with `AI_REVIEW_API_KEY` when set.
- **Exposure of both secrets.** `AI_REVIEW_GITLAB_TOKEN` and `AI_REVIEW_API_KEY` are masked but not
  protected project variables, because merge-request pipelines run on unprotected refs. GitLab
  therefore passes them to **every job** of every pipeline of the project, not only to `review:ai`,
  and an MR can change those jobs' YAML and scripts. Masking hides them in logs; it does not stop MR
  code from reading or sending them. Treat both as readable by anyone who can push a branch to the
  project and open an MR:
  - use a dedicated project access token for this project only, with no more than Reporter and
    `api`, and a short expiry;
  - use an endpoint key with a spending limit that grants access to nothing else (for example a
    per-project key of an LLM proxy);
  - enable the review only where everyone with push access may hold both values, and never put
    either value on the protected runners.
- **Fork MRs.** `review:ai` never runs for an MR from a fork (`CI_MERGE_REQUEST_SOURCE_PROJECT_ID`
  differs from the project). `review:ai-status` has no fork rule, so on a fork MR with complete
  settings neither job appears: the review is silently absent there, not failed.

## 11. Human approval

`approval:human` is an audit record of who looked at the MR, not a tamper-proof gate (§8). The
controls are the ones listed under "Enforced" in §8.
