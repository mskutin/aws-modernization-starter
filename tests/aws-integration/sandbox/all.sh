#!/usr/bin/env bash
# shellcheck disable=SC2329  # functions run via trap / run_check are reported as never invoked
# Phase 2 end to end: bootstrap → up → test → rollback → down (+ verify), with teardown ALWAYS
# (EXIT trap: deployment failure, test failure, Ctrl-C, SIGTERM).
#
#   tests/aws-integration/sandbox/all.sh
#
# SBX_DESTROY_BOOTSTRAP=true (default) also deletes the CDK bootstrap at the end — only if this
# experiment created it (bootstrap.json). Exit: the first failure of up/test/rollback/teardown;
# 4 refused; 5 when everything passed but the teardown verification could settle some categories
# only through fallbacks (verify.sh prints them).
set -euo pipefail
# shellcheck source=_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

# The run id is fixed here, so the teardown knows it even when up.sh fails before writing state.
export SBX_RUN_ID="${SBX_RUN_ID:-$(new_run_id)}"
set_run "$SBX_RUN_ID"
ensure_run_dir
start_logging
sbx_log "run ${RUN_ID}: bootstrap -> up -> test -> rollback -> down"

up_rc=0
test_rc=0
rollback_rc=0
down_rc=0
bootstrap_rc=0
tore_down=false

teardown() {
  local rc=$?
  # The teardown must not be cut short by a second Ctrl-C / CI cancel (ignored signals stay
  # ignored in down.sh too); `kill -9` remains the operator's last resort.
  trap - EXIT
  trap '' INT TERM
  if ! $tore_down; then
    tore_down=true
    sbx_log "teardown of ${RUN_ID}"
    set +e
    "${SBX_DIR}/down.sh"
    down_rc=$?
    if [[ "${SBX_DESTROY_BOOTSTRAP:-true}" == "true" ]]; then
      # 5: nothing found, some categories unverifiable with this role — a re-run cannot change
      # that, so the bootstrap goes too.
      if ((down_rc == 0 || down_rc == 5)); then
        "${SBX_DIR}/bootstrap.sh" --destroy || bootstrap_rc=$?
        if ((bootstrap_rc == 0)); then
          "${SBX_DIR}/verify.sh" --include-bootstrap || bootstrap_rc=$?
        fi
      else
        sbx_warn "teardown not clean (exit ${down_rc}): the bootstrap is kept so down.sh can be re-run"
      fi
    fi
    set -e
  fi
  printf '{"runId":"%s","up":%s,"test":%s,"rollback":%s,"down":%s,"bootstrapDestroy":%s,"finishedAt":"%s"}\n' \
    "$RUN_ID" "$up_rc" "$test_rc" "$rollback_rc" "$down_rc" "$bootstrap_rc" "$(now_iso)" >"${RUN_DIR}/all.json"
  sbx_log "up ${up_rc}, test ${test_rc}, rollback ${rollback_rc}, down ${down_rc}, bootstrap destroy ${bootstrap_rc}"
  ((rc != 0)) || rc=$up_rc
  ((rc != 0)) || rc=$test_rc
  ((rc != 0)) || rc=$rollback_rc
  ((rc != 0)) || rc=$down_rc
  ((rc != 0)) || rc=$bootstrap_rc
  exit "$rc"
}
trap teardown EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

set +e
# finops baseline BEFORE anything is deployed (the bootstrap included).
"${SBX_DIR}/verify.sh" --baseline ||
  sbx_warn "no finops baseline: the teardown verification runs without one"
"${SBX_DIR}/bootstrap.sh"
bootstrap_create_rc=$?
set -e
if ((bootstrap_create_rc != 0)); then
  up_rc=$bootstrap_create_rc
  exit "$up_rc"
fi

set +e
"${SBX_DIR}/up.sh"
up_rc=$?
set -e
((up_rc == 0)) || exit "$up_rc"

set +e
"${SBX_DIR}/test.sh"
test_rc=$?
"${SBX_DIR}/rollback.sh"
rollback_rc=$?
set -e
exit 0
