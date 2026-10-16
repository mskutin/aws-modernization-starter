#!/usr/bin/env bash
# Destroy the run's mini-stack and VERIFY nothing is left. Idempotent; safe to call repeatedly
# (CI after_script, lifecycle.sh trap, after a failed deploy).
#
# Writes reports/aws-integration/cleanup-status.json:
#   { runId, region, destroyExitCode, status: clean|clean-with-residual-resources|stacks-clean|
#     unverifiable|leaked|error, ... }
# In sandbox mode it also runs the finops sweep (verify-clean, read-only): the sandbox permission set
# may not call tag:GetResources, so cleanup-verify can only prove the stacks gone ("stacks-clean").
# Exit: 0 clean, 1 leaked, 2 error, 3 not verified (stacks gone, resource sweep unavailable),
# 4 not verified (tagged resources still listed; a leak with AWS_INTEGRATION_STRICT_RESOURCES=true),
# 6 not verified (a listed KMS key's state could not be read),
# 5 (sandbox mode) nothing found, but the finops sweep settled categories the role cannot list
# (KMS keys, Secrets Manager) only through fallbacks — printed with their evidence.
set -euo pipefail
# shellcheck source=_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_enabled
require_region
setup_guard
load_run_env
mkdir -p "$REPORT_DIR"
status_file="${REPORT_DIR}/cleanup-status.json"

# Cleanup must not be cut short by a second Ctrl-C / CI cancel: record and continue.
interrupted=false
trap 'interrupted=true; log "interrupt received during cleanup; finishing verification first"' INT TERM

log "run ${AWS_INTEGRATION_RUN_ID}: cdk destroy"
set +e
if [[ -f "${INFRA_DIR}/dist/bin/integration.js" ]] || build_infra; then
  cdk destroy --all --force
  destroy_rc=$?
else
  log "could not build the infra app; skipping cdk destroy"
  destroy_rc=97
fi
set -e

verify_args=(
  --run-id "$AWS_INTEGRATION_RUN_ID"
  --region "$AWS_REGION"
  --destroy-exit-code "$destroy_rc"
  --wait-seconds "${AWS_INTEGRATION_CLEANUP_WAIT_SECONDS:-900}"
  --expected-account "$EXPECTED_ACCOUNT"
  --out "$status_file"
)
delete_remaining=false
if [[ $destroy_rc -ne 0 ]]; then
  log "cdk destroy failed (exit ${destroy_rc}); falling back to DeleteStack by starter:run-id tag"
  verify_args+=(--delete-remaining)
  delete_remaining=true
fi
[[ "${AWS_INTEGRATION_STRICT_RESOURCES:-false}" == "true" ]] && verify_args+=(--strict-resources)

ensure_suite_built
set +e
if $delete_remaining; then
  # DeleteStack is a mutation: through the guard (verification alone is read-only).
  guard_exec "DeleteStack fallback for run ${AWS_INTEGRATION_RUN_ID}" "${VERIFY_CMD[@]}" "${verify_args[@]}"
else
  "${VERIFY_CMD[@]}" "${verify_args[@]}"
fi
verify_rc=$?
set -e

# IAM roles of the run (e.g. the mini-stack's KeyProbeRole, named starter-it-<runId>-…) must be gone
# too. Read-only, sandbox mode only (the guard there requires the AWS CLI; CI has none).
iam_file="${REPORT_DIR}/iam-residual.json"
iam_rc=0
if [[ "$GUARD_MODE" == sandbox ]]; then
  set +e
  roles="$("${AWS_CLI_CMD[@]}" iam list-roles --profile "$SANDBOX_PROFILE" --region "$AWS_REGION" \
    --output text --query "Roles[?starts_with(RoleName, 'starter-it-${AWS_INTEGRATION_RUN_ID}-')].RoleName" 2>/dev/null)"
  list_rc=$?
  set -e
  roles="$(printf '%s' "$roles" | tr '\t' '\n' | grep -v '^None$' | grep -v '^$' || true)"
  if ((list_rc != 0)); then
    printf '{"runId":"%s","checked":false,"reason":"iam list-roles failed"}\n' "$AWS_INTEGRATION_RUN_ID" >"$iam_file"
    log "could not list IAM roles (exit ${list_rc}); IAM residue NOT verified"
    iam_rc=2
  elif [[ -n "$roles" ]]; then
    printf '{"runId":"%s","checked":true,"remainingRoles":%s}\n' "$AWS_INTEGRATION_RUN_ID" \
      "$(printf '%s\n' "$roles" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8").trim().split("\n")))')" >"$iam_file"
    log "IAM roles of run ${AWS_INTEGRATION_RUN_ID} remain: $(printf '%s' "$roles" | tr '\n' ' ')"
    iam_rc=1
  else
    printf '{"runId":"%s","checked":true,"remainingRoles":[]}\n' "$AWS_INTEGRATION_RUN_ID" >"$iam_file"
  fi
else
  printf '{"runId":"%s","checked":false,"reason":"ci mode (no AWS CLI)"}\n' "$AWS_INTEGRATION_RUN_ID" >"$iam_file"
fi

status="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('${status_file}','utf8')).status)" 2>/dev/null || echo unknown)"
finops_rc=""
if [[ "$GUARD_MODE" == sandbox && -f "$FINOPS_CLI" ]]; then
  set +e
  node "$FINOPS_CLI" verify-clean --run-id "$AWS_INTEGRATION_RUN_ID" --out "${REPORT_DIR}/verify-clean.json" \
    --strict --region "$AWS_REGION" --guard-log "$SANDBOX_GUARD_LOG"
  finops_rc=$?
  set -e
  [[ -s "${REPORT_DIR}/verify-clean.json" ]] || finops_rc=4
  log "finops verify-clean: exit ${finops_rc} (${REPORT_DIR}/verify-clean.json)"
  if ((finops_rc == 5)); then
    log "nothing found, but these categories could NOT be listed with this role and are settled only by the evidence shown:"
    "${SBX_TOOL_CMD[@]}" unverifiable "${REPORT_DIR}/verify-clean.json" ||
      log "  (the report names no category: treat the run as NOT verified)"
  fi
fi

if $interrupted; then
  log "cleanup was interrupted; status recorded in ${status_file}"
fi
log "cleanup status: ${status} (${status_file})"
# cleanup-verify exits 3 on stacks-clean (NOT verified); in sandbox mode the finops sweep below may
# still settle it, so only that verdict continues.
if [[ $verify_rc -ne 0 ]] && ! [[ $verify_rc -eq 3 && "$status" == stacks-clean ]]; then
  exit "$verify_rc"
fi
((iam_rc == 0)) || exit "$iam_rc"
if [[ -n "$finops_rc" ]]; then
  ((finops_rc == 0)) && exit 0
  ((finops_rc == 1)) && exit 1
  ((finops_rc == 5)) && exit 5
  exit 3
fi
if [[ "$status" == stacks-clean ]]; then
  log "the stacks are gone but no resource sweep could run: NOT verified (run the finops verify-clean for ${AWS_INTEGRATION_RUN_ID})"
  exit 3
fi
exit 0
