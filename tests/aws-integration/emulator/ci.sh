#!/usr/bin/env bash
# The MiniStack EMULATOR job entry point (GitLab CI: integration:ministack:{cdk,workflows}).
# NOT AWS — see _emulator.sh. Never calls Podman: MiniStack is a GitLab service (CI) or a
# container someone else started (local-equivalent run: up.sh, all.sh).
#
#   bash tests/aws-integration/emulator/ci.sh cdk         # deploy, reconcile, update, destroy
#   bash tests/aws-integration/emulator/ci.sh workflows   # deploy, *.aws.test.ts suites, destroy
#
# Modes (STARTER_EMULATOR_MODE, checked by the shared guard):
#   ci-service  GitLab CI: GITLAB_CI=true, AWS_ENDPOINT_URL == STARTER_EMULATOR_ALLOWED_ENDPOINT
#               (http://ministack:4566) and the fake-credential environment of the job.
#   loopback    (default) a local emulator on http://127.0.0.1:${STARTER_EMULATOR_PORT:-45660}; this
#               script exports the fake-credential environment itself.
# Steps: guard (+ CDK CLI phone-home off, egress audit on) → health (exact
# STARTER_MINISTACK_EXPECTED_VERSION, bounded wait) + STS identity (fake account) + in-service socket
# probe → cdk bootstrap (qualifier starter) → cdk synth → cdk deploy of that assembly (DeployTarget
# must be ministack-emulator) → suite → cdk destroy → destroy verification → POST /_ministack/reset
# → egress audit (no connection or DNS query to anything but the emulator endpoint, from any Node
# process of the run: egress.json). Teardown runs from an EXIT trap after a failure.
#
# Artifacts (always): reports/aws-integration/emulator/<runId>/
#   report/junit.xml (lifecycle steps + vitest suites), steps.jsonl, diagnostics.json,
#   preflight.json, template.json, outputs.json, stack-resources.json, destroy.json, reset.json,
#   egress.jsonl (audit records) and egress.json (verdict);
#   cdk: reconciliation.json, functions-before.json, update.json, reconciliation-after-update.json;
#   workflows: report/{results.json, results/, not-applicable.jsonl, vitest.json, evidence/}.
# Run id: ci<CI_PIPELINE_IID>-<cdk|wf>-<4 hex> in CI (stack starter-it-<runId>), em-<6 hex> locally.
# Exit: 0 pass; 5 refused by the guard; 3 workspace not built; 2 usage; 1 any other failure.
set -euo pipefail
# shellcheck source=_emulator.sh
source "$(dirname "${BASH_SOURCE[0]}")/_emulator.sh"

SUITE="${1:-}"
case "$SUITE" in
  cdk) SUITE_ABBR=cdk ;;
  workflows) SUITE_ABBR=wf ;;
  *) die "usage: ci.sh cdk|workflows" 2 ;;
esac
export STARTER_EMULATOR_SUITE="$SUITE"

require_build

# ── Run id and report directory (no network yet) ───────────────────────────────────────────────
RUN_ID_PATTERN='^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$'
hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
if [[ -n "${STARTER_EMULATOR_CI_RUN_ID:-}" ]]; then
  RUN_ID="$STARTER_EMULATOR_CI_RUN_ID"
elif [[ -n "${CI_PIPELINE_IID:-}" ]]; then
  [[ "$CI_PIPELINE_IID" =~ ^[0-9]{1,12}$ ]] || die "CI_PIPELINE_IID is not numeric" 2
  RUN_ID="ci${CI_PIPELINE_IID}-${SUITE_ABBR}-$(hex 2)"
else
  RUN_ID="$(new_run_id)"
fi
[[ "$RUN_ID" =~ $RUN_ID_PATTERN ]] || die "invalid run id '${RUN_ID}' (3-24 chars of [a-z0-9-])" 2
STACK="starter-it-${RUN_ID}"
RUN_DIR="${REPORT_ROOT}/${RUN_ID}"
mkdir -p "${RUN_DIR}/report"
chmod 700 "$RUN_DIR"
STEPS_FILE="${RUN_DIR}/steps.jsonl"
: >"$STEPS_FILE"
export STARTER_MINISTACK_EXPECTED_VERSION="${STARTER_MINISTACK_EXPECTED_VERSION:-$MINISTACK_VERSION}"
export STARTER_MINISTACK_IMAGE="${STARTER_MINISTACK_IMAGE:-$MINISTACK_IMAGE}"
export MINISTACK_VERSION="$STARTER_MINISTACK_EXPECTED_VERSION"
# The socket-less local executor (always in CI); the preflight probe proves which one runs. Only a
# local --socket-mode container (up.sh, dedicated machine) may declare docker.
EXECUTOR="${STARTER_EMULATOR_LAMBDA_EXECUTOR:-local}"
case "$EXECUTOR" in
  local) ;;
  docker)
    [[ "${STARTER_EMULATOR_MODE:-loopback}" != ci-service ]] ||
      die "the CI service runs socket-less only (STARTER_EMULATOR_LAMBDA_EXECUTOR=local)" 2
    ;;
  *) die "STARTER_EMULATOR_LAMBDA_EXECUTOR must be local or docker" 2 ;;
