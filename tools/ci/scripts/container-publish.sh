#!/bin/sh
# Publish the scanned OCI archive to the project's GitLab container registry with skopeo, preserving
# the digest — protected release refs only (ADR 0411), and only when the registry is enabled (the job
# does not exist otherwise; release:status reports "not published"). Tags: <commit sha>, plus the
# moving tag <default branch> (or <git tag>) that the rescan schedule follows. Every tag is re-read
# and must resolve to the built digest. TLS is verified unless REGISTRY_TLS_VERIFY=false.
set -eu
. tools/ci/scripts/registry-tls.sh
: "${COMPONENT_ID:?}" "${IMAGE_NAME:?}"
out=reports/publish
mkdir -p "$out"
archive="oci-out/${COMPONENT_ID}/image.oci.tar"
digest="$(cat "oci-out/${COMPONENT_ID}/digest")"
var_prefix="$(printf '%s' "$COMPONENT_ID" | tr '[:lower:]-' '[:upper:]_')"

if [ -z "${CI_REGISTRY:-}" ] || [ -z "${CI_REGISTRY_IMAGE:-}" ]; then
  # The job's rules require CI_REGISTRY_IMAGE; reaching this means the rules were bypassed.
  printf '{"published":false,"reason":"container registry not available (CI_REGISTRY unset)","digest":"%s"}\n' "$digest" > "${out}/${COMPONENT_ID}.json"
  echo "ERROR: NOT PUBLISHED: the GitLab container registry is not enabled for this project (CI_REGISTRY unset)." >&2
  exit 1
fi

dest="${CI_REGISTRY_IMAGE}/${IMAGE_NAME##*/}"
tls="$(registry_tls_verify)"
authdir="$(mktemp -d)"
auth="${authdir}/auth.json"
printf '{}' > "$auth" # skopeo needs a valid JSON auth file, not an empty one
trap 'rm -f "$auth"; rmdir "$authdir"' EXIT
if ! printf '%s' "$CI_REGISTRY_PASSWORD" |
  skopeo login --authfile "$auth" --tls-verify="$tls" --username "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"; then
  echo "ERROR: login to ${CI_REGISTRY} failed (TLS verification ${tls})." >&2
  echo "  A registry served over plain HTTP or with a private CA needs either a trusted certificate on" >&2
  echo "  the runner or the explicit opt-in REGISTRY_TLS_VERIFY=false (docs/ci-cd.md)." >&2
  exit 1
fi
tags="${CI_COMMIT_SHA}"
if [ -n "${CI_COMMIT_TAG:-}" ]; then
  tags="${tags} ${CI_COMMIT_TAG}"
elif [ -n "${CI_COMMIT_BRANCH:-}" ] && [ "${CI_COMMIT_BRANCH}" = "${CI_DEFAULT_BRANCH:-}" ]; then
  tags="${tags} ${CI_DEFAULT_BRANCH}"
fi
for tag in $tags; do
  skopeo copy --authfile "$auth" --dest-tls-verify="$tls" --preserve-digests --retry-times 2 \
    "oci-archive:${archive}" "docker://${dest}:${tag}"
  remote="sha256:$(skopeo inspect --authfile "$auth" --tls-verify="$tls" --raw "docker://${dest}:${tag}" | sha256sum | cut -d' ' -f1)"
  if [ "$remote" != "$digest" ]; then
    echo "ERROR: registry digest of ${dest}:${tag} is ${remote}, built digest ${digest}" >&2
    exit 1
  fi
done
printf '{"published":true,"ref":"%s@%s","tags":"%s","runner":"%s"}\n' "$dest" "$digest" "$tags" "${CI_RUNNER_DESCRIPTION:-}" > "${out}/${COMPONENT_ID}.json"
{
  echo "${var_prefix}_PUBLISHED_REF=${dest}@${digest}"
  echo "${var_prefix}_PUBLISHED_TAGS=${tags}"
} > "${out}/publish.env"
echo "published ${dest}@${digest} (tags: ${tags})"
