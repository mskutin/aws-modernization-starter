#!/usr/bin/env bash
# shellcheck disable=SC2329  # functions run via trap / run_check are reported as never invoked
# Phase 2: live checks against the deployed sandbox run.
#
#   SBX_RUN_ID=sbx-1a2b3c tests/aws-integration/sandbox/test.sh     (default: the current run)
#   SBX_TESTS=smoke,security tests/aws-integration/sandbox/test.sh   (subset; default: all)
#
# Checks, in order (each writes JSON result lines to <run dir>/test-<UTC>/results.jsonl):
#   clock            local clock within 30 s of CloudFront's Date (tokens are minted locally)
#   spa              SPA shell, CSP and /config.json through CloudFront
#   health           /health/live and /health/ready through CloudFront
#   origin-protection direct ALB access denied (no header, wrong header) + listener/SG configuration
#   smoke            tests/smoke against CloudFront with the local test IdP (per step)
#   canary           canary + business-invalid jobs (for the leak scan and the Lambda failure path)
#   security         tests/security SECTEST_MODE=external (all suites but rate-limit) against
#                    CloudFront, real DynamoDB (SDK, pinned profile), the real API log stream
#   rate-limit       tests/security rate-limit suite alone (it exhausts the per-address budget)
#   e2e              Playwright against CloudFront (E2E_AUTH_MODE=aws-test-issuer)
#   db-probe         one-off ECS task of the API task definition: TLS verify-full, wrong CA/host,
#                    no TLS, other-role IAM login, privilege denials
#   leak-scan        CloudWatch Logs + Step Functions histories: positive controls, then no
#                    canary/token/secret; the business-invalid job's Lambda failure path
#   step-functions   every execution of this test run is terminal
# Exit: 0 when every check that ran passed (and something ran), 1 otherwise, 4 refused.
# A check that could not run is recorded as not-run, never as passed.
set -euo pipefail
# shellcheck source=_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

resolve_run || sbx_die "no run: set SBX_RUN_ID or run up.sh first" 2
[[ -d "$RUN_DIR" ]] || sbx_die "run directory ${RUN_DIR} is missing" 2
TEST_DIR="${RUN_DIR}/test-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$TEST_DIR"
ln -sfn "$(basename "$TEST_DIR")" "${RUN_DIR}/test-latest"
RESULTS="${TEST_DIR}/results.jsonl"
: >"$RESULTS"
start_logging
on_exit() {
  local rc=$?
  record_failed_step "$rc"
  exit "$rc"
}
trap on_exit EXIT
guard_init

# Evidence paths are relative to the run directory.
ev() { printf '%s' "${1#"${RUN_DIR}"/}"; }
wanted() { [[ -z "${SBX_TESTS:-}" || ",${SBX_TESTS}," == *",$1,"* ]]; }

# run_check <check> <function>: re-verifies the account (the guard dies on a mismatch), then runs
# the check in a subshell with errexit OFF: each check handles and records its own failures, and
# neither a failing command nor a fatal error (sbx_die) of one check stops the others. A check
# that records nothing is recorded as an error.
run_check() {
  local check="$1" fn="$2" before after rc
  wanted "$check" || return 0
  sbx_log "── check ${check}"
  sandbox_guard "test.sh check ${check} [${RUN_ID}]" >&2
  before="$(wc -l <"$RESULTS")"
  set +e
  ("$fn")
  rc=$?
  set -e
  after="$(wc -l <"$RESULTS")"
  if ((after == before)); then
    result "$RESULTS" "$check" "${check}: check produced no result" error "$(ev "$TEST_DIR")" "exit ${rc}"
  fi
  sbx_log "── check ${check}: exit ${rc}"
  return 0
}

not_run() { result "$RESULTS" "$1" "$2" not-run "$(ev "$TEST_DIR")" "$3"; }

