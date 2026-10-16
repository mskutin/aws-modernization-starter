#!/usr/bin/env bash
# Shared helpers of the Phase 2 sandbox lifecycle (sourced by bootstrap/up/test/rollback/down/
# verify/all): run identity and local state, account guard, stacks/outputs/context, test identity
# and this lifecycle.
#
# Rules every script follows:
#   - account guard first: sandbox_guard_init, then EVERY AWS mutation as
#     `guarded "<label> [<runId>]" -- <executable…>` through `mut` / `aws_mut` (cdk_sbx,
#     cdk_bootstrap, run_task and the empty_* helpers use them internally). The guard accepts
#     executables only — never pass it a shell function;
#   - read-only AWS calls go through `awsr` (profile and region pinned on the command line too);
#   - secrets (origin-verify value, issuer private key, registry tokens) live only in the run
#     directory (0700/0600) and are never printed;
#   - everything a script prints is also appended to <run dir>/logs/<script>-<UTC>.log.
# shellcheck disable=SC2034  # variables are used by the sourcing scripts

umask 077
# Written for bash 3.2 (macOS /bin/bash): no associative arrays, and arrays that may be empty are
# expanded as ${a[@]+"${a[@]}"} (set -u treats an empty "${a[@]}" as unbound before bash 4.4).

SBX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE_DIR="$(cd "${SBX_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SUITE_DIR}/../.." && pwd)"
INFRA_DIR="${SBX_INFRA_DIR:-${REPO_ROOT}/infra}"

# Region default and rules, shared with the account guard (tools/aws-preflight/scripts/region.sh).
if [[ -f "${REPO_ROOT}/tools/aws-preflight/scripts/region.sh" ]]; then
  # shellcheck source=../../../tools/aws-preflight/scripts/region.sh
  source "${REPO_ROOT}/tools/aws-preflight/scripts/region.sh"
fi

# ── Fixed parameters of the experiment ──────────────────────────────────────
# Region: SANDBOX_REGION, default ap-southeast-1 (STARTER_DEFAULT_REGION of region.sh). Checked in
# sbx_check_region (any aws-partition region; the cost tooling then needs price data for it, and a
# run is always torn down in the region it was deployed to).
SBX_REGION="${SANDBOX_REGION:-${STARTER_DEFAULT_REGION:-}}"
SBX_PROFILE=starter-sandbox-developer
SBX_QUALIFIER=starter
SBX_TOOLKIT_STACK=starter-cdk-toolkit
SBX_STAGE=Sandbox
SBX_RESOURCE_PREFIX=starter-sbx
SBX_EXPERIMENT=live-validation
SBX_AUDIENCE=starter-jobs-api-sandbox
SBX_CLIENT_ID=starter-web-sandbox
SBX_IDP_HOST=127.0.0.1
SBX_IDP_PORT="${SBX_IDP_PORT:-9400}"
SBX_IDP_URL="http://${SBX_IDP_HOST}:${SBX_IDP_PORT}"
# Deploy order; teardown is the reverse.
SBX_STACKS=(Foundation TestIssuer Platform Data Workflow Migrations Api Frontend Observability)
SBX_RUN_ID_RE='^sbx-[0-9a-f]{6}$'

SANDBOX_HOME="${SANDBOX_HOME:-${HOME}/.config/starter-aws-sandbox}"
RUNS_DIR="${SANDBOX_HOME}/runs"
EXPECTED_ACCOUNT_FILE="${SANDBOX_HOME}/expected-account"
# The operator's IAM role ARN (0600): -c operatorPrincipalArn on every app synth (KMS key-policy
# grant for the operator, KeyProbeRole trust). Never printed: it contains the account id.
OPERATOR_ROLE_FILE="${SANDBOX_HOME}/operator-role-arn"
BOOTSTRAP_STATE="${SANDBOX_HOME}/bootstrap.json"
SANDBOX_GUARD_SCRIPT="${SANDBOX_GUARD_SCRIPT:-${REPO_ROOT}/tools/aws-preflight/scripts/sandbox-guard.sh}"

