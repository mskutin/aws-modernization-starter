#!/usr/bin/env bash
# rootless-socket.sh — give docker-compose, Testcontainers and `podman --url` a ROOTLESS Podman API
# socket, on macOS and on Linux, through one interface.
#
# Usage: scripts/podman/rootless-socket.sh {start|stop|status|env}
#   start   idempotent: make the rootless API socket answer, verify it reports rootless=true
#   stop    stop only what this helper started (never a socket that systemd or another tool owns)
#   status  exit 0 if the socket answers and reports rootless=true
#   env     ensure started, then print shell exports, e.g.
#             eval "$(scripts/podman/rootless-socket.sh env)"
#
# Modes (STARTER_PODMAN_MODE=auto picks by `uname -s`):
#   machine  macOS. `podman compose` (external docker-compose provider) ignores `--connection` and
#            talks to the machine's *default* API socket, which is often the ROOTFUL one. This mode
#            forwards the rootless socket of the VM user over SSH to
#            ~/.local/share/starter-podman/run/podman-rootless.sock. SSH port, identity and user
#            come from `podman machine inspect`; the remote path is resolved inside the VM.
#   native   Linux (incl. WSL2) with rootless Podman: the user's own
#            $XDG_RUNTIME_DIR/podman/podman.sock, socket-activated with `systemctl --user start
#            podman.socket` when a systemd user session exists, otherwise served by a
#            `podman system service` process that this helper starts, records and (on `stop`) ends.
#
# Rootless only: the helper refuses to run as uid 0 in native mode, never uses sudo or a rootful
# socket, and verifies that the API reports rootless=true before `env` prints anything.
#
# Environment overrides:
#   STARTER_PODMAN_MODE           auto | machine | native                         (default: auto)
#   PODMAN_MACHINE                machine name, machine mode         (default: podman-machine-default)
#   STARTER_PODMAN_ROOTLESS_SOCK  socket path used by host tools
#                                   machine: ~/.local/share/starter-podman/run/podman-rootless.sock
#                                   native : $XDG_RUNTIME_DIR/podman/podman.sock
#   STARTER_PODMAN_START_TIMEOUT  seconds to wait for the API after starting it         (default: 20)
#
# Diagnostics go to stderr; `env` prints only `export` lines to stdout.
set -euo pipefail

log() { printf 'rootless-socket: %s\n' "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

START_TIMEOUT=${STARTER_PODMAN_START_TIMEOUT:-20}
[[ "$START_TIMEOUT" =~ ^[0-9]+$ ]] || die "STARTER_PODMAN_START_TIMEOUT must be a whole number of seconds"

detect_mode() {
  local os
  os=$(uname -s 2>/dev/null || echo unknown)
  case "${STARTER_PODMAN_MODE:-auto}" in
    auto)
      case "$os" in
        Darwin) MODE=machine ;;
        Linux) MODE=native ;;
        *) die "unsupported OS '$os': use macOS (podman machine) or Linux (rootless Podman; on Windows: WSL2)" ;;
      esac
      ;;
    machine) MODE=machine ;;
    native)
      [[ "$os" == Linux ]] || die "STARTER_PODMAN_MODE=native needs Linux (this is '$os'); on macOS use machine mode"
      MODE=native
      ;;
    *) die "STARTER_PODMAN_MODE must be auto, machine or native (got '${STARTER_PODMAN_MODE}')" ;;
  esac
}

require_tools() {
  command -v podman >/dev/null || die "podman CLI not found (install Podman 5+, see docs/development.md)"
  command -v curl >/dev/null || die "curl not found (needed to probe the Podman API socket)"
}

# ------------------------------------------------------------------------------------- common
api_info() {
  [[ -S "$SOCK" ]] || return 1
  curl -fsS --max-time 5 --unix-socket "$SOCK" http://d/v4.0.0/libpod/info 2>/dev/null
}

# Returns 0 when the socket answers and the engine is rootless.
api_ok() {
  local info
  info=$(api_info) || return 1
  grep -Eq '"rootless": ?true' <<<"$info"
}

# Fails loudly when something answers on the socket but it is NOT rootless.
refuse_rootful() {
  local info
  info=$(api_info) || return 0
  if grep -Eq '"rootless": ?false' <<<"$info"; then
    die "$SOCK serves a ROOTFUL Podman API; refusing (this helper only works with rootless Podman)"
  fi
}

# Polls (bounded by STARTER_PODMAN_START_TIMEOUT) until the rootless API answers.
wait_api() {
  local deadline=$((SECONDS + START_TIMEOUT))
  until api_ok; do
    refuse_rootful
    ((SECONDS < deadline)) || return 1
    sleep 0.5
  done
}

# $1: the socket path as the ENGINE sees it (Testcontainers bind-mounts it into its Ryuk reaper).
print_env() {
  printf 'export DOCKER_HOST=%q\n' "unix://${SOCK}"
  printf 'export CONTAINER_HOST=%q\n' "unix://${SOCK}"
  printf 'export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=%q\n' "$1"
}