# ── context ───────────────────────────────────────────────────────────────────────────────────
refresh_outputs
CF="https://$(out Frontend DistributionDomainName)"
ISSUER="$(run_env_get ISSUER_URL)"
[[ -n "$ISSUER" ]] || sbx_die "ISSUER_URL missing in run.env (run up.sh)"
T0_MS="$("${NODE_CMD[@]}" -e 'process.stdout.write(String(Date.now()))')"
T0_ISO="$(now_iso)"
SECTEST_ID="$(printf '%s%s' "${RUN_ID#sbx-}" "$(date -u +%H%M%S)")"
printf '{"runId":"%s","startedAt":"%s","cloudFrontUrl":"%s","issuer":"%s","idpUrl":"%s","sectestRunId":"%s"}\n' \
  "$RUN_ID" "$T0_ISO" "$CF" "$ISSUER" "$SBX_IDP_URL" "$SECTEST_ID" >"${TEST_DIR}/context.json"

if [[ "${SBX_SKIP_BUILD:-}" != "true" ]]; then
  (cd "$REPO_ROOT" && "${PNPM_CMD[@]}" --filter "@starter/tests-security..." --filter "@starter/tests-smoke..." \
    --filter "@starter/tests-e2e..." --filter "@starter/tests-aws-integration..." run build) ||
    sbx_die "build of the test packages failed"
fi

IDP_OK=true
if ! idp_running || [[ "$(run_env_get IDP_REDIRECT_URI)" != "${CF}/" ]]; then
  idp_start "${CF}/" || IDP_OK=false
fi

# The API task definition currently serving (its env tells the suite the real limits).
SERVICE_TD=""
API_ENV_JSON="${TEST_DIR}/api-task-definition.json"
api_task_definition() {
  local cluster service
  cluster="$(out Platform ClusterName)"
  service="$(out Api ServiceName)"
  awsr ecs describe-services --cluster "$cluster" --services "$service" --output json >"${TEST_DIR}/service.json" &&
    SERVICE_TD="$(tool json-get "${TEST_DIR}/service.json" services.0.taskDefinition)" &&
    awsr ecs describe-task-definition --task-definition "$SERVICE_TD" --output json >"$API_ENV_JSON"
}
api_env() {
  "${NODE_CMD[@]}" -e '
    const td = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).taskDefinition;
    const env = td.containerDefinitions[0].environment ?? [];
    const v = env.find((e) => e.name === process.argv[2]);
    if (v) process.stdout.write(String(v.value));' "$API_ENV_JSON" "$1" 2>/dev/null || true
}
api_task_definition || sbx_warn "could not read the API service/task definition"

# ── checks ────────────────────────────────────────────────────────────────────────────────────
check_clock() {
  tool clock-skew --url "${CF}/" --max-seconds 30 --results "$RESULTS" --check clock \
    --evidence "$(ev "$LOG_FILE_HINT")"
}

check_spa() {
  tool spa-check --base-url "$CF" --issuer "$ISSUER" --client-id "$SBX_CLIENT_ID" \
    --deadline-ms 120000 --results "$RESULTS" --check spa --evidence "$(ev "$LOG_FILE_HINT")"
}

check_health() {
  tool health-check --base-url "$CF" --deadline-ms 300000 --results "$RESULTS" --check health \
    --evidence "$(ev "$LOG_FILE_HINT")"
}

check_origin() {
  local alb lb_arn
  alb="$(out Api AlbDnsName)"
  tool alb-direct-check --alb "$alb" --results "$RESULTS" --check origin-protection --evidence "$(ev "$LOG_FILE_HINT")"
  lb_arn="$(awsr elbv2 describe-load-balancers --query "LoadBalancers[?DNSName=='${alb}'].LoadBalancerArn | [0]" --output text)"
  if [[ -z "$lb_arn" || "$lb_arn" == None ]]; then
    not_run origin-protection "ALB listener/security-group configuration" "load balancer ${alb} not found"
    return 1
  fi
  awsr elbv2 describe-load-balancers --load-balancer-arns "$lb_arn" --output json >"${TEST_DIR}/alb.json"
  awsr elbv2 describe-listeners --load-balancer-arn "$lb_arn" --output json >"${TEST_DIR}/alb-listeners.json"
  local listener
  listener="$(tool json-get "${TEST_DIR}/alb-listeners.json" Listeners.0.ListenerArn)"
  # The raw rules contain the origin-verify value: evaluate them, keep only a redacted copy.
  awsr elbv2 describe-rules --listener-arn "$listener" --output json >"${TEST_DIR}/.alb-rules.raw.json"
  tool listener-check --rules "${TEST_DIR}/.alb-rules.raw.json" --secret-file "${RUN_DIR}/origin-verify" \
    --redacted-out "${TEST_DIR}/alb-rules.json" \
    --results "$RESULTS" --check origin-protection --evidence "$(ev "${TEST_DIR}/alb-rules.json")"
  rm -f "${TEST_DIR}/.alb-rules.raw.json"
  local sgs
  sgs="$(awsr elbv2 describe-load-balancers --load-balancer-arns "$lb_arn" --query 'LoadBalancers[0].SecurityGroups' --output text)"
  # shellcheck disable=SC2086  # word splitting of the group ids is intended
  awsr ec2 describe-security-groups --group-ids $sgs --output json >"${TEST_DIR}/alb-security-groups.json"
  tool alb-sg-check --groups "${TEST_DIR}/alb-security-groups.json" --results "$RESULTS" \
    --check origin-protection --evidence "$(ev "${TEST_DIR}/alb-security-groups.json")"
}

