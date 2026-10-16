#!/bin/sh
# Scheduled sweeper for expired ephemeral stacks (tests/aws-integration/src/sweeper).
# Dry run unless SWEEP_APPLY=true. Only stacks tagged starter:ephemeral=true are eligible.
set -eu
mkdir -p reports/aws-integration
set -- --region "${AWS_REGION}" --name-prefix "${SWEEP_NAME_PREFIX:-starter-it-}" --report reports/aws-integration/sweeper.json
if [ "${SWEEP_APPLY:-false}" = "true" ]; then set -- "$@" --apply --wait-seconds 900; else echo "dry run (set SWEEP_APPLY=true on the schedule to delete)"; fi
node tests/aws-integration/dist/sweeper.js "$@"