# ----------------------------------------------------------------------------- machine (macOS)
machine_setup() {
  MACHINE=${PODMAN_MACHINE:-podman-machine-default}
  SOCK=${STARTER_PODMAN_ROOTLESS_SOCK:-$HOME/.local/share/starter-podman/run/podman-rootless.sock}
  RUN_DIR=$(dirname "$SOCK")
  CTL="$RUN_DIR/podman-rootless.ssh-ctl"
  REMOTE_FILE="$RUN_DIR/podman-rootless.remote-path"
}

machine_field() {
  podman machine inspect --format "$1" "$MACHINE" 2>/dev/null
}

load_machine() {
  require_tools
  local state
  state=$(machine_field '{{.State}}') ||
    die "podman machine '$MACHINE' not found (create one: podman machine init && podman machine start; or set PODMAN_MACHINE)"
  [[ "$state" == "running" ]] || die "podman machine '$MACHINE' is '$state' (run: podman machine start $MACHINE)"
  SSH_PORT=$(machine_field '{{.SSHConfig.Port}}')
  SSH_KEY=$(machine_field '{{.SSHConfig.IdentityPath}}')
  SSH_USER=$(machine_field '{{.SSHConfig.RemoteUsername}}')
  [[ -n "$SSH_PORT" && -n "$SSH_KEY" && -n "$SSH_USER" ]] || die "could not read SSH config from 'podman machine inspect $MACHINE'"
  [[ "$SSH_USER" != "root" ]] || die "machine RemoteUsername is root; a non-root user is required for rootless"
  SSH_OPTS=(-i "$SSH_KEY" -p "$SSH_PORT"
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
    -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10)
}

tunnel_pids() {
  pgrep -f -- "-L ${SOCK}:" 2>/dev/null || true
}

# Prints the VM user's rootless socket path; with "activate", socket-activates it first.
remote_socket_path() {
  # Evaluated by the VM user's shell (not here), hence single quotes.
  # shellcheck disable=SC2016
  local cmd='printf "%s\n" "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman/podman.sock"'
  [[ "$1" == activate ]] && cmd="systemctl --user start podman.socket >/dev/null 2>&1 || true; $cmd"
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@127.0.0.1" "$cmd"
}

machine_status() {
  if api_ok; then
    log "OK: $SOCK -> rootless Podman API (machine $MACHINE)"
    return 0
  fi
  refuse_rootful
  if [[ -n "$(tunnel_pids)" ]]; then
    log "DEGRADED: ssh forward process exists but the API does not answer as rootless"
  else
    log "DOWN: no forward for $SOCK"
  fi
  return 1
}

