#!/usr/bin/env bash
# Print `export` lines for host-side processes that talk to the compose stack:
# the API/web dev servers (non-container dev loop) and the test suites.
#
#   eval "$(local/compose/bin/env.sh)"
#
# Values are LOCAL ONLY (generated passwords from the env file, see bin/_lib.sh; dummy AWS credentials
# accepted by DynamoDB Local). Never use this against AWS. DB_* is the API's identity (starter_app,
# TLS verified against the local CA); DB_ADMIN_* / DB_BOOTSTRAP_* feed `db:prepare` only.
# API_BASE_URL / BASE_URL / WEB_BASE_URL keep the caller's values when already set (e.g. an API
# started on another port).
set -euo pipefail
# shellcheck source=_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

[[ -f "$ENV_FILE" ]] || die "missing ${ENV_FILE}; run local/compose/bin/dev-up.sh first"

# Read KEY=VALUE pairs without executing the file.
get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1; }

cat <<EOF
export PORT=8080
export APP_RUNTIME=local
export DB_HOST=127.0.0.1
export DB_PORT=$(setting STARTER_PG_HOST_PORT 15432)
export DB_NAME='$(get POSTGRES_DB)'
export DB_USER=starter_app
export DB_PASSWORD='$(get STARTER_APP_PASSWORD)'
export DB_AUTH=password
export DB_SSL=verify-full
export DB_SSL_ROOT_CERT='${TLS_DIR}/ca.pem'
# apps/api db:prepare (bootstrap as the admin, then migrate as starter_migrator): local only.
export DB_ADMIN_USER='$(get POSTGRES_ADMIN_USER)'
export DB_ADMIN_PASSWORD='$(get POSTGRES_ADMIN_PASSWORD)'
export DB_BOOTSTRAP_MIGRATOR_PASSWORD='$(get STARTER_MIGRATOR_PASSWORD)'
export DB_BOOTSTRAP_APP_PASSWORD='$(get STARTER_APP_PASSWORD)'
export DB_BOOTSTRAP_PROCESSOR_PASSWORD='$(get STARTER_PROCESSOR_PASSWORD)'
export DB_BOOTSTRAP_RETENTION_PASSWORD='$(get STARTER_RETENTION_PASSWORD)'
export JOBS_TABLE_NAME='$(get JOBS_TABLE_NAME)'
export DYNAMODB_ENDPOINT=http://127.0.0.1:$(setting STARTER_DYNAMODB_HOST_PORT 18000)
export AWS_REGION='$(get AWS_REGION)'
export AWS_ACCESS_KEY_ID=local
export AWS_SECRET_ACCESS_KEY=local
export WORKFLOW_MODE=local
# Workflow (LOCAL SIMULATION): the in-process steps load documents as starter_processor, never starter_app.
export PROCESSOR_DB_USER=starter_processor
export PROCESSOR_DB_PASSWORD='$(get STARTER_PROCESSOR_PASSWORD)'
export API_BASE_URL='${API_BASE_URL:-http://127.0.0.1:$(setting STARTER_API_HOST_PORT 8080)}'
export BASE_URL='${BASE_URL:-${API_BASE_URL:-http://127.0.0.1:$(setting STARTER_API_HOST_PORT 8080)}}'
export WEB_BASE_URL='${WEB_BASE_URL:-http://127.0.0.1:$(setting STARTER_WEB_HOST_PORT 4173)}'
export TEST_IDP_URL='${TEST_IDP_URL:-http://127.0.0.1:$(setting STARTER_IDP_HOST_PORT 9400)}'
EOF
