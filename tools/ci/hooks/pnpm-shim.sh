#!/bin/sh
# Create a temporary directory holding a `pnpm` shim that runs tools/ci/hooks/pnpm.sh, and print
# its path. Git hooks prepend it to PATH when no pnpm is installed, so child scripts that call
# `pnpm` (cdk-synth.sh, package scripts) work too. The shim exports STARTER_PNPM_SHIM_DIR; pnpm.sh
# skips that directory when it looks for a real pnpm, so the shim can never call itself.
#
# usage: shim_dir="$(sh tools/ci/hooks/pnpm-shim.sh [REPO_ROOT])"
set -eu
root="${1:-$PWD}"
launcher="${root}/tools/ci/hooks/pnpm.sh"
[ -f "$launcher" ] || {
  echo "pnpm-shim: ${launcher} not found" >&2
  exit 1
}
dir="$(mktemp -d)"
cat > "${dir}/pnpm" <<EOF
#!/bin/sh
STARTER_PNPM_SHIM_DIR='${dir}'
export STARTER_PNPM_SHIM_DIR
exec sh '${launcher}' "\$@"
EOF
chmod +x "${dir}/pnpm"
printf '%s\n' "$dir"
