#!/usr/bin/env bash
# Start a LOCAL MiniStack emulator in rootless Podman — SOCKET-LESS by default, configured like the
# GitLab CI service. NOT AWS — see _emulator.sh. Deploying and testing is ci.sh's job (run.sh,
# all.sh call it against this container in loopback mode).
#
#   tests/aws-integration/emulator/up.sh                 # new run id em-<6 hex>
#   STARTER_EMULATOR_PORT=45661 tests/aws-integration/emulator/up.sh
#   STARTER_EMULATOR_SOCKET_MACHINE=<machine> up.sh --socket-mode    # opt-in, see below
#
# Default (socket-less): container starter-ministack-<runId> (label starter.emulator.run-id=<runId>),
# published on 127.0.0.1:<port> only, LAMBDA_EXECUTOR=local (functions run as worker processes
# inside the MiniStack container), no volume, no socket, no host directory, no credentials, all
# capabilities dropped, no-new-privileges. Handler error names are lost in this mode
# (gap localExecutorErrorNames).
#
# --socket-mode (full-fidelity docker executor) hands MiniStack — a third-party image running as
# root — a container-engine API socket. It is REFUSED unless STARTER_EMULATOR_SOCKET_MACHINE names a
# dedicated Podman machine (not podman-machine-default) whose configuration has NO host mounts,
# and it uses that machine's connection for everything. Never on a shared or credential-holding
# engine, never in CI.
# Writes reports/aws-integration/emulator/<runId>/run.env.
# Exit codes: 5 refused (real AWS present), 6 not rootless / unsafe socket mode, 7 port busy.
set -euo pipefail
# shellcheck source=_emulator.sh
source "$(dirname "${BASH_SOURCE[0]}")/_emulator.sh"

SOCKET_MODE=false
for arg in "$@"; do
  case "$arg" in
    --socket-mode) SOCKET_MODE=true ;;
    *) die "usage: up.sh [--socket-mode]" 2 ;;
  esac
done

refuse_real_aws
RUN_ID="${STARTER_EMULATOR_RUN_ID:-$(new_run_id)}"
[[ "$RUN_ID" =~ $LOCAL_RUN_ID_RE ]] || die "invalid emulator run id '${RUN_ID}' (expected em-<6 hex>)"
RUN_DIR="${REPORT_ROOT}/${RUN_ID}"
CONTAINER="$(container_name "$RUN_ID")"
NETWORK="$CONTAINER"

# The opt-in socket mode: a dedicated machine with no host mounts, or nothing.
require_dedicated_machine() {
  local machine="${STARTER_EMULATOR_SOCKET_MACHINE:-}" config_dir mounts
  [[ -n "$machine" ]] ||
    die "--socket-mode needs STARTER_EMULATOR_SOCKET_MACHINE=<a dedicated Podman machine with no host mounts>" 6
  [[ "$machine" != podman-machine-default ]] ||
    die "--socket-mode refused: podman-machine-default is the shared machine (it mounts the home directory)" 6
  config_dir="$(podman machine inspect "$machine" --format '{{.ConfigDir.Path}}' 2>/dev/null)" ||
    die "--socket-mode refused: Podman machine '${machine}' not found" 6
  mounts="$(node -e '
    const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String((c.Mounts ?? []).length));' "${config_dir}/${machine}.json" 2>/dev/null)" ||
    die "--socket-mode refused: cannot read the configuration of machine '${machine}'" 6
  [[ "$mounts" == 0 ]] ||
    die "--socket-mode refused: machine '${machine}' has ${mounts} host mount(s); it must have none" 6
  PODMAN_CONNECTION="$machine"
}
if $SOCKET_MODE; then
  require_dedicated_machine
  log "SOCKET MODE on dedicated machine ${PODMAN_CONNECTION}: MiniStack gets that machine's engine socket"
else
  # The socket-less default needs no socket forwarding at all: only the published loopback port.
  :
fi

require_rootless
if curl -s --max-time 2 -o /dev/null "${EMULATOR_ENDPOINT}"; then
  die "127.0.0.1:${EMULATOR_PORT} is already in use (set STARTER_EMULATOR_PORT)" 7
