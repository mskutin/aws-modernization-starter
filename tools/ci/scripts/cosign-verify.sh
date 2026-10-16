#!/bin/sh
# Independent release verification — opt-in with signing (STARTER_RELEASE_SIGNING=true), protected
# release refs only (ADR 0411), on the protected runner (STARTER_PROTECTED_RUNNER_TAG), a separate job
# from signing. The trust anchor is the runner-mounted /run/starter-trust/cosign.pub, which the MR
# cannot change. Every check must hold; anything missing FAILS the job (exit 1):
#   1. the committed .gitlab/security/cosign.pub (the project's published key, committed by the
#      adopter) equals the trust anchor (missing or drift fails)
#   2. a valid signature over the BUILT digest, and the published tag <commit sha> resolves to it
#   3. valid SLSA provenance and CycloneDX attestations whose subject is the built digest; the
#      provenance names the commit
#   4. negative controls that must FAIL for the right reason: an unsigned artifact of the same
#      repository ("no signatures found"), and the signed digest against an unrelated, freshly
#      generated key ("signatures do not match")
set -eu
. tools/ci/scripts/registry-tls.sh
: "${COMPONENT_ID:?}"
out=reports/verify
mkdir -p "$out"
anchor="${STARTER_TRUST_ANCHOR:-/run/starter-trust/cosign.pub}"
tree_key=.gitlab/security/cosign.pub
passed=""

pass() {
  passed="${passed}${passed:+,}\"$1\""
  echo "PASS $1"
}
fail() {
  printf '{"verified":false,"reason":"%s","passed":[%s]}\n' "$1" "$passed" > "${out}/${COMPONENT_ID}.json"
  echo "FAIL $1" >&2
  exit 1
}

[ -s "$anchor" ] || fail "trust anchor not mounted at ${anchor} on runner '${CI_RUNNER_DESCRIPTION:-?}' (runner-scoped; STARTER_PROTECTED_RUNNER_TAG='${STARTER_PROTECTED_RUNNER_TAG:-}', docs/ci-cd.md)"
[ -s "$tree_key" ] || fail "${tree_key} missing: commit the project's public signing key there (docs/ci-cd.md)"
anchor_sha="$(sha256sum "$anchor" | cut -d' ' -f1)"
tree_sha="$(sha256sum "$tree_key" | cut -d' ' -f1)"
[ "$anchor_sha" = "$tree_sha" ] || fail "${tree_key} (sha256 ${tree_sha}) differs from the runner trust anchor (sha256 ${anchor_sha})"
pass "trust anchor sha256 ${anchor_sha} equals ${tree_key}"

digest="$(cat "oci-out/${COMPONENT_ID}/digest")"
var_prefix="$(printf '%s' "$COMPONENT_ID" | tr '[:lower:]-' '[:upper:]_')"
eval "published=\${${var_prefix}_PUBLISHED_REF:-}"
[ -n "$published" ] || fail "nothing was published for ${COMPONENT_ID}"
[ "${published#*@}" = "$digest" ] || fail "published ${published} is not the built digest ${digest}"
repo="${published%@*}"

reg="$(registry_cosign_flags)"
printf '%s' "${CI_REGISTRY_PASSWORD:?}" |
  cosign login --username "${CI_REGISTRY_USER:?}" --password-stdin "${CI_REGISTRY:?}" >/dev/null

# shellcheck disable=SC2086 # $reg is empty or two flags
verify() { cosign verify --key "$anchor" --insecure-ignore-tlog=true $reg "$@"; }
# shellcheck disable=SC2086
verify_att() { cosign verify-attestation --key "$anchor" --insecure-ignore-tlog=true $reg "$@"; }

verify "${repo}@${digest}" > "${out}/signature.json" 2> "${out}/signature.err" ||
  fail "no valid signature for ${repo}@${digest}"
grep -q "\"docker-manifest-digest\": *\"${digest}\"" "${out}/signature.json" || fail "signature payload does not name ${digest}"
pass "signature over the built digest ${digest}"

verify "${repo}:${CI_COMMIT_SHA:?}" > "${out}/tag.json" 2> "${out}/tag.err" ||
  fail "tag ${CI_COMMIT_SHA} has no valid signature (tampered or re-pushed tag?)"
grep -q "\"docker-manifest-digest\": *\"${digest}\"" "${out}/tag.json" || fail "tag ${CI_COMMIT_SHA} does not resolve to ${digest}"
pass "published tag ${CI_COMMIT_SHA} resolves to the built digest"

for type in slsaprovenance1 cyclonedx; do
  verify_att --type "$type" "${repo}@${digest}" > "${out}/${type}.att.json" 2> "${out}/${type}.err" ||
    fail "no valid ${type} attestation for ${digest}"
  payload="$(sed -n 's/.*"payload": *"\([^"]*\)".*/\1/p' "${out}/${type}.att.json" | head -n 1 | base64 -d)"
  printf '%s' "$payload" | grep -q "\"sha256\": *\"${digest#sha256:}\"" || fail "${type} attestation subject is not ${digest}"
  if [ "$type" = slsaprovenance1 ]; then
    printf '%s' "$payload" | grep -q '"predicateType": *"https://slsa.dev/provenance/v1"' || fail "provenance predicate type"
    printf '%s' "$payload" | grep -q "${CI_COMMIT_SHA}" || fail "provenance does not name commit ${CI_COMMIT_SHA}"
  fi
  pass "${type} attestation verified (subject = built digest)"
done

# Negative control 1: an artifact of the same repository that nobody signed (a referrer of the
# image, e.g. its signature manifest) must be rejected because it has no signature.
# shellcheck disable=SC2086
unsigned="$(cosign tree $reg "${repo}@${digest}" 2>/dev/null | grep 'via OCI referrer' | grep -o '@sha256:[a-f0-9]\{64\}' | head -n 1)"
[ -n "$unsigned" ] || fail "no referrer artifact found for the unsigned-digest control"
if verify "${repo}${unsigned}" > /dev/null 2> "${out}/negative-unsigned.err"; then
  fail "the unsigned artifact ${unsigned#@} verified"
fi
grep -q 'no signatures found' "${out}/negative-unsigned.err" ||
  fail "unsigned control failed for an unexpected reason: $(grep -v WARNING "${out}/negative-unsigned.err" | tail -n 1)"
pass "unsigned digest ${unsigned#@} rejected (no signatures found)"

# Negative control 2: the signed digest must not verify against an unrelated key.
other="$(mktemp -d)"
(cd "$other" && COSIGN_PASSWORD="$(head -c 24 /dev/urandom | base64)" cosign generate-key-pair --output-key-prefix other > /dev/null 2>&1)
# shellcheck disable=SC2086
if cosign verify --key "${other}/other.pub" --insecure-ignore-tlog=true $reg "${repo}@${digest}" > /dev/null 2> "${out}/negative-key.err"; then
  fail "the signed digest verified against an unrelated key"
fi
grep -qE 'signatures do not match|no matching signatures' "${out}/negative-key.err" ||
  fail "unrelated-key control failed for an unexpected reason: $(grep -v WARNING "${out}/negative-key.err" | tail -n 1)"
rm -rf "$other"
pass "unrelated key rejected"

printf '{"verified":true,"ref":"%s","digest":"%s","trustAnchorSha256":"%s","passed":[%s],"runner":"%s","job":"%s"}\n' \
  "$published" "$digest" "$anchor_sha" "$passed" "${CI_RUNNER_DESCRIPTION:-}" "${CI_JOB_URL:-}" > "${out}/${COMPONENT_ID}.json"
echo "verified ${published}"
