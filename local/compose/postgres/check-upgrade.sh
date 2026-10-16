#!/usr/bin/env bash
# Isolated end-to-end check of the local compose database setup (ADR 0220/0222).
#
# Runs a COPY of local/compose under its own project, container names, volumes, network, image tag
# and ephemeral host ports, so the developer's starter-app stack, its starter-app-pgdata volume and the
# reserved ports (15432, 18000, 8080, 4173) are never touched.
#
#   fresh   new volume: admin from initdb -> db-bootstrap -> migrate -> API as starter_app over TLS
#   legacy  a volume initialised the legacy way (POSTGRES_USER=starter_app = bootstrap superuser
#           owning the tables, migrations 0001-0002 applied, one job row) plus its old .env; the
#           current flow upgrades it in place: admin created once, starter_app renamed and locked and
#           replaced by a least-privilege role, objects moved to starter_owner, data kept
#
#   local/compose/postgres/check-upgrade.sh [fresh|legacy|all]      (default: all)
#
# Needs rootless Podman (DOCKER_HOST, see scripts/podman/rootless-socket.sh), openssl, node, curl
# and the API image built under the TEST tag:
#   podman build --ignorefile apps/api/.dockerignore -f apps/api/Dockerfile \
#     -t localhost/starter-dbtest/api:local .
# Removes everything it created (containers, network, volumes, temp dir), also on failure.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../../.." && pwd)"
PROJECT=starter-dbtest
PG_IMAGE="docker.io/library/postgres:17.11@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3"
scenario="${1:-all}"