# ── Tools (overridable for the offline self-test; paths must not contain spaces) ─────────────
read -r -a PNPM_CMD <<<"${PNPM:-pnpm}"
read -r -a AWS_CMD <<<"${SBX_AWS_CLI:-aws}"
read -r -a SBX_TOOL_CMD <<<"${SBX_TOOL:-node ${SUITE_DIR}/dist/sandbox/cli.js}"
read -r -a SKOPEO_CMD <<<"${SKOPEO:-skopeo}"
read -r -a PODMAN_CMD <<<"${PODMAN:-podman --connection podman-machine-default}"
read -r -a COSIGN_CMD <<<"${COSIGN:-cosign}"
read -r -a NODE_CMD <<<"${SBX_NODE:-node}"
TEST_IDP_DIST="${SBX_TEST_IDP_DIST:-${REPO_ROOT}/tools/test-idp/dist}"
# The FinOps sandbox tool's executable entry point (dist/cli.js only exports main).
FINOPS_CLI="${SBX_FINOPS_CLI:-${REPO_ROOT}/tools/aws-sandbox/dist/bin.js}"
SMOKE_CLI="${SBX_SMOKE_CLI:-${REPO_ROOT}/tests/smoke/dist/cli.js}"
export AWS_PAGER=""
export CDK_DISABLE_CLI_TELEMETRY=true
# log-follow (sbx-tool) runs `aws logs filter-log-events` with this pinned command line.
export SBX_AWS="${AWS_CMD[*]} --profile ${SBX_PROFILE} --region ${SBX_REGION} --no-cli-pager"

SBX_SCRIPT="$(basename "${BASH_SOURCE[1]:-sandbox}" .sh)"
RUN_ID=""
RUN_DIR=""
EXPECTED_ACCOUNT=""
OPERATOR_ARN=""
CURRENT_STEP=""
STEP_T0=0