esac
export MINISTACK_LAMBDA_EXECUTOR="$EXECUTOR"

# ── Step bookkeeping (steps.jsonl → JUnit) ─────────────────────────────────────────────────────
case "$SUITE" in
  cdk)
    PLANNED=(guard preflight bootstrap synth deploy reconcile "snapshot functions" "synth update"
      "update deploy" "verify update" "reconcile after update" "cdk destroy" "verify destroyed" reset
      "egress audit" "leak scan")
    ;;
  workflows)
    PLANNED=(guard preflight bootstrap synth deploy "workflow suites" "not-applicable governance"
      "cdk destroy" "verify destroyed" reset "egress audit" "leak scan")
    ;;
esac
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
record_step() { # <name> <pass|fail|skipped> <durationMs> [message]
  node -e '
    const [name, status, ms, message] = process.argv.slice(1);
    const r = { name, status, durationMs: Number(ms) };
    if (message) r.message = message;
    process.stdout.write(JSON.stringify(r) + "\n");' "$1" "$2" "$3" "${4:-}" >>"$STEPS_FILE"
}
FAILED_STEPS=0
# step <name> <command…> — runs, records pass/fail with its duration, returns the command's code.
step() {
  local name="$1" t0 rc=0
  shift
  log "── ${name}"
  t0="$(now_ms)"
  "$@" || rc=$?
  if [[ $rc -eq 0 ]]; then
    record_step "$name" pass "$(($(now_ms) - t0))"
  else
    record_step "$name" fail "$(($(now_ms) - t0))" "exit ${rc}"
    FAILED_STEPS=$((FAILED_STEPS + 1))
    log "step '${name}' FAILED (exit ${rc})"
  fi
  return "$rc"
}
step_recorded() { grep -q "\"name\":\"$1\"" "$STEPS_FILE"; }

# ── Teardown (EXIT trap) ───────────────────────────────────────────────────────────────────────
DEPLOY_STARTED=false
DESTROYED=false
EMULATOR_REACHED=false
EGRESS_AUDITED=false
EGRESS_LOG="${RUN_DIR}/egress.jsonl"
LAST_ASSEMBLY="${RUN_DIR}/cdk.out"
emulator_ci() { node "$EMULATOR_CI_CLI" "$@"; }

destroy_and_verify() {
  # Physical ids as they are now (an update replaced the Lambda versions), then destroy.
  emulator_ci stack-resources --stack "$STACK" --out "${RUN_DIR}/stack-resources.json" || true
  step "cdk destroy" emulator_destroy "$LAST_ASSEMBLY" || return
  DESTROYED=true
  step "verify destroyed" emulator_ci verify-destroyed \
    --resources "${RUN_DIR}/stack-resources.json" --out "${RUN_DIR}/destroy.json"
}

