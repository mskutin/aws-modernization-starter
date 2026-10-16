#!/usr/bin/env bash
# Full ephemeral lifecycle in one process: deploy -> run tests -> destroy + verify.
# Cleanup ALWAYS runs (EXIT trap covers test failures, errors, Ctrl-C and CI cancellation
# signals). Exit code: the test result, or the cleanup result if tests passed but cleanup leaked.
#
#   AWS_INTEGRATION_ENABLED=true AWS_REGION=ap-southeast-1 tests/aws-integration/scripts/lifecycle.sh
#   (another region: AWS_INTEGRATION_REGION=<region> AWS_REGION=<region> …; see _common.sh)
set -euo pipefail
# shellcheck source=_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_enabled
require_region
# Refuse before anything runs (exit 4) when no expected account is configured;
# deploy/run/cleanup initialise the guard themselves.
require_expected_account

export AWS_INTEGRATION_RUN_ID="${AWS_INTEGRATION_RUN_ID:-$(new_run_id)}"
test_rc=0
cleaned=false

# shellcheck disable=SC2329  # invoked via trap
finish() {
  local rc=$?
  trap - EXIT INT TERM
  if ! $cleaned; then
    cleaned=true
    "${SCRIPT_DIR}/cleanup.sh" || {
      local crc=$?
      log "cleanup reported a problem (exit ${crc}); see reports/aws-integration/cleanup-status.json"
      [[ $rc -eq 0 ]] && rc=$crc
    }
  fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${SCRIPT_DIR}/deploy.sh"
# deploy.sh may have cleaned up already on failure (set -e exits above, EXIT trap re-checks: idempotent)
set +e
"${SCRIPT_DIR}/run.sh"
test_rc=$?
set -e
exit "$test_rc"
