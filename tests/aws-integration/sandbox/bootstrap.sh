#!/usr/bin/env bash
# CDK bootstrap of the sandbox account for the experiment.
#
#   tests/aws-integration/sandbox/bootstrap.sh            # create only if absent (idempotent)
#   tests/aws-integration/sandbox/bootstrap.sh --destroy  # delete it, ONLY if this experiment created it
#
# Create: `cdk bootstrap aws://<expected account>/<SANDBOX_REGION> --qualifier starter
# --toolkit-stack-name starter-cdk-toolkit` (no termination protection, default execution policy —
# a recorded sandbox deviation) unless the toolkit stack already exists;
# ${SANDBOX_HOME}/bootstrap.json records whether it pre-existed. It runs with the operator's own
# credentials, so it asks only for what the permission set allows: no customer-managed KMS key
# (default AWS-managed bucket encryption; kms:CreateKey is denied) and no stack tags (they would
# propagate to the ECR repository and the SSM parameter, i.e. ecr:TagResource /
# ssm:AddTagsToResource, which the permission set does not grant). The account's own `CDKToolkit`
# (qualifier hnb659fds) is never read or touched.
# Destroy: refused unless bootstrap.json says createdByExperiment=true and no experiment stack
# (Sandbox-* of this experiment, starter-it-*) is left (their deletion needs the bootstrap roles);
# deletes the stack (if its asset repository is not empty: `ecr delete-repository --force` of that
# repository — the permission set has no ecr:BatchDeleteImage — and one retry), then empties and
# deletes the retained staging bucket.
# Exit: 0 ok, 1 failure, 4 refused by the guard/state.
set -euo pipefail
# shellcheck source=_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

mode=create
case "${1:-}" in
  "") ;;
  --destroy) mode=destroy ;;
  *) sbx_die "usage: bootstrap.sh [--destroy]" 2 ;;
esac

# Never the account's default bootstrap.
[[ "$SBX_TOOLKIT_STACK" != CDKToolkit && "$SBX_QUALIFIER" != hnb659fds ]] ||
  sbx_die "refusing to operate on the default CDK bootstrap" 4

# Account-wide state (not per run): logs and guard log under ${SANDBOX_HOME}/bootstrap.
RUN_DIR="${SANDBOX_HOME}/bootstrap"
mkdir -p "$RUN_DIR/logs"
chmod 700 "$SANDBOX_HOME" "$RUN_DIR"
start_logging
trap 'rc=$?; record_failed_step "$rc"; exit "$rc"' EXIT
guard_init

toolkit_status() {
  awsr cloudformation describe-stacks --stack-name "$SBX_TOOLKIT_STACK" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo ABSENT
}

state_field() {
  [[ -f "$BOOTSTRAP_STATE" ]] || return 0
  tool json-get "$BOOTSTRAP_STATE" "$1" 2>/dev/null || true
}

write_state() {
  local pre="$1" created="$2" more="${3:-}"
  printf '{"toolkitStackName":"%s","qualifier":"%s","region":"%s","preExisted":%s,"createdByExperiment":%s,"recordedAt":"%s"%s}\n' \
    "$SBX_TOOLKIT_STACK" "$SBX_QUALIFIER" "$SBX_REGION" "$pre" "$created" "$(now_iso)" "$more" >"$BOOTSTRAP_STATE"
  chmod 600 "$BOOTSTRAP_STATE"
}

cdk_bootstrap() {
  (
    cd "$INFRA_DIR" || exit 1
    mut "cdk bootstrap ${SBX_TOOLKIT_STACK}" "${PNPM_CMD[@]}" exec cdk bootstrap \
        "aws://${EXPECTED_ACCOUNT}/${SBX_REGION}" \
        --profile "$SBX_PROFILE" \
        --qualifier "$SBX_QUALIFIER" \
        --toolkit-stack-name "$SBX_TOOLKIT_STACK" \
        --termination-protection false
  )
}

