#!/usr/bin/env bash
# Phase 2: deploy the full sandbox stage for ONE run.
#
#   tests/aws-integration/sandbox/up.sh                    # new run sbx-<6 hex>
#   SBX_RUN_ID=sbx-1a2b3c tests/aws-integration/sandbox/up.sh   # resume that run (idempotent)
#
# Steps (each recorded in <run dir>/steps.jsonl; a finished step is skipped on resume unless it is
# listed in SBX_FORCE_STEPS): build → run.env → no other run deployed → per-run secrets (origin
# verify value, issuer key) → API image selected (digest) → Foundation, TestIssuer → publish +
# verify discovery/JWKS → local IdP → Platform → API image into ECR by digest → Data, Workflow →
# Migrations → bootstrap task →
# migration task → Api, Frontend, Observability → SPA to S3 + invalidation → IdP with the SPA
# redirect URI → outputs.json → finops inventory.
#
# Environment: SBX_IMAGE_SOURCE=auto|ci|local (default auto: the CI-published, Cosign-verified
# image if it matches HEAD's API sources, else a local rootless build), SBX_CI_IMAGE, SBX_COSIGN_PUBKEY
# (the project's release-signing public key; required to use the CI image),
# SBX_SOURCE_AUTHFILE, SBX_TTL_HOURS (tag starter:expires-at, default 8, at most 72),
# SBX_RESERVED_CONCURRENCY (none|<n>: -c sandbox.reservedConcurrency, for a Lambda concurrency
# quota below 105), SBX_ORIGIN_PREFIX_LIST_ID (-c sandbox.originPrefixListId; default pl-31a34658,
# the CloudFront origin-facing list confirmed by discovery on 2026-10-15),
# SBX_MASTER_SECRET_ROTATION (on|off: -c sandbox.masterSecretRotation, default on), SBX_SKIP_BUILD=true.
# Exit: 0 deployed, 1 failure (run down.sh — all.sh does it automatically), 4 refused.
set -euo pipefail
# shellcheck source=_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

if [[ -n "${SBX_RUN_ID:-}" ]]; then
  set_run "$SBX_RUN_ID"
else
  set_run "$(new_run_id)"
fi
ensure_run_dir
start_logging
on_exit() {
  local rc=$?
  record_failed_step "$rc"
  cleanup_registry_auth
  if ((rc != 0)); then
    sbx_log "up.sh failed (exit ${rc}) — resources may exist; tear down with: SBX_RUN_ID=${RUN_ID} ${SBX_DIR}/down.sh"
  fi
  exit "$rc"
}
trap on_exit EXIT
guard_init

# ── steps ─────────────────────────────────────────────────────────────────────────────────────

build_workspace() {
  if [[ "${SBX_SKIP_BUILD:-}" == "true" ]]; then
    sbx_log "SBX_SKIP_BUILD=true: using the existing builds"
    return 0
  fi
  (cd "$REPO_ROOT" && "${PNPM_CMD[@]}" --filter "@starter/infra..." --filter "@starter/tool-test-idp..." \
    --filter "@starter/tests-aws-integration..." --filter "@starter/tests-smoke..." --filter "@starter/web..." run build)
}

write_run_env() {
  local ttl="${SBX_TTL_HOURS:-8}"
  [[ "$ttl" =~ ^[0-9]+$ && "$ttl" -ge 1 && "$ttl" -le 24 ]] || sbx_die "SBX_TTL_HOURS must be 1..24" 2
  run_env_set RUN_ID "$RUN_ID"
  run_env_set CREATED_AT "$(now_iso)"
  run_env_set EXPIRES_AT "$("${NODE_CMD[@]}" -e "process.stdout.write(new Date(Date.now()+${ttl}*3600e3).toISOString().replace(/\.\d{3}Z$/,'Z'))")"
  run_env_set REGION "$SBX_REGION"
  run_env_set PROFILE "$SBX_PROFILE"
  run_env_set ACCOUNT_MASKED "$(mask_account "$EXPECTED_ACCOUNT")"
  run_env_set GIT_COMMIT "$(git -C "$REPO_ROOT" rev-parse HEAD)"
  run_env_set APP_VERSION "$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
  # Pinned for every deploy of this run (the templates must not drift between deploys).
  run_env_set RESERVED_CONCURRENCY "${SBX_RESERVED_CONCURRENCY:-}"
  run_env_set ORIGIN_PREFIX_LIST_ID "${SBX_ORIGIN_PREFIX_LIST_ID-pl-31a34658}"
  # Hosted rotation of the RDS master secret (Transform AWS::SecretsManager-2024-09-16; the CDK CLI
  # sends CAPABILITY_AUTO_EXPAND itself): on by default, SBX_MASTER_SECRET_ROTATION=off as fallback.
  local rotation="${SBX_MASTER_SECRET_ROTATION:-on}"
  [[ "$rotation" == on || "$rotation" == off ]] || sbx_die "SBX_MASTER_SECRET_ROTATION must be on or off" 2
  run_env_set MASTER_SECRET_ROTATION "$rotation"
}

