#!/bin/sh
# Scheduled drift detection via @starter/tool-drift (part of the policy tooling).
# Exit codes: 0 in sync, 1 drifted, 2 error, 3 not configured (-> job warning, never success).
set -eu
mkdir -p reports/drift
COMPONENT_ID=infra sh tools/ci/scripts/cdk-synth.sh "${DRIFT_STAGE:-prod}"
pnpm -C tools/drift run drift:detect --stage "${DRIFT_STAGE:-prod}" --cdk-out "infra/cdk.out/${DRIFT_STAGE:-prod}" --execute