check_smoke() {
  if ! $IDP_OK; then
    not_run smoke "smoke" "the local test IdP is not running"
    return 1
  fi
  local log="${TEST_DIR}/smoke.log"
  BASE_URL="$CF" SMOKE_TEST_IDP_URL="$SBX_IDP_URL" SMOKE_JUNIT="${TEST_DIR}/smoke-junit.xml" \
    SMOKE_READY_DEADLINE_MS=120000 SMOKE_JOB_DEADLINE_MS=180000 \
    "${NODE_CMD[@]}" "$SMOKE_CLI" >"$log" 2>&1
  local rc=$?
  tool results-smoke --log "$log" --results "$RESULTS" --check smoke --evidence "$(ev "$log")"
  return "$rc"
}

CANARY_RUN="${TEST_DIR}/canary-run.json"
check_canary() {
  if ! $IDP_OK; then
    not_run canary "canary jobs" "the local test IdP is not running"
    return 1
  fi
  if tool canary-submit --base-url "$CF" --idp-url "$SBX_IDP_URL" --run-id "$RUN_ID" --out "$CANARY_RUN" \
    >"${TEST_DIR}/canary.log" 2>&1; then
    result "$RESULTS" canary "canary job SUCCEEDED and business-invalid job FAILED through CloudFront" passed \
      "$(ev "$CANARY_RUN")"
  else
    result "$RESULTS" canary "canary job SUCCEEDED and business-invalid job FAILED through CloudFront" failed \
      "$(ev "${TEST_DIR}/canary.log")" "$(tail -n 1 "${TEST_DIR}/canary.log")"
    return 1
  fi
}

security_env() {
  local targets=(WEB_BASE_URL="$CF")
  [[ "${SBX_SECTEST_TARGETS:-web}" == both ]] && targets+=(API_BASE_URL="$CF")
  printf '%s\n' "${targets[@]}" \
    SECTEST_MODE=external \
    "TEST_IDP_URL=${SBX_IDP_URL}" \
    "AUTH_AUDIENCE=${SBX_AUDIENCE}" \
    "SECTEST_MAX_TOKEN_AGE_SECONDS=$(api_env AUTH_MAX_TOKEN_AGE_SECONDS | grep -E '^[0-9]+$' || echo 3600)" \
    "JOBS_TABLE_NAME=$(out Data JobTableName)" \
    SECTEST_DYNAMODB_AWS=true \
    "AWS_PROFILE=${SBX_PROFILE}" \
    "AWS_REGION=${SBX_REGION}" \
    "SECTEST_KNOWN_SECRET_FILES=${RUN_DIR}/origin-verify" \
    "SECTEST_RUN_ID=${SECTEST_ID}"
}

# vitest_security <check> <report> [vitest args…]
vitest_security() {
  local check="$1" report="$2"
  shift 2
  local envs=()
  while IFS= read -r line; do envs+=("$line"); done < <(security_env)
  (cd "$REPO_ROOT" && env "${envs[@]}" "$@" "${PNPM_CMD[@]}" --filter @starter/tests-security exec vitest run \
    --project security --reporter=default --reporter=json --reporter=junit \
    --outputFile.json="$report" --outputFile.junit="${report%.json}-junit.xml" "${VITEST_ARGS[@]}") \
    >"${report%.json}.log" 2>&1
  local rc=$?
  tool results-vitest --report "$report" --results "$RESULTS" --check "$check" --evidence "$(ev "$report")"
  return "$rc"
}

