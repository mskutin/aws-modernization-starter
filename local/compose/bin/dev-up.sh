#!/usr/bin/env bash
# Start the local starter-app stack on ROOTLESS Podman.
#
#   local/compose/bin/dev-up.sh            # deps only: PostgreSQL :15432, DynamoDB Local :18000 (+ table init)
#   local/compose/bin/dev-up.sh app        # full stack: deps + migrate + api :8080 + web :4173
#                                          # + TEST ONLY identity provider :9400
#   local/compose/bin/dev-up.sh app --build  # rebuild the API image and apps/web/dist first
#
# Host ports default to the contract (15432, 18000, 8080, 4173, 9400); override with
# STARTER_PG_HOST_PORT / STARTER_DYNAMODB_HOST_PORT / STARTER_API_HOST_PORT / STARTER_WEB_HOST_PORT /
# STARTER_IDP_HOST_PORT (env or .env).
#
# Waits (bounded by DEV_UP_WAIT_TIMEOUT, default 300 s) until one-shots exited 0 and services are
# running/healthy, then prints endpoints. On failure it prints the failing container's logs.
set -euo pipefail
# shellcheck source=_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

profile="deps"
build=false
wait_timeout="${DEV_UP_WAIT_TIMEOUT:-300}"
for arg in "$@"; do
  case "$arg" in
    deps | app) profile="$arg" ;;
    --build) build=true ;;
    -h | --help)
      sed -n '2,13p' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done

ensure_rootless_docker_host
ensure_compose_provider
ensure_env_file
# PostgreSQL accepts TLS only; clients verify against this local CA (ADR 0222).
ensure_local_tls

if [[ "$profile" == "app" ]]; then
  if $build || [[ ! -f "${REPO_ROOT}/apps/web/dist/index.html" ]]; then
    log "building @starter/web (apps/web/dist)"
    (cd "$REPO_ROOT" && ${PNPM:-npm exec --yes pnpm@12.11.2 --} --filter @starter/web... build)
  fi
  if $build || ! podman_remote image exists "$API_IMAGE"; then
    build_api_image
  fi
  if $build || ! podman_remote image exists "$TEST_IDP_IMAGE"; then
    build_test_idp_image
  fi
fi

# `up --wait` is deliberately not used: this compose provider reports a one-shot container that
# exits 0 during the wait phase as a failure, which made start-up timing-dependent. Compose still
# honours depends_on conditions (healthy / completed successfully) while starting.
log "starting profile '${profile}' (DOCKER_HOST=${DOCKER_HOST})"
up_failed=false
compose --profile "$profile" up -d || up_failed=true

# wait_for <container> <one-shot|service>
wait_for() {
  local name="$1" kind="$2" status code health deadline=$(($(date +%s) + wait_timeout))
  while :; do
    read -r status code health < <(
      podman_remote inspect \
        --format '{{.State.Status}} {{.State.ExitCode}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
        "$name" 2>/dev/null || echo 'missing -1 none'
    )
    [[ "$status" != missing ]] || die "${name} was not created"
    if [[ "$kind" == one-shot && "$status" == exited ]]; then
      [[ "$code" == 0 ]] && return 0
      podman_remote logs "$name" 2>&1 | tail -n 20 >&2
      die "one-shot ${name} failed (exit ${code})"
    fi
    if [[ "$kind" == service ]]; then
      [[ "$status" == running && ("$health" == healthy || "$health" == none) ]] && return 0
      if [[ "$status" == exited ]]; then
        podman_remote logs "$name" 2>&1 | tail -n 20 >&2
        die "${name} exited (${code})"
      fi
    fi
    if [[ $(date +%s) -ge $deadline ]]; then
      podman_remote logs "$name" 2>&1 | tail -n 20 >&2
      die "${name} not ready after ${wait_timeout}s (status=${status}, health=${health})"
    fi
    sleep 1
  done
}

wait_for starter-app-postgres service
wait_for starter-app-postgres-admin one-shot
wait_for starter-app-dynamodb service
wait_for starter-app-dynamodb-init one-shot
if [[ "$profile" == "app" ]]; then
  wait_for starter-app-db-bootstrap one-shot
  wait_for starter-app-migrate one-shot
  wait_for starter-app-api service
  wait_for starter-app-test-idp service
  wait_for starter-app-web service
fi
if $up_failed; then die "compose up reported an error (see above)"; fi

cat >&2 <<EOF
[starter-compose] ready:
  PostgreSQL     127.0.0.1:$(setting STARTER_PG_HOST_PORT 15432)   (TLS only, CA ${TLS_DIR}/ca.pem; credentials in ${ENV_FILE})
  DynamoDB Local http://127.0.0.1:$(setting STARTER_DYNAMODB_HOST_PORT 18000)
EOF
if [[ "$profile" == "app" ]]; then
  cat >&2 <<EOF
  API            http://127.0.0.1:$(setting STARTER_API_HOST_PORT 8080)   (/health/ready, /v1/jobs, /openapi.json)
  Web            http://127.0.0.1:$(setting STARTER_WEB_HOST_PORT 4173)   (nginx: /v1 + /health proxied to the API)
  Test IdP       http://127.0.0.1:$(setting STARTER_IDP_HOST_PORT 9400)   (TEST ONLY sign-in: alice / bob / mallory)
EOF
fi
if [[ "$profile" == "deps" ]]; then
  log "deps only: roles and schema are prepared by the app profile, or from the host after a build:"
  log "  eval \"\$(local/compose/bin/env.sh)\" && pnpm --filter @starter/api run db:prepare"
fi
log "host-side env for tests / dev servers:  eval \"\$(local/compose/bin/env.sh)\""