sbx_log() { printf '[sandbox %s %s] %s\n' "$SBX_SCRIPT" "$(date -u +%H:%M:%SZ)" "$*" >&2; }
sbx_warn() { sbx_log "WARNING: $*"; }
sbx_die() {
  sbx_log "ERROR: $1"
  exit "${2:-1}"
}
mask_account() { printf '********%s' "${1: -4}"; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

tool() { "${SBX_TOOL_CMD[@]}" "$@"; }

# ── Expected account and guard ────────────────────────────────────────────────────────────────
load_expected_account() {
  [[ -f "$EXPECTED_ACCOUNT_FILE" ]] ||
    sbx_die "no expected account: ${EXPECTED_ACCOUNT_FILE} is missing — refusing" 4
  EXPECTED_ACCOUNT="$(tr -d ' \t\r\n' <"$EXPECTED_ACCOUNT_FILE")"
  [[ "$EXPECTED_ACCOUNT" =~ ^[0-9]{12}$ ]] ||
    sbx_die "${EXPECTED_ACCOUNT_FILE} does not hold a 12-digit account id — refusing" 4
}

# file_mode <file> — octal permission bits (GNU and BSD/macOS stat; see scripts/_file-mode.sh).
# shellcheck source=../scripts/_file-mode.sh
source "${SUITE_DIR}/scripts/_file-mode.sh"

load_operator_arn() {
  [[ -f "$OPERATOR_ROLE_FILE" ]] || sbx_die "${OPERATOR_ROLE_FILE} is missing (the operator's role ARN) — refusing" 4
  local mode
  mode="$(file_mode "$OPERATOR_ROLE_FILE")" || sbx_die "cannot read the mode of ${OPERATOR_ROLE_FILE} — refusing" 4
  [[ "$mode" == 600 || "$mode" == 400 ]] || sbx_die "${OPERATOR_ROLE_FILE} has mode ${mode}; it must be 0600 — refusing" 4
  OPERATOR_ARN="$(tr -d ' \t\r\n' <"$OPERATOR_ROLE_FILE")"
  [[ "$OPERATOR_ARN" =~ ^arn:aws[a-z-]*:iam::([0-9]{12}):role/[A-Za-z0-9+=,.@_/-]+$ ]] ||
    sbx_die "${OPERATOR_ROLE_FILE} does not hold an IAM role ARN — refusing" 4
  [[ "${BASH_REMATCH[1]}" == "$EXPECTED_ACCOUNT" ]] ||
    sbx_die "the operator role in ${OPERATOR_ROLE_FILE} is not in the expected account — refusing" 4
}

# Refuses (exit 4) a region that is not an aws-partition region name, and a run whose recorded
# region (run.env REGION, written by up.sh) is not SBX_REGION.
sbx_check_region() {
  declare -F starter_region_ok >/dev/null || sbx_die "tools/aws-preflight/scripts/region.sh is missing — refusing" 4
  starter_region_ok "$SBX_REGION" || sbx_die "SANDBOX_REGION is not an aws-partition region name — refusing" 4
  if [[ -n "${RUN_DIR:-}" ]]; then
    local recorded
    recorded="$(run_env_get REGION)"
    [[ -z "$recorded" || "$recorded" == "$SBX_REGION" ]] ||
      sbx_die "run ${RUN_ID} was deployed in ${recorded}, not ${SBX_REGION}: set SANDBOX_REGION=${recorded} — refusing" 4
  fi
}

# Initialises the account guard (once per script, after the run directory is known).
guard_init() {
  sbx_check_region
  load_expected_account
  load_operator_arn
  [[ -f "$SANDBOX_GUARD_SCRIPT" ]] || sbx_die "account guard not found: ${SANDBOX_GUARD_SCRIPT}" 4
  export SANDBOX_HOME
  export SANDBOX_PROFILE="$SBX_PROFILE" SANDBOX_REGION="$SBX_REGION"
  export SANDBOX_EXPECTED_ACCOUNT_FILE="$EXPECTED_ACCOUNT_FILE"
  export SANDBOX_GUARD_LOG="${SANDBOX_GUARD_LOG:-${RUN_DIR:-${SANDBOX_HOME}}/guard.log}"
  # shellcheck source=/dev/null
  source "$SANDBOX_GUARD_SCRIPT"
  sandbox_guard_init || sbx_die "the account guard refused to initialise" 4
  sbx_log "account guard initialised: profile ${SBX_PROFILE}, region ${SBX_REGION}, account $(mask_account "$EXPECTED_ACCOUNT")"
}

# mut "<label>" <executable> [args…] — the ONLY way a script runs a mutation: the guard's STS
# check right before the command (any refusal exits the script), then the executable. The guard
# writes its own output to stderr, so `x="$(mut …)"` and `mut … >file` capture only the command's
# output (a plain assignment under set -e: a refusal then fails the assignment).
mut() {
  local label="$1"
  shift
  # Labels are logged: never an account id (e.g. inside a bootstrap bucket name).
  label="$(printf '%s' "$label" | sed -E 's/[0-9]{12}/<account>/g')"
  guarded "${label} [${RUN_ID:-account}]" -- "$@"
}

# Read-only AWS call, profile and region pinned.
awsr() { "${AWS_CMD[@]}" --profile "$SBX_PROFILE" --region "$SBX_REGION" --no-cli-pager "$@"; }
# aws_mut "<label>" <aws args…> — a mutating AWS CLI call through the guard.
aws_mut() {
  local label="$1"
  shift
  mut "$label" "${AWS_CMD[@]}" --profile "$SBX_PROFILE" --region "$SBX_REGION" --no-cli-pager "$@"
}

# ── Run identity and directory ──────────────────────────────────────────────────
new_run_id() { printf 'sbx-%s' "$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"; }

set_run() {
  RUN_ID="$1"
  [[ "$RUN_ID" =~ $SBX_RUN_ID_RE ]] || sbx_die "invalid run id '${RUN_ID}' (expected sbx-<6 hex>)" 2
  RUN_DIR="${RUNS_DIR}/${RUN_ID}"
}

# Resolves the run from SBX_RUN_ID, else the `current` link. Returns 1 if none is known.
resolve_run() {
  local id="${SBX_RUN_ID:-}"
  if [[ -z "$id" && -L "${RUNS_DIR}/current" ]]; then
    id="$(basename "$(readlink "${RUNS_DIR}/current")")"
  fi
  [[ -n "$id" ]] || return 1
  set_run "$id"
}

ensure_run_dir() {
  mkdir -p "$RUNS_DIR"
  chmod 700 "$SANDBOX_HOME" "$RUNS_DIR" 2>/dev/null || true
  mkdir -p "$RUN_DIR"/{logs,state,cdk-outputs,tasks}
  chmod 700 "$RUN_DIR"
}

set_current_run() { ln -sfn "$RUN_ID" "${RUNS_DIR}/current"; }

# Mirrors everything the script prints into the run directory.
start_logging() {
  local log
  log="${RUN_DIR}/logs/${SBX_SCRIPT}-$(date -u +%Y%m%dT%H%M%SZ).log"
  exec > >(tee -a "$log") 2>&1
  sbx_log "run ${RUN_ID}: log ${log}"
}

run_env_get() {
  local key="$1"
  [[ -f "${RUN_DIR}/run.env" ]] || return 0
  sed -n "s/^${key}=//p" "${RUN_DIR}/run.env" | tail -n 1
}

run_env_set() {
  local key="$1" value="$2" file="${RUN_DIR}/run.env"
  [[ "$value" != *$'\n'* ]] || sbx_die "run.env value for ${key} contains a newline"
  touch "$file"
  { grep -v "^${key}=" "$file" || true; } >"${file}.tmp"
  printf '%s=%s\n' "$key" "$value" >>"${file}.tmp"
  mv "${file}.tmp" "$file"
}

# ── Steps: idempotent, timed, recorded in steps.jsonl ─────────────────────────────────────────
# step <name> <function> [args…]: skipped when <run dir>/state/<name>.done exists, unless the name
# is listed in SBX_FORCE_STEPS (comma-separated). A failing step exits the script (set -e); the
# EXIT handler records it as failed.
step() {
  local name="$1"
  shift
  if [[ -f "${RUN_DIR}/state/${name}.done" && ",${SBX_FORCE_STEPS:-}," != *",${name},"* ]]; then
    sbx_log "step ${name}: done earlier ($(<"${RUN_DIR}/state/${name}.done")) — skipped"
    return 0
  fi
  CURRENT_STEP="$name"
  STEP_T0="$(date +%s)"
  sbx_log "step ${name}: start"
  "$@"
  local t1
  t1="$(date +%s)"
  now_iso >"${RUN_DIR}/state/${name}.done"
  printf '{"script":"%s","step":"%s","status":"done","startedAt":%s,"durationSeconds":%s}\n' \
    "$SBX_SCRIPT" "$name" "$STEP_T0" "$((t1 - STEP_T0))" >>"${RUN_DIR}/steps.jsonl"
  sbx_log "step ${name}: done in $((t1 - STEP_T0))s"
  CURRENT_STEP=""
}

# EXIT handler part: records an interrupted/failed step.
record_failed_step() {
  local rc="$1"
  if [[ -n "$CURRENT_STEP" && -n "$RUN_DIR" && -d "$RUN_DIR" ]]; then
    printf '{"script":"%s","step":"%s","status":"failed","exitCode":%s,"startedAt":%s,"durationSeconds":%s}\n' \
      "$SBX_SCRIPT" "$CURRENT_STEP" "$rc" "$STEP_T0" "$(($(date +%s) - STEP_T0))" >>"${RUN_DIR}/steps.jsonl"
    sbx_log "step ${CURRENT_STEP}: FAILED (exit ${rc})"
  fi
}

# ── Stacks, CDK and outputs ─────────────────────────────────────────────────────
cfn_name() { printf '%s-%s' "$SBX_STAGE" "$1"; }

# cdk_sbx <deploy|destroy> <Stack> [extra cdk args…] — one stack, exclusively, with the run's
# context (the same for every deploy of the run, from run.env), through the guard. The
# origin-verify value is passed as a FILE (-c originVerifySecretFile, 0600), never on the command
# line; the synthesized assembly (whose templates contain it) goes to the run directory, never to
# infra/cdk.out. A deploy adds -c requireDeployInputs=true: the app then refuses any placeholder
# (account, run id, expiry, image digest, secret). Destroy works without the run's secrets.
cdk_sbx() {
  local sub="$1" stack="$2"
  shift 2
  local secret_file="${RUN_DIR}/origin-verify"
  [[ -n "$OPERATOR_ARN" ]] || sbx_die "cdk ${sub}: no operator role ARN (guard_init not called)" 70
  local ctx=(
    -c envs=sandbox
    -c "account.sandbox=${EXPECTED_ACCOUNT}"
    -c "region.sandbox=${SBX_REGION}"
    -c "runId=${RUN_ID}"
    -c "operatorPrincipalArn=${OPERATOR_ARN}"
  )
  local v
  for v in APP_VERSION:appVersion EXPIRES_AT:expiresAt IMAGE_DIGEST:apiImageDigest \
    RESERVED_CONCURRENCY:sandbox.reservedConcurrency ORIGIN_PREFIX_LIST_ID:sandbox.originPrefixListId \
    MASTER_SECRET_ROTATION:sandbox.masterSecretRotation; do
    local value
    value="$(run_env_get "${v%%:*}")"
    [[ -n "$value" ]] && ctx+=(-c "${v#*:}=${value}")
  done
  if [[ -s "$secret_file" ]]; then
    ctx+=(-c "originVerifySecretFile=${secret_file}")
  elif [[ "$sub" == deploy ]]; then
    sbx_die "cdk deploy: ${secret_file} is missing"
  fi
  local extra=(--profile "$SBX_PROFILE" --output "${RUN_DIR}/cdk.out")
  case "$sub" in
    deploy)
      [[ -n "$(run_env_get IMAGE_DIGEST)" ]] || sbx_die "cdk deploy: no API image digest selected yet"
      ctx+=(-c requireDeployInputs=true)
      extra+=(--require-approval never --progress events --toolkit-stack-name "$SBX_TOOLKIT_STACK"
        --outputs-file "${RUN_DIR}/cdk-outputs/$(cfn_name "$stack").json")
      ;;
    destroy) extra+=(--force) ;;
    *) sbx_die "cdk_sbx: unsupported subcommand ${sub}" 70 ;;
  esac
  (
    cd "$INFRA_DIR" || exit 1
    mut "cdk ${sub} $(cfn_name "$stack")" \
      "${PNPM_CMD[@]}" exec cdk "$sub" "${SBX_STAGE}/${stack}" --exclusively "${ctx[@]}" "${extra[@]}" "$@"
  )
}

