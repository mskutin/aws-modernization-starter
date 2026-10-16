#!/bin/sh
# Scheduled rescan target (SCHEDULE_TASK=rescan, protected runner STARTER_PROTECTED_RUNNER_TAG,
# ADR 0412): the latest published image of a component (moving tag <default branch>), accepted only
# with a valid signature from the runner-mounted trust anchor. Writes its digest (dotenv
# <ID>_RESCAN_REF) and its VERIFIED CycloneDX attestation for `trivy sbom`. No validly signed image =>
# FAIL: the release chain of the default branch did not complete, which is itself a finding. Needs
# release signing (STARTER_RELEASE_SIGNING=true): without it the target cannot be authenticated.
set -eu
. tools/ci/scripts/registry-tls.sh
if [ "${STARTER_RELEASE_SIGNING:-false}" != "true" ]; then
  echo "ERROR: signing: not configured (STARTER_RELEASE_SIGNING is not \"true\")." >&2
  echo "  The rescan accepts only images signed with the project key, so it cannot pick a trustworthy" >&2
  echo "  target. Enable release signing (docs/ci-cd.md) or remove the SCHEDULE_TASK=rescan schedule." >&2
  exit 1
fi
: "${COMPONENT_ID:?}" "${IMAGE_NAME:?}"
out=reports/rescan
mkdir -p "$out"
anchor="${STARTER_TRUST_ANCHOR:-/run/starter-trust/cosign.pub}"
[ -s "$anchor" ] || {
  echo "ERROR: trust anchor not mounted at ${anchor}" >&2
  exit 1
}
repo="${CI_REGISTRY_IMAGE:?}/${IMAGE_NAME##*/}"
tag="${RESCAN_TAG:-${CI_DEFAULT_BRANCH:?}}"
reg="$(registry_cosign_flags)"
printf '%s' "${CI_REGISTRY_PASSWORD:?}" |
  cosign login --username "${CI_REGISTRY_USER:?}" --password-stdin "${CI_REGISTRY:?}" >/dev/null

# shellcheck disable=SC2086 # $reg is empty or two flags
if ! cosign verify --key "$anchor" --insecure-ignore-tlog=true $reg "${repo}:${tag}" > "${out}/${COMPONENT_ID}.signature.json" 2> "${out}/${COMPONENT_ID}.signature.err"; then
  echo "ERROR: no validly signed image at ${repo}:${tag}" >&2
  grep -v WARNING "${out}/${COMPONENT_ID}.signature.err" | tail -n 2 >&2
  exit 1
fi
digest="$(grep -o '"docker-manifest-digest": *"sha256:[a-f0-9]*"' "${out}/${COMPONENT_ID}.signature.json" | head -n 1 | grep -o 'sha256:[a-f0-9]*')"
[ -n "$digest" ] || {
  echo "ERROR: could not read the signed digest of ${repo}:${tag}" >&2
  exit 1
}
# shellcheck disable=SC2086
cosign verify-attestation --key "$anchor" --insecure-ignore-tlog=true $reg --type cyclonedx "${repo}@${digest}" \
  > "${out}/${COMPONENT_ID}.cdx.intoto.jsonl" 2> /dev/null || {
  echo "ERROR: no verified CycloneDX attestation for ${repo}@${digest}" >&2
  exit 1
}
var_prefix="$(printf '%s' "$COMPONENT_ID" | tr '[:lower:]-' '[:upper:]_')"
printf '%s_RESCAN_REF=%s@%s\n' "$var_prefix" "$repo" "$digest" > "${out}/rescan.env"
echo "rescan target ${repo}:${tag} -> ${digest} (signature + SBOM attestation verified with the trust anchor)"
