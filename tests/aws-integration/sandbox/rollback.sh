#!/usr/bin/env bash
# shellcheck disable=SC2329  # functions run via trap / run_check are reported as never invoked
# Phase 2: ECS deployment circuit-breaker rollback, observed live.
#
#   SBX_RUN_ID=sbx-1a2b3c tests/aws-integration/sandbox/rollback.sh   (default: the current run)
#
#  1. baseline   the service's current task definition must be settled (one COMPLETED deployment,
#                running = desired) and the API healthy through CloudFront; its image digest is
#                the baseline digest;
#  2. unhealthy  `FROM <api>@<baseline digest>` with a CMD that exits 1, made from an OCI layout
#                copy (no container engine), pushed to ECR by digest;
#  3. revision   a new task-definition revision with that image (tagged starter:rollback-test);
#  4. deploy     `ecs update-service` to it;
#  5. observe    describe-services every SBX_POLL_SECONDS until the circuit breaker failed the
#                deployment and ECS is back on the baseline (deadline SBX_ROLLBACK_DEADLINE_SECONDS);
#                deployments, events, alarm states and timings are recorded;
#  6. verify     the service runs the baseline revision at full count, the running containers
#                carry the baseline digest, the API is healthy and the smoke passes through
#                CloudFront. If ECS did not roll back, the script restores the baseline itself
#                (and the check FAILS). The service is always left on the healthy revision.
# Exit: 0 rollback observed and verified, 1 otherwise, 4 refused.
set -euo pipefail
# shellcheck source=_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

resolve_run || sbx_die "no run: set SBX_RUN_ID or run up.sh first" 2
[[ -d "$RUN_DIR" ]] || sbx_die "run directory ${RUN_DIR} is missing" 2
RB_DIR="${RUN_DIR}/rollback-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "${RB_DIR}/snapshots"
ln -sfn "$(basename "$RB_DIR")" "${RUN_DIR}/rollback-latest"
RESULTS="${RB_DIR}/results.jsonl"
: >"$RESULTS"
start_logging
BASE_TD=""
NEW_TD=""
RESTORED=false
on_exit() {
  local rc=$?
  record_failed_step "$rc"
  cleanup_registry_auth
  # Never leave the service on the unhealthy revision.
  if [[ -n "$NEW_TD" && -n "$BASE_TD" ]] && ! $RESTORED; then
    local current
    current="$(awsr ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
      --query 'services[0].taskDefinition' --output text 2>/dev/null || echo unknown)"
    if [[ "$current" != "$BASE_TD" ]]; then
      sbx_warn "the service is on ${current##*/}; restoring the baseline ${BASE_TD##*/}"
      aws_mut "update-service back to the baseline (exit handler)" ecs update-service --cluster "$CLUSTER" \
        --service "$SERVICE" --task-definition "$BASE_TD" --output json >"${RB_DIR}/restore.json" || true
    fi
  fi
  exit "$rc"
}
trap on_exit EXIT
guard_init
refresh_outputs

CLUSTER="$(out Platform ClusterName)"
SERVICE="$(out Api ServiceName)"
CF="https://$(out Frontend DistributionDomainName)"
REPO_URI="$(out Platform ApiRepositoryUri)"
EV="$(basename "$RB_DIR")"

describe_service() { awsr ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json >"$1"; }

# ── 1. baseline ───────────────────────────────────────────────────────────────────────────────
CURRENT_STEP=baseline
STEP_T0="$(date +%s)"
describe_service "${RB_DIR}/service-before.json"
BASE_TD="$(tool json-get "${RB_DIR}/service-before.json" services.0.taskDefinition)"
deployments="$(tool json-get "${RB_DIR}/service-before.json" services.0.deployments.length || echo 0)"
rollout="$(tool json-get "${RB_DIR}/service-before.json" services.0.deployments.0.rolloutState || echo unknown)"
running="$(tool json-get "${RB_DIR}/service-before.json" services.0.runningCount || echo 0)"
desired="$(tool json-get "${RB_DIR}/service-before.json" services.0.desiredCount || echo -1)"
[[ "$deployments" == 1 && "$rollout" == COMPLETED && "$running" == "$desired" ]] ||
  sbx_die "the service is not settled (deployments ${deployments}, rollout ${rollout}, running ${running}/${desired}); not starting the experiment"
awsr ecs describe-task-definition --task-definition "$BASE_TD" --include TAGS --output json >"${RB_DIR}/baseline-task-definition.json"
CONTAINER="$(tool json-get "${RB_DIR}/baseline-task-definition.json" taskDefinition.containerDefinitions.0.name)"
BASE_IMAGE="$(tool json-get "${RB_DIR}/baseline-task-definition.json" taskDefinition.containerDefinitions.0.image)"
BASE_DIGEST="${BASE_IMAGE##*@}"
[[ "$BASE_DIGEST" == sha256:* ]] || sbx_die "the baseline image is not pinned by digest: ${BASE_IMAGE}"
tool health-check --base-url "$CF" --deadline-ms 120000 --results "$RESULTS" --check rollback-baseline \
  --evidence "${EV}/results.jsonl" || sbx_die "the API is not healthy before the experiment"
