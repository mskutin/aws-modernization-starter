#!/bin/sh
# usage: buildah-diagnose.sh <buildah log file>
# Explains a failed rootless Buildah build that the runner's container engine caused (blocked user
# namespaces, mounts or unshare under the default seccomp/AppArmor profile — common on Docker Engine
# runners) and the two supported ways out. Prints nothing and exits 1 when the log shows no such
# cause (an ordinary build error, e.g. a failing RUN step), 0 after printing a diagnosis. Never turns
# a failed build into a pass: container-build.sh exits non-zero either way.
set -eu
log="${1:?usage: buildah-diagnose.sh <log>}"
pattern='unshare|user namespace|newuidmap|newgidmap|uid_map|creating new namespace|cannot clone|clone: operation not permitted|mount.*operation not permitted|operation not permitted.*mount|pivot_root|setns|error running container: .*permission denied|cannot set up namespace|is not permitted in this namespace'
evidence="$(grep -Ei "$pattern" "$log" | head -n 5 || true)"
[ -n "$evidence" ] || exit 1
cat <<MSG
================================================================================================
container:build: Buildah could not create the namespaces or mounts it needs on this runner.
  runner: ${CI_RUNNER_DESCRIPTION:-unknown} (job image ${IMG_BUILDAH:-?}; no privileged mode, no socket)
  evidence:
$(printf '%s\n' "$evidence" | sed 's/^/    /')
The pipeline builds images rootless and unprivileged on purpose (ADR 0402). Either
  1. run this job on a runner whose engine allows unprivileged user namespaces and mounts inside job
     containers (e.g. a rootless Podman engine, or a Docker host whose seccomp/AppArmor profile
     permits unshare/mount for this image; see docs/ci-cd.md "Bring your own GitLab"), and
     select it with STARTER_RELEASE_RUNNER_TAG; or
  2. opt out explicitly: project CI/CD variable STARTER_CONTAINER_BUILD=false. No image is then
     built, scanned, described or published; release:status and gates:mandatory report the opt-out.
Do NOT enable privileged mode or mount a container socket for this job.
================================================================================================
MSG
exit 0
