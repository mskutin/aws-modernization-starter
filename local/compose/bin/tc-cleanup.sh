#!/usr/bin/env bash
# Remove containers left behind by Testcontainers on the ROOTLESS Podman engine.
#
# Ryuk (Testcontainers' reaper) only works on rootless Podman with SELinux enforcing when both
# TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE (the engine-side socket path, printed by
# `scripts/podman/rootless-socket.sh env`) and TESTCONTAINERS_RYUK_PRIVILEGED=true are set (see
# docs/testing.md §4). With the reaper disabled or a run killed, use this. It only touches containers labelled org.testcontainers=true.
#
#   local/compose/bin/tc-cleanup.sh            # list what would be removed
#   local/compose/bin/tc-cleanup.sh --apply    # remove them
set -euo pipefail
# shellcheck source=_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

apply=false
case "${1:-}" in
  --apply) apply=true ;;
  "") ;;
  *) die "usage: $0 [--apply]" ;;
esac

ensure_rootless_docker_host
ids=()
while IFS= read -r id; do
  [[ -n "$id" ]] && ids+=("$id")
done < <(podman --url "$DOCKER_HOST" ps -a -q --filter label=org.testcontainers=true)
if [[ ${#ids[@]} -eq 0 ]]; then
  log "no Testcontainers-labelled containers found"
  exit 0
fi
podman --url "$DOCKER_HOST" ps -a --filter label=org.testcontainers=true \
  --format '{{.ID}}  {{.Names}}  {{.Image}}  {{.Status}}'
if $apply; then
  podman --url "$DOCKER_HOST" rm -f "${ids[@]}" >/dev/null
  log "removed ${#ids[@]} container(s)"
else
  log "dry run: pass --apply to remove ${#ids[@]} container(s)"
fi
