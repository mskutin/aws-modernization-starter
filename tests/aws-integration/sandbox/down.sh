#!/usr/bin/env bash
# shellcheck disable=SC2329  # functions run via trap / run_check are reported as never invoked
# Phase 2 teardown — always safe to run, idempotent.
#
#   SBX_RUN_ID=sbx-1a2b3c tests/aws-integration/sandbox/down.sh   # that run (default: the current run)
#   tests/aws-integration/sandbox/down.sh --all-runs               # every experiment stack found
#
# The sandbox account is shared with other stacks, VPCs and databases: every destructive step acts
# ONLY on this experiment's stacks — `Sandbox-*` names that ALSO carry starter:experiment=live-validation (or
# starter:run-id=sbx-…) — and on resources captured from those stacks, plus names under the stage's own
# resource prefix (starter-sbx). Works from the run directory when it exists and from CloudFormation
# names/tags when it does not. Order:
#   1. stop the local test IdP;
#   2. capture the physical ids of our stacks' resources (kept in <run dir>/captured-resources.tsv,
#      so a re-run still knows them after the stacks are gone);
#   3. destroy our stacks in reverse deploy order, one at a time: `cdk destroy --exclusively
#      --force` when the run's context is available, else (or on failure) `delete-stack` by name;
#      a DELETE_FAILED stack gets its buckets emptied / repositories deleted and one more delete;
#   4. remove what CloudFormation leaves: task-definition revisions of our families (incl.
#      rollback.sh's), our ECR repository if retained, runtime-created log groups of our resources,
#      RDS automated backups and manual snapshots of our DB instances;
#      REPORT (the permission set cannot act): KMS keys not pending deletion (kms:ScheduleKeyDeletion
#      is denied; CloudFormation schedules our keys on delete) and Secrets Manager (denied entirely);
#   5. delete the local secrets (issuer private key, origin-verify value, registry auth);
#   6. verify.sh (finops verify-clean). Exit: verify's result (0 clean, 1 remains, 3 not verified,
#      5 clean with categories this role cannot list), 1 when a teardown step failed.
set -euo pipefail
# shellcheck source=_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

all_runs=false
case "${1:-}" in
  "") ;;
  --all-runs) all_runs=true ;;
  *) sbx_die "usage: down.sh [--all-runs]" 2 ;;
esac

if resolve_run; then
  have_run_dir=false
  [[ -f "${RUN_DIR}/run.env" ]] && have_run_dir=true
else
  all_runs=true
  have_run_dir=false
  RUN_DIR="${SANDBOX_HOME}/teardown-$(date -u +%Y%m%dT%H%M%SZ)"
fi
mkdir -p "${RUN_DIR}/logs"
chmod 700 "$RUN_DIR"
DOWN_DIR="${RUN_DIR}/down-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DOWN_DIR"
start_logging
FAILURES=0
on_exit() {
  local rc=$?
  record_failed_step "$rc"
  cleanup_registry_auth
  exit "$rc"
}
trap on_exit EXIT
guard_init
sbx_log "teardown of ${RUN_ID:-every experiment run} (run directory: $($have_run_dir && echo present || echo absent))"
fail() {
  FAILURES=$((FAILURES + 1))
  sbx_warn "$*"
  printf '%s\n' "$*" >>"${DOWN_DIR}/failures.txt"
}
note() {
  sbx_warn "$*"
  printf '%s\n' "$*" >>"${DOWN_DIR}/notes.txt"
}

# ── 1. local test IdP ─────────────────────────────────────────────────────────────────────────
$have_run_dir && idp_stop

# ── 2. our stacks and their resources ─────────────────────────────────────────────────────────
list_stacks() {
  awsr cloudformation describe-stacks --output json >"${DOWN_DIR}/stacks.json"
  if $all_runs; then
    tool experiment-stacks "${DOWN_DIR}/stacks.json"
  else
    tool experiment-stacks --run-id "$RUN_ID" "${DOWN_DIR}/stacks.json"
  fi
}
STACK_LINES="$(list_stacks)"
printf '%s\n' "$STACK_LINES" >"${DOWN_DIR}/stacks-before.tsv"