fi

mkdir -p "$RUN_DIR"
chmod 700 "$RUN_DIR"
printf '%s\n' "$RUN_ID" >"${REPORT_ROOT}/current"
EXECUTOR=local
$SOCKET_MODE && EXECUTOR=docker
cat >"${RUN_DIR}/run.env" <<EOF
EMULATOR_RUN_ID=${RUN_ID}
EMULATOR_PORT=${EMULATOR_PORT}
EMULATOR_CONTAINER=${CONTAINER}
EMULATOR_PODMAN_CONNECTION=${PODMAN_CONNECTION}
EMULATOR_LAMBDA_EXECUTOR=${EXECUTOR}
MINISTACK_VERSION=${MINISTACK_VERSION}
MINISTACK_IMAGE=${MINISTACK_IMAGE}
TARGET=ministack-emulator
EOF
log "run ${RUN_ID}: MiniStack ${MINISTACK_VERSION} on ${EMULATOR_ENDPOINT}, Lambda executor ${EXECUTOR} (EMULATOR, not AWS)"

p image exists "$MINISTACK_IMAGE" || p pull --quiet "$MINISTACK_IMAGE" >/dev/null

# Same service configuration as the CI job: region, host name, socket-less local executor. The
# Lambda workers inherit MiniStack's environment, so AWS_ENDPOINT_URL is pinned to MiniStack's own
# loopback listener (in CI the job's AWS_ENDPOINT_URL=http://ministack:4566 would otherwise reach
# the workers, and the service alias does not resolve inside the service itself).
SERVICE_ENV=(
  -e "MINISTACK_REGION=${EMULATOR_REGION}"
  -e "MINISTACK_HOST=127.0.0.1"
  -e "AWS_ENDPOINT_URL=http://127.0.0.1:4566"
)
if ! $SOCKET_MODE; then
  p run -d --name "$CONTAINER" --hostname "$CONTAINER" \
    --label "starter.emulator.run-id=${RUN_ID}" --label starter.emulator.mode=socket-less \
    -p "127.0.0.1:${EMULATOR_PORT}:4566" \
    --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=1024 --memory=2g \
    "${SERVICE_ENV[@]}" -e LAMBDA_EXECUTOR=local \
    "$MINISTACK_IMAGE" >/dev/null
else
  p image exists "$LAMBDA_NODE_IMAGE" || p pull --quiet "$LAMBDA_NODE_IMAGE" >/dev/null
  p tag "$LAMBDA_NODE_IMAGE" "$LAMBDA_NODE_LOCAL_TAG"
  socket="$(p info --format '{{.Host.RemoteSocket.Path}}')"
  socket="${socket#unix://}"
  [[ "$socket" == /run/user/* ]] || die "unexpected rootless API socket path '${socket}'" 6
  p network create --label "starter.emulator.run-id=${RUN_ID}" "$NETWORK" >/dev/null
  p run -d --name "$CONTAINER" --hostname "$CONTAINER" --network "$NETWORK" \
    --label "starter.emulator.run-id=${RUN_ID}" --label starter.emulator.mode=socket \
    -p "127.0.0.1:${EMULATOR_PORT}:4566" \
    -v "${socket}:/var/run/docker.sock" --security-opt label=disable \
    -e "MINISTACK_REGION=${EMULATOR_REGION}" -e "MINISTACK_HOSTNAME=${CONTAINER}" \
    -e "MINISTACK_IMAGE_PREFIX=${IMAGE_PREFIX}" -e LAMBDA_EXECUTOR=docker \
    -e "LAMBDA_DOCKER_NETWORK=${NETWORK}" -e "AWS_ENDPOINT_URL=http://${CONTAINER}:4566" \
    "$MINISTACK_IMAGE" >/dev/null
fi

deadline=$((SECONDS + 60))
until emulator_healthy; do
  ((SECONDS < deadline)) || die "MiniStack ${MINISTACK_VERSION} did not become healthy in 60 s"
  sleep 1
done
log "ready: run ${RUN_ID} (tests: run.sh [runId] [cdk|workflows], teardown: down.sh)"
