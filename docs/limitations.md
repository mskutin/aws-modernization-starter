# Status and limitations

What has and has not been shown, so that nobody mistakes a green local pipeline for production
readiness. Read this before you reuse any part of the repository with real data.

## 1. Status at a glance

**Implemented** = the code exists. **Verified without AWS** = executed by unit, integration,
security or browser tests, offline synth and policy checks, or the MiniStack emulator jobs in GitLab
CI. **Validated on AWS** = executed once in a disposable personal sandbox account with synthetic
data (functional behaviour on ordinary AWS, not compliance with any landing zone; the run evidence
is not published).

| Capability                                           | Implemented | Verified without AWS                                                      | Validated on AWS                                                              |
| ---------------------------------------------------- | ----------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| SPA, API, Lambdas, contracts, migrations             | yes         | unit, integration, E2E (workflow simulated locally)                       | sandbox profile                                                               |
| OIDC/JWT authentication, owner-scoped access, limits | yes         | security suite (direct and through a proxy), browser sign-in              | sandbox profile with a test issuer; no organization IdP                       |
| Least-privilege DB identities, IAM auth, verify-full | yes         | real PostgreSQL permission and TLS suites                                 | sandbox profile                                                               |
| Step Functions workflow (CDK definition)             | yes         | synth and assertions against the spec; emulator runs within declared gaps | sandbox executions; Lambda alias rollback exercised manually, not through CDK |
| Stale-job reconciler                                 | yes         | unit, DynamoDB Local, local loop                                          | deployed, not exercised                                                       |
| ECS deployment and circuit-breaker rollback          | yes         | synth and assertions                                                      | sandbox profile (rollback experiment)                                         |
| CDK `dev`/`staging`/`prod` with landing-zone imports | yes         | offline synth, assertion tests, policy checks                             | **never deployed**                                                            |
| Policy-as-code (cdk-nag pack, Guard, registers)      | yes         | pass/fail fixtures, synth-time rules, CI audit                            | not applicable                                                                |
| FinOps estimate and destructive-change gate          | yes         | fixtures and CI gate (dated price snapshot)                               | no live prices or billing data                                                |
| Drift detection, sweeper                             | yes         | mocked SDK only                                                           | never run against an account                                                  |
| Integration mini-stack                               | yes         | MiniStack: deploy, reconcile, update, destroy, workflow suites            | not on AWS (the lifecycle scripts exist; see §2)                              |
| Container build, scan, SBOM, provenance              | yes         | GitLab CI with rootless Buildah                                           | the sandbox ran a locally built, unsigned image                               |
| Image signing and verification (Cosign)              | opt-in      | unit tests; requires runner-mounted keys                                  | not applicable                                                                |
| Gate integrity, scheduled rescans                    | opt-in      | unit tests of the rendered checks                                         | not applicable                                                                |
| Advisory AI review                                   | opt-in      | job wiring only; no endpoint configured                                   | not applicable                                                                |

## 2. Governed environments have never been deployed

- The `dev`, `staging` and `prod` profiles have never been deployed. CloudFormation has never
  accepted those templates; deployment order, rollback, alarms, budgets and rotation are designed
  and tested offline only.
- All account, VPC, subnet, KMS, certificate, hosted-zone, WAF, permissions-boundary and identity
  provider values in `infra/environments/*.ts` are **placeholders**.
- The one AWS validation used the opt-in **sandbox** profile in an ordinary, dedicated account. It
  did not exercise any landing-zone control (imported foundation, permissions boundary, WAF, a VPC
  origin over a governed network, central egress, an organization IdP). After teardown no remaining
  resource was found, but the teardown verifier's final verdict was `incomplete`, not `clean`.
- The integration mini-stack lifecycle scripts keep their account guard but have only run against
  the emulator; the AWS jobs in CI are opt-in and not configured by default.

## 3. Simulators and emulators are not AWS

- `WORKFLOW_MODE=local` runs the workflow **in-process**; the API refuses it on `APP_RUNTIME=aws`.
  DynamoDB Local differs from DynamoDB in throughput, TTL deletion and some consistency semantics.