deploy_stack() { cdk_sbx deploy "$1"; }

# <run dir>/outputs.json from describe-stacks. refresh_outputs: every sandbox stack (rebuilt, so
# deleted stacks disappear); refresh_stack_outputs <Stack…>: those stacks, merged into the file.
refresh_outputs() { _refresh_outputs rebuild "${SBX_STACKS[@]}"; }
refresh_stack_outputs() { _refresh_outputs merge "$@"; }
_refresh_outputs() {
  local mode="$1" dir="${RUN_DIR}/describe-stacks" files=() s merge=()
  shift
  mkdir -p "$dir"
  if [[ "$mode" == merge && -f "${RUN_DIR}/outputs.json" ]]; then
    merge=(--merge "${RUN_DIR}/outputs.json")
  fi
  for s in "$@"; do
    if awsr cloudformation describe-stacks --stack-name "$(cfn_name "$s")" --output json \
      >"${dir}/${s}.json" 2>/dev/null; then
      files+=("${dir}/${s}.json")
    else
      rm -f "${dir}/${s}.json"
    fi
  done
  if ((${#files[@]} == 0 && ${#merge[@]} == 0)); then
    printf '{}\n' >"${RUN_DIR}/outputs.json"
  elif ((${#files[@]} > 0)); then
    tool outputs-from-stacks --out "${RUN_DIR}/outputs.json" ${merge[@]+"${merge[@]}"} "${files[@]}"
  fi
}

# out <Stack> <OutputKey> — a stack output of this run (dies when missing).
out() {
  local v
  v="$(tool output "${RUN_DIR}/outputs.json" "$(cfn_name "$1")" "$2")" ||
    sbx_die "stack output $(cfn_name "$1").$2 not available (deployed? see ${RUN_DIR}/outputs.json)"
  printf '%s' "$v"
}

# out_opt <Stack> <OutputKey> — the output, or nothing when the stack does not define it.
out_opt() { tool output "${RUN_DIR}/outputs.json" "$(cfn_name "$1")" "$2" 2>/dev/null || true; }

# ── One-off ECS tasks (bootstrap, migrations, DB probes) ──────────────────────────────────────
# run_task <name> <task definition> [overrides file] [security group] — Fargate task in the task
# subnets with the given security group (default: TaskSecurityGroupId of the Migrations stack, the
# migration task's PostgreSQL + HTTPS group); waits (bounded) until it stops; keeps run-task,
# describe-tasks, the task definition and the container's log events under
# <run dir>/tasks/<name>-<UTC>/. Sets TASK_DIR, TASK_ARN, TASK_EXIT_CODE, TASK_STOPPED_REASON, TASK_LOGS.
run_task() {
  local name="$1" td="$2" overrides="${3:-}" sg="${4:-}"
  TASK_DIR="${RUN_DIR}/tasks/${name}-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$TASK_DIR"
  local cluster subnets
  cluster="$(out Platform ClusterName)"
  subnets="$(out Migrations TaskSubnetIds | tr -d '[]" ')"
  [[ -n "$sg" ]] || sg="$(out Migrations TaskSecurityGroupId)"
  local args=(ecs run-task --cluster "$cluster" --task-definition "$td" --launch-type FARGATE --count 1
    --network-configuration "awsvpcConfiguration={subnets=[${subnets}],securityGroups=[${sg}],assignPublicIp=DISABLED}"
    --started-by "${RUN_ID}-${name}" --propagate-tags TASK_DEFINITION --output json)
  [[ -n "$overrides" ]] && args+=(--overrides "file://${overrides}")
  aws_mut "ecs run-task ${name}" "${args[@]}" >"${TASK_DIR}/run-task.json"
  TASK_ARN="$(tool json-get "${TASK_DIR}/run-task.json" tasks.0.taskArn)" ||
    sbx_die "run-task ${name} started no task (see ${TASK_DIR}/run-task.json)"
  sbx_log "task ${name}: ${TASK_ARN##*/} started; waiting for it to stop"
  local limit="${SBX_TASK_DEADLINE_SECONDS:-1200}" status
  local deadline=$((SECONDS + limit))
  while :; do
    awsr ecs describe-tasks --cluster "$cluster" --tasks "$TASK_ARN" --output json >"${TASK_DIR}/describe-tasks.json"
    status="$(tool json-get "${TASK_DIR}/describe-tasks.json" tasks.0.lastStatus || echo UNKNOWN)"
    [[ "$status" == STOPPED ]] && break
    ((SECONDS < deadline)) || sbx_die "task ${name} still ${status} after ${limit}s"
    sleep "${SBX_POLL_SECONDS:-10}"
  done
  TASK_EXIT_CODE="$(tool json-get "${TASK_DIR}/describe-tasks.json" tasks.0.containers.0.exitCode || echo none)"
  TASK_STOPPED_REASON="$(tool json-get "${TASK_DIR}/describe-tasks.json" tasks.0.stoppedReason || echo -)"
  awsr ecs describe-task-definition --task-definition "$td" --output json >"${TASK_DIR}/task-definition.json"
  local group prefix cname stream
  cname="$(tool json-get "${TASK_DIR}/task-definition.json" taskDefinition.containerDefinitions.0.name)"
  group="$(tool json-get "${TASK_DIR}/task-definition.json" 'taskDefinition.containerDefinitions.0.logConfiguration.options[awslogs-group]')"
  prefix="$(tool json-get "${TASK_DIR}/task-definition.json" 'taskDefinition.containerDefinitions.0.logConfiguration.options[awslogs-stream-prefix]')"
  stream="${prefix}/${cname}/${TASK_ARN##*/}"
  TASK_LOGS="${TASK_DIR}/logs.json"
  # awslogs delivers a few seconds after the container stopped: poll (bounded) for the events.
  local log_deadline=$((SECONDS + ${SBX_TASK_LOG_DEADLINE_SECONDS:-180}))
  until awsr logs filter-log-events --log-group-name "$group" --log-stream-names "$stream" \
    --output json >"$TASK_LOGS" 2>/dev/null && tool json-get "$TASK_LOGS" events.0.message >/dev/null 2>&1; do
    if ((SECONDS >= log_deadline)); then
      sbx_warn "no log events for task ${name} in ${group} ${stream}"
      break
    fi
    sleep "${SBX_POLL_SECONDS:-10}"
  done
  printf '{"name":"%s","taskArn":"%s","exitCode":"%s","logGroup":"%s","logStream":"%s"}\n' \
    "$name" "$TASK_ARN" "$TASK_EXIT_CODE" "$group" "$stream" >"${TASK_DIR}/summary.json"
  sbx_log "task ${name}: exit ${TASK_EXIT_CODE} (${TASK_STOPPED_REASON}); logs ${TASK_LOGS}"
}

# ── Local test IdP ──────────────────────────────────────────────────────────────
idp_running() {
  local pid
  [[ -f "${RUN_DIR}/idp.pid" ]] || return 1
  pid="$(<"${RUN_DIR}/idp.pid")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  # Never signal a recycled pid: it must still be the test IdP of this run. (No `ps | grep -q`:
  # under pipefail an early grep exit fails the pipeline through SIGPIPE.)
  local cmd
  cmd="$(ps -o command= -p "$pid" 2>/dev/null)" || return 1
  [[ "$cmd" == *server.js* ]]
}

idp_stop() {
  if idp_running; then
    local pid
    pid="$(<"${RUN_DIR}/idp.pid")"
    sbx_log "stopping the local test IdP (pid ${pid})"
    kill -TERM "$pid" 2>/dev/null || true
    local i
    for i in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
  fi
  rm -f "${RUN_DIR}/idp.pid"
}

# idp_start <redirect uri> — (re)starts the local IdP with the run's key and issuer.
idp_start() {
  local redirect="$1" issuer key
  issuer="$(run_env_get ISSUER_URL)"
  key="${RUN_DIR}/issuer-key.jwk"
  [[ -n "$issuer" && -s "$key" ]] || sbx_die "idp_start: issuer URL or key missing (run up.sh)"
  idp_stop
  if curl -fsS --max-time 2 "${SBX_IDP_URL}/.well-known/openid-configuration" >/dev/null 2>&1; then
    sbx_die "something else already listens on ${SBX_IDP_URL} — stop it first"
  fi
  sbx_log "starting the local test IdP on ${SBX_IDP_URL} (issuer ${issuer}, redirect ${redirect})"
  # `&` must background node ITSELF (not a subshell around it): the pid file then names the IdP,
  # and no background shell keeps this script's log pipe open.
  (
    cd "$REPO_ROOT" || exit 1
    APP_RUNTIME=local \
      TEST_IDP_HOST="$SBX_IDP_HOST" \
      TEST_IDP_PORT="$SBX_IDP_PORT" \
      TEST_IDP_ISSUER="$issuer" \
      TEST_IDP_SIGNING_KEY_FILE="$key" \
      TEST_IDP_AUDIENCE="$SBX_AUDIENCE" \
      TEST_IDP_CLIENT_ID="$SBX_CLIENT_ID" \
      TEST_IDP_REDIRECT_URIS="$redirect" \
      TEST_IDP_ENABLE_TEST_ENDPOINTS=true \
      nohup "${NODE_CMD[@]}" "${TEST_IDP_DIST}/server.js" </dev/null >>"${RUN_DIR}/idp.log" 2>&1 &
    echo $! >"${RUN_DIR}/idp.pid"
  )
  local deadline=$((SECONDS + 30)) body
  until body="$(curl -fsS --max-time 2 "${SBX_IDP_URL}/.well-known/openid-configuration" 2>/dev/null)" &&
    [[ "$body" == *"\"issuer\":\"${issuer}\""* ]]; do
    ((SECONDS < deadline)) || sbx_die "the local test IdP did not become ready (see ${RUN_DIR}/idp.log)"
    idp_running || sbx_die "the local test IdP exited (see ${RUN_DIR}/idp.log)"
    sleep 0.5
  done
  run_env_set IDP_REDIRECT_URI "$redirect"
  sbx_log "local test IdP ready (pid $(<"${RUN_DIR}/idp.pid"))"
}

# ── Results (every result recorded; never a pass for something that did not run) ─
# result <results file> <check> <name> <status> <evidence> [detail]
result() {
  local file="$1" check="$2" name="$3" status="$4" evidence="$5" detail="${6:-}"
  local args=(results-add --results "$file" --check "$check" --name "$name" --status "$status" --evidence "$evidence")
  [[ -n "$detail" ]] && args+=(--detail "$detail")
  tool "${args[@]}"
}

# Removes temporary credentials of registry logins (called from EXIT handlers).
cleanup_registry_auth() {
  [[ -n "$RUN_DIR" ]] || return 0
  rm -f "${RUN_DIR}/.ecr-auth.json" "${RUN_DIR}/.docker/config.json" 2>/dev/null || true
}

# Deletes every object version and delete marker of a bucket (each delete through the guard).
# `aws s3 rm --recursive` would leave the versions of a versioned bucket behind.
empty_bucket_versions() {
  local bucket="$1" tmp n
  tmp="$(mktemp -d "${RUN_DIR}/.s3-XXXXXX")"
  for _ in $(seq 1 1000); do
    awsr s3api list-object-versions --bucket "$bucket" --max-items 1000 --output json >"${tmp}/list.json"
    n="$(tool s3-delete-payload --in "${tmp}/list.json" --out "${tmp}/delete.json")"
    ((n > 0)) || break
    aws_mut "delete object versions in ${bucket}" s3api delete-objects --bucket "$bucket" \
      --delete "file://${tmp}/delete.json" --output json >/dev/null
    sbx_log "deleted ${n} object version(s) from s3://${bucket}"
  done
  rm -rf "$tmp"
}

# delete_ecr_repository <repo> — deletes one of OUR repositories with its images (`--force`;
# the permission set has ecr:DeleteRepository but not ecr:BatchDeleteImage).
delete_ecr_repository() {
  local repo="$1"
  awsr ecr describe-repositories --repository-names "$repo" >/dev/null 2>&1 || return 0
  aws_mut "delete ECR repository ${repo}" ecr delete-repository --repository-name "$repo" --force \
    --output json >/dev/null
}

# ECR login into a private auth file (token via stdin only). Prints the registry host.
ecr_login() {
  local registry="$1"
  printf '{}' >"${RUN_DIR}/.ecr-auth.json"
  awsr ecr get-login-password |
    "${SKOPEO_CMD[@]}" login --authfile "${RUN_DIR}/.ecr-auth.json" --username AWS --password-stdin "$registry" >/dev/null
}
