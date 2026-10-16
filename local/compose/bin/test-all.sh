#!/usr/bin/env bash
# Run every local suite against the full compose stack and summarise the results.
#
#   local/compose/bin/test-all.sh            # assumes `dev-up.sh app` already ran
#   local/compose/bin/test-all.sh --up       # start/refresh the stack first (dev-up.sh app --build)
#   local/compose/bin/test-all.sh --no-outage --no-e2e --no-security
#
# Order: smoke (API) -> smoke (through web tier) -> integration -> outage (stops/starts store
# containers) -> e2e -> security (API directly AND through the web tier) -> leakage scan of the
# reports and the API container log -> image config check. Each suite writes JUnit XML to
# reports/junit/. Exit non-zero if any failed.
#
# Security suite (tests/security, SECTEST_MODE=external) requirements on the stack under test:
#   - the TEST-ONLY IdP with TEST_IDP_ENABLE_TEST_ENDPOINTS=true (TEST_IDP_URL, default
#     http://127.0.0.1:9400): the suite mints its tokens, including every negative case, there;
#   - RATE_LIMIT_UNAUTHENTICATED_MAX raised (e.g. 10000) in the api environment: the negative
#     authentication matrix sends ~60 failed authentications per target from one address, and
#     the configuration allows relaxing limits for tests by raising them. Exhaustion of the limits is
#     then proven by the self-started run (pnpm --filter @starter/tests-security test:integration);
#   - AUTH_ALLOWED_CLIENT_IDS=starter-web-local in the api environment: without it the
#     "token issued to another client" check fails, as it should.
set -uo pipefail
# shellcheck source=_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

up=false
outage=true
e2e=true
security=true
for arg in "$@"; do
  case "$arg" in
    --up) up=true ;;
    --no-outage) outage=false ;;
    --no-e2e) e2e=false ;;
    --no-security) security=false ;;
    *) die "unknown argument: $arg" ;;
  esac
done

ensure_rootless_docker_host
read -r -a PNPM_CMD <<<"${PNPM:-npm exec --yes pnpm@12.11.2 --}"
pnpm_run() { (cd "$REPO_ROOT" && "${PNPM_CMD[@]}" "$@"); }

if $up; then
  "${COMPOSE_DIR}/bin/dev-up.sh" app --build || die "stack did not come up"
fi
eval "$("${COMPOSE_DIR}/bin/env.sh")"

pnpm_run --filter @starter/workflow-processing --filter @starter/contracts --filter @starter/tests-smoke build >/dev/null ||
  die "build of test prerequisites failed"

results=()
run() {
  local name="$1"
  shift
  log "=== ${name}"
  if "$@"; then
    results+=("PASS  ${name}")
  else
    results+=("FAIL  ${name} (exit $?)")
  fi
}

run "smoke (API ${API_BASE_URL})" env BASE_URL="$API_BASE_URL" SMOKE_JUNIT="${REPO_ROOT}/reports/junit/smoke-api.xml" \
  node "${REPO_ROOT}/tests/smoke/dist/cli.js"
run "smoke (web tier ${WEB_BASE_URL})" env BASE_URL="$WEB_BASE_URL" SMOKE_JUNIT="${REPO_ROOT}/reports/junit/smoke-web.xml" \
  node "${REPO_ROOT}/tests/smoke/dist/cli.js"
run "integration (api project)" pnpm_run --filter @starter/tests-integration test:api
if $outage; then
  # shellcheck disable=SC2329  # invoked via run()
  outage_suite() { (export LOCAL_CONTAINER_CONTROL=true && pnpm_run --filter @starter/tests-integration test:outage); }
  run "integration (outage project, local only)" outage_suite
fi
if $e2e; then
  run "e2e (Playwright Chromium)" pnpm_run --filter @starter/tests-e2e test:e2e
fi
if $security; then
  pnpm_run --filter "@starter/tests-security..." build >/dev/null || die "build of the security suite failed"
  sectest_run="compose-$(date -u +%Y%m%dT%H%M%SZ)"
  evidence="${REPO_ROOT}/reports/security/${sectest_run}"
  # The same suite on both paths: the API directly and through the web tier (nginx).
  # shellcheck disable=SC2329  # invoked via run()
  security_suite() {
    (export SECTEST_RUN_ID="$sectest_run" TEST_IDP_URL="${TEST_IDP_URL:-http://127.0.0.1:9400}" &&
      pnpm_run --filter @starter/tests-security test:security)
  }
  run "security (API ${API_BASE_URL} + web tier ${WEB_BASE_URL})" security_suite
  # The API container's log for the leakage scan (the suite wrote this run's canaries.json).
  mkdir -p "$evidence"
  podman_remote logs starter-app-api >"${evidence}/api-container.log" 2>&1 ||
    log "could not read the starter-app-api log; the leakage scan covers the reports only"
  # shellcheck disable=SC2329  # invoked via run()
  leak_scan() {
    node "${REPO_ROOT}/tests/security/dist/scanner/cli.js" --dir "${REPO_ROOT}/reports" \
      --secret-env DB_PASSWORD --report "${REPO_ROOT}/reports/security/leak-scan.json"
  }
  run "leakage scan (reports/ + API log: canaries, secret formats, DB password)" leak_scan
  # shellcheck disable=SC2329  # invoked via run()
  image_check() {
    local archive="${evidence}/api-image.oci.tar"
    podman_remote save --format oci-archive -o "$archive" "$API_IMAGE" >/dev/null &&
      node "${REPO_ROOT}/tests/security/dist/container/cli.js" --archive "$archive" \
        --report "${REPO_ROOT}/reports/security/image-check.json"
    local rc=$?
    rm -f "$archive"
    return "$rc"
  }
  run "image config (${API_IMAGE}: non-root, exec entrypoint, no secret ENV)" image_check
fi

log "=== summary"
failed=0
for r in "${results[@]}"; do
  printf '  %s\n' "$r" >&2
  [[ "$r" == FAIL* ]] && failed=1
done
exit "$failed"