sbx_log "baseline: ${BASE_TD##*/} with ${BASE_DIGEST}"
CURRENT_STEP=""

# ── 2. unhealthy image ────────────────────────────────────────────────────────────────────────
CURRENT_STEP=unhealthy-image
STEP_T0="$(date +%s)"
ecr_login "${REPO_URI%%/*}"
rm -rf "${RB_DIR}/oci"
# Reading from ECR is read-only.
"${SKOPEO_CMD[@]}" copy --src-authfile "${RUN_DIR}/.ecr-auth.json" \
  "docker://${REPO_URI}@${BASE_DIGEST}" "oci:${RB_DIR}/oci:healthy" >/dev/null
UNHEALTHY_DIGEST="$(tool unhealthy-image --layout "${RB_DIR}/oci" --from healthy --to unhealthy)"
mut "push the deliberately unhealthy image" "${SKOPEO_CMD[@]}" copy --preserve-digests \
  --dest-authfile "${RUN_DIR}/.ecr-auth.json" --digestfile "${RB_DIR}/unhealthy.digest" \
  "oci:${RB_DIR}/oci:unhealthy" "docker://${REPO_URI}:unhealthy-${RUN_ID}-$(date -u +%H%M%S)"
cleanup_registry_auth
pushed="$(tr -d ' \n' <"${RB_DIR}/unhealthy.digest")"
[[ "$pushed" == "$UNHEALTHY_DIGEST" ]] || sbx_die "pushed digest ${pushed} != built ${UNHEALTHY_DIGEST}"
run_env_set ROLLBACK_IMAGE_DIGESTS "$(run_env_get ROLLBACK_IMAGE_DIGESTS) ${pushed}"
CURRENT_STEP=""

# ── 3. task-definition revision ───────────────────────────────────────────────────────────────
CURRENT_STEP=register-revision
STEP_T0="$(date +%s)"
tool taskdef-clone --in "${RB_DIR}/baseline-task-definition.json" --image "${REPO_URI}@${UNHEALTHY_DIGEST}" \
  --container "$CONTAINER" --tag starter:rollback-test=unhealthy --out "${RB_DIR}/unhealthy-task-definition.json"
NEW_TD="$(aws_mut "register the unhealthy task-definition revision" ecs register-task-definition \
  --cli-input-json "file://${RB_DIR}/unhealthy-task-definition.json" \
  --query taskDefinition.taskDefinitionArn --output text)"
[[ "$NEW_TD" == arn:* ]] || sbx_die "register-task-definition returned no ARN"
# down.sh deregisters and deletes this revision (CloudFormation does not know it).
run_env_set ROLLBACK_TASKDEF_ARNS "$(run_env_get ROLLBACK_TASKDEF_ARNS) ${NEW_TD}"
sbx_log "unhealthy revision ${NEW_TD##*/} (${UNHEALTHY_DIGEST})"
CURRENT_STEP=""

# ── 4. deploy it ──────────────────────────────────────────────────────────────────────────────
T_UPDATE="$(now_iso)"
T_UPDATE_S="$(date +%s)"
aws_mut "update-service to the unhealthy revision" ecs update-service --cluster "$CLUSTER" \
  --service "$SERVICE" --task-definition "$NEW_TD" --output json >"${RB_DIR}/update-service.json"

# ── 5. observe ────────────────────────────────────────────────────────────────────────────────
CURRENT_STEP=observe
STEP_T0="$(date +%s)"
phase=waiting
n=0
deadline=$((SECONDS + ${SBX_ROLLBACK_DEADLINE_SECONDS:-1800}))
while :; do
  n=$((n + 1))
  snap="${RB_DIR}/snapshots/$(printf '%03d' "$n").json"
  if describe_service "$snap"; then
    phase="$(tool rollback-observe --snapshot "$snap" --baseline "$BASE_TD" --target "$NEW_TD" \
      --state "${RB_DIR}/rollout-state.json" --since "$T_UPDATE" --events "${RB_DIR}/service-events.json")"
    sbx_log "t+$(($(date +%s) - T_UPDATE_S))s: ${phase}"
  fi
  [[ "$phase" == rolled-back || "$phase" == target-serving ]] && break
  ((SECONDS < deadline)) || break
  sleep "${SBX_POLL_SECONDS:-15}"
done
T_END_S="$(date +%s)"
awsr cloudwatch describe-alarms --alarm-name-prefix "${SBX_RESOURCE_PREFIX}-api" --output json \
  >"${RB_DIR}/alarms.json" || true
awsr cloudwatch describe-alarm-history --alarm-name "${SBX_RESOURCE_PREFIX}-api-deployment-target-5xx" \
  --start-date "$T_UPDATE" --output json >"${RB_DIR}/alarm-history.json" || true
CURRENT_STEP=""

