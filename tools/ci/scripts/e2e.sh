#!/bin/sh
# Playwright E2E: API (background) + `vite preview` of the built SPA, which
# proxies /v1 and /health to the API like CloudFront does in AWS.
set -eu
. tools/ci/scripts/api-lib.sh
echo "node $(node --version) | $(pnpm --filter @starter/tests-e2e exec playwright --version)"
api_start
API_PROXY_TARGET=http://127.0.0.1:8080 pnpm -C apps/web run preview > "${API_LOG_DIR}/web-preview.log" 2>&1 &
web_pid=$!
status=0
node tools/ci/scripts/wait-for.mjs --timeout 60 "http:http://127.0.0.1:4173/" || status=$?
if [ "$status" -eq 0 ]; then
  CI=true WEB_BASE_URL=http://127.0.0.1:4173 pnpm -C tests/e2e run test:e2e || status=$?
fi
kill "$web_pid" 2>/dev/null || true
api_stop || status=$?
exit "$status"