machine_start() {
  if api_ok; then
    log "already running: $SOCK"
    return 0
  fi
  refuse_rootful
  load_machine
  # macOS sun_path is 104 bytes; ssh fails with "Bad local forwarding specification" beyond it.
  ((${#SOCK} < 100 && ${#CTL} < 100)) || die "socket path too long for a unix socket (${#SOCK} chars): $SOCK"
  mkdir -p "$RUN_DIR"
  chmod 700 "$RUN_DIR"

  # Kill a half-dead forward for our socket path, if any.
  local pids
  pids=$(tunnel_pids)
  if [[ -n "$pids" ]]; then
    log "removing stale forward (pids: $(tr '\n' ' ' <<<"$pids"))"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
  fi
  rm -f "$CTL"

  # Make sure the user's API socket is listening (socket-activated) and get its path.
  local remote
  remote=$(remote_socket_path activate) || die "ssh to ${SSH_USER}@127.0.0.1:${SSH_PORT} failed"
  [[ "$remote" == /* ]] || die "unexpected remote socket path: '$remote'"
  printf '%s\n' "$remote" >"$REMOTE_FILE"

  ssh "${SSH_OPTS[@]}" \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -o StreamLocalBindUnlink=yes -o StreamLocalBindMask=0177 \
    -M -S "$CTL" -fnNT -L "${SOCK}:${remote}" "${SSH_USER}@127.0.0.1" ||
    die "could not start ssh forward"

  wait_api || die "forward started but the rootless API did not answer within ${START_TIMEOUT}s"
  log "started: $SOCK -> ${SSH_USER}@vm:${remote}"
}

machine_stop() {
  if [[ -S "$CTL" ]]; then
    load_machine
    ssh "${SSH_OPTS[@]}" -S "$CTL" -O exit "${SSH_USER}@127.0.0.1" >/dev/null 2>&1 || true
  fi
  local pids
  pids=$(tunnel_pids)
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
  fi
  rm -f "$SOCK" "$CTL"
  log "stopped"
}

machine_env() {
  machine_start
  local remote
  remote=$(cat "$REMOTE_FILE" 2>/dev/null || true)
  if [[ -z "$remote" ]]; then
    # The forward was started by something else; resolve the remote path once.
    load_machine
    remote=$(remote_socket_path no-activate)
    [[ "$remote" == /* ]] || die "unexpected remote socket path: '$remote'"
    printf '%s\n' "$remote" >"$REMOTE_FILE"
  fi
  # Testcontainers mounts the socket into a container, i.e. inside the VM: the VM-side path.
  print_env "$remote"
}

# ------------------------------------------------------------------------------ native (Linux)
native_setup() {
  local uid
  uid=$(id -u)
  [[ "$uid" != 0 ]] || die "running as root: this helper manages ROOTLESS Podman only; run it as your regular user (never with sudo)"
  RUNTIME_DIR=${XDG_RUNTIME_DIR:-}
  if [[ -z "$RUNTIME_DIR" ]]; then
    # Some login paths (su, cron, ssh without pam_systemd) do not export it.
    if [[ -d "/run/user/$uid" && -O "/run/user/$uid" ]]; then
      RUNTIME_DIR="/run/user/$uid"
    else
      die "XDG_RUNTIME_DIR is not set and /run/user/$uid does not exist: log in through a regular user session (systemd-logind), or run 'loginctl enable-linger' for your user and log in again"
    fi
  fi
  DEFAULT_SOCK="$RUNTIME_DIR/podman/podman.sock"
  SOCK=${STARTER_PODMAN_ROOTLESS_SOCK:-$DEFAULT_SOCK}
  STATE_DIR="$RUNTIME_DIR/starter-podman"
  PID_FILE="$STATE_DIR/service.pid"
  SERVICE_LOG="$STATE_DIR/service.log"
}

have_systemd_user() {
  command -v systemctl >/dev/null &&
    systemctl --user show-environment >/dev/null 2>&1 &&
    systemctl --user cat podman.socket >/dev/null 2>&1
}

# Prints the PID of the `podman system service` this helper started for $SOCK, if it still runs.
own_service_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid args
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  args=$(ps -o args= -p "$pid" 2>/dev/null || true)
  [[ "$args" == *"system service"*"unix://${SOCK}"* ]] || return 1
  printf '%s\n' "$pid"
}

native_status() {
  if api_ok; then
    log "OK: $SOCK -> rootless Podman API (native)"
    return 0
  fi
  refuse_rootful
  log "DOWN: no rootless Podman API on $SOCK (run: scripts/podman/rootless-socket.sh start)"
  return 1
}

native_start() {
  if api_ok; then
    log "already running: $SOCK"
    return 0
  fi
  refuse_rootful
  require_tools
  mkdir -p "$(dirname "$SOCK")"

  if [[ "$SOCK" == "$DEFAULT_SOCK" ]] && have_systemd_user; then
    systemctl --user start podman.socket || die "systemctl --user start podman.socket failed"
    wait_api || die "podman.socket started but the rootless API did not answer on $SOCK within ${START_TIMEOUT}s"
    log "started: $SOCK (systemd --user podman.socket)"
    return 0
  fi

  # No systemd user session (containers, WSL2 without systemd, minimal hosts) or a custom path:
  # serve the API from a process of our own, recorded so that `stop` ends exactly that one.
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  local pid
  if pid=$(own_service_pid); then
    log "removing stale podman system service (pid $pid)"
    kill "$pid" 2>/dev/null || true
  fi
  nohup podman system service --time=0 "unix://${SOCK}" </dev/null >"$SERVICE_LOG" 2>&1 &
  printf '%s\n' "$!" >"$PID_FILE"
  if ! wait_api; then
    log "--- last lines of $SERVICE_LOG"
    tail -n 20 "$SERVICE_LOG" >&2 || true
    die "podman system service did not answer as rootless on $SOCK within ${START_TIMEOUT}s"
  fi
  log "started: $SOCK (podman system service, pid $(cat "$PID_FILE"))"
}

native_stop() {
  local pid
  if pid=$(own_service_pid); then
    kill "$pid" 2>/dev/null || true
    # Bounded wait, so that a `start` right after does not race the old process for the socket.
    local deadline=$((SECONDS + 10))
    while kill -0 "$pid" 2>/dev/null && ((SECONDS < deadline)); do sleep 0.2; done
    rm -f "$PID_FILE"
    log "stopped podman system service (pid $pid)"
    return 0
  fi
  rm -f "$PID_FILE"
  if [[ "$SOCK" == "$DEFAULT_SOCK" ]] && have_systemd_user; then
    log "nothing to stop: $SOCK is the systemd podman.socket, shared with other tools; left running" \
      "(stop it yourself with: systemctl --user stop podman.socket podman.service)"
  else
    log "nothing to stop: no podman system service started by this helper for $SOCK"
  fi
}

native_env() {
  native_start
  # Host tools and the engine share one filesystem: the same path inside and outside.
  print_env "$SOCK"
}

# ------------------------------------------------------------------------------------- main
case "${1:-}" in
  start | stop | status | env) ;;
  *)
    echo "usage: $0 {start|stop|status|env}" >&2
    exit 2
    ;;
esac

detect_mode
"${MODE}_setup"
"${MODE}_$1"