CAPTURED="${RUN_DIR}/captured-resources.tsv"
touch "$CAPTURED"
# <stack> <type> <physical id> of every resource of OUR stacks (never a stack merely named alike).
while IFS=$'\t' read -r name _; do
  [[ -n "$name" ]] || continue
  awsr cloudformation describe-stack-resources --stack-name "$name" \
    --query 'StackResources[].[ResourceType,PhysicalResourceId]' --output text 2>/dev/null |
    awk -v s="$name" -F '\t' 'NF == 2 && $2 != "None" { print s "\t" $1 "\t" $2 }' >>"$CAPTURED" || true
done <<<"$STACK_LINES"
sort -u -o "$CAPTURED" "$CAPTURED"
# captured <ResourceType> — physical ids of that type in our stacks (this and earlier runs of down.sh).
captured() { awk -F '\t' -v t="$1" '$2 == t { print $3 }' "$CAPTURED" | sort -u; }

# ── 3. destroy the stacks ─────────────────────────────────────────────────────────────────────
# cdk destroy needs the run's context (run.env) and the built app; not the run's secrets.
can_cdk() {
  $have_run_dir && [[ -f "${INFRA_DIR}/dist/bin/app.js" ]] && [[ "${SBX_DOWN_FORCE_CFN:-}" != "true" ]]
}

stack_status() {
  awsr cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' \
    --output text 2>/dev/null || echo DELETE_COMPLETE
}

wait_deleted() {
  local name="$1" status deadline=$((SECONDS + ${SBX_STACK_DELETE_DEADLINE_SECONDS:-3600}))
  while :; do
    status="$(stack_status "$name")"
    case "$status" in
      DELETE_COMPLETE) return 0 ;;
      DELETE_FAILED) return 1 ;;
    esac
    ((SECONDS < deadline)) || return 1
    sleep "${SBX_POLL_SECONDS:-15}"
  done
}

# What blocks a DELETE_FAILED stack of ours: its buckets (emptied) and repositories (deleted with
# their images: the permission set has ecr:DeleteRepository, not ecr:BatchDeleteImage).
unblock() {
  local name="$1" stack type id
  while IFS=$'\t' read -r stack type id; do
    [[ "$stack" == "$name" ]] || continue
    case "$type" in
      AWS::S3::Bucket) empty_bucket_versions "$id" || fail "could not empty s3://${id}" ;;
      AWS::ECR::Repository) delete_ecr_repository "$id" || fail "could not delete ECR ${id}" ;;
    esac
  done <"$CAPTURED"
}

destroy_stack() {
  local name="$1" stack="${1#"${SBX_STAGE}"-}"
  if can_cdk; then
    if cdk_sbx destroy "$stack" && wait_deleted "$name"; then
      return 0
    fi
    sbx_warn "cdk destroy of ${name} did not complete; falling back to delete-stack"
  fi
  aws_mut "delete-stack ${name}" cloudformation delete-stack --stack-name "$name" || true
  wait_deleted "$name" && return 0
  sbx_warn "${name} is $(stack_status "$name"); emptying what blocks it and retrying once"
  unblock "$name"
  aws_mut "delete-stack ${name} (retry)" cloudformation delete-stack --stack-name "$name" || true
  wait_deleted "$name"
}

CURRENT_STEP=destroy-stacks
STEP_T0="$(date +%s)"
while IFS=$'\t' read -r name status run protected; do
  [[ -n "$name" ]] || continue
  if [[ "$protected" == true ]]; then
    fail "${name} has termination protection; not deleted"
    continue
  fi
  sbx_log "destroying ${name} (${status}, run ${run})"
  t0="$(date +%s)"
  if destroy_stack "$name"; then
    printf '{"stack":"%s","status":"DELETE_COMPLETE","seconds":%s}\n' "$name" "$(($(date +%s) - t0))" >>"${DOWN_DIR}/stacks-deleted.jsonl"
  else
    fail "${name} could not be deleted ($(stack_status "$name"))"
  fi
done <<<"$STACK_LINES"
CURRENT_STEP=""

# ── 4. what CloudFormation leaves ─────────────────────────────────────────────────────────────
CURRENT_STEP=leftovers
STEP_T0="$(date +%s)"

