# 0111 — Secrets are bound to protected jobs (runner-scoped files), not to protected refs

- Status: Accepted (amended: signing and AWS are opt-in; no key material ships)

## Context

GitLab gives a **protected** CI/CD variable to every job of a protected-ref pipeline, whichever
runner runs it. Storing the Cosign key, its password or AWS keys as protected variables would hand
them to every `main` job on the default runner. An "absent in MR pipelines" check cannot fail,
because protected variables never reach MR pipelines by definition.

GitLab CE supports environment-scoped variables. They reach only jobs that declare a matching
`environment:` (also in `rules:if`). But nothing ties a variable to a runner, and any reviewed job
on `main` could declare the environment.

## Decision

1. **No secret is a GitLab variable.** Release signing (`STARTER_RELEASE_SIGNING=true`) and AWS jobs
   (`AWS_JOBS_ENABLED=true`) are opt-in. Their material is files in an operator-only directory on the
   runner host (directories 0700, files 0600), mounted read-only into the job containers of dedicated
   runners only:

   | Mount                  | Content                                                   | Mounted by                                            |
   | ---------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
   | `/run/starter-signing` | `cosign.key` (encrypted), `cosign.password`, `cosign.pub` | the signer runner (`STARTER_SIGNER_RUNNER_TAG`) only  |
   | `/run/starter-trust`   | `cosign.pub` (trust anchor, public)                       | the protected runner (`STARTER_PROTECTED_RUNNER_TAG`) |
   | `/run/starter-aws`     | `credentials`, `config`                                   | the protected runner, only when AWS jobs are enabled  |

   The default runner mounts none of them. The password reaches cosign through the job's own process
   environment (read from the file, never echoed, `set +x`), never through a CI/CD variable or a log.
   With nothing configured no key exists anywhere: the sign, verify and chain-report jobs do not
   exist, and `release:status` says "signing: not configured".

2. **Generation** — `cosign generate-key-pair` in the pinned cosign image (`--rm`,
   `--network none`). The password comes from a CSPRNG (e.g. `openssl rand`) and reaches the
   container through the client environment (`-e NAME`), never through argv (docs/ci-cd.md
   §11). A new production key is **staged** (unmounted) until the runner operator has verified the
   runner isolation (ADR 0110) and activates it.

3. **Trust anchor** — verification uses the runner-mounted `/run/starter-trust/cosign.pub`, which
   the MR cannot change. The adopter commits the same public key as `.gitlab/security/cosign.pub`
   (published for consumers); the verify job fails if it is missing or differs from the anchor. The
   repository ships no key.

4. **Proof:** `security:protected-secrets` runs on the default runner in MR, `main` and tag
   pipelines (gated). It fails on any `COSIGN_*`, `AWS_*` or `STARTER_SIGNING_*` variable _name_ —
   except the non-secret `AWS_REGION`, `AWS_DEFAULT_REGION` and the switch `AWS_JOBS_ENABLED` — or on
   any runner-scoped mount. It reports names only. The non-secret switches are named so that they do
   not match (`STARTER_RELEASE_SIGNING`, `STARTER_SIGNER_RUNNER_TAG`). The release-chain report
   records that every chain job ran on a configured protected or signer tag.

## Key rotation and revocation

- **Rotation** (scheduled, or after a custodian change):
  1. Generate and stage a new pair; keep the old one as retired.
  2. Commit the new `cosign.pub`. With gate integrity installed this is a gate-defining change and
     needs gate approval.
  3. Unmount the old key, mount the new one (signer runner) and the new public key (protected runner).
  4. Re-run the release pipeline of `main` and of any release tag still deployed, so the current
     images carry signatures from the new key. Images signed only by the old key no longer verify.
- **Revocation** (suspected compromise):
  1. Unmount the key immediately. Signing then fails closed on protected refs.
  2. Rotate as above.
  3. Re-sign every image that should stay deployable, and tell consumers to pin the new public key.
  4. Without a transparency log (`--tlog-upload=false`) no global revocation exists. Consumers
     trust exactly the public key they pin.

## Consequences

- Signing needs a self-managed runner for the signer role: hosted runners cannot mount files. A
  project on hosted runners only publishes unsigned images, and says so.
- An operator with access to the runners' container engine or to the 0600 files can read the key.
  That is the same trust domain as the runner hosts. A hardware or KMS-backed key would be the
  production answer; an AWS deployment should use KMS-backed Cosign keys and IAM roles instead of
  files.
- AWS jobs need the mounted credentials and `AWS_JOBS_ENABLED=true`. Without them `aws:status`
  reports "not configured — not executed".
- Signing in the pipeline proves nothing about AWS or ECR: no ECR policy, deploy-time admission
  control or AWS-side verification exists.
