#!/usr/bin/env bash
# Tear down a LOCAL MiniStack emulator run (up.sh): its container (with its anonymous volumes) and,
# in the opt-in socket mode, the Lambda containers MiniStack started for it and its network —
# nothing else. NOT AWS — see _emulator.sh.
#
#   tests/aws-integration/emulator/down.sh [runId]  # default: the run of the last up.sh
#
# Only objects labelled for this run are touched (starter.emulator.run-id=<runId>, and MiniStack's
# own ministack.instance=starter-ministack-<runId>:4566 on its Lambda containers); no prune. The
# pinned images stay cached; STARTER_EMULATOR_REMOVE_IMAGES=true also removes the private Lambda tag.
# Writes reports/aws-integration/emulator/<runId>/down-status.json. Idempotent.
set -euo pipefail
# shellcheck source=_emulator.sh
source "$(dirname "${BASH_SOURCE[0]}")/_emulator.sh"

load_run "${1:-}"
if [[ -f "${RUN_DIR}/run.env" ]]; then
  connection="$(sed -n 's/^EMULATOR_PODMAN_CONNECTION=//p' "${RUN_DIR}/run.env")"
  [[ -z "$connection" ]] || PODMAN_CONNECTION="$connection"
fi
require_rootless

lambda_filter="label=ministack.instance=${CONTAINER}:4566"
lambdas="$(p ps -a -q --filter "$lambda_filter")"
if [[ -n "$lambdas" ]]; then
  log "removing the Lambda container(s) of run ${RUN_ID}"
  # shellcheck disable=SC2086  # container ids, one per line: word splitting is intended
  p rm -f -v $lambdas >/dev/null
fi
if p container exists "$CONTAINER"; then
  log "removing container ${CONTAINER} and its anonymous volumes"
  p rm -f -v -t 5 "$CONTAINER" >/dev/null
fi
if p network exists "$NETWORK"; then
  p network rm "$NETWORK" >/dev/null
fi
if [[ "${STARTER_EMULATOR_REMOVE_IMAGES:-false}" == "true" ]] && p image exists "$LAMBDA_NODE_LOCAL_TAG"; then
  p untag "$LAMBDA_NODE_LOCAL_TAG" >/dev/null || true
fi

left_containers="$(p ps -a -q --filter "label=starter.emulator.run-id=${RUN_ID}" | wc -l | tr -d ' ')"
left_lambdas="$(p ps -a -q --filter "$lambda_filter" | wc -l | tr -d ' ')"
left_network=false
p network exists "$NETWORK" && left_network=true
status=clean
[[ "$left_containers" == 0 && "$left_lambdas" == 0 && "$left_network" == false ]] || status=leaked

mkdir -p "$RUN_DIR"
cat >"${RUN_DIR}/down-status.json" <<EOF
{
  "runId": "${RUN_ID}",
  "target": "ministack-emulator",
  "finishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "${status}",
  "containersLeft": ${left_containers},
  "lambdaContainersLeft": ${left_lambdas},
  "networkLeft": ${left_network}
}
EOF
if [[ -f "${REPORT_ROOT}/current" && "$(cat "${REPORT_ROOT}/current")" == "$RUN_ID" ]]; then
  rm -f "${REPORT_ROOT}/current"
fi
log "teardown of ${RUN_ID}: ${status}"
[[ "$status" == clean ]]