# Task-definition revisions of OUR families (from our stacks' task definitions; rollback.sh's
# revision is in the API family and also listed in run.env). Deregister ACTIVE, then delete.
cleanup_task_definitions() {
  local families=() family arns=() arn status
  while IFS= read -r arn; do
    [[ "$arn" == *:task-definition/* ]] || continue
    family="${arn##*:task-definition/}"
    families+=("${family%:*}")
  done < <(
    captured AWS::ECS::TaskDefinition
    run_env_get ROLLBACK_TASKDEF_ARNS | tr ' ' '\n'
  )
  for family in $(printf '%s\n' ${families[@]+"${families[@]}"} | sort -u); do
    if [[ "$family" != "${SBX_RESOURCE_PREFIX}-"* ]]; then
      note "task-definition family ${family} is not under ${SBX_RESOURCE_PREFIX}-; left alone"
      continue
    fi
    for status in ACTIVE INACTIVE; do
      arns=()
      while IFS= read -r arn; do
        # --family-prefix matches by prefix: keep exactly this family.
        [[ "$arn" == *":task-definition/${family}:"* ]] && arns+=("$arn")
      done < <(awsr ecs list-task-definitions --family-prefix "$family" --status "$status" \
        --query 'taskDefinitionArns' --output text | tr '\t' '\n')
      if [[ "$status" == ACTIVE ]]; then
        for arn in ${arns[@]+"${arns[@]}"}; do
          aws_mut "deregister ${arn##*/}" ecs deregister-task-definition --task-definition "$arn" \
            --output json >/dev/null || fail "could not deregister ${arn##*/}"
        done
      else
        while ((${#arns[@]} > 0)); do
          aws_mut "delete task definitions of ${family}" ecs delete-task-definitions \
            --task-definitions "${arns[@]:0:10}" --output json >/dev/null ||
            fail "could not delete task definitions of ${family}"
          arns=("${arns[@]:10}")
        done
      fi
    done
  done
}
cleanup_task_definitions

# Our ECR repositories, if retained.
while IFS= read -r repo; do
  [[ -n "$repo" ]] || continue
  delete_ecr_repository "$repo" || fail "could not delete ECR ${repo}"
done < <(captured AWS::ECR::Repository)

# Log groups: those our stacks declared (if retained) and those our resources create at runtime —
# exact names from captured Lambda functions, DB instances and ECS clusters — plus groups under the
# stage's own resource prefix (e.g. the RDS rotation Lambda of a nested stack).
log_group_candidates() {
  # Created outside CloudFormation (Container Insights, the hosted-rotation Lambda).
  printf '%s\n' "/aws/ecs/containerinsights/${SBX_RESOURCE_PREFIX}-cluster/performance" \
    "/aws/lambda/${SBX_RESOURCE_PREFIX}-rds-rotation"
  captured AWS::Logs::LogGroup
  local id prefix
  for id in $(captured AWS::Lambda::Function); do printf '/aws/lambda/%s\n' "$id"; done
  for id in $(captured AWS::RDS::DBInstance); do
    awsr logs describe-log-groups --log-group-name-prefix "/aws/rds/instance/${id}/" \
      --query 'logGroups[].logGroupName' --output text | tr '\t' '\n'
  done
  for id in $(captured AWS::ECS::Cluster); do
    awsr logs describe-log-groups --log-group-name-prefix "/aws/ecs/containerinsights/${id##*/}/" \
      --query 'logGroups[].logGroupName' --output text | tr '\t' '\n'
  done
  for prefix in "/starter/${SBX_RESOURCE_PREFIX}/" "/aws/lambda/${SBX_RESOURCE_PREFIX}-" \
    "/aws/vendedlogs/states/${SBX_RESOURCE_PREFIX}-" "/aws/ecs/containerinsights/${SBX_RESOURCE_PREFIX}-"; do
    awsr logs describe-log-groups --log-group-name-prefix "$prefix" \
      --query 'logGroups[].logGroupName' --output text | tr '\t' '\n'
  done
}
while IFS= read -r group; do
  [[ -n "$group" && "$group" != None ]] || continue
  # Only groups that exist (exact match: describe-log-groups matches by prefix).
  exists="$(awsr logs describe-log-groups --log-group-name-prefix "$group" \
    --query "logGroups[?logGroupName=='${group}'].logGroupName" --output text 2>/dev/null || true)"
  [[ "$exists" == "$group" ]] || continue
  aws_mut "delete log group ${group}" logs delete-log-group --log-group-name "$group" ||
    fail "could not delete log group ${group}"
done < <(log_group_candidates | sort -u)

# RDS: automated backups retained after OUR instances, and their manual snapshots.
while IFS= read -r db; do
  [[ -n "$db" ]] || continue
  while IFS= read -r dbi; do
    [[ -n "$dbi" && "$dbi" != None ]] || continue
    aws_mut "delete automated backups of ${db}" rds delete-db-instance-automated-backup \
      --dbi-resource-id "$dbi" --output json >/dev/null || fail "could not delete automated backup ${dbi}"
  done < <(awsr rds describe-db-instance-automated-backups --db-instance-identifier "$db" \
    --query 'DBInstanceAutomatedBackups[].DbiResourceId' --output text 2>/dev/null | tr '\t' '\n')
  while IFS= read -r snap; do
    [[ -n "$snap" && "$snap" != None ]] || continue
    aws_mut "delete RDS snapshot ${snap}" rds delete-db-snapshot --db-snapshot-identifier "$snap" \
      --output json >/dev/null || fail "could not delete snapshot ${snap}"
  done < <(awsr rds describe-db-snapshots --db-instance-identifier "$db" --snapshot-type manual \
    --query 'DBSnapshots[].DBSnapshotIdentifier' --output text 2>/dev/null | tr '\t' '\n')
done < <(captured AWS::RDS::DBInstance)

# KMS: CloudFormation schedules our keys for deletion (7-day window) when it deletes them. The
# permission set only has kms:DescribeKey, so a key that is NOT pending deletion is reported.
while IFS= read -r key; do
  [[ -n "$key" ]] || continue
  state="$(awsr kms describe-key --key-id "$key" --query 'KeyMetadata.KeyState' --output text 2>/dev/null || echo Gone)"
  case "$state" in
    PendingDeletion | Gone) ;;
    *) fail "KMS key ${key##*/} is ${state}, not pending deletion (kms:ScheduleKeyDeletion is denied to this role: schedule it with an administrator)" ;;
  esac
done < <(captured AWS::KMS::Key)

# Secrets Manager is denied to this permission set (not even DescribeSecret/ListSecrets): the
# fixed-name master secret cannot be checked or force-deleted here — reported.
note "NOT VERIFIED: secret ${SBX_RESOURCE_PREFIX}/rds/master — Secrets Manager is denied to this permission set. CloudFormation deletes it with a recovery window; while it is pending deletion a redeploy of the same name fails. An administrator can check it (describe-secret) and force-delete it (delete-secret --force-delete-without-recovery)."
CURRENT_STEP=""

# ── 5. local secrets ──────────────────────────────────────────────────────────────────────────
remaining="$(list_stacks)"
if $have_run_dir && [[ -z "$remaining" ]]; then
  for f in issuer-key.jwk origin-verify; do
    if [[ -f "${RUN_DIR}/${f}" ]]; then
      # Overwrite before unlinking (best effort on SSD/APFS; the files never left the run dir).
      head -c 4096 /dev/urandom >"${RUN_DIR}/${f}"
      rm -f "${RUN_DIR}/${f}"
      sbx_log "deleted ${RUN_DIR}/${f}"
    fi
  done
  rm -rf "${RUN_DIR}/cdk.out"
elif $have_run_dir; then
  sbx_warn "stacks remain; keeping the run's origin-verify value and key so down.sh can be re-run"
fi

# ── 6. verification ───────────────────────────────────────────────────────────────────────────
set +e
if [[ -n "$RUN_ID" ]]; then
  SBX_RUN_ID="$RUN_ID" SBX_VERIFY_OUT_DIR="$DOWN_DIR" "${SBX_DIR}/verify.sh"
  vrc=$?
else
  sbx_warn "no run id known: verify-clean needs one; run verify.sh with SBX_RUN_ID=<id> for each run"
  vrc=3
fi
set -e
sbx_log "teardown finished: ${FAILURES} failure(s); verification exit ${vrc}"
((FAILURES == 0)) || exit 1
exit "$vrc"
