#!/bin/sh
# Wait for the CI services (PostgreSQL, DynamoDB Local) to accept TCP connections.
set -eu
ddb="$(printf '%s' "${DYNAMODB_ENDPOINT:-http://dynamodb-local:8000}" | sed -E 's#^https?://##; s#/.*$##')"
node tools/ci/scripts/wait-for.mjs --timeout "${SERVICE_WAIT_SECONDS:-90}" \
  "tcp:${DB_HOST:-postgres}:${DB_PORT:-5432}" "tcp:${ddb}"
