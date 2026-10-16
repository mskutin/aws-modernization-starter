#!/bin/sh
# One-shot, idempotent creation of the job-state table in DynamoDB Local.
#
# Layout mirrors workflows/processing/src/spec.ts (JobStateTable):
#   pk (S, HASH) / sk (S, RANGE); GSI "gsi1" = gsi1pk (S, HASH) / gsi1sk (S, RANGE), projection ALL;
#   TTL attribute "expiresAt"; on-demand billing.
#
# Requests are SigV4-signed by curl (--aws-sigv4) with dummy local credentials, so the same
# script also works against any DynamoDB-compatible endpoint that validates signatures.
# Runs in the curlimages/curl image (POSIX sh, no AWS CLI needed).
set -eu

: "${DYNAMODB_ENDPOINT:?DYNAMODB_ENDPOINT is required}"
: "${JOBS_TABLE_NAME:?JOBS_TABLE_NAME is required}"
: "${AWS_REGION:?AWS_REGION is required}"
: "${AWS_ACCESS_KEY_ID:=local}"
: "${AWS_SECRET_ACCESS_KEY:=local}"
: "${INIT_DEADLINE_SECONDS:=60}"

RESP="$(mktemp)"
trap 'rm -f "$RESP"' EXIT

log() { printf '[dynamodb-init] %s\n' "$*"; }

# ddb <Operation> <json-body>  -> prints HTTP status; response body in $RESP
ddb() {
  curl -sS -o "$RESP" -w '%{http_code}' \
    --max-time 5 \
    --aws-sigv4 "aws:amz:${AWS_REGION}:dynamodb" \
    --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" \
    -H 'Content-Type: application/x-amz-json-1.0' \
    -H "X-Amz-Target: DynamoDB_20120810.$1" \
    --data "$2" \
    "${DYNAMODB_ENDPOINT}/" 2>/dev/null || echo 000
}

# 1. Wait (bounded) for the endpoint to answer.
deadline=$(($(date +%s) + INIT_DEADLINE_SECONDS))
until [ "$(ddb ListTables '{}')" = 200 ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "ERROR: ${DYNAMODB_ENDPOINT} not reachable within ${INIT_DEADLINE_SECONDS}s"
    exit 1
  fi
  sleep 1
done
log "endpoint ${DYNAMODB_ENDPOINT} is up"

# 2. Create the table unless it exists.
status=$(ddb DescribeTable "{\"TableName\":\"${JOBS_TABLE_NAME}\"}")
if [ "$status" = 200 ]; then
  log "table ${JOBS_TABLE_NAME} already exists"
else
  status=$(
    ddb CreateTable "$(
      cat <<JSON
{
  "TableName": "${JOBS_TABLE_NAME}",
  "BillingMode": "PAY_PER_REQUEST",
  "AttributeDefinitions": [
    { "AttributeName": "pk", "AttributeType": "S" },
    { "AttributeName": "sk", "AttributeType": "S" },
    { "AttributeName": "gsi1pk", "AttributeType": "S" },
    { "AttributeName": "gsi1sk", "AttributeType": "S" }
  ],
  "KeySchema": [
    { "AttributeName": "pk", "KeyType": "HASH" },
    { "AttributeName": "sk", "KeyType": "RANGE" }
  ],
  "GlobalSecondaryIndexes": [
    {
      "IndexName": "gsi1",
      "KeySchema": [
        { "AttributeName": "gsi1pk", "KeyType": "HASH" },
        { "AttributeName": "gsi1sk", "KeyType": "RANGE" }
      ],
      "Projection": { "ProjectionType": "ALL" }
    }
  ]
}
JSON
    )"
  )
  if [ "$status" = 200 ]; then
    log "created table ${JOBS_TABLE_NAME}"
  elif grep -q ResourceInUseException "$RESP"; then
    log "table ${JOBS_TABLE_NAME} created concurrently"
  else
    log "ERROR: CreateTable failed (HTTP ${status}): $(cat "$RESP")"
    exit 1
  fi
fi

# 3. Wait (bounded) for ACTIVE.
until ddb DescribeTable "{\"TableName\":\"${JOBS_TABLE_NAME}\"}" >/dev/null && grep -q '"TableStatus":"ACTIVE"' "$RESP"; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "ERROR: table ${JOBS_TABLE_NAME} not ACTIVE within ${INIT_DEADLINE_SECONDS}s"
    exit 1
  fi
  sleep 1
done
grep -q '"IndexName":"gsi1"' "$RESP" || {
  log "ERROR: table ${JOBS_TABLE_NAME} exists but has no gsi1 index (stale volume? run dev-down.sh --volumes)"
  exit 1
}

# 4. Enable TTL on expiresAt (idempotent).
ddb DescribeTimeToLive "{\"TableName\":\"${JOBS_TABLE_NAME}\"}" >/dev/null
if grep -q '"TimeToLiveStatus":"ENABLED"' "$RESP"; then
  log "TTL already enabled"
else
  status=$(ddb UpdateTimeToLive "{\"TableName\":\"${JOBS_TABLE_NAME}\",\"TimeToLiveSpecification\":{\"Enabled\":true,\"AttributeName\":\"expiresAt\"}}")
  if [ "$status" != 200 ]; then
    log "ERROR: UpdateTimeToLive failed (HTTP ${status}): $(cat "$RESP")"
    exit 1
  fi
  log "TTL enabled on expiresAt"
fi

log "table ${JOBS_TABLE_NAME} ready (pk/sk, gsi1, TTL expiresAt)"
