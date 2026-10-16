# ADR 0402 — Rootless Buildah in non-privileged jobs; OCI archive as the artifact

- Status: Accepted (amended: generic runners, explicit failure mode, opt-out)

## Context

Jobs run on whatever Docker-executor runner the adopter provides (ADR 0110): no privileged
mode, no container socket; DinD and socket mounting are excluded by policy. The build was
first measured on a runner backed by rootless Podman (`no-new-privileges`, SELinux, default
capabilities minus NET_RAW/NET_ADMIN/SYS_ADMIN/SYS_PTRACE/SYS_MODULE/MKNOD/AUDIT_WRITE). On some
Docker Engine hosts the default seccomp/AppArmor profile blocks the user namespaces and mounts
that Buildah's `RUN` steps need.

## Decision

- Build with **Buildah** (`quay.io/buildah/stable:v1.43.4-immutable@sha256:…`) as root
  inside the job's user namespace: `buildah build --isolation chroot --storage-driver vfs
--format oci --source-date-epoch <commit time> --rewrite-timestamp`, ignore file
  passed explicitly (`--ignorefile apps/api/.dockerignore`, build context = repo root).
- Export with `buildah push --digestfile … oci-archive:…`; the archive, its manifest
  digest and `image.json` metadata are job artifacts. Scan/SBOM/provenance consume the
  archive (Trivy needs it unpacked as an OCI layout; Syft reads `oci-archive:`).
- Publish only after the mandatory gate, on release refs, with
  `skopeo copy --preserve-digests` (digest re-checked after push).
- Minimal requirements, measured with the pinned image on a rootless Podman engine:
  capabilities `CHOWN DAC_OVERRIDE FOWNER FSETID SETUID SETGID SETFCAP SYS_CHROOT` (no extra
  caps), no devices, default seccomp/SELinux, works with `no-new-privileges`.
- **Failure mode is explicit.** The build job logs its capabilities, seccomp mode and user-namespace
  limits first; when Buildah fails with an engine-caused error (blocked `unshare`, user namespace or
  mount), `tools/ci/scripts/buildah-diagnose.sh` names the evidence and the two supported ways out.
  The job still fails: no image, no pass.
- **Explicit opt-out.** A project whose runners cannot build sets `STARTER_CONTAINER_BUILD=false`:
  the build, scan, SBOM, provenance, publish and signing jobs (and the image-config check) are then
  absent, the impact analysis marks them "opted out" instead of required, `gates:mandatory` prints
  the notice and `release:status` ends as a warning. `container:lint` still runs. Only the exact
  value `false` disables; scanning is never skipped for an image that was built.

## Consequences

- No daemon, no socket, no privileged runner — the same job runs on any non-privileged
  Docker/Podman executor that keeps default capabilities and allows user namespaces. Where that
  does not hold, the pipeline says so (diagnosis or opt-out warning) instead of skipping silently.
- vfs is slower and disk-hungry (full layer copies); acceptable for one service image
  (~45 s build, ~64 MB archive).
- OCI format drops Dockerfile `HEALTHCHECK`; the ECS task definition and compose
  declare the same check (`/nodejs/bin/node dist/healthcheck.js`).
- Reproducible digests make provenance/signature verification meaningful and let a
  rebuild prove the artifact.