- Locally the simulator loads documents through `load_job_document()` like the Lambdas, but with
  password authentication (`APP_RUNTIME=local|ci` only). The local reconciler loop uses the simulator
  as its execution authority; neither has observed a real `DescribeExecution`.
- **MiniStack** evaluates neither IAM nor KMS policies. In socket-less mode it reports every handler
  error as `Runtime.HandlerError`, so Step Functions retries and catches that match handler error
  names are not exercised; further gaps (retry jitter and maximum delay, Fail-state paths, execution
  timeout, state machine versions and aliases, throttling, execution logs) are listed in a versioned
  baseline ([ministack.md](ministack.md)). Only the workflow mini-stack runs on the emulator, not the
  application stages.

## 4. Identity and access

- OIDC/JWT authentication, owner-scoped authorization, principal-scoped idempotency, rate limits and
  audit events are tested locally and in the sandbox with a TEST ONLY issuer, never with an
  organization identity provider. The test IdP (`tools/test-idp`) refuses `APP_RUNTIME=aws`.
- Authorization is the owner predicate in the API's SQL; there is **no row-level security**. An SQL
  injection or code execution in the API could read the titles and metadata of every owner's jobs
  (document content stays protected by the column grant).
- Rate limits are per API task and in memory; `dev` has no WAF; the per-address limit counts failed
  authentications only. On the local direct API port a client can spoof `X-Forwarded-For`
  (`TRUST_PROXY_HOPS=1` assumes nginx in front). The CloudFront → ALB hop count
  (`TRUST_PROXY_HOPS=2`) is not verified behind a governed edge.
- Tokens are verified offline, so revocation takes effect at token expiry (`AUTH_MAX_TOKEN_AGE_SECONDS`
  caps the accepted age). The audit pseudonym `sha256(iss|sub)` is linkable across events.
- There is no alerting on audit events (denial bursts, 429 responses, aborted requests).

## 5. Data handling

- Step Functions receives only `{ jobId, contractVersion, submittedAt }`; the Lambdas load the
  document through `load_job_document()` (one row, within one hour of creation). A compromised step
  Lambda can still read the documents of the jobs it is invoked for.
- Derived results (top terms) live in the DynamoDB job item and are returned to the owner.
- Retention is implemented but **disabled**: no retention period is approved (ADR 0223); `STEP#`
  audit items have no TTL by default (`JOB_AUDIT_TTL_DAYS` unset); RDS backups, DynamoDB PITR and the
  Step Functions execution history extend every window.
- The KMS key-policy prerequisites of the CMK-encrypted state machine in a landing zone are documented
  but not verified ([landing-zone-adaptation.md](landing-zone-adaptation.md) §3).

## 6. Database credentials and transport

- Runtime identities use RDS IAM authentication; the API and Lambdas hold no password and no master
  secret. Only the one-off bootstrap task reads the RDS master secret at runtime (a governed
  exception): anyone allowed to run that task can run arbitrary SQL as the master user. Restrict it
  to a break-glass role and alarm on its use; neither is implemented here.
- ALB → task traffic is plain HTTP inside the VPC and carries bearer tokens. Add TLS to the container
  if your organization requires end-to-end encryption ([landing-zone-adaptation.md](landing-zone-adaptation.md) §4).
- Local only: on local volumes created by an earlier version of the bootstrap, the original
  superuser remains as `starter_app_legacy_bootstrap` (NOLOGIN); PostgreSQL cannot drop it.

## 7. Policies and exceptions

- The rules are a **proposed baseline**, not an approved control set of any organization, auditor or
  regulator. They need project-specific review and approval.
- Policy waivers live in the registers under `policies/exceptions/`
  ([policy-as-code.md](policy-as-code.md)). The reference design's own deviations are `reference`
  entries: part of the code, undated and never expiring, pinned by content digest in the policy
  source, so adding or widening one is a reviewed code change.
  Entries you add for your project are dated, expire (at most 180 days) and can require recorded
  approvals; approvals recorded outside the merge request need a protected approvals file (for
  example from the optional gate-integrity project) and are not configured by default — without it,
  the Maintainer's merge is the approval.
