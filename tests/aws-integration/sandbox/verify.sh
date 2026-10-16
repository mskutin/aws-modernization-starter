#!/usr/bin/env bash
# Phase 2: read-only verification that a run left nothing behind.
#
#   SBX_RUN_ID=sbx-1a2b3c tests/aws-integration/sandbox/verify.sh   (default: the current run)
#   … verify.sh --include-bootstrap     (after bootstrap.sh --destroy: the toolkit must be gone too)
#   … verify.sh --baseline              (BEFORE the first deploy: records verify-baseline.json, which
#                                        later verifications pass to verify-clean as --baseline)
#
# Calls the FinOps sandbox tool's sweep (tools/aws-sandbox, executable dist/bin.js):
#   node tools/aws-sandbox/dist/bin.js verify-clean --run-id <id> --out <file> --strict
#     [--inventory <run>/inventory.json] [--baseline <run>/verify-baseline.json] --guard-log <run guard.log>
# (CloudFormation, ECS, EC2/VPC, ELB, RDS incl. snapshots, DynamoDB, Lambda, Step Functions,
# CloudFront, S3, ECR, CloudWatch Logs/alarms, KMS, Secrets Manager; non-zero when experiment
# resources remain; it runs the account guard before each of its AWS calls). Before it, a quick
# own check that no experiment stack is left.
# Exit: 0 clean; 1 experiment resources remain; 3 not verifiable (the finops tool is missing,
# refused, incomplete or wrote no report) — never reported as clean; 5 clean-with-unverifiable:
# nothing found, but categories the role cannot list (KMS keys, Secrets Manager) were settled
# only through fallbacks — each one is printed with its evidence (UNVERIFIABLE lines).
set -euo pipefail
# shellcheck source=_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

include_bootstrap=()
baseline_mode=false
case "${1:-}" in
  "") ;;
  --include-bootstrap) include_bootstrap=(--include-bootstrap) ;;
  --baseline) baseline_mode=true ;;
  *) sbx_die "usage: verify.sh [--include-bootstrap | --baseline]" 2 ;;
esac
resolve_run || sbx_die "no run: set SBX_RUN_ID (verify-clean needs the run id)" 2
mkdir -p "${RUN_DIR}/logs"
OUT_DIR="${SBX_VERIFY_OUT_DIR:-${RUN_DIR}/verify-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT_DIR"
start_logging
guard_init

if $baseline_mode; then
  [[ -f "$FINOPS_CLI" ]] || sbx_die "the finops tool (${FINOPS_CLI}) is not available: no baseline" 3
  set +e
  "${NODE_CMD[@]}" "$FINOPS_CLI" verify-clean --run-id "$RUN_ID" --out "${RUN_DIR}/verify-baseline.json" \
    --region "$SBX_REGION" --guard-log "$SANDBOX_GUARD_LOG" --strict
  brc=$?
  set -e
  # A baseline records what exists before the experiment; resources found (exit 1) are expected,
  # and so are categories this role cannot list (exit 5).
  if ((brc <= 1 || brc == 5)) && [[ -s "${RUN_DIR}/verify-baseline.json" ]]; then
    sbx_log "finops baseline recorded: ${RUN_DIR}/verify-baseline.json (exit ${brc})"
    exit 0
  fi
  rm -f "${RUN_DIR}/verify-baseline.json"
  sbx_die "verify-clean baseline failed (exit ${brc})" 3
fi

rc=0
awsr cloudformation describe-stacks --output json >"${OUT_DIR}/stacks.json"
left="$(tool experiment-stacks --run-id "$RUN_ID" "${OUT_DIR}/stacks.json")"
if [[ -n "$left" ]]; then
  sbx_warn "experiment stacks remain:"$'\n'"${left}"
  rc=1
else
  sbx_log "no Sandbox-* stack of ${RUN_ID} remains"
fi

if [[ ! -f "$FINOPS_CLI" ]]; then
  sbx_warn "the finops sweep (${FINOPS_CLI}) is not available: the account is NOT verified clean"
  exit $((rc == 1 ? 1 : 3))
fi
report="${OUT_DIR}/verify-clean.json"
rm -f "$report"
baseline=()
[[ -s "${RUN_DIR}/verify-baseline.json" ]] && baseline=(--baseline "${RUN_DIR}/verify-baseline.json")
# The run's inventory (up.sh) tells verify-clean what was created and since when.
inventory=()
if [[ -s "${RUN_DIR}/inventory.json" ]]; then
  inventory=(--inventory "${RUN_DIR}/inventory.json")
else
  sbx_warn "no inventory for ${RUN_ID} (up.sh did not reach it): verify-clean runs without --inventory"
fi
set +e
# --strict (the tool's default, kept explicit): retained, billed RDS
# snapshots/backups fail the verdict. Never --lenient.
"${NODE_CMD[@]}" "$FINOPS_CLI" verify-clean --run-id "$RUN_ID" --out "$report" --strict \
  --region "$SBX_REGION" --guard-log "$SANDBOX_GUARD_LOG" ${inventory[@]+"${inventory[@]}"} \
  ${include_bootstrap[@]+"${include_bootstrap[@]}"} ${baseline[@]+"${baseline[@]}"}
vrc=$?
set -e
# finops exit codes: 0 clean, 1 not clean, 2 usage, 3 refused, 4 incomplete, 5 clean with
# unverifiable categories. Every verdict also needs the report: an entry point that exits 0
# without running must not read as clean.
if ((vrc == 0)) && [[ -s "$report" ]]; then
  sbx_log "verify-clean: clean (${report})"
elif ((vrc == 1)) && [[ -s "$report" ]]; then
  sbx_warn "verify-clean: experiment resources remain (${report})"
  rc=1
elif ((vrc == 5)) && [[ -s "$report" ]]; then
  sbx_warn "verify-clean: nothing found, but these categories could NOT be listed with this role and are settled only by the evidence shown (${report}):"
  tool unverifiable "$report" || sbx_warn "  (the report names no category: treat the run as NOT verified)"
  ((rc == 1)) || rc=5
else
  sbx_warn "verify-clean exit ${vrc}$([[ -s "$report" ]] || echo ', no report'): NOT verified"
  ((rc == 1)) || rc=3
fi
exit "$rc"
