#!/bin/sh
# usage: run-tool.sh <gitleaks|hadolint|trivy> [args...]
# 1. binary on PATH  2. pinned CI image (.gitlab/ci/images.yml) on Podman/Docker
# 3. otherwise print SKIP and succeed — CI enforces the check regardless.
set -eu
tool="$1"
shift
if command -v "$tool" >/dev/null 2>&1; then
  exec "$tool" "$@"
fi
root="$(git rev-parse --show-toplevel)"
var="IMG_$(printf '%s' "$tool" | tr '[:lower:]' '[:upper:]')"
image="$(sed -n "s/^  ${var}: *//p" "${root}/.gitlab/ci/images.yml" | tr -d "'\"")"
engine=""
if command -v podman >/dev/null 2>&1; then
  # Rootless only: on macOS the machine's default connection may be rootful (other projects).
  if [ -z "${DOCKER_HOST:-}" ] &&
    [ "$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null)" != "true" ] &&
    [ -x "${root}/scripts/podman/rootless-socket.sh" ]; then
    eval "$("${root}/scripts/podman/rootless-socket.sh" env 2>/dev/null)" || true
  fi
  if [ -n "${DOCKER_HOST:-}" ]; then
    engine="podman --url ${DOCKER_HOST}"
  elif [ "$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null)" = "true" ]; then
    engine="podman"
  fi
elif command -v docker >/dev/null 2>&1; then
  engine="docker"
fi
if [ -z "$engine" ] || [ -z "$image" ]; then
  echo "SKIP ${tool}: not installed and no container engine available (CI runs this check)."
  exit 0
fi
# Mount the work tree (and, for linked worktrees, the shared git dir) read-only at
# the same absolute paths so git-aware tools work; no network needed.
common="$(cd "$root" && cd "$(git rev-parse --git-common-dir)" && pwd)"
set -- --rm -i --network none --security-opt label=disable \
  -v "${root}:${root}:ro" -w "$root" --entrypoint "$tool" "$image" "$@"
case "$common" in
  "${root}"/*) ;;
  *) set -- -v "${common}:${common}:ro" "$@" ;;
esac
set +e
# shellcheck disable=SC2086  # $engine may carry --url
$engine run "$@"
status=$?
set -e
if [ "$status" -ne 0 ]; then
  # Distinguish "tool found problems" from "engine unavailable".
  # shellcheck disable=SC2086
  if ! $engine info >/dev/null 2>&1; then
    echo "SKIP ${tool}: container engine not reachable (start Podman or set DOCKER_HOST). CI runs this check."
    exit 0
  fi
fi
exit "$status"
