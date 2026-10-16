#!/bin/sh
# usage: cdk-synth.sh <environment>
# Offline synth of one environment via the @starter/infra package scripts (the CDK
# app): dev|staging|prod -> infra/cdk.out/<env>, integration ->
# infra/cdk.out/integration. No AWS credentials; placeholder image digest unless
# API_IMAGE_DIGEST is set; cdk-nag runs inside synth.
set -eu
env="${1:?usage: cdk-synth.sh <environment>}"
pkg="${COMPONENT_PACKAGE:-@starter/infra}"
# Build everything synth consumes: package deps + bundled Lambda sources (components.yaml dependsOn).
# shellcheck disable=SC2046
pnpm $(node tools/impact/src/cli.ts filters "${COMPONENT_ID:-infra}") run --if-present build
mkdir -p reports/synth
case "$env" in
  integration) pnpm --filter "$pkg" run synth:integration -c "runId=ci-synth-${CI_PIPELINE_IID:-local}" ;;
  *) pnpm --filter "$pkg" run synth -c "envs=${env}" -o "cdk.out/${env}" ;;
esac
find "infra/cdk.out/${env}" -name '*.template.json' | sort > "reports/synth/${env}-templates.txt"
echo "synth ${env}: $(wc -l < "reports/synth/${env}-templates.txt") template(s) in infra/cdk.out/${env}"