check_security() {
  if ! $IDP_OK; then
    not_run security "security suite (external)" "the local test IdP is not running"
    return 1
  fi
  local limit
  limit="$(api_env RATE_LIMIT_UNAUTHENTICATED_MAX)"
  if [[ "$limit" =~ ^[0-9]+$ ]] && ((limit < 150)); then
    sbx_warn "RATE_LIMIT_UNAUTHENTICATED_MAX=${limit}: the negative authentication matrix sends more failed authentications per minute from one address; expect 429s"
  fi
  # The REAL API log stream feeds the suite's log assertions (audit trail, no token/secret/canary).
  local api_log="${TEST_DIR}/api-log.jsonl" group
  group="$(out Api ApiLogGroupName)"
  : >"$api_log"
  # Started as the command itself (not through the `tool` function), so $! is the follower and
  # killing it cannot orphan a process that keeps polling CloudWatch.
  "${SBX_TOOL_CMD[@]}" log-follow --group "$group" --out "$api_log" --start-ms "$T0_MS" --interval-ms 2000 \
    </dev/null >>"${TEST_DIR}/log-follow.log" 2>&1 &
  local follower=$!
  # (this runs in the check's subshell: stop the follower however the subshell ends)
  trap 'kill "$follower" 2>/dev/null' EXIT
  VITEST_ARGS=(--exclude '**/rate-limit.test.ts')
  vitest_security security "${TEST_DIR}/security.json" "SECTEST_LOG_FILES=${api_log}"
  local rc=$?
  kill "$follower" 2>/dev/null
  wait "$follower" 2>/dev/null
  return "$rc"
}

check_rate_limit() {
  if ! $IDP_OK; then
    not_run rate-limit "rate-limit suite (external)" "the local test IdP is not running"
    return 1
  fi
  VITEST_ARGS=(src/suites/rate-limit.test.ts)
  vitest_security rate-limit "${TEST_DIR}/rate-limit.json" "SECTEST_MAX_EXHAUST=${SBX_MAX_EXHAUST:-300}"
}

check_e2e() {
  if [[ ! -f "${SBX_E2E_AUTH_MODULE:-${REPO_ROOT}/tests/e2e/support/aws-auth.ts}" ]]; then
    not_run e2e "browser E2E through CloudFront" "tests/e2e/support/aws-auth.ts is not present"
    return 1
  fi
  if ! $IDP_OK; then
    not_run e2e "browser E2E through CloudFront" "the local test IdP is not running"
    return 1
  fi
  # Preflight (offline, no AWS): the Chromium check of the aws-test-issuer routing.
  # If the routing is broken locally, a live failure would say nothing about the deployment.
  local offline_log="${TEST_DIR}/e2e-aws-auth-offline.log"
  if (cd "$REPO_ROOT" && "${PNPM_CMD[@]}" --filter @starter/tests-e2e run test:aws-auth-offline) \
    >"$offline_log" 2>&1; then
    result "$RESULTS" e2e "e2e: aws-test-issuer routing works offline (preflight)" passed "$(ev "$offline_log")"
  else
    result "$RESULTS" e2e "e2e: aws-test-issuer routing works offline (preflight)" failed "$(ev "$offline_log")" \
      "pnpm --filter @starter/tests-e2e run test:aws-auth-offline failed"
    not_run e2e "browser E2E through CloudFront" "the offline aws-auth preflight failed"
    return 1
  fi
  local report="${TEST_DIR}/e2e.json"
  (cd "$REPO_ROOT" && env WEB_BASE_URL="$CF" E2E_AUTH_MODE=aws-test-issuer E2E_ISSUER="$ISSUER" \
    E2E_IDP_URL="$SBX_IDP_URL" E2E_READY_DEADLINE_MS=120000 \
    PLAYWRIGHT_JSON_OUTPUT_NAME="$report" PLAYWRIGHT_JUNIT_OUTPUT_NAME="${TEST_DIR}/e2e-junit.xml" \
    "${PNPM_CMD[@]}" --filter @starter/tests-e2e exec playwright test --reporter=line,json,junit) \
    >"${TEST_DIR}/e2e.log" 2>&1
  local rc=$?
  tool results-playwright --report "$report" --results "$RESULTS" --check e2e --evidence "$(ev "$report")"
  return "$rc"
}

