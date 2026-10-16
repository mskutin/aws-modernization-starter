#!/bin/sh
# pnpm launcher for git hooks: a real pnpm on PATH, else corepack, else the exact version from
# package.json "packageManager" via npm exec (no global install).
#
# The pre-push hook puts a `pnpm` shim (tools/ci/hooks/pnpm-shim.sh) first on PATH that execs this
# script, and exports STARTER_PNPM_SHIM_DIR. That directory is skipped below: resolving the shim
# itself would exec shim -> launcher -> shim forever (the hook hung).
set -eu

# Print the first executable `pnpm` on PATH that is not the hook's own shim.
real_pnpm() {
  old_ifs=$IFS
  IFS=:
  for dir in $PATH; do
    [ -n "$dir" ] || continue
    if [ -n "${STARTER_PNPM_SHIM_DIR:-}" ] && [ "$dir" = "$STARTER_PNPM_SHIM_DIR" ]; then continue; fi
    if [ -f "$dir/pnpm" ] && [ -x "$dir/pnpm" ]; then
      IFS=$old_ifs
      printf '%s\n' "$dir/pnpm"
      return 0
    fi
  done
  IFS=$old_ifs
  return 1
}

if found="$(real_pnpm)"; then exec "$found" "$@"; fi
if command -v corepack >/dev/null 2>&1; then exec corepack pnpm "$@"; fi
version="$(node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]")"
exec npm exec --yes "pnpm@${version}" -- "$@"
