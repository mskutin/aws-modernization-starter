#!/bin/sh
# Rootless, daemonless, NON-privileged image build with Buildah.
#   - chroot isolation + vfs storage: no /dev/fuse, no extra capabilities, no
#     seccomp/SELinux relaxation, compatible with no-new-privileges
#   - reproducible: SOURCE_DATE_EPOCH = commit time, timestamps rewritten
#   - output: OCI archive + digest + metadata (provenance input) + dotenv
#   - a runner that blocks the user namespaces/mounts Buildah needs fails with an explicit diagnosis
#     (buildah-diagnose.sh) and the two supported ways out; it never passes without an image
# Env: COMPONENT_ID DOCKERFILE IMAGE_NAME [BUILD_CONTEXT] [IGNORE_FILE]
set -eu
: "${COMPONENT_ID:?}" "${DOCKERFILE:?}" "${IMAGE_NAME:?}"
context="${BUILD_CONTEXT:-.}"
out="oci-out/${COMPONENT_ID}"
mkdir -p "$out"

commit="${CI_COMMIT_SHA:-$(git rev-parse HEAD)}"
created="${CI_COMMIT_TIMESTAMP:-$(git log -1 --format=%cI "$commit")}"
sde="$(date -d "$created" +%s)"
tag="${CI_COMMIT_SHORT_SHA:-$(printf '%s' "$commit" | cut -c1-8)}"
local_ref="localhost/${IMAGE_NAME}:${tag}"
source_url="${CI_PROJECT_URL:-local}"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
buildah_version="$(buildah --version | awk '{print $3}')"

echo "buildah ${buildah_version} | uid $(id -u) | $(grep -E '^(CapEff|NoNewPrivs|Seccomp):' /proc/self/status | tr -s '\t\n' ' ')"
echo "user namespaces: max_user_namespaces=$(cat /proc/sys/user/max_user_namespaces 2> /dev/null || echo '?') apparmor_restrict_unprivileged_userns=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2> /dev/null || echo 'n/a')"
echo "building ${local_ref} from ${DOCKERFILE} (context ${context}, SOURCE_DATE_EPOCH ${sde})"

set -- build --isolation chroot --storage-driver vfs --format oci \
  --source-date-epoch "$sde" --rewrite-timestamp \
  --build-arg "VCS_REF=${commit}" --build-arg "SOURCE_URL=${source_url}" \
  --build-arg "BUILD_CREATED=${created}" --build-arg "VERSION=${tag}" \
  -f "$DOCKERFILE" -t "$local_ref"
if [ -n "${IGNORE_FILE:-}" ]; then set -- "$@" --ignorefile "$IGNORE_FILE"; fi
build_log="$(mktemp)"
build_rc="$(mktemp)"
{
  rc=0
  buildah "$@" "$context" 2>&1 || rc=$?
  echo "$rc" > "$build_rc"
} | tee "$build_log"
rc="$(cat "$build_rc")"
if [ "$rc" != 0 ]; then
  sh tools/ci/scripts/buildah-diagnose.sh "$build_log" >&2 || true
  echo "ERROR: buildah build failed (exit ${rc:-unknown}); no image was produced." >&2
  case "$rc" in '' | *[!0-9]*) exit 1 ;; *) exit "$rc" ;; esac
fi
rm -f "$build_log" "$build_rc"

# Policy: the runtime image must not run as root.
user="$(buildah inspect --storage-driver vfs --format '{{.OCIv1.Config.User}}' "$local_ref")"
case "$user" in
  "" | root | root:* | 0 | 0:*) echo "ERROR: image ${local_ref} runs as root (USER='${user}')" >&2; exit 1 ;;
esac

buildah push --storage-driver vfs --digestfile "${out}/digest" "$local_ref" \
  "oci-archive:${out}/image.oci.tar:${IMAGE_NAME}:${tag}"
digest="$(cat "${out}/digest")"
finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
archive_sha="$(sha256sum "${out}/image.oci.tar" | cut -d' ' -f1)"
dockerfile_sha="$(sha256sum "$DOCKERFILE" | cut -d' ' -f1)"
lock_sha=""
[ -f pnpm-lock.yaml ] && lock_sha="$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)"

# Base images = every digest-pinned reference in the Dockerfile (supply-chain:lint
# guarantees every FROM is pinned).
bases=""
# The pattern cannot match whitespace, so splitting the list on whitespace is exact.
refs=$(grep -Eo '[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}' "$DOCKERFILE" | sort -u)
for ref in $refs; do
  bases="${bases}${bases:+,}{\"ref\":\"${ref}\",\"digest\":\"${ref#*@}\"}"
done

cat > "${out}/image.json" <<JSON
{
  "component": "${COMPONENT_ID}",
  "image": "${IMAGE_NAME}",
  "tag": "${tag}",
  "digest": "${digest}",
  "archive": "${out}/image.oci.tar",
  "archiveSha256": "${archive_sha}",
  "dockerfile": "${DOCKERFILE}",
  "dockerfileSha256": "${dockerfile_sha}",
  "context": "${context}",
  "ignoreFile": "${IGNORE_FILE:-}",
  "baseImages": [${bases}],
  "buildArgs": { "VCS_REF": "${commit}", "SOURCE_URL": "${source_url}", "BUILD_CREATED": "${created}", "VERSION": "${tag}" },
  "lockfileSha256": "${lock_sha}",
  "sourceDateEpoch": ${sde},
  "startedOn": "${started}",
  "finishedOn": "${finished}",
  "builder": { "buildahVersion": "${buildah_version}", "image": "${IMG_BUILDAH:-unknown}", "isolation": "chroot", "storageDriver": "vfs" },
  "git": { "commit": "${commit}", "ref": "${CI_COMMIT_REF_NAME:-}", "repository": "${source_url}" },
  "ci": {
    "CI_SERVER_URL": "${CI_SERVER_URL:-}", "CI_SERVER_VERSION": "${CI_SERVER_VERSION:-}",
    "CI_RUNNER_ID": "${CI_RUNNER_ID:-}", "CI_RUNNER_VERSION": "${CI_RUNNER_VERSION:-}",
    "CI_PIPELINE_ID": "${CI_PIPELINE_ID:-}", "CI_JOB_ID": "${CI_JOB_ID:-}", "CI_JOB_URL": "${CI_JOB_URL:-}"
  }
}
JSON

var_prefix="$(printf '%s' "$COMPONENT_ID" | tr '[:lower:]-' '[:upper:]_')"
{
  echo "${var_prefix}_IMAGE_DIGEST=${digest}"
  echo "${var_prefix}_IMAGE_REF=${local_ref}"
} > "${out}/image.env"

echo "image ${local_ref}"
echo "digest ${digest}"
echo "archive ${out}/image.oci.tar sha256:${archive_sha} ($(du -h "${out}/image.oci.tar" | cut -f1))"
echo "user ${user} | healthcheck $(buildah inspect --storage-driver vfs --format '{{.Docker.Config.Healthcheck}}' "$local_ref" 2>/dev/null || echo n/a)"
