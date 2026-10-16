#!/bin/sh
# usage: trivy.sh fs | image | rescan
#   fs     : SCA over pnpm-lock.yaml (sca:trivy-fs)
#   image  : vulnerabilities + secrets in the built OCI archive (container:scan:<id>)
#   rescan : scheduled re-scan of the latest published, signed image AND of its verified CycloneDX
#            attestation with today's DB (container:rescan:<id>, SCHEDULE_TASK=rescan, ADR 0412)
# Gate: HIGH/CRITICAL with a fix available, minus documented, unexpired exceptions
# in .gitlab/security/trivyignore.yaml. The JSON report keeps every finding.
set -eu
mode="${1:?usage: trivy.sh fs|image}"
ignore=.gitlab/security/trivyignore.yaml
case "$mode" in
  fs)
    prefix=reports/sca/trivy-fs
    # Dev dependencies run on developer machines and CI runners: scan them too.
    set -- fs --scanners vuln --include-dev-deps --skip-dirs .pnpm-store,.cache,node_modules .
    ;;
  image)
    : "${COMPONENT_ID:?}"
    archive="oci-out/${COMPONENT_ID}/image.oci.tar"
    [ -f "$archive" ] || { echo "missing $archive (container:build:${COMPONENT_ID} artifact)" >&2; exit 1; }
    prefix="reports/container/trivy-image-${COMPONENT_ID}"
    # `trivy image --input` reads docker-archive tars or OCI layout DIRECTORIES.
    layout="$(mktemp -d)"
    tar -xf "$archive" -C "$layout"
    set -- image --scanners vuln,secret --input "$layout"
    ;;
  rescan)
    : "${COMPONENT_ID:?}"
    var_prefix="$(printf '%s' "$COMPONENT_ID" | tr '[:lower:]-' '[:upper:]_')"
    eval "ref=\${${var_prefix}_RESCAN_REF:-}"
    [ -n "$ref" ] || { echo "missing ${var_prefix}_RESCAN_REF (dotenv of container:rescan-verify:${COMPONENT_ID})" >&2; exit 1; }
    sbom="reports/rescan/${COMPONENT_ID}.cdx.intoto.jsonl"
    [ -s "$sbom" ] || { echo "missing ${sbom} (verified SBOM attestation)" >&2; exit 1; }
    # Registry credentials of this job (job token); TLS verified unless REGISTRY_TLS_VERIFY=false.
    TRIVY_USERNAME="${CI_REGISTRY_USER:?}"
    TRIVY_PASSWORD="${CI_REGISTRY_PASSWORD:?}"
    export TRIVY_USERNAME TRIVY_PASSWORD
    . tools/ci/scripts/registry-tls.sh
    tls="$(registry_tls_verify)"
    if [ "$tls" = false ]; then TRIVY_INSECURE=true; export TRIVY_INSECURE; fi
    prefix="reports/rescan/trivy-image-${COMPONENT_ID}"
    sbom_prefix="reports/rescan/trivy-sbom-${COMPONENT_ID}"
    set -- image --scanners vuln --image-src remote "$ref"
    ;;
  *) echo "unknown mode $mode" >&2; exit 2 ;;
esac
mkdir -p "$(dirname "$prefix")"
echo "trivy $(trivy --version | head -n 1) — $mode scan"
status=0
# gate PREFIX TRIVY-ARGS...: full JSON record, JUnit of the gating subset, then the gate itself
gate() {
  p=$1
  shift
  # 1) full record (all severities, no exceptions applied)
  trivy "$@" --format json --output "${p}.json" --exit-code 0
  # 2) JUnit of the gating subset for the MR widget
  trivy "$@" --ignorefile "$ignore" --ignore-unfixed --severity HIGH,CRITICAL \
    --format template --template "@/contrib/junit.tpl" --output "${p}-junit.xml" --exit-code 0
  # 3) the gate (human-readable table)
  trivy "$@" --ignorefile "$ignore" --ignore-unfixed --severity HIGH,CRITICAL \
    --format table --exit-code 1 || status=1
}
gate "$prefix" "$@"
if [ "$mode" = rescan ]; then
  echo "rescan of ${ref}: the image above, its verified SBOM attestation below"
  gate "$sbom_prefix" sbom "$sbom"
fi
exit "$status"