no_other_run() {
  awsr cloudformation describe-stacks --output json >"${RUN_DIR}/describe-all-stacks.json"
  local others
  others="$(tool other-runs --run-id "$RUN_ID" "${RUN_DIR}/describe-all-stacks.json")"
  [[ -z "$others" ]] ||
    sbx_die "another run is deployed (${others//$'\n'/, }); resume it with SBX_RUN_ID=<id> or tear it down first" 4
}

make_secrets() {
  if [[ ! -s "${RUN_DIR}/origin-verify" ]]; then
    # 32 random bytes as hex (the ALB compares header values case-insensitively)
    "${NODE_CMD[@]}" -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" \
      >"${RUN_DIR}/origin-verify"
    chmod 600 "${RUN_DIR}/origin-verify"
    sbx_log "origin-verify value generated (${RUN_DIR}/origin-verify, 0600)"
  fi
  if [[ ! -s "${RUN_DIR}/issuer-key.jwk" ]]; then
    "${NODE_CMD[@]}" "${TEST_IDP_DIST}/sandbox-issuer.js" keygen --out "${RUN_DIR}/issuer-key.jwk"
    sbx_log "issuer key generated (${RUN_DIR}/issuer-key.jwk)"
  fi
  chmod 600 "${RUN_DIR}/issuer-key.jwk"
  local mode
  mode="$(file_mode "${RUN_DIR}/issuer-key.jwk")" || sbx_die "cannot read the mode of the issuer key"
  [[ "$mode" == 600 ]] || sbx_die "issuer key mode is ${mode}, expected 600"
}

deploy() {
  deploy_stack "$1"
  refresh_stack_outputs "$1"
}