reason="$(tool json-get "${RB_DIR}/rollout-state.json" targetRolloutStateReason || echo -)"
failed_tasks="$(tool json-get "${RB_DIR}/rollout-state.json" targetFailedTasks || echo -)"
seen_failed="$(tool json-get "${RB_DIR}/rollout-state.json" seen.targetFailed || echo -)"
seen_back="$(tool json-get "${RB_DIR}/rollout-state.json" seen.rolledBack || echo -)"
detail="phase ${phase} after $((T_END_S - T_UPDATE_S))s; failed tasks ${failed_tasks}; target FAILED seen ${seen_failed}; rolled back seen ${seen_back}; reason: ${reason}"
if [[ "$phase" == rolled-back ]]; then
  result "$RESULTS" rollback "ECS circuit breaker failed the unhealthy deployment and rolled back to the baseline revision" \
    passed "${EV}/rollout-state.json" "$detail"
  RESTORED=true
else
  result "$RESULTS" rollback "ECS circuit breaker failed the unhealthy deployment and rolled back to the baseline revision" \
    failed "${EV}/rollout-state.json" "$detail"
  sbx_warn "no automatic rollback observed (${phase}); restoring the baseline"
  aws_mut "update-service back to the baseline" ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
    --task-definition "$BASE_TD" --output json >"${RB_DIR}/restore.json"
  RESTORED=true
  awsr ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" ||
    sbx_warn "the service did not report stable within the waiter's limit"
fi

# ── 6. verify the service serves the baseline ────────────────────────────────────────────────
describe_service "${RB_DIR}/service-after.json"
after_td="$(tool json-get "${RB_DIR}/service-after.json" services.0.taskDefinition || echo unknown)"
after_running="$(tool json-get "${RB_DIR}/service-after.json" services.0.runningCount || echo 0)"
after_desired="$(tool json-get "${RB_DIR}/service-after.json" services.0.desiredCount || echo -1)"
if [[ "$after_td" == "$BASE_TD" && "$after_running" == "$after_desired" ]]; then
  result "$RESULTS" rollback "after the experiment the service runs the baseline revision at full count" passed \
    "${EV}/service-after.json" "${after_td##*/} running ${after_running}/${after_desired}"
else
  result "$RESULTS" rollback "after the experiment the service runs the baseline revision at full count" failed \
    "${EV}/service-after.json" "${after_td##*/} running ${after_running}/${after_desired}"
fi
awsr ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --desired-status RUNNING \
  --query 'taskArns' --output text >"${RB_DIR}/running-tasks.txt"
digests_ok=false
if [[ -s "${RB_DIR}/running-tasks.txt" ]]; then
  # shellcheck disable=SC2046  # task ARNs contain no spaces
  awsr ecs describe-tasks --cluster "$CLUSTER" --tasks $(tr '\t' ' ' <"${RB_DIR}/running-tasks.txt") \
    --output json >"${RB_DIR}/running-tasks.json"
  if ! grep -o '"imageDigest": *"sha256:[a-f0-9]*"' "${RB_DIR}/running-tasks.json" | grep -vq "$BASE_DIGEST" &&
    grep -q "$BASE_DIGEST" "${RB_DIR}/running-tasks.json"; then
    digests_ok=true
  fi
fi
result "$RESULTS" rollback "the running containers carry the baseline image digest" \
  "$($digests_ok && echo passed || echo failed)" "${EV}/running-tasks.json" "baseline ${BASE_DIGEST}"
tool health-check --base-url "$CF" --deadline-ms 300000 --results "$RESULTS" --check rollback \
  --evidence "${EV}/results.jsonl" || true
if idp_running || idp_start "${CF}/"; then
  BASE_URL="$CF" SMOKE_TEST_IDP_URL="$SBX_IDP_URL" SMOKE_READY_DEADLINE_MS=120000 SMOKE_JOB_DEADLINE_MS=180000 \
    "${NODE_CMD[@]}" "$SMOKE_CLI" >"${RB_DIR}/smoke-after.log" 2>&1 || true
  tool results-smoke --log "${RB_DIR}/smoke-after.log" --results "$RESULTS" --check rollback-after-smoke \
    --evidence "${EV}/smoke-after.log" || true
else
  result "$RESULTS" rollback-after-smoke "smoke through CloudFront after the rollback" not-run "${EV}" \
    "the local test IdP could not be started"
fi

printf '{"runId":"%s","baselineTaskDefinition":"%s","baselineDigest":"%s","unhealthyTaskDefinition":"%s","unhealthyDigest":"%s","updateAt":"%s","durationSeconds":%s,"phase":"%s","failedTasks":"%s","reason":"%s"}\n' \
  "$RUN_ID" "$BASE_TD" "$BASE_DIGEST" "$NEW_TD" "$UNHEALTHY_DIGEST" "$T_UPDATE" "$((T_END_S - T_UPDATE_S))" \
  "$phase" "$failed_tasks" "${reason//\"/\'}" >"${RB_DIR}/rollback.json"
set +e
tool results-summary --results "$RESULTS" --out "${RB_DIR}/summary.json"
rc=$?
set -e
exit "$rc"
