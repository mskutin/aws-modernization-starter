#!/usr/bin/env bash
# Deploy the ephemeral AWS integration mini-stack for ONE run (unique runId, TTL-tagged).
#
#   AWS_INTEGRATION_ENABLED=true AWS_REGION=ap-southeast-1 tests/aws-integration/scripts/deploy.sh
#   (another region: AWS_INTEGRATION_REGION=<region> AWS_REGION=<region> …; see _common.sh)
#
# Requires the expected account (AWS_INTEGRATION_EXPECTED_ACCOUNT or the expected-account file;
# exit 4 otherwise) and deploys through the account guard (see _common.sh `setup_guard`), with
# -c account=<expected>, qualifier starter and toolkit stack starter-cdk-toolkit.
#
# Writes reports/aws-integration/run.env (run id, expiry) and outputs.json (cdk outputs:
# state machine ARN + table name). The infra app tags every stack starter:ephemeral=true,
# starter:run-id=<id>, starter:expires-at=<iso>, so the scheduled sweeper removes it even if this
# pipeline dies before cleanup.sh runs. On failure or interruption it runs cleanup.sh itself.
set -euo pipefail
# shellcheck source=_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_enabled
require_region
setup_guard

export AWS_INTEGRATION_RUN_ID="${AWS_INTEGRATION_RUN_ID:-$(new_run_id)}"
[[ "$AWS_INTEGRATION_RUN_ID" =~ $RUN_ID_RE ]] || die "invalid run id '${AWS_INTEGRATION_RUN_ID}'"
ttl_hours="${AWS_INTEGRATION_TTL_HOURS:-4}"
[[ "$ttl_hours" =~ ^[0-9]+$ && "$ttl_hours" -ge 1 && "$ttl_hours" -le 24 ]] ||
  die "AWS_INTEGRATION_TTL_HOURS must be an integer 1..24"
export AWS_INTEGRATION_EXPIRES_AT
AWS_INTEGRATION_EXPIRES_AT="$(node -e "process.stdout.write(new Date(Date.now()+${ttl_hours}*3600e3).toISOString().replace(/\.\d{3}Z$/,'Z'))")"

mkdir -p "$REPORT_DIR"
cat >"$RUN_ENV" <<EOF
AWS_INTEGRATION_RUN_ID=${AWS_INTEGRATION_RUN_ID}
AWS_INTEGRATION_EXPIRES_AT=${AWS_INTEGRATION_EXPIRES_AT}
AWS_REGION=${AWS_REGION}
EOF
log "run ${AWS_INTEGRATION_RUN_ID}: deploying (expires ${AWS_INTEGRATION_EXPIRES_AT}, region ${AWS_REGION})"

abort() {
  local code=$1
  trap - INT TERM
  log "deploy did not complete (exit ${code}); destroying partial run ${AWS_INTEGRATION_RUN_ID}"
  "${SCRIPT_DIR}/cleanup.sh" || log "cleanup after failed deploy also failed; the sweeper will retry"
  exit "$code"
}
trap 'abort 130' INT
trap 'abort 143' TERM

build_infra || abort 1

set +e
cdk deploy --all \
  --require-approval never \
  --progress events \
  --outputs-file "$OUTPUTS_FILE"
rc=$?
set -e
[[ $rc -eq 0 ]] || abort "$rc"
trap - INT TERM

[[ -s "$OUTPUTS_FILE" ]] || abort 1
log "deployed run ${AWS_INTEGRATION_RUN_ID}; outputs in ${OUTPUTS_FILE}"
