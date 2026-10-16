#!/usr/bin/env bash
# Stop the local starter-app stack (both profiles). Data volumes are KEPT by default.
#
#   local/compose/bin/dev-down.sh             # stop + remove containers/network, keep volumes
#   local/compose/bin/dev-down.sh --volumes   # ALSO delete starter-app-pgdata / starter-app-dynamodb-data
#
# Only touches resources of the `starter-app` compose project on the rootless Podman engine.
set -euo pipefail
# shellcheck source=_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

down_args=(down --remove-orphans)
for arg in "$@"; do
  case "$arg" in
    --volumes) down_args+=(--volumes) ;;
    -h | --help)
      sed -n '2,7p' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg (only --volumes is accepted)" ;;
  esac
done

ensure_rootless_docker_host
ensure_compose_provider
# Interpolation needs the variables even for `down`; fall back to the example if .env is absent.
[[ -f "$ENV_FILE" ]] || ENV_FILE="$ENV_EXAMPLE"

compose --profile deps --profile app "${down_args[@]}"
if [[ " ${down_args[*]} " == *" --volumes "* ]]; then
  log "stopped; volumes deleted"
else
  log "stopped; volumes kept (pass --volumes to delete them)"
fi