# shellcheck disable=SC2329  # invoked via trap
finish() {
  local rc=$?
  trap - EXIT INT TERM
  set +e
  if $DEPLOY_STARTED && ! $DESTROYED; then
    log "teardown after a failure: destroying ${STACK}"
    destroy_and_verify || true
  fi
  if $EMULATOR_REACHED && ! step_recorded reset; then
    step reset emulator_ci reset --out "${RUN_DIR}/reset.json"
  fi
  if [[ -n "${FORWARDER_PID:-}" ]]; then
    kill "$FORWARDER_PID" 2>/dev/null
    wait "$FORWARDER_PID" 2>/dev/null
    FORWARDER_PID=""
  fi
  # After every network-capable process of the run has finished (the forwarder too).
  if $EGRESS_AUDITED; then
    step "egress audit" node "$EGRESS_REPORT" --log "$EGRESS_LOG" --out "${RUN_DIR}/egress.json" \
      --require cdk,emulator-ci.js
  fi
  # The run's own artifacts (outputs, read-backs, logs) must name no AWS endpoint host and no account
  # but the emulator's fake one; blocking, like every other step.
  if [[ -d "$RUN_DIR" ]]; then
    step "leak scan" emulator_ci scan-leaks --dir "$RUN_DIR" --out "${RUN_DIR}/leak-scan.json"
  fi
  [[ -z "${CDK_ISOLATED_HOME:-}" ]] || rm -rf "$CDK_ISOLATED_HOME"
  local name
  for name in "${PLANNED[@]}"; do
    step_recorded "$name" || record_step "$name" skipped 0 "not reached (an earlier step failed)"
  done
  emulator_ci diagnostics --run-dir "$RUN_DIR" --out "${RUN_DIR}/diagnostics.json" ||
    log "could not write diagnostics.json"
  emulator_ci junit --steps "$STEPS_FILE" --suite "ministack-emulator ${SUITE} (${RUN_ID})" \
    --include "${RUN_DIR}/report/vitest-junit.xml" \
    --reconciliation "${RUN_DIR}/reconciliation.json" \
    --reconciliation "${RUN_DIR}/reconciliation-after-update.json" \
    --out "${RUN_DIR}/report/junit.xml" ||
    log "could not write junit.xml"
  [[ $rc -eq 0 && $FAILED_STEPS -gt 0 ]] && rc=1
  log "run ${RUN_ID} (${SUITE}) finished with exit ${rc}: ${RUN_DIR}"
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ── 1. Guard: before any cdk, SDK or HTTP call ─────────────────────────────────────────────────
# Then, in both modes: the CDK CLI's phone-home off, proxies removed (emulator_cli_isolation), a
# private HOME for `cdk`, and the egress audit preloaded into every Node process from here on — its
# allowlist is exactly the guard-validated endpoint.
guard_step() {
  node "$GUARD_CLI" --phase incoming >/dev/null || return
  emulator_cli_isolation
  [[ "${STARTER_EMULATOR_MODE:-loopback}" == ci-service ]] || emulator_env
  node "$GUARD_CLI" --phase effective >/dev/null || return
  cdk_home_prepare || return
  egress_audit_start "$EGRESS_LOG" "$(endpoint_host_port "$AWS_ENDPOINT_URL")" || return
  EGRESS_AUDITED=true
}
guard_rc=0
step guard guard_step || guard_rc=$?
if [[ $guard_rc -ne 0 ]]; then
  [[ $guard_rc -eq $REFUSED_EXIT ]] &&
    die "refusing: the emulator guard rejected this environment; nothing was called" "$REFUSED_EXIT"
  die "the emulator guard failed (exit ${guard_rc})" "$guard_rc"
fi
log "run ${RUN_ID}: ${SUITE} against ${AWS_ENDPOINT_URL} (MiniStack ${STARTER_MINISTACK_EXPECTED_VERSION}, EMULATOR — not AWS)"

# ── 1b. CI service: loopback forwarder ─────────────────────────────────────────────────────────
# Against a host-name endpoint the AWS SDK addresses S3 buckets virtual-hosted style
# (<bucket>.ministack), which no service alias resolves, and the CDK CLI has no path-style
# switch. So, once the guard has accepted the job environment, every cdk/SDK call goes through a
# forwarder on 127.0.0.1 whose only target is that guard-validated, allowlisted endpoint; the
# children run in loopback mode (path-style S3, as locally) and pass the guard again.
FORWARDER_PID=""
start_forwarder() {
  local port_file="${RUN_DIR}/forwarder.port" i
  rm -f "$port_file"
  node "$EMULATOR_CI_CLI" forward --port-file "$port_file" &
  FORWARDER_PID=$!
  for i in $(seq 1 50); do
    [[ -s "$port_file" ]] && break
    kill -0 "$FORWARDER_PID" 2>/dev/null || return 1
    sleep 0.2
  done
  [[ -s "$port_file" ]] || return 1
  export STARTER_EMULATOR_JOB_MODE=ci-service STARTER_EMULATOR_SERVICE_ENDPOINT="$AWS_ENDPOINT_URL"
  export STARTER_EMULATOR_MODE=loopback AWS_ENDPOINT_URL="http://127.0.0.1:$(tr -d ' \n' <"$port_file")"
  node "$GUARD_CLI" --phase effective >/dev/null || return
  # The forwarder alone talks to the service; every later process only to the forwarder.
  STARTER_EMULATOR_EGRESS_ALLOW="$(endpoint_host_port "$AWS_ENDPOINT_URL")" || return
  export STARTER_EMULATOR_EGRESS_ALLOW
}
if [[ "${STARTER_EMULATOR_MODE:-loopback}" == ci-service ]]; then
  PLANNED=(guard "service forwarder" "${PLANNED[@]:1}")
  step "service forwarder" start_forwarder
  log "forwarding ${AWS_ENDPOINT_URL} -> ${STARTER_EMULATOR_SERVICE_ENDPOINT}"
fi

# ── 2. Preflight: health + version, STS identity, socket-less proof ────────────────────────────
EMULATOR_REACHED=true
step preflight emulator_ci preflight --expected-version "$STARTER_MINISTACK_EXPECTED_VERSION" \
  --expected-executor "$EXECUTOR" \
  --timeout-seconds "${STARTER_EMULATOR_HEALTH_TIMEOUT:-90}" --run-id "$RUN_ID" \
  --out "${RUN_DIR}/preflight.json"

# ── 3. Bootstrap, synth, deploy ────────────────────────────────────────────────────────────────
step bootstrap emulator_bootstrap "$RUN_DIR"
synth_and_copy() {
  emulator_synth "$RUN_ID" "${RUN_DIR}/cdk.out" "initial-${RUN_ID}" &&
    cp "${RUN_DIR}/cdk.out/IntegrationWorkflowStack.template.json" "${RUN_DIR}/template.json"
}
step synth synth_and_copy
deploy_initial() {
  emulator_deploy "${RUN_DIR}/cdk.out" "${RUN_DIR}/outputs.json" &&
    require_emulator_target "${RUN_DIR}/outputs.json" &&
    emulator_ci stack-resources --stack "$STACK" --out "${RUN_DIR}/stack-resources.json"
}
DEPLOY_STARTED=true
step deploy deploy_initial

# ── 4. Suite ───────────────────────────────────────────────────────────────────────────────────
if [[ "$SUITE" == cdk ]]; then
  step reconcile emulator_ci reconcile --stack "$STACK" --template "${RUN_DIR}/template.json" \
    --out "${RUN_DIR}/reconciliation.json"
  step "snapshot functions" emulator_ci snapshot --stack "$STACK" \
    --out "${RUN_DIR}/functions-before.json"
  UPDATE_VERSION="update-${RUN_ID}"
  step "synth update" emulator_synth "$RUN_ID" "${RUN_DIR}/cdk.out-update" "$UPDATE_VERSION"
  LAST_ASSEMBLY="${RUN_DIR}/cdk.out-update"
  step "update deploy" emulator_deploy "${RUN_DIR}/cdk.out-update" "${RUN_DIR}/outputs-update.json"
  step "verify update" emulator_ci verify-update --stack "$STACK" \
    --before "${RUN_DIR}/functions-before.json" --app-version "$UPDATE_VERSION" \
    --out "${RUN_DIR}/update.json"
  step "reconcile after update" emulator_ci reconcile --stack "$STACK" \
    --template "${RUN_DIR}/cdk.out-update/IntegrationWorkflowStack.template.json" \
    --out "${RUN_DIR}/reconciliation-after-update.json"
else
  run_suites() {
    (cd "$SUITE_DIR" &&
      AWS_INTEGRATION_ENABLED=true AWS_INTEGRATION_REQUIRED=true AWS_INTEGRATION_TARGET=emulator \
        AWS_INTEGRATION_RUN_ID="$RUN_ID" AWS_INTEGRATION_OUTPUTS="${RUN_DIR}/outputs.json" \
        AWS_INTEGRATION_REPORT_DIR="${RUN_DIR}/report" MINISTACK_IMAGE="$STARTER_MINISTACK_IMAGE" \
        "${PNPM_CMD[@]}" exec vitest run --project aws \
        --reporter=default --reporter=json --reporter=junit \
        --outputFile.json="${RUN_DIR}/report/vitest.json" \
        --outputFile.junit="${RUN_DIR}/report/vitest-junit.xml")
  }
  TESTS_STARTED="$(now_ms)"
  step "workflow suites" run_suites || true
  step "not-applicable governance" node "$RESULTS_CLI" \
    --vitest "${RUN_DIR}/report/vitest.json" \
    --not-applicable "${RUN_DIR}/report/evidence/emulator-not-applicable-assertions.jsonl" \
    --baseline "$BASELINE_FILE" --out "${RUN_DIR}/report" --run-id "$RUN_ID" \
    --duration-seconds "$((($(now_ms) - TESTS_STARTED) / 1000))" || true
fi

# ── 5. Destroy, verify, reset ──────────────────────────────────────────────────────────────────
destroy_and_verify || true
step reset emulator_ci reset --out "${RUN_DIR}/reset.json" || true
[[ $FAILED_STEPS -eq 0 ]]
