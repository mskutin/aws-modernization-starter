#!/bin/sh
# Black-box API integration suite + smoke check against the CI services.
# Builds what it runs, starts the API in the background, always stops it
# (verifying graceful SIGTERM shutdown) and keeps the API log as an artifact.
set -eu
. tools/ci/scripts/api-lib.sh
pnpm --filter "@starter/api..." --filter "@starter/tool-test-idp..." --filter "@starter/tests-integration..." --filter "@starter/tests-smoke..." run --if-present build
api_start
status=0
pnpm -C tests/integration run test:api || status=$?
SMOKE_JUNIT=reports/junit/smoke.xml BASE_URL="${API_BASE_URL}" node tests/smoke/dist/cli.js || status=$?
api_stop || status=$?
exit "$status"