publish_issuer() {
  local issuer bucket dist
  issuer="$(out TestIssuer IssuerUrl)"
  issuer="${issuer%/}"
  bucket="$(out TestIssuer IssuerBucketName)"
  dist="$(out TestIssuer IssuerDistributionId)"
  [[ "$issuer" == https://* ]] || sbx_die "IssuerUrl is not https: ${issuer}"
  run_env_set ISSUER_URL "$issuer"
  mkdir -p "${RUN_DIR}/issuer-public"
  "${NODE_CMD[@]}" "${TEST_IDP_DIST}/sandbox-issuer.js" export --issuer "$issuer" \
    --key "${RUN_DIR}/issuer-key.jwk" --out "${RUN_DIR}/issuer-public"
  [[ -s "${RUN_DIR}/issuer-public/openid-configuration" && -s "${RUN_DIR}/issuer-public/jwks.json" ]] ||
    sbx_die "sandbox-issuer export did not write openid-configuration and jwks.json"
  # Belt and braces: never publish private key material.
  if grep -Eq '"(d|p|q|dp|dq|qi)"[[:space:]]*:' "${RUN_DIR}/issuer-public/jwks.json"; then
    sbx_die "the exported jwks.json contains private key parameters — refusing to publish"
  fi
  aws_mut "s3 cp openid-configuration" s3 cp "${RUN_DIR}/issuer-public/openid-configuration" \
    "s3://${bucket}/.well-known/openid-configuration" --content-type application/json --cache-control no-cache
  aws_mut "s3 cp jwks.json" s3 cp "${RUN_DIR}/issuer-public/jwks.json" \
    "s3://${bucket}/jwks.json" --content-type application/json --cache-control no-cache
  # A re-publish must not be masked by cached copies.
  aws_mut "cloudfront invalidation (issuer)" cloudfront create-invalidation --distribution-id "$dist" \
    --paths /.well-known/openid-configuration /jwks.json --output json >"${RUN_DIR}/issuer-invalidation.json"
}

check_issuer() {
  # Tokens minted here must be valid for the API: the local clock may not drift (> 30 s).
  tool clock-skew --url "$(run_env_get ISSUER_URL)/jwks.json" --max-seconds 30 \
    --results "${RUN_DIR}/up-checks.jsonl" --check clock --evidence up-checks.jsonl ||
    sbx_die "the local clock is more than 30 s off; fix NTP and resume"
  tool issuer-check --issuer "$(run_env_get ISSUER_URL)" --jwks "${RUN_DIR}/issuer-public/jwks.json" \
    --idp-url "$SBX_IDP_URL" --audience "$SBX_AUDIENCE" --deadline-ms "${SBX_ISSUER_DEADLINE_MS:-900000}" \
    --results "${RUN_DIR}/up-checks.jsonl" --check issuer --evidence up-checks.jsonl ||
    sbx_die "the published discovery/JWKS did not verify (see ${RUN_DIR}/up-checks.jsonl)"
}

# ── API image: CI-published + Cosign-verified, else local rootless build (by digest) ──────────
API_CLOSURE=(apps/api packages functions workflows pnpm-lock.yaml pnpm-workspace.yaml package.json)
SRC_REF=""
SRC_TLS=""
SRC_DIGEST=""
IMAGE_SOURCE=""
IMAGE_NOTE=""

image_from_ci() {
  local ref="${SBX_CI_IMAGE:-registry.example.invalid/aws-modernization-starter/api:main}"
  local tls="${SBX_CI_REGISTRY_TLS_VERIFY:-false}" dir="${RUN_DIR}/image"
  local auth=()
  [[ -n "${SBX_SOURCE_AUTHFILE:-}" ]] && auth=(--authfile "$SBX_SOURCE_AUTHFILE")
  if ! "${SKOPEO_CMD[@]}" inspect ${auth[@]+"${auth[@]}"} --tls-verify="$tls" "docker://${ref}" \
    >"${dir}/ci-inspect.json" 2>"${dir}/ci-inspect.err"; then
    IMAGE_NOTE="cannot inspect ${ref}: $(tail -n 1 "${dir}/ci-inspect.err")"
    return 1
  fi
  local digest arch revision repo
  digest="$(tool json-get "${dir}/ci-inspect.json" Digest)"
  arch="$(tool json-get "${dir}/ci-inspect.json" Architecture || echo unknown)"
  revision="$(tool json-get "${dir}/ci-inspect.json" 'Labels[org.opencontainers.image.revision]' || echo unknown)"
  if [[ "$ref" == *@sha256:* ]]; then repo="${ref%@*}"; else repo="${ref%:*}"; fi
  [[ "$digest" == sha256:* ]] || {
    IMAGE_NOTE="no digest for ${ref}"
    return 1
  }
  [[ "$arch" == arm64 ]] || {
    IMAGE_NOTE="${ref} is ${arch}; the sandbox runs linux/arm64"
    return 1
  }
  if ! git -C "$REPO_ROOT" cat-file -e "${revision}^{commit}" 2>/dev/null; then
    IMAGE_NOTE="the image revision ${revision:0:12} is not in this repository"
    return 1
  fi
  if ! git -C "$REPO_ROOT" diff --quiet "$revision" HEAD -- "${API_CLOSURE[@]}"; then
    IMAGE_NOTE="the image was built from ${revision:0:12}; the API sources differ from HEAD"
    return 1
  fi
  # The project's own release-signing public key (docs/ci-cd.md, signing is opt-in); without
  # it the CI image cannot be verified and up.sh falls back to a local build.
  local pub="${SBX_COSIGN_PUBKEY:-}"
  if [[ -z "$pub" || ! -f "$pub" ]]; then
    IMAGE_NOTE="SBX_COSIGN_PUBKEY (the project's signing public key) is not set or not a file; the CI image cannot be verified"
    return 1
  fi
  local cenv=()
  if [[ -n "${SBX_SOURCE_AUTHFILE:-}" ]]; then
    mkdir -p "${RUN_DIR}/.docker"
    cp "$SBX_SOURCE_AUTHFILE" "${RUN_DIR}/.docker/config.json"
    cenv=("DOCKER_CONFIG=${RUN_DIR}/.docker")
  fi
  if ! env ${cenv[@]+"${cenv[@]}"} "${COSIGN_CMD[@]}" verify --key "$pub" --insecure-ignore-tlog=true \
    --allow-insecure-registry --allow-http-registry "${repo}@${digest}" \
    >"${dir}/cosign-verify.json" 2>"${dir}/cosign-verify.err"; then
    IMAGE_NOTE="cosign verify of ${repo}@${digest} failed: $(grep -v WARNING "${dir}/cosign-verify.err" | tail -n 1)"
    return 1
  fi
  grep -Eq "\"docker-manifest-digest\": *\"${digest}\"" "${dir}/cosign-verify.json" || {
    IMAGE_NOTE="the signature payload does not name ${digest}"
    return 1
  }
  SRC_REF="docker://${repo}@${digest}"
  SRC_TLS="$tls"
  SRC_DIGEST="$digest"
  IMAGE_SOURCE=ci-registry
  IMAGE_NOTE="CI image ${repo}@${digest} (revision ${revision}), Cosign-verified with $(basename "$pub") (sha256 $(shasum -a 256 "$pub" | cut -d' ' -f1)); API sources equal HEAD"
}

image_from_local_build() {
  local dir="${RUN_DIR}/image" tag="localhost/starter-sbx/api:${RUN_ID}" commit created dirty=false
  commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  created="$(git -C "$REPO_ROOT" log -1 --format=%cI HEAD)"
  [[ -z "$(git -C "$REPO_ROOT" status --porcelain -- "${API_CLOSURE[@]}" apps/api/Dockerfile)" ]] || dirty=true
  sbx_log "building the API image locally (rootless podman, linux/arm64, commit ${commit:0:12}, uncommitted changes: ${dirty})"
  (cd "$REPO_ROOT" && "${PODMAN_CMD[@]}" build --platform linux/arm64 --format oci \
    --ignorefile apps/api/.dockerignore -f apps/api/Dockerfile \
    --build-arg "VCS_REF=${commit}" --build-arg SOURCE_URL=local-sandbox-build \
    --build-arg "BUILD_CREATED=${created}" --build-arg "VERSION=${commit:0:12}" \
    -t "$tag" .) >"${dir}/podman-build.log" 2>&1 || sbx_die "podman build failed (see ${dir}/podman-build.log)"
  rm -f "${dir}/api.oci.tar"
  "${PODMAN_CMD[@]}" save --format oci-archive -o "${dir}/api.oci.tar" "$tag"
  SRC_REF="oci-archive:${dir}/api.oci.tar"
  SRC_TLS=""
  # The manifest digest of the archive is the digest ECR will report (copied with --preserve-digests).
  "${SKOPEO_CMD[@]}" inspect "$SRC_REF" >"${dir}/local-inspect.json" ||
    sbx_die "cannot inspect the local image archive"
  SRC_DIGEST="$(tool json-get "${dir}/local-inspect.json" Digest)"
  [[ "$SRC_DIGEST" == sha256:* ]] || sbx_die "no digest for the local image archive"
  IMAGE_SOURCE=local-build
  IMAGE_NOTE="local rootless podman build of ${commit} (uncommitted API changes: ${dirty}); not Cosign-signed"
}

# Step image-select (before the first deploy: every deploy carries -c apiImageDigest under
# requireDeployInputs, and the digest is content-addressed, so it is known before the push).
select_image() {
  local dir="${RUN_DIR}/image"
  mkdir -p "$dir"
  local mode="${SBX_IMAGE_SOURCE:-auto}"
  case "$mode" in
    ci) image_from_ci || sbx_die "SBX_IMAGE_SOURCE=ci but the CI image is unusable: ${IMAGE_NOTE}" ;;
    local) image_from_local_build ;;
    auto)
      if ! image_from_ci; then
        sbx_warn "CI image not used (${IMAGE_NOTE}); falling back to a local rootless build"
        local reason="$IMAGE_NOTE"
        image_from_local_build
        IMAGE_NOTE="${IMAGE_NOTE}; CI image not used: ${reason}"
      fi
      ;;
    *) sbx_die "SBX_IMAGE_SOURCE must be auto, ci or local" 2 ;;
  esac
  run_env_set IMAGE_DIGEST "$SRC_DIGEST"
  run_env_set IMAGE_SOURCE "$IMAGE_SOURCE"
  run_env_set IMAGE_SRC_REF "$SRC_REF"
  run_env_set IMAGE_SRC_TLS "$SRC_TLS"
  printf '{"digest":"%s","source":"%s","sourceRef":"%s","provenance":"%s","selectedAt":"%s"}\n' \
    "$SRC_DIGEST" "$IMAGE_SOURCE" "$SRC_REF" "${IMAGE_NOTE//\"/\'}" "$(now_iso)" >"${dir}/image.json"
  sbx_log "API image selected: ${SRC_DIGEST} (${IMAGE_SOURCE})"
}

