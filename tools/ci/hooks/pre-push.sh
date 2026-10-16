#!/bin/sh
# pre-push: typecheck + unit tests for every package affected since the branch
# point with the upstream default branch (dependency-aware, via tools/impact),
# plus offline synth + Guard policy validation when infra/policies are affected.
set -eu
# Git exports GIT_DIR, GIT_INDEX_FILE & co. to hooks; tests that create git fixtures would write into
# this repository with them. Everything below finds the repository from the working directory.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_QUARANTINE_PATH
if ! command -v pnpm >/dev/null 2>&1; then
  # Shim so child scripts (cdk-synth.sh) find pnpm too. pnpm.sh skips STARTER_PNPM_SHIM_DIR when it
  # looks for a real pnpm, so the shim never resolves to itself.
  shim="$(sh tools/ci/hooks/pnpm-shim.sh "$PWD")"
  trap 'rm -rf "$shim"' EXIT
  STARTER_PNPM_SHIM_DIR="$shim"
  PATH="${shim}:${PATH}"
  export STARTER_PNPM_SHIM_DIR PATH
fi
# Base: STARTER_PUSH_BASE, else the upstream branch, else <remote>/main for origin/gitlab.
base="${STARTER_PUSH_BASE:-}"
if [ -z "$base" ]; then
  for candidate in '@{upstream}' origin/main gitlab/main; do
    if git rev-parse --verify --quiet "$candidate" >/dev/null; then base="$candidate"; break; fi
  done
fi
base="${base:-origin/main}" # unresolvable -> impact fails safe to the whole workspace
plan="$(node tools/impact/src/cli.ts plan --base "$base" --format filters)"
if [ -z "$plan" ]; then
  echo "pre-push: no package affected since ${base} — nothing to check."
  exit 0
fi
if [ "$plan" = "--recursive" ]; then
  echo "pre-push: shared config changed — checking the whole workspace."
  pnpm -r run --if-present build
  pnpm -r run typecheck
  pnpm -r run --if-present test:unit
else
  echo "pre-push: affected packages: ${plan}"
  # shellcheck disable=SC2046,SC2086  # filters are intentionally word-split
  pnpm $(printf '%s ' $plan | sed 's/\(--filter=[^ ]*\)/\1.../g') run --if-present build
  # shellcheck disable=SC2086
  pnpm $plan run typecheck
  # shellcheck disable=SC2086
  pnpm $plan run --if-present test:unit
fi
components="$(node tools/impact/src/cli.ts plan --base "$base" --format components)"
case "$plan $components" in
  *--recursive* | *infra* | *policies*)
    echo "pre-push: infra/policies affected — offline synth (dev) + Guard validation"
    COMPONENT_ID=infra sh tools/ci/scripts/cdk-synth.sh dev
    pnpm --filter @starter/policies run guard:install
    pnpm --filter @starter/policies run guard:validate --dir "$PWD/infra/cdk.out/dev" --out "$PWD/reports/policies"
    ;;
esac
