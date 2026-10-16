#!/bin/sh
# Real `cdk diff` against the target account(s) — read-only, informational.
set -eu
mkdir -p reports/aws
# shellcheck disable=SC2046
pnpm $(node tools/impact/src/cli.ts filters infra) run --if-present build
for env in ${CDK_DIFF_ENVS:-dev}; do
  echo "== cdk diff (${env})"
  (cd infra && pnpm exec cdk diff "**" -c "envs=${env}" ${API_IMAGE_DIGEST:+-c "apiImageDigest=${API_IMAGE_DIGEST}"}) \
    > "reports/aws/cdk-diff-${env}.txt" 2>&1 || { cat "reports/aws/cdk-diff-${env}.txt"; exit 1; }
  cat "reports/aws/cdk-diff-${env}.txt"
done