# Step image-push (after Platform created the repository): copy by digest, verify it.
push_image() {
  local dir="${RUN_DIR}/image" repo_uri repo_name tag pushed digest src
  digest="$(run_env_get IMAGE_DIGEST)"
  src="$(run_env_get IMAGE_SRC_REF)"
  [[ "$digest" == sha256:* && -n "$src" ]] || sbx_die "no image selected (step image-select)"
  repo_uri="$(out Platform ApiRepositoryUri)"
  repo_name="$(out Platform ApiRepositoryName)"
  if awsr ecr describe-images --repository-name "$repo_name" --image-ids "imageDigest=${digest}" \
    --output json >"${dir}/ecr-describe-images.json" 2>/dev/null; then
    sbx_log "API image ${digest} is already in ECR"
    return 0
  fi
  local src_opts=()
  if [[ "$src" == docker://* ]]; then
    src_opts+=(--src-tls-verify="$(run_env_get IMAGE_SRC_TLS)")
    [[ -n "${SBX_SOURCE_AUTHFILE:-}" ]] && src_opts+=(--src-authfile "$SBX_SOURCE_AUTHFILE")
  fi
  tag="${RUN_ID}-$(date -u +%Y%m%d%H%M%S)"
  ecr_login "${repo_uri%%/*}"
  mut "push API image to ECR ($(run_env_get IMAGE_SOURCE))" "${SKOPEO_CMD[@]}" copy --preserve-digests \
    --retry-times 2 ${src_opts[@]+"${src_opts[@]}"} --dest-authfile "${RUN_DIR}/.ecr-auth.json" \
    --digestfile "${dir}/pushed.digest" "$src" "docker://${repo_uri}:${tag}"
  cleanup_registry_auth
  pushed="$(tr -d ' \n' <"${dir}/pushed.digest")"
  [[ "$pushed" == "$digest" ]] ||
    sbx_die "ECR digest ${pushed} differs from the selected digest ${digest} (digest not preserved)"
  awsr ecr describe-images --repository-name "$repo_name" --image-ids "imageDigest=${pushed}" \
    --output json >"${dir}/ecr-describe-images.json" || sbx_die "ECR does not list ${pushed}"
  run_env_set IMAGE_TAG "$tag"
  sbx_log "API image in ECR by digest: ${pushed} ($(run_env_get IMAGE_SOURCE))"
}

db_task() {
  local name="$1" output="$2" sg="${3:-}" td
  td="$(out Migrations "$output")"
  run_task "$name" "$td" "" "$sg"
  [[ "$TASK_EXIT_CODE" == 0 ]] ||
    sbx_die "the ${name} task exited ${TASK_EXIT_CODE} (${TASK_STOPPED_REASON}); logs ${TASK_LOGS}"
}

publish_spa() {
  local dist="${SBX_WEB_DIST:-${REPO_ROOT}/apps/web/dist}" bucket dist_id inv
  if [[ "${SBX_SKIP_BUILD:-}" != "true" || ! -f "${dist}/index.html" ]]; then
    (cd "$REPO_ROOT" && "${PNPM_CMD[@]}" --filter @starter/web run build)
  fi
  [[ -f "${dist}/index.html" ]] || sbx_die "no SPA build at ${dist}"
  bucket="$(out Frontend WebBucketName)"
  dist_id="$(out Frontend DistributionId)"
  # /config.json is answered at the edge (CloudFront Function); never upload one.
  aws_mut "s3 sync SPA assets" s3 sync "${dist}/" "s3://${bucket}/" --delete \
    --exclude index.html --exclude config.json --cache-control "public,max-age=31536000,immutable"
  aws_mut "s3 cp SPA index.html" s3 cp "${dist}/index.html" "s3://${bucket}/index.html" \
    --cache-control no-cache --content-type "text/html; charset=utf-8"
  inv="$(aws_mut "cloudfront invalidation (SPA)" cloudfront create-invalidation --distribution-id "$dist_id" \
    --paths '/*' --query Invalidation.Id --output text)"
  awsr cloudfront wait invalidation-completed --distribution-id "$dist_id" --id "$inv"
}

write_endpoints() {
  local cf
  cf="https://$(out Frontend DistributionDomainName)"
  run_env_set CLOUDFRONT_URL "$cf"
  printf '{"runId":"%s","cloudFrontUrl":"%s","issuerUrl":"%s","idpUrl":"%s","albDnsName":"%s","imageDigest":"%s","imageSource":"%s"}\n' \
    "$RUN_ID" "$cf" "$(run_env_get ISSUER_URL)" "$SBX_IDP_URL" "$(out Api AlbDnsName)" \
    "$(run_env_get IMAGE_DIGEST)" "$(run_env_get IMAGE_SOURCE)" >"${RUN_DIR}/endpoints.json"
}

# finops verify-clean before the first deploy: verify.sh compares the teardown against it.
verify_baseline() {
  [[ -s "${RUN_DIR}/verify-baseline.json" ]] && return 0
  SBX_RUN_ID="$RUN_ID" "${SBX_DIR}/verify.sh" --baseline ||
    sbx_warn "no finops baseline (verify.sh --baseline exit $?): the teardown verification runs without one"
}

inventory() {
  if [[ ! -f "$FINOPS_CLI" ]]; then
    sbx_warn "finops inventory not available (${FINOPS_CLI} missing) — skipped"
    return 0
  fi
  local synth=()
  [[ -d "${RUN_DIR}/cdk.out" ]] && synth=(--synth "${RUN_DIR}/cdk.out")
  "${NODE_CMD[@]}" "$FINOPS_CLI" inventory --run-id "$RUN_ID" --phase 2 --out "${RUN_DIR}/inventory.json" \
    --markdown "${RUN_DIR}/inventory.md" --region "$SBX_REGION" --guard-log "$SANDBOX_GUARD_LOG" \
    ${synth[@]+"${synth[@]}"} ||
    sbx_warn "finops inventory failed (exit $?); see the log"
}

# ── the run ───────────────────────────────────────────────────────────────────────────────────
step build build_workspace
step run-env write_run_env
set_current_run
step no-other-run no_other_run
step secrets make_secrets
step image-select select_image
step verify-baseline verify_baseline
step deploy-foundation deploy Foundation
step deploy-test-issuer deploy TestIssuer
step publish-issuer publish_issuer
idp_start "https://sandbox-spa.invalid/"
step check-issuer check_issuer
step deploy-platform deploy Platform
step image-push push_image
step deploy-data deploy Data
step deploy-workflow deploy Workflow
step deploy-migrations deploy Migrations
# The bootstrap task has its own security group (BootstrapSecurityGroupId) where the stage defines one.
step db-bootstrap-task db_task db-bootstrap BootstrapTaskDefinitionArn "$(out_opt Migrations BootstrapSecurityGroupId)"
step db-migrate-task db_task db-migrate MigrationTaskDefinitionArn
step deploy-api deploy Api
step deploy-frontend deploy Frontend
step publish-spa publish_spa
step deploy-observability deploy Observability
refresh_outputs
idp_start "https://$(out Frontend DistributionDomainName)/"
write_endpoints
step inventory inventory
sbx_log "run ${RUN_ID} is up: $(run_env_get CLOUDFRONT_URL) (outputs ${RUN_DIR}/outputs.json)"
sbx_log "next: SBX_RUN_ID=${RUN_ID} ${SBX_DIR}/test.sh"