- The sandbox relaxations ship only as an `example` register that nothing loads: the sandbox synth
  fails until you adopt the entries you accept as dated project entries.
- No SAST waiver is shipped: reviewed false positives are suppressed inline with the exact rule id
  and a reason, which a test enforces. Adopters review these suppressions like any other code.

## 8. Landing-zone prerequisites to confirm

With your platform team: CloudFront **VPC origins** need an internet gateway attached to the VPC; the
CloudFront origin-facing prefix-list id is committed only for `ap-southeast-1` and must be confirmed;
the egress path (central egress or VPC endpoints) for tasks and Lambdas, including JWKS egress to the
IdP; KMS key and log-bucket policies; the content of the permissions boundary; the WAF web ACL; the
Lambda concurrency quota. Details: [landing-zone-adaptation.md](landing-zone-adaptation.md).

## 9. CI and supply chain

- The pipeline is verified on a self-managed GitLab CE with one generic Docker-executor runner (no
  tags, not privileged, no mounts). GitLab.com hosted runners are expected to work but are untested;
  rootless Buildah in particular depends on the runner's container engine.
- By default every job runs on one generic runner and published images are **unsigned**. Release
  signing, protected runners, gate integrity and AWS jobs are opt-ins that need runner-operator setup
  ([ci-cd.md](ci-cd.md) §11). When signing is enabled there is no transparency log, and verification
  happens in the pipeline only (no ECR signing policy or admission check).
- Rootless Buildah needs unprivileged user namespaces. On some Docker Engine hosts the default
  seccomp/AppArmor profile blocks them and `container:build` fails with a diagnosis; use a runner
  that allows them (for example a Docker executor backed by rootless Podman) or opt out of the image
  build (`STARTER_CONTAINER_BUILD=false`). Never enable privileged mode for it.
- The MiniStack image pin carries a release-age exception (`.gitlab/security/image-age-exceptions.yaml`)
  for the first 14 days after its release. Once the release is 14 days old `supply-chain:lint` only
  warns that the entry can be deleted; a newer, younger pin needs a new reviewed exception or an
  aged release.
- GitLab tier features such as required approvals, CODEOWNERS enforcement and protected
  environments are not assumed; the `approval:human` job and the `finops-approved` label are audit
  records, not controls ([security.md](security.md) §8).
- The egress audit of the emulator jobs covers the job's Node.js processes, not non-Node executables
  or the MiniStack service container.

## 10. Cost data

- FinOps numbers come from a dated, manually maintained list-price snapshot and assumed usage, not
  live prices or billing data.
- Price data exists only for the default region `ap-southeast-1`
  (`tools/finops/pricing/ap-southeast-1.yaml` and the sandbox supplement). For another region the
  cost tools fail closed until you add a price table; nothing is priced with another region's data.
- AWS Budgets alert; they do not cap spend.

## 11. Reproduction notes

- CDK synth needs `pnpm` on the `PATH` of its child processes (Lambda bundling runs
  `pnpm exec esbuild`); running it through `npm exec --yes pnpm@12.11.2 -- …` provides that.
- The Guard-backed policy tests skip without the pinned binary (`pnpm -C policies run guard:install`);
  set `REQUIRE_CFN_GUARD=1` to make them fail instead, as CI does.
- Type checks that pass on macOS can fail on Linux through pnpm's virtual store layout; CI is the
  reference.
- The Linux native mode of the local socket helper (systemd socket activation, its own
  `podman system service` fallback) and `docker-compose` against native rootless Podman are verified
  by the helper's tests and in a container, not on a real Linux workstation; macOS with
  `podman machine` is the platform the local stack was exercised on.
- The first build of the compose `app` profile needs registry and npm access (pinned images, npm
  packages); after that the deps profile and the unit tests work offline.
- Browser E2E covers Chromium only; the nginx proxy suite and the outage tests run locally only (CI
  jobs have no container runtime).
- Lifecycle-script tests in `tests/aws-integration` can exceed their timeout on a heavily loaded
  host; they pass when run alone.
