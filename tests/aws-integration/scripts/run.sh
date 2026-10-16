#!/usr/bin/env bash
# Run the real-AWS test project against the mini-stack deployed by deploy.sh.
#
# Sets AWS_INTEGRATION_REQUIRED=true so the suite FAILS (instead of skipping) when credentials
# or outputs are missing — a deployed run must never go green by skipping.
# Results: reports/junit/aws-integration.xml and reports/aws-integration/test-status.json.
set -euo pipefail
# shellcheck source=_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_enabled
require_region
setup_guard
load_run_env
[[ -s "$OUTPUTS_FILE" ]] || die "missing ${OUTPUTS_FILE}; run deploy.sh first"

export AWS_INTEGRATION_REQUIRED=true
export AWS_INTEGRATION_OUTPUTS="$OUTPUTS_FILE"
# The live suites write their evidence next to the lifecycle reports.
export AWS_INTEGRATION_REPORT_DIR="$REPORT_DIR"

log "run ${AWS_INTEGRATION_RUN_ID}: executing real-AWS tests"
set +e
# The tests start executions, write items and invoke Lambdas: a mutation, so through the guard.
guard_exec "real-AWS tests on mini-stack ${AWS_INTEGRATION_RUN_ID}" \
  "${PNPM_CMD[@]}" --filter @starter/tests-aws-integration run test:aws
rc=$?
set -e

cat >"${REPORT_DIR}/test-status.json" <<EOF
{
  "runId": "${AWS_INTEGRATION_RUN_ID}",
  "region": "${AWS_REGION}",
  "finishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "exitCode": ${rc},
  "junit": "reports/junit/aws-integration.xml"
}
EOF
log "tests finished with exit ${rc}"
exit "$rc"