check_db_probe() {
  if [[ -z "$SERVICE_TD" ]]; then
    not_run db-probe "in-VPC database probes" "the API task definition is unknown"
    return 1
  fi
  local container probe_id overrides="${TEST_DIR}/db-probe-overrides.json"
  container="$(tool json-get "$API_ENV_JSON" taskDefinition.containerDefinitions.0.name)"
  probe_id="${RUN_ID}-p$(date -u +%H%M%S)"
  tool probe-overrides --container "$container" --run-id "$probe_id" --out "$overrides" || {
    not_run db-probe "in-VPC database probes" "could not build the command override"
    return 1
  }
  # A one-off task is a mutation (it starts compute): through the guard (run_task uses mut).
  run_task db-probe "$SERVICE_TD" "$overrides" || return 1
  if [[ "$TASK_EXIT_CODE" != 0 ]]; then
    result "$RESULTS" db-probe "db: the probe task ran to completion" failed "$(ev "$TASK_DIR")" \
      "exit ${TASK_EXIT_CODE} (${TASK_STOPPED_REASON})"
  fi
  tool probe-evaluate --events "$TASK_LOGS" --run-id "$probe_id" --out "${TASK_DIR}/evaluation.json" \
    --results "$RESULTS" --check db-probe --evidence "$(ev "${TASK_DIR}/evaluation.json")"
}

# download_scan_inputs [execution ARN…] — every experiment log group's events since T0, the
# histories of the run's newest executions (SBX_HISTORY_SCAN_MAX) and of the given executions
# (the canary jobs: listed newest first, they may be older than the cap).
download_scan_inputs() {
  local logs="${TEST_DIR}/scan/logs" hist="${TEST_DIR}/scan/history" groups=() g prefix i=0
  rm -rf "${TEST_DIR}/scan"
  mkdir -p "$logs" "$hist"
  : >"${logs}/index.jsonl"
  # Our groups only: the stage's resource prefix, our DB instance (first label of DbEndpoint) and
  # our cluster (the account also holds other workloads).
  local db cluster
  db="$(out_opt Data DbEndpoint)"
  db="${db%%.*}"
  cluster="$(out_opt Platform ClusterName)"
  for prefix in "/starter/${SBX_RESOURCE_PREFIX}/" "/aws/vendedlogs/states/${SBX_RESOURCE_PREFIX}-" \
    "/aws/lambda/${SBX_RESOURCE_PREFIX}-" ${db:+"/aws/rds/instance/${db}/"} \
    ${cluster:+"/aws/ecs/containerinsights/${cluster}/"}; do
    while IFS= read -r g; do
      [[ -n "$g" && "$g" != None ]] && groups+=("$g")
    done < <(awsr logs describe-log-groups --log-group-name-prefix "$prefix" \
      --query 'logGroups[].logGroupName' --output text | tr '\t' '\n')
  done
  groups+=("$(out Api ApiLogGroupName)")
  while IFS= read -r g; do
    i=$((i + 1))
    awsr logs filter-log-events --log-group-name "$g" --start-time "$T0_MS" --output json \
      >"${logs}/group-${i}.json" || continue
    printf '{"file":"group-%s.json","group":"%s"}\n' "$i" "$g" >>"${logs}/index.jsonl"
  done < <(printf '%s\n' "${groups[@]}" | sort -u)
  local sm
  sm="$(out Workflow StateMachineArn)"
  awsr stepfunctions list-executions --state-machine-arn "$sm" --max-items "${SBX_HISTORY_SCAN_MAX:-100}" \
    --output json >"${TEST_DIR}/scan/executions.json"
  local arn
  while IFS= read -r arn; do
    [[ "$arn" == arn:* ]] || continue
    awsr stepfunctions get-execution-history --execution-arn "$arn" --include-execution-data \
      --output json >"${hist}/${arn##*:}.json" || rm -f "${hist}/${arn##*:}.json"
  done < <(
    "${NODE_CMD[@]}" -e '
    const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const since = Date.parse(process.argv[2]);
    for (const e of j.executions ?? []) if (Date.parse(e.startDate) >= since) console.log(e.executionArn);
  ' "${TEST_DIR}/scan/executions.json" "$T0_ISO"
    printf '%s\n' "$@"
  )
}

