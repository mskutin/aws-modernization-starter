#!/bin/sh
# Cosign signing — opt-in (STARTER_RELEASE_SIGNING=true), protected release refs only (ADR 0411).
#
# The key is a runner-scoped secret: /run/starter-signing/{cosign.key,cosign.password,cosign.pub}
# is mounted read-only into the job containers of the signing runner (STARTER_SIGNER_RUNNER_TAG)
# only; it is never a GitLab variable. The job signs the published DIGEST (never a tag) and attests
# the SLSA provenance and the CycloneDX SBOM. No transparency-log upload (works offline and on a
# self-managed GitLab); signatures and attestations are stored as OCI referrers next to the image.
# Once signing is enabled, anything missing FAILS the job. Verification is a separate job on a
# separate runner (cosign-verify.sh).
set -eu
set +x # never trace: the key password is in this process's environment
. tools/ci/scripts/registry-tls.sh
: "${COMPONENT_ID:?}"
out=reports/signing
mkdir -p "$out"
key_dir="${STARTER_SIGNING_DIR:-/run/starter-signing}"

report() { printf '%s\n' "$1" > "${out}/${COMPONENT_ID}.json"; }
fail() {
  report "{\"signed\":false,\"reason\":\"$1\"}"
  echo "ERROR: $1" >&2
  exit 1
}

[ -s "${key_dir}/cosign.key" ] && [ -s "${key_dir}/cosign.password" ] && [ -s "${key_dir}/cosign.pub" ] ||
  fail "STARTER_RELEASE_SIGNING=true but no signing key is mounted at ${key_dir} on runner '${CI_RUNNER_DESCRIPTION:-?}' (STARTER_SIGNER_RUNNER_TAG='${STARTER_SIGNER_RUNNER_TAG:-}'): select the runner that mounts cosign.key, cosign.password and cosign.pub there (docs/ci-cd.md)"
digest="$(cat "oci-out/${COMPONENT_ID}/digest")"
var_prefix="$(printf '%s' "$COMPONENT_ID" | tr '[:lower:]-' '[:upper:]_')"
eval "published=\${${var_prefix}_PUBLISHED_REF:-}"
[ -n "$published" ] || fail "container:publish:${COMPONENT_ID} published nothing: a protected release needs the registry"
[ "${published#*@}" = "$digest" ] || fail "published ${published} is not the built digest ${digest}"
predicate="reports/provenance/${COMPONENT_ID}.predicate.json"
sbom="reports/sbom/${COMPONENT_ID}.cdx.json"
[ -s "$predicate" ] && [ -s "$sbom" ] || fail "provenance predicate or SBOM artifact missing"

reg="$(registry_cosign_flags)"
# shellcheck disable=SC2086 # $reg is empty or two flags
set -- --key "${key_dir}/cosign.key" --use-signing-config=false --tlog-upload=false $reg
printf '%s' "${CI_REGISTRY_PASSWORD:?}" |
  cosign login --username "${CI_REGISTRY_USER:?}" --password-stdin "${CI_REGISTRY:?}" >/dev/null

COSIGN_PASSWORD="$(cat "${key_dir}/cosign.password")"
export COSIGN_PASSWORD
echo "signing ${published} on runner ${CI_RUNNER_DESCRIPTION:-?}"
cosign sign "$@" "$published"
cosign attest "$@" --type slsaprovenance1 --predicate "$predicate" "$published"
cosign attest "$@" --type cyclonedx --predicate "$sbom" "$published"
unset COSIGN_PASSWORD

key_sha="$(sha256sum "${key_dir}/cosign.pub" | cut -d' ' -f1)"
report "{\"signed\":true,\"ref\":\"${published}\",\"digest\":\"${digest}\",\"attestations\":[\"https://slsa.dev/provenance/v1\",\"https://cyclonedx.org/bom\"],\"publicKeySha256\":\"${key_sha}\",\"tlogUpload\":false,\"runner\":\"${CI_RUNNER_DESCRIPTION:-}\",\"job\":\"${CI_JOB_URL:-}\"}"
echo "signed ${published} and attested provenance + SBOM (public key sha256 ${key_sha})"