create() {
  local status
  status="$(toolkit_status)"
  case "$status" in
    ABSENT | None)
      sbx_log "no ${SBX_TOOLKIT_STACK} in the account: bootstrapping (qualifier ${SBX_QUALIFIER})"
      CURRENT_STEP=cdk-bootstrap
      STEP_T0="$(date +%s)"
      cdk_bootstrap
      CURRENT_STEP=""
      write_state false true
      ;;
    CREATE_COMPLETE | UPDATE_COMPLETE | UPDATE_ROLLBACK_COMPLETE)
      local version
      # ssm:GetParameters (plural) is what the permission set grants.
      version="$(awsr ssm get-parameters --names "/cdk-bootstrap/${SBX_QUALIFIER}/version" \
        --query 'Parameters[0].Value' --output text 2>/dev/null || echo 0)"
      [[ "$version" =~ ^[0-9]+$ && "$version" -ge 6 ]] ||
        sbx_die "${SBX_TOOLKIT_STACK} exists but /cdk-bootstrap/${SBX_QUALIFIER}/version is '${version}' (need >= 6)"
      if [[ "$(state_field createdByExperiment)" == "true" ]]; then
        sbx_log "${SBX_TOOLKIT_STACK} (${status}, version ${version}) was created by this experiment earlier — nothing to do"
      else
        sbx_log "${SBX_TOOLKIT_STACK} pre-exists (${status}, version ${version}): used as is, never deleted by teardown"
        write_state true false ",\"bootstrapVersion\":${version}"
      fi
      ;;
    *_IN_PROGRESS)
      sbx_die "${SBX_TOOLKIT_STACK} is ${status}; wait until it settles and run again"
      ;;
    *)
      sbx_die "${SBX_TOOLKIT_STACK} is ${status}; inspect it (bootstrap.sh --destroy if this experiment created it)"
      ;;
  esac
}

destroy() {
  if [[ "$(state_field createdByExperiment)" != "true" ]]; then
    sbx_log "${BOOTSTRAP_STATE} does not say this experiment created ${SBX_TOOLKIT_STACK} — it is left alone"
    exit 0
  fi
  local status
  status="$(toolkit_status)"
  if [[ "$status" == ABSENT || "$status" == None ]]; then
    sbx_log "${SBX_TOOLKIT_STACK} is already gone"
    write_state false true ",\"deletedAt\":\"$(now_iso)\""
    return 0
  fi
  local left
  awsr cloudformation describe-stacks --output json >"${RUN_DIR}/stacks-before-destroy.json"
  left="$(tool experiment-stacks "${RUN_DIR}/stacks-before-destroy.json" | cut -f1)
$(awsr cloudformation describe-stacks --query "Stacks[?starts_with(StackName, 'starter-it-')].StackName" --output text)"
  left="$(printf '%s' "$left" | tr '\t' '\n' | grep -v '^None$' | grep -v '^[[:space:]]*$' || true)"
  [[ -z "$left" ]] ||
    sbx_die "experiment stacks still use the bootstrap ($(printf '%s' "$left" | tr '\n' ' ')); run down.sh / cleanup.sh first" 4
  local bucket repo
  bucket="$(awsr cloudformation describe-stacks --stack-name "$SBX_TOOLKIT_STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)"
  repo="$(awsr cloudformation describe-stacks --stack-name "$SBX_TOOLKIT_STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='ImageRepositoryName'].OutputValue" --output text)"
  # Only the starter bootstrap's own bucket and repository.
  [[ "$bucket" == None || "$bucket" == *"-${SBX_QUALIFIER}-"* ]] || sbx_die "unexpected bucket name ${bucket}" 4
  [[ "$repo" == None || "$repo" == *"-${SBX_QUALIFIER}-"* ]] || sbx_die "unexpected repository name ${repo}" 4
  CURRENT_STEP=bootstrap-destroy
  STEP_T0="$(date +%s)"
  aws_mut "delete stack ${SBX_TOOLKIT_STACK}" cloudformation delete-stack --stack-name "$SBX_TOOLKIT_STACK"
  if ! awsr cloudformation wait stack-delete-complete --stack-name "$SBX_TOOLKIT_STACK"; then
    # A non-empty asset repository blocks the delete: remove it (with its images), retry once.
    sbx_warn "${SBX_TOOLKIT_STACK} did not delete ($(toolkit_status)); removing its asset repository and retrying"
    [[ -n "$repo" && "$repo" != None ]] && delete_ecr_repository "$repo"
    aws_mut "delete stack ${SBX_TOOLKIT_STACK} (retry)" cloudformation delete-stack --stack-name "$SBX_TOOLKIT_STACK"
    awsr cloudformation wait stack-delete-complete --stack-name "$SBX_TOOLKIT_STACK" ||
      sbx_die "${SBX_TOOLKIT_STACK} could not be deleted ($(toolkit_status))"
  fi
  # The staging bucket has DeletionPolicy Retain in the bootstrap template.
  if [[ -n "$bucket" && "$bucket" != None ]] && awsr s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    empty_bucket_versions "$bucket"
    aws_mut "delete bucket ${bucket}" s3api delete-bucket --bucket "$bucket"
  fi
  CURRENT_STEP=""
  write_state false true ",\"deletedAt\":\"$(now_iso)\""
  sbx_log "bootstrap ${SBX_TOOLKIT_STACK} deleted (it was created by this experiment)"
}

"$mode"