check_leak_scan() {
  if [[ ! -s "$CANARY_RUN" ]]; then
    not_run leak-scan "CloudWatch Logs and execution-history leak scan" "no canary jobs (the canary check did not run or failed)"
    return 1
  fi
  local canary_job failure_job sm canary_exec failure_exec
  canary_job="$(tool json-get "$CANARY_RUN" canaryJobId)"
  failure_job="$(tool json-get "$CANARY_RUN" failureJobId)"
  sm="$(out Workflow StateMachineArn)"
  canary_exec="$(tool execution-arn --state-machine "$sm" --job-id "$canary_job")"
  failure_exec="$(tool execution-arn --state-machine "$sm" --job-id "$failure_job")"
  local suite_canaries=()
  [[ -f "${REPO_ROOT}/reports/security/${SECTEST_ID}/canaries.json" ]] &&
    suite_canaries=(--canaries "${REPO_ROOT}/reports/security/${SECTEST_ID}/canaries.json")
  # Lambda logs can take minutes to arrive: re-download until the positive controls hold.
  local deadline=$((SECONDS + ${SBX_LEAK_SCAN_DEADLINE_SECONDS:-900})) rc
  while :; do
    download_scan_inputs "$canary_exec" "$failure_exec"
    tool leak-scan --canary-run "$CANARY_RUN" ${suite_canaries[@]+"${suite_canaries[@]}"} \
      --logs-dir "${TEST_DIR}/scan/logs" --history-dir "${TEST_DIR}/scan/history" \
      --expect-log "/ecs/api=${canary_job}" --expect-log "/ecs/api=${failure_job}" \
      --expect-history "${canary_exec##*:}=${canary_job}" --expect-history "${failure_exec##*:}=${failure_job}" \
      --failure-execution "${failure_exec##*:}" \
      --secret-file "${RUN_DIR}/origin-verify" --jwk-file "${RUN_DIR}/issuer-key.jwk" \
      --out "${TEST_DIR}/leak-report.json" >"${TEST_DIR}/leak-scan.log" 2>&1
    rc=$?
    # Findings (hits) are final; only missing positive controls are worth waiting for.
    if ((rc == 0)) || grep -q '^FINDING' "${TEST_DIR}/leak-scan.log" || ((SECONDS >= deadline)); then
      break
    fi
    sbx_log "leak scan: positive controls not yet satisfied (log delivery lag); retrying"
    sleep "${SBX_LEAK_SCAN_RETRY_SECONDS:-60}"
  done
  tool leak-scan --canary-run "$CANARY_RUN" ${suite_canaries[@]+"${suite_canaries[@]}"} \
    --logs-dir "${TEST_DIR}/scan/logs" --history-dir "${TEST_DIR}/scan/history" \
    --expect-log "/ecs/api=${canary_job}" --expect-log "/ecs/api=${failure_job}" \
    --expect-history "${canary_exec##*:}=${canary_job}" --expect-history "${failure_exec##*:}=${failure_job}" \
    --failure-execution "${failure_exec##*:}" \
    --secret-file "${RUN_DIR}/origin-verify" --jwk-file "${RUN_DIR}/issuer-key.jwk" \
    --out "${TEST_DIR}/leak-report.json" --results "$RESULTS" --check leak-scan \
    --evidence "$(ev "${TEST_DIR}/leak-report.json")"
}

check_step_functions() {
  local sm
  sm="$(out Workflow StateMachineArn)"
  awsr stepfunctions list-executions --state-machine-arn "$sm" --max-items 1000 --output json \
    >"${TEST_DIR}/executions.json" || {
    not_run step-functions "Step Functions executions" "list-executions failed"
    return 1
  }
  tool sfn-summary --executions "${TEST_DIR}/executions.json" --since "$T0_ISO" --results "$RESULTS" \
    --check step-functions --evidence "$(ev "${TEST_DIR}/executions.json")"
}

LOG_FILE_HINT="${TEST_DIR}/results.jsonl"
CURRENT_STEP=checks
STEP_T0="$(date +%s)"
run_check clock check_clock
run_check spa check_spa
run_check health check_health
run_check origin-protection check_origin
run_check smoke check_smoke
run_check canary check_canary
run_check security check_security
run_check rate-limit check_rate_limit
run_check e2e check_e2e
run_check db-probe check_db_probe
run_check leak-scan check_leak_scan
run_check step-functions check_step_functions
CURRENT_STEP=""

set +e
tool results-summary --results "$RESULTS" --out "${TEST_DIR}/summary.json"
rc=$?
set -e
sbx_log "results: ${RESULTS}; summary: ${TEST_DIR}/summary.json"
exit "$rc"
