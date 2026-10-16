#!/bin/sh
# Sourced helpers: run the built API as a background process against the CI
# services (PostgreSQL + DynamoDB Local), honouring the runtime contract in
# docs/contracts.md §3. Requires: apps/api built, DB_* / DYNAMODB_ENDPOINT /
# JOBS_TABLE_NAME / WORKFLOW_MODE=local exported by the job.
API_LOG_DIR="${API_LOG_DIR:-reports/api}"
API_PID=""
IDP_PID=""

# Identity: the TEST ONLY identity provider (tools/test-idp) runs as a background process
# in the job. The API trusts it through AUTH_* (.gitlab/ci/integration.yml, APP_RUNTIME=ci) and
# the suites mint tokens from its /test/token endpoint (TEST_IDP_ENABLE_TEST_ENDPOINTS=true).
idp_start() {
  node tools/test-idp/dist/server.js > "${API_LOG_DIR}/test-idp.log" 2>&1 &
  IDP_PID=$!
  echo "test IdP started (pid ${IDP_PID}); waiting for /healthz"
  if ! node tools/ci/scripts/wait-for.mjs --timeout 30 "http:${TEST_IDP_URL:-http://127.0.0.1:9400}/healthz"; then
    tail -n 50 "${API_LOG_DIR}/test-idp.log" >&2
    return 1
  fi
}

idp_stop() {
  [ -n "$IDP_PID" ] || return 0
  kill -TERM "$IDP_PID" 2>/dev/null || true
  wait "$IDP_PID" 2>/dev/null || true
  IDP_PID=""
}

api_start() {
  mkdir -p "$API_LOG_DIR"
  idp_start || return 1
  echo "migrate PostgreSQL ${DB_HOST}:${DB_PORT}/${DB_NAME}"
  sh apps/api/db/prepare-database.sh
  # The API creates the DynamoDB Local table itself (ensureJobsTable) when DYNAMODB_ENDPOINT is set.
  node apps/api/dist/server.js > "${API_LOG_DIR}/server.log" 2>&1 &
  API_PID=$!
  echo "API started (pid ${API_PID}); waiting for /health/ready"
  if ! node tools/ci/scripts/wait-for.mjs --timeout "${API_READY_SECONDS:-60}" "http:${API_BASE_URL:-http://127.0.0.1:8080}/health/ready"; then
    tail -n 100 "${API_LOG_DIR}/server.log" >&2
    return 1
  fi
}

# Stops the API (graceful-shutdown check below), then the test IdP.
api_stop() {
  api_rc=0
  api_stop_process || api_rc=$?
  idp_stop
  return "$api_rc"
}

# SIGTERM must drain and exit 0 within SHUTDOWN_TIMEOUT_MS (contract: < ECS stopTimeout 30 s).
api_stop_process() {
  [ -n "$API_PID" ] || return 0
  kill -TERM "$API_PID" 2>/dev/null || return 0
  limit=$(( ${SHUTDOWN_TIMEOUT_MS:-20000} / 1000 + 5 ))
  i=0
  while kill -0 "$API_PID" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -gt "$limit" ]; then
      echo "ERROR: API did not exit within ${limit}s of SIGTERM" >&2
      kill -KILL "$API_PID" 2>/dev/null || true
      return 1
    fi
    sleep 1
  done
  rc=0
  wait "$API_PID" || rc=$?
  echo "API exited with status ${rc} after SIGTERM (${i}s)"
  API_PID=""
  # 143 = killed by SIGTERM without a handler: not a graceful shutdown.
  [ "$rc" -eq 0 ]
}