say() { printf '[check-upgrade] %s\n' "$*" >&2; }
fail() {
  say "FAIL: $*"
  exit 1
}
[[ "${DOCKER_HOST:-}" == unix://* ]] || fail "DOCKER_HOST must point at the rootless Podman socket"
pm() { podman --url "$DOCKER_HOST" "$@"; }
pm image exists "localhost/${PROJECT}/api:local" || fail "build localhost/${PROJECT}/api:local first (see header)"

WORK="$(mktemp -d)"
COPY="${WORK}/local/compose"
# The copy's env file and TLS material: inside the temp dir, never the developer's state dir.
export STARTER_LOCAL_STATE_DIR="${WORK}/state"
export STARTER_TLS_DIR="${STARTER_LOCAL_STATE_DIR}/postgres-tls"
cleanup() {
  if [[ -f "${COPY}/compose.yaml" ]]; then
    (cd "$COPY" && podman compose -p "$PROJECT" -f compose.yaml --env-file "${STARTER_LOCAL_STATE_DIR}/.env" --profile app \
      down --volumes --remove-orphans >/dev/null 2>&1) || true
  fi
  pm rm -f "${PROJECT}-legacy-init" >/dev/null 2>&1 || true
  pm volume rm -f "${PROJECT}-pgdata" "${PROJECT}-dynamodb-data" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

prepare_copy() {
  rm -rf "${WORK}/local"
  mkdir -p "$COPY"
  (cd "${REPO_ROOT}/local/compose" && tar --exclude=.env --exclude=postgres/tls -cf - .) | (cd "$COPY" && tar -xf -)
  rm -rf "$STARTER_LOCAL_STATE_DIR"
  # Rename everything that carries the developer stack's identity.
  find "$COPY" -type f \( -name '*.yaml' -o -name '*.sh' -o -name '.env.example' \) -print0 |
    xargs -0 sed -i.bak "s/starter-app/${PROJECT}/g"
  find "$COPY" -name '*.bak' -delete
  export STARTER_PG_HOST_PORT STARTER_DYNAMODB_HOST_PORT STARTER_API_HOST_PORT STARTER_WEB_HOST_PORT
  STARTER_PG_HOST_PORT="$(free_port)"
  STARTER_DYNAMODB_HOST_PORT="$(free_port)"
  STARTER_API_HOST_PORT="$(free_port)"
  STARTER_WEB_HOST_PORT="$(free_port)"
}

compose() { (cd "$COPY" && podman compose -p "$PROJECT" -f compose.yaml --env-file "${STARTER_LOCAL_STATE_DIR}/.env" "$@"); }
admin_sql() { pm exec "${PROJECT}-postgres" psql -U "$(env_get POSTGRES_ADMIN_USER)" -d starter_app -XAtc "$1"; }
env_get() { sed -n "s/^$1=//p" "${STARTER_LOCAL_STATE_DIR}/.env" | tail -n1; }
# GNU coreutils (Linux) or perl's shasum (macOS).
sha256_of() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

# Sources the COPIED helpers so ensure_env_file/ensure_local_tls act on the copy only.
prepare_env_and_tls() {
  # shellcheck source=/dev/null
  (source "${COPY}/bin/_lib.sh" && ensure_env_file && ensure_local_tls)
}

wait_healthy() {
  local deadline=$((SECONDS + 300)) state
  while :; do
    state="$(pm inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "${PROJECT}-api" 2>/dev/null || echo missing)"
    [[ "$state" == "running healthy" ]] && return 0
    if [[ "$state" == exited* || $SECONDS -ge $deadline ]]; then
      for c in postgres-admin db-bootstrap migrate api; do
        say "--- logs ${PROJECT}-${c}"
        pm logs "${PROJECT}-${c}" 2>&1 | tail -n 15 >&2 || true
      done
      fail "API not healthy (${state})"
    fi
    sleep 2
  done
}

check_running_stack() {
  local api="http://127.0.0.1:${STARTER_API_HOST_PORT}"
  local ready
  ready="$(curl -s -o /dev/null -w '%{http_code}' "${api}/health/ready")"
  [[ "$ready" == 200 ]] || fail "/health/ready answered ${ready}"
  local job
  job="$(curl -s -X POST "${api}/v1/jobs" -H 'content-type: application/json' \
    -d '{"title":"check-upgrade","content":"Cloud migration is a journey. Every migration starts with discovery and planning, step by step."}' |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).jobId||"")}catch{}})')"
  [[ -n "$job" ]] || say "note: POST /v1/jobs did not return a job id (authentication may be required on this branch)"
  # The API session: starter_app, TLS.
  local session
  session="$(admin_sql "SELECT a.usename || ' ssl=' || s.ssl FROM pg_stat_activity a JOIN pg_stat_ssl s USING (pid) WHERE a.application_name = 'starter-api' LIMIT 1")"
  [[ "$session" == "starter_app ssl=true" ]] || fail "API session is '${session}', expected starter_app over TLS"
  [[ "$(admin_sql "SELECT rolsuper FROM pg_roles WHERE rolname = 'starter_app'")" == f ]] || fail "starter_app is a superuser"
  [[ "$(admin_sql "SELECT string_agg(DISTINCT pg_get_userbyid(relowner), ',') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'")" == starter_owner ]] ||
    fail "tables are not all owned by starter_owner"
  [[ "$(admin_sql "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations")" == 0001,0002,0003,0004 ]] ||
    fail "schema_migrations is not at 0004"
  # Plain TCP is refused by the server (hostnossl reject).
  if pm exec "${PROJECT}-postgres" psql "host=127.0.0.1 dbname=starter_app user=starter_app sslmode=disable" -XAtc 'SELECT 1' >/dev/null 2>&1; then
    fail "a plain-text TCP connection was accepted"
  fi
  say "OK: API ready as starter_app over TLS; schema at 0004; tables owned by starter_owner; plain TCP refused"
}

run_fresh() {
  say "=== fresh volume"
  prepare_copy
  prepare_env_and_tls
  compose --profile app up -d api >/dev/null
  wait_healthy
  check_running_stack
  compose --profile app down --volumes --remove-orphans >/dev/null 2>&1
}

run_legacy() {
  say "=== legacy volume (starter_app was the bootstrap superuser)"
  prepare_copy
  local old_password
  old_password="$(node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("hex"))')"
  # 1. The old .env and volume, created exactly like the legacy local/compose setup did.
  printf 'POSTGRES_USER=starter_app\nPOSTGRES_DB=starter_app\nPOSTGRES_PASSWORD=%s\nJOBS_TABLE_NAME=%s-jobs-local\nAWS_REGION=ap-southeast-1\nLOG_LEVEL=info\n' \
    "$old_password" "$PROJECT" >"${COPY}/.env"
  chmod 600 "${COPY}/.env"
  # ...which the current flow moves into the state directory (ensure_env_file).
  pm run -d --name "${PROJECT}-legacy-init" -v "${PROJECT}-pgdata:/var/lib/postgresql/data" \
    -e POSTGRES_USER=starter_app -e POSTGRES_PASSWORD="$old_password" -e POSTGRES_DB=starter_app \
    -e POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 "$PG_IMAGE" >/dev/null
  local deadline=$((SECONDS + 120))
  until pm exec "${PROJECT}-legacy-init" pg_isready -q -h 127.0.0.1 -U starter_app -d starter_app 2>/dev/null; do
    [[ $SECONDS -lt $deadline ]] || fail "legacy PostgreSQL did not start"
    sleep 1
  done
  local file sum
  for file in 0001_create_jobs.sql 0002_jobs_listing_index.sql; do
    pm exec -i "${PROJECT}-legacy-init" psql -U starter_app -d starter_app -v ON_ERROR_STOP=1 -Xq <"${REPO_ROOT}/apps/api/migrations/${file}"
  done
  # schema_migrations as the legacy runner wrote it (checksums = SHA-256 of the files).
  pm exec "${PROJECT}-legacy-init" psql -U starter_app -d starter_app -v ON_ERROR_STOP=1 -Xqc \
    "CREATE TABLE schema_migrations (version text PRIMARY KEY, name text NOT NULL, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), execution_ms integer NOT NULL)"
  for file in 0001_create_jobs.sql 0002_jobs_listing_index.sql; do
    sum="$(sha256_of "${REPO_ROOT}/apps/api/migrations/${file}")"
    pm exec "${PROJECT}-legacy-init" psql -U starter_app -d starter_app -v ON_ERROR_STOP=1 -Xqc \
      "INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES ('${file:0:4}', '$(basename "${file:5}" .sql)', '${sum}', 1)"
  done
  pm exec "${PROJECT}-legacy-init" psql -U starter_app -d starter_app -v ON_ERROR_STOP=1 -Xqc \
    "INSERT INTO jobs (id, title, content, content_sha256, content_length, idempotency_key, request_fingerprint, contract_version)
     VALUES ('0f8fad5b-d9cb-469f-a165-70867728950e', 'legacy job', 'legacy body', repeat('a', 64), 11, 'legacy-0001', repeat('b', 64), '1.0.0')"
  pm stop "${PROJECT}-legacy-init" >/dev/null
  pm rm "${PROJECT}-legacy-init" >/dev/null

  # 2. The current flow, exactly as bin/dev-up.sh app: .env upgrade, TLS, compose.
  prepare_env_and_tls
  [[ ! -e "${COPY}/.env" ]] || fail "the worktree-local .env was not moved into the state directory"
  grep -q '^LEGACY_SUPERUSER=starter_app$' "${STARTER_LOCAL_STATE_DIR}/.env" || fail ".env upgrade did not record the legacy superuser"
  compose --profile app up -d api >/dev/null
  wait_healthy
  check_running_stack
  [[ "$(admin_sql "SELECT title FROM jobs WHERE id = '0f8fad5b-d9cb-469f-a165-70867728950e'")" == "legacy job" ]] ||
    fail "the legacy row is gone"
  [[ "$(admin_sql "SELECT rolname || ':' || rolcanlogin FROM pg_roles WHERE oid = 10")" == "starter_app_legacy_bootstrap:false" ]] ||
    fail "the old bootstrap superuser was not renamed and locked"
  pm logs "${PROJECT}-db-bootstrap" 2>&1 | grep -q 'was the cluster bootstrap superuser' ||
    fail "db-bootstrap did not report the legacy upgrade"
  # 3. A second start is a no-op for the database.
  compose --profile app up -d --force-recreate db-bootstrap migrate >/dev/null
  wait_healthy
  check_running_stack
  say "OK: legacy volume upgraded in place, data kept, second start idempotent"
  compose --profile app down --volumes --remove-orphans >/dev/null 2>&1
}

case "$scenario" in
  fresh) run_fresh ;;
  legacy) run_legacy ;;
  all)
    run_fresh
    run_legacy
    ;;
  *) fail "usage: $0 [fresh|legacy|all]" ;;
esac
say "all requested scenarios passed"
