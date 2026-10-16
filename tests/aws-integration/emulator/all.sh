#!/usr/bin/env bash
# up.sh → ci.sh <suite>… → down.sh in one process; down.sh ALWAYS runs (EXIT trap). NOT AWS — see
# _emulator.sh. Socket-less by default (the CI service configuration, in loopback mode).
#
#   tests/aws-integration/emulator/all.sh              # cdk, then workflows
#   tests/aws-integration/emulator/all.sh workflows    # one suite
#
# Exit code: the first failing suite's, or down.sh's when the suites passed but teardown leaked.
set -euo pipefail
# shellcheck source=_emulator.sh
source "$(dirname "${BASH_SOURCE[0]}")/_emulator.sh"

suites=("$@")
[[ ${#suites[@]} -gt 0 ]] || suites=(cdk workflows)
for s in "${suites[@]}"; do
  [[ "$s" == cdk || "$s" == workflows ]] || die "usage: all.sh [cdk] [workflows]" 2
done

refuse_real_aws
export STARTER_EMULATOR_RUN_ID="${STARTER_EMULATOR_RUN_ID:-$(new_run_id)}"
torn_down=false

# shellcheck disable=SC2329  # invoked via trap
finish() {
  local rc=$?
  trap - EXIT INT TERM
  if ! $torn_down; then
    torn_down=true
    "${EM_DIR}/down.sh" "$STARTER_EMULATOR_RUN_ID" || {
      local drc=$?
      [[ $rc -eq 0 ]] && rc=$drc
    }
  fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${EM_DIR}/up.sh"
rc=0
for s in "${suites[@]}"; do
  src=0
  "${EM_DIR}/run.sh" "$STARTER_EMULATOR_RUN_ID" "$s" || src=$?
  [[ $rc -ne 0 || $src -eq 0 ]] || rc=$src
done
exit "$rc"
