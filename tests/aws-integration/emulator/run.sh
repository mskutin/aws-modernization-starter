#!/usr/bin/env bash
# Run ci.sh (cdk or workflows) against the LOCAL MiniStack container started by up.sh, in loopback
# mode. NOT AWS — see _emulator.sh.
#
#   tests/aws-integration/emulator/run.sh [runId] [cdk|workflows]   # default: last up.sh, workflows
#
# Results land in reports/aws-integration/emulator/<ci.sh run id>/ (see ci.sh). Exit code: ci.sh's.
set -euo pipefail
# shellcheck source=_emulator.sh
source "$(dirname "${BASH_SOURCE[0]}")/_emulator.sh"

suite="workflows"
run_arg=""
for arg in "$@"; do
  case "$arg" in
    cdk | workflows) suite="$arg" ;;
    *) run_arg="$arg" ;;
  esac
done
load_run "$run_arg"
refuse_real_aws
[[ -f "${RUN_DIR}/run.env" ]] || die "missing ${RUN_DIR}/run.env; run up.sh first"
emulator_healthy || die "MiniStack ${MINISTACK_VERSION} is not answering on ${EMULATOR_ENDPOINT}"
executor="$(sed -n 's/^EMULATOR_LAMBDA_EXECUTOR=//p' "${RUN_DIR}/run.env")"

STARTER_EMULATOR_MODE=loopback STARTER_EMULATOR_PORT="$EMULATOR_PORT" \
  STARTER_EMULATOR_LAMBDA_EXECUTOR="${executor:-local}" STARTER_MINISTACK_IMAGE="$MINISTACK_IMAGE" \
  exec bash "${EM_DIR}/ci.sh" "$suite"
