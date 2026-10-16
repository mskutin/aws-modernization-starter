#!/bin/sh
# Bootstraps the pinned pnpm and installs the workspace strictly from pnpm-lock.yaml.
# pnpm version: root package.json "packageManager" (corepack verifies the npm
# registry signature) and pnpm-lock.yaml packageManagerDependencies (integrity).
set -eu
: "${PNPM_STORE_DIR:=${CI_PROJECT_DIR:-$PWD}/.pnpm-store}"
corepack enable pnpm
echo "node $(node --version) | pnpm $(pnpm --version) | store $PNPM_STORE_DIR"
# --ignore-scripts: no dependency or root lifecycle scripts run on CI runners
# (esbuild finds its platform binary package without its postinstall; git hooks
# are a local convenience).
# shellcheck disable=SC2086  # PNPM_INSTALL_ARGS is intentionally word-split
pnpm install --frozen-lockfile --prefer-offline --ignore-scripts --store-dir "$PNPM_STORE_DIR" ${PNPM_INSTALL_ARGS:-}
