#!/bin/sh
# usage: synth-baseline.sh <dest-dir>
# Synthesizes FINOPS_ENVIRONMENTS (default: dev staging prod) at the diff base
# in a temporary git worktree, for the FinOps / destructive-change comparison.
# When no baseline can be produced, writes <dest>/BASELINE_UNAVAILABLE with the
# reason; finops.sh then reports destructive-change detection as NOT performed.
set -eu
dest="${1:?usage: synth-baseline.sh <dest-dir>}"
mkdir -p "$dest"
dest="$(cd "$dest" && pwd)"
envs="${FINOPS_ENVIRONMENTS:-dev staging prod}"
unavailable() {
  echo "$1" > "${dest}/BASELINE_UNAVAILABLE"
  echo "baseline unavailable: $1"
  exit 0
}
base="${CI_MERGE_REQUEST_DIFF_BASE_SHA:-}"
if [ -z "$base" ] && [ -n "${CI_COMMIT_BEFORE_SHA:-}" ] && ! printf '%s' "$CI_COMMIT_BEFORE_SHA" | grep -Eq '^0+$'; then
  base="$CI_COMMIT_BEFORE_SHA"
fi
[ -n "$base" ] || unavailable "no diff base for this pipeline (${CI_PIPELINE_SOURCE:-local})"
git cat-file -e "${base}^{commit}" 2>/dev/null || git fetch --no-tags --quiet --depth=1 origin "$base" ||
  unavailable "base ${base} cannot be fetched"
wt="$(dirname "$dest")/src"
rm -rf "${wt:?}"
filters="$(node tools/impact/src/cli.ts filters "${COMPONENT_ID:-infra}")"
# The runner reuses the clone and `git clean`s untracked dirs between jobs: drop
# stale worktree registrations first.
git worktree prune
git worktree add --quiet --force --detach "$wt" "$base"
[ -f "${wt}/infra/package.json" ] || unavailable "base ${base} has no infra package"
(
  cd "$wt"
  pnpm install --frozen-lockfile --prefer-offline --ignore-scripts --store-dir "${PNPM_STORE_DIR:-${CI_PROJECT_DIR}/.pnpm-store}" >/dev/null
  # shellcheck disable=SC2086
  pnpm $filters run --if-present build >/dev/null
  for env in $envs; do
    pnpm --filter @starter/infra run synth -c "envs=${env}" -o "${dest}/${env}" >/dev/null
  done
) || unavailable "synth at base ${base} failed (see job log)"
echo "$base" > "${dest}/BASELINE_COMMIT"
echo "baseline synthesized at ${base}: ${envs}"
