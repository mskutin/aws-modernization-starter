# 0411 — Release chain on protected refs; opt-in Cosign sign and independent verification

- Status: Accepted (amended: signing is opt-in; generic runners by default)

## Context

The image is built, scanned, described (SBOM) and given provenance in every pipeline. A release
needs more: publication of exactly the scanned digest, a signature and attestations that consumers
can verify, and evidence of where each step ran. Signing needs key material that no repository and no
CI/CD variable may hold (ADR 0111), so it cannot be part of a zero-configuration pipeline.

## Decision

1. **Release refs only:** the protected default branch or a protected tag. A Developer can create an
   unprotected tag, which is never a release. MR and other unprotected pipelines build **unsigned**
   images and have no publish, sign, verify or chain-report jobs.
2. **Publish** (`skopeo copy --preserve-digests`, `STARTER_PROTECTED_RUNNER_TAG`) exists on release
   refs when the project's container registry is enabled (`CI_REGISTRY_IMAGE`); otherwise it is absent
   and `release:status` says "not published". It pushes `:<commit sha>` plus the moving tag
   `:<default branch>` (or `:<git tag>`, which the rescan follows) and re-reads every tag's digest.
   Registry TLS is verified unless `REGISTRY_TLS_VERIFY=false` (explicit opt-in).
3. **Signing is opt-in** (`STARTER_RELEASE_SIGNING=true`). Without it, sign, verify and the chain
   report do not exist, and `release:status` plus the provenance status state "signing: not
   configured" / "NOT SIGNED" in every release pipeline — an unsigned release never looks signed. On
   a release ref with signing enabled, `release:status` fails when the registry or one of the runner
   tags it needs is missing.
4. **Sign** (`cosign-sign.sh`, signer runner `STARTER_SIGNER_RUNNER_TAG`) signs the published digest,
   never a tag. It attests SLSA provenance (`slsaprovenance1`) and the CycloneDX SBOM with the
   runner-mounted key (ADR 0111), with `--tlog-upload=false`. Signatures and attestations are stored
   as OCI referrers next to the image. Missing key, missing publication or digest mismatch:
   **exit 1**.
5. **Verify** (`cosign-verify.sh`, protected runner) is a separate job from signing, and checks:
   - the committed `.gitlab/security/cosign.pub` equals the runner-mounted trust anchor;
   - a valid signature over the **built** digest;
   - the `:<sha>` tag resolves to that digest;
   - both attestations verify with subject = built digest, and the provenance names the commit;
   - **negative controls** fail for the right reason: an unsigned artifact of the same repository
     (a referrer manifest; "no signatures found"), and the signed digest against a freshly generated
     unrelated key ("signatures do not match").
     Anything missing: exit 1.
6. **Chain report** (`container:chain-report:<id>`, proof per release) reads the pipeline's jobs with
   the job token. For build → scan → SBOM → provenance → publish → sign → verify it records the
   runner, the tags (must be non-empty and only `STARTER_PROTECTED_RUNNER_TAG` /
   `STARTER_SIGNER_RUNNER_TAG`; none configured fails) and fresh-clone evidence. The job token cannot
   read job logs, so each chain job records its own evidence (`clone-evidence.sh`): the number of HEAD
   reflog entries is 1 for a fresh clone and grows on reuse. Building release images on the protected
   runner therefore needs `STARTER_RELEASE_RUNNER_TAG` set (as a protected variable) to that tag.

## Evidence

On a dedicated test instance, build, scan, SBOM, provenance, publish and verify ran on a protected
runner and sign on a separate signing runner, all green; a tampered-tag run failed verification as
intended. The negative controls run in every signed release.

## Consequences and limits

- A fresh project publishes unsigned images on its default branch and says so; consumers must not
  treat them as signed. Signing needs a self-managed signer runner (hosted runners cannot mount files).
- No SLSA build level is claimed: provenance is generated in-pipeline by the build job, and runner
  isolation is the operator's responsibility (ADR 0110).
- **Signing proves nothing about AWS/ECR enforcement.** Nothing in AWS checks these signatures.
  An AWS deployment needs an ECR repository policy or admission control (e.g. a deployment gate
  verifying the digest with the pinned key) before "signed" means anything there.
- Without a transparency log there is no time-stamped, public record of the signatures. Consumers
  trust the pinned public key (rotation: ADR 0111).
- Rescans follow the moving tag and accept only a validly signed image (ADR 0412); without signing
  the rescan fails instead of trusting an unauthenticated tag.
