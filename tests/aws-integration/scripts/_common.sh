#!/usr/bin/env bash
# Shared helpers for the AWS integration lifecycle scripts (sourced, not executed).
# shellcheck disable=SC2034  # variables are used by the sourcing scripts

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SUITE_DIR}/../.." && pwd)"
# shellcheck source=_file-mode.sh
source "${SCRIPT_DIR}/_file-mode.sh"
# Region default and rules, shared with the account guard (tools/aws-preflight/scripts/region.sh).
REGION_HELPER="${REPO_ROOT}/tools/aws-preflight/scripts/region.sh"
if [[ -f "$REGION_HELPER" ]]; then
  # shellcheck source=../../../tools/aws-preflight/scripts/region.sh
  source "$REGION_HELPER"
fi
REPORT_DIR="${AWS_INTEGRATION_REPORT_DIR:-${REPO_ROOT}/reports/aws-integration}"
RUN_ENV="${REPORT_DIR}/run.env"
OUTPUTS_FILE="${REPORT_DIR}/outputs.json"
# The CDK app of the integration mini-stack (in infra/; compiled by `tsc -b`).
INFRA_DIR="${AWS_INTEGRATION_INFRA_DIR:-${REPO_ROOT}/infra}"
CDK_APP="${AWS_INTEGRATION_CDK_APP:-node dist/bin/integration.js}"
# Cleanup verifier (override only for the scripts' self-test; paths must not contain spaces).
read -r -a VERIFY_CMD <<<"${AWS_INTEGRATION_VERIFY_CMD:-node ${SUITE_DIR}/dist/cleanup-verify.js}"
# pnpm launcher; CI images can set PNPM="corepack pnpm" or "npm exec --yes pnpm@12.11.2 --".
read -r -a PNPM_CMD <<<"${PNPM:-pnpm}"
# AWS CLI for the read-only IAM residue check of cleanup.sh (sandbox mode; overridable for the self-test).
read -r -a AWS_CLI_CMD <<<"${AWS_INTEGRATION_AWS_CLI:-aws}"
# The sandbox helper CLI (prints the finops report's unverifiable categories).
read -r -a SBX_TOOL_CMD <<<"${AWS_INTEGRATION_SBX_TOOL:-node ${SUITE_DIR}/dist/sandbox/cli.js}"

log() { printf '[aws-integration] %s\n' "$*" >&2; }
die() {
  log "ERROR: $*"
  exit "${2:-1}"
}

# Real AWS is opt-in. Exit code 3 = "refused: not enabled" (distinct from failures).
require_enabled() {
  if [[ "${AWS_INTEGRATION_ENABLED:-}" != "true" ]]; then
    log "AWS_INTEGRATION_ENABLED is not 'true' — refusing to touch AWS (nothing was deployed)."
    exit 3
  fi
}

# Region. The run's AWS region is AWS_REGION, else AWS_DEFAULT_REGION (required, as before). The
# CONFIGURED region is AWS_INTEGRATION_REGION, default ap-southeast-1 (STARTER_DEFAULT_REGION of
# region.sh = DEFAULT_AWS_REGION of @starter/config/region). setup_guard refuses (exit 4), before any
# AWS call, a configured region that is not an aws-partition region name and a run region that
# differs from it: targeting another region takes AWS_INTEGRATION_REGION AND AWS_REGION.
require_region() {
  export AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
  [[ -n "$AWS_REGION" ]] || die "AWS_REGION is not set"
}

# Prints the configured region, or refuses (exit 4).
configured_region() {
  declare -F starter_region_ok >/dev/null || die "${REGION_HELPER} is missing — refusing" 4
  local region="${AWS_INTEGRATION_REGION:-${STARTER_DEFAULT_REGION:-}}"
  starter_region_ok "$region" ||
    die "AWS_INTEGRATION_REGION is not an aws-partition region name — refusing (nothing was deployed)" 4
  printf '%s' "$region"
}

# ── Account guard ──────────────────────────────
# Whenever real AWS is enabled the run needs the EXPECTED account: AWS_INTEGRATION_EXPECTED_ACCOUNT
# or the expected-account file. Exit 4 = refused (no or inconsistent expected account / guard
# refused); nothing was deployed.
SANDBOX_HOME="${SANDBOX_HOME:-${HOME}/.config/starter-aws-sandbox}"
EXPECTED_ACCOUNT_FILE="${AWS_INTEGRATION_EXPECTED_ACCOUNT_FILE:-${SANDBOX_HOME}/expected-account}"
# The operator's IAM role ARN (0600; sandbox mode): -c operatorPrincipalArn on every synth (KMS
# key-policy grant, KeyProbeRole trust). ci mode: AWS_INTEGRATION_OPERATOR_PRINCIPAL_ARN, optional.
OPERATOR_ROLE_FILE="${SANDBOX_HOME}/operator-role-arn"
OPERATOR_ARN=""
# finops sweep (tools/aws-sandbox) used by cleanup.sh in sandbox mode.
FINOPS_CLI="${AWS_INTEGRATION_FINOPS_CLI:-${REPO_ROOT}/tools/aws-sandbox/dist/bin.js}"
SANDBOX_GUARD_SCRIPT="${SANDBOX_GUARD_SCRIPT:-${REPO_ROOT}/tools/aws-preflight/scripts/sandbox-guard.sh}"
# Guard mode:
#   sandbox (default outside CI) — the account guard of tools/aws-preflight: sandbox_guard_init
#           pins profile (SANDBOX_PROFILE, default starter-sandbox-developer) and region, and every
#           mutation runs as `guarded "<label>" -- <executable> …` (guard_exec), i.e. after an STS
#           check against the expected account (logged to SANDBOX_GUARD_LOG). The guard accepts
#           executables only (no shell functions), so PNPM must name one (e.g. pnpm on PATH, or
#           PNPM="npm exec --yes pnpm@12.11.2 --");
#   ci      (default when CI=true) — runner-scoped credentials and no AWS CLI: the account is
#           pinned by `-c account=<expected>` (the CDK CLI compares it with the STS caller
#           identity before every deploy/destroy) and cleanup-verify refuses a DeleteStack
#           fallback outside the expected account (--expected-account).
GUARD_MODE="${AWS_INTEGRATION_GUARD:-}"
if [[ -z "$GUARD_MODE" ]]; then
  if [[ "${CI:-}" == "true" ]]; then GUARD_MODE=ci; else GUARD_MODE=sandbox; fi
fi
EXPECTED_ACCOUNT=""

# Account ids are not secrets, but logs show only the last four digits.
mask_account() { printf '********%s' "${1: -4}"; }

require_expected_account() {
  local from_file=""
  if [[ -f "$EXPECTED_ACCOUNT_FILE" ]]; then
    from_file="$(tr -d ' \t\r\n' <"$EXPECTED_ACCOUNT_FILE")"
  fi
  local account="${AWS_INTEGRATION_EXPECTED_ACCOUNT:-$from_file}"
  if [[ -z "$account" ]]; then
    log "no expected account: set AWS_INTEGRATION_EXPECTED_ACCOUNT or create ${EXPECTED_ACCOUNT_FILE} — refusing to touch AWS (nothing was deployed)."
    exit 4
  fi
  if [[ ! "$account" =~ ^[0-9]{12}$ ]]; then
    log "the expected account is not a 12-digit account id — refusing to touch AWS (nothing was deployed)."
    exit 4
  fi
  if [[ -n "$from_file" && "$from_file" != "$account" ]]; then
    log "AWS_INTEGRATION_EXPECTED_ACCOUNT ($(mask_account "$account")) differs from ${EXPECTED_ACCOUNT_FILE} ($(mask_account "$from_file")) — refusing."
    exit 4
  fi
  EXPECTED_ACCOUNT="$account"
  export AWS_INTEGRATION_EXPECTED_ACCOUNT="$account"
}

load_operator_arn() {
  local mode
  if [[ "$GUARD_MODE" == sandbox ]]; then
    [[ -f "$OPERATOR_ROLE_FILE" ]] || die "${OPERATOR_ROLE_FILE} (the operator's role ARN) is missing — refusing" 4
    mode="$(file_mode "$OPERATOR_ROLE_FILE")" || die "cannot read the mode of ${OPERATOR_ROLE_FILE} — refusing" 4
    [[ "$mode" == 600 || "$mode" == 400 ]] || die "${OPERATOR_ROLE_FILE} has mode ${mode}; it must be 0600 — refusing" 4
    OPERATOR_ARN="$(tr -d ' \t\r\n' <"$OPERATOR_ROLE_FILE")"
  else
    OPERATOR_ARN="${AWS_INTEGRATION_OPERATOR_PRINCIPAL_ARN:-}"
    [[ -n "$OPERATOR_ARN" ]] || return 0
  fi
  [[ "$OPERATOR_ARN" =~ ^arn:aws[a-z-]*:iam::([0-9]{12}):role/[A-Za-z0-9+=,.@_/-]+$ ]] ||
    die "the operator principal is not an IAM role ARN — refusing" 4
  [[ "${BASH_REMATCH[1]}" == "$EXPECTED_ACCOUNT" ]] ||
    die "the operator role is not in the expected account — refusing" 4
}

# Resolves the expected account and initialises the guard. The run's region must be the configured
# region (configured_region): anything else is refused before any AWS call.
setup_guard() {
  local region
  region="$(configured_region)" || exit 4
  [[ "$AWS_REGION" == "$region" ]] ||
    die "AWS_REGION must be the configured region ${region} (AWS_INTEGRATION_REGION, default ${STARTER_DEFAULT_REGION}; got ${AWS_REGION}) — refusing" 4
  require_expected_account
  case "$GUARD_MODE" in
    sandbox)
      [[ -f "$SANDBOX_GUARD_SCRIPT" ]] || die "account guard not found: ${SANDBOX_GUARD_SCRIPT}" 4
      [[ -f "$EXPECTED_ACCOUNT_FILE" ]] ||
        die "the account guard reads the expected account from ${EXPECTED_ACCOUNT_FILE}, which is missing" 4
      load_operator_arn
      mkdir -p "$REPORT_DIR"
      export SANDBOX_HOME
      export SANDBOX_PROFILE="${SANDBOX_PROFILE:-starter-sandbox-developer}"
      export SANDBOX_REGION="$region"
      export SANDBOX_EXPECTED_ACCOUNT_FILE="$EXPECTED_ACCOUNT_FILE"
      export SANDBOX_GUARD_LOG="${SANDBOX_GUARD_LOG:-${REPORT_DIR}/guard.log}"
      # shellcheck source=/dev/null
      source "$SANDBOX_GUARD_SCRIPT"
      sandbox_guard_init || die "the account guard refused to initialise" 4
      ;;
    ci) load_operator_arn ;;
    *) die "AWS_INTEGRATION_GUARD must be 'sandbox' or 'ci' (got '${GUARD_MODE}')" 4 ;;
  esac
  log "account guard: mode ${GUARD_MODE}, expected account $(mask_account "$EXPECTED_ACCOUNT")"
}

# guard_exec "<label>" <executable> [args…] — how these scripts run a mutation. sandbox: through
# the guard (`guarded`: STS check, then the executable; shell functions are refused by design);
# ci: the account is pinned by `-c account` / --expected-account, the label is logged.
guard_exec() {
  local label="$1"
  shift
  if [[ "$GUARD_MODE" == sandbox ]]; then
    guarded "$label" -- "$@"
  else
    log "guard(ci): ${label} (account $(mask_account "$EXPECTED_ACCOUNT") pinned via cdk -c account)"
    "$@"
  fi
}

# Must match RUN_ID_PATTERN in infra/stacks/integration-workflow-stack.ts (stack starter-it-<runId>).
RUN_ID_RE='^[a-z0-9]([a-z0-9-]{1,22}[a-z0-9])$'

# Unique, CloudFormation-safe run id: it[-<pipeline>]-<6 hex>  (<= 24 chars)
new_run_id() {
  local rnd
  rnd="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
  printf 'it%s-%s' "${CI_PIPELINE_ID:+-${CI_PIPELINE_ID}}" "$rnd"
}

load_run_env() {
  if [[ -f "$RUN_ENV" ]]; then
    local file_run_id file_expires
    file_run_id="$(sed -n 's/^AWS_INTEGRATION_RUN_ID=//p' "$RUN_ENV")"
    file_expires="$(sed -n 's/^AWS_INTEGRATION_EXPIRES_AT=//p' "$RUN_ENV")"
    if [[ -z "${AWS_INTEGRATION_RUN_ID:-}" || "$AWS_INTEGRATION_RUN_ID" == "$file_run_id" ]]; then
      AWS_INTEGRATION_RUN_ID="$file_run_id"
      AWS_INTEGRATION_EXPIRES_AT="${AWS_INTEGRATION_EXPIRES_AT:-$file_expires}"
    fi
  fi
  [[ -n "${AWS_INTEGRATION_RUN_ID:-}" ]] || die "no run id: set AWS_INTEGRATION_RUN_ID or run deploy.sh first"
  [[ "$AWS_INTEGRATION_RUN_ID" =~ $RUN_ID_RE ]] ||
    die "invalid run id '${AWS_INTEGRATION_RUN_ID}' (3-24 chars [a-z0-9-], alphanumeric at both ends)"
  export AWS_INTEGRATION_RUN_ID AWS_INTEGRATION_EXPIRES_AT
}

pnpm_run() { "${PNPM_CMD[@]}" "$@"; }

# cdk <subcommand> [args...]  — runs the integration app with the run's context, through the
# account guard (deploy and destroy are mutations). expiresAt is passed only on deploy: the app
# rejects a past expiry, and destroy must keep working after the TTL has elapsed. The stack
# environment is pinned to the expected account (the CDK CLI refuses credentials of any other
# account) and to the starter bootstrap.
cdk() {
  local sub="$1"
  shift
  local ctx=(--context "runId=${AWS_INTEGRATION_RUN_ID}" --context "region=${AWS_REGION}")
  [[ -n "$EXPECTED_ACCOUNT" ]] || die "cdk ${sub}: no expected account (setup_guard not called)" 4
  ctx+=(--context "account=${EXPECTED_ACCOUNT}")
  [[ -n "$OPERATOR_ARN" ]] && ctx+=(--context "operatorPrincipalArn=${OPERATOR_ARN}")
  if [[ "$sub" == "deploy" && -n "${AWS_INTEGRATION_EXPIRES_AT:-}" ]]; then
    ctx+=(--context "expiresAt=${AWS_INTEGRATION_EXPIRES_AT}")
  fi
  ctx+=(--context "qualifier=${AWS_INTEGRATION_CDK_QUALIFIER:-starter}")
  [[ -n "${AWS_INTEGRATION_PERMISSIONS_BOUNDARY_ARN:-}" ]] &&
    ctx+=(--context "permissionsBoundaryArn=${AWS_INTEGRATION_PERMISSIONS_BOUNDARY_ARN}")
  # Deploy and destroy alike (the CDK CLI's option parser is not strict; destroy ignores it).
  ctx+=(--toolkit-stack-name "${AWS_INTEGRATION_TOOLKIT_STACK_NAME:-starter-cdk-toolkit}")
  (
    cd "$INFRA_DIR" || exit 1
    guard_exec "cdk ${sub} mini-stack ${AWS_INTEGRATION_RUN_ID}" \
      "${PNPM_CMD[@]}" exec cdk "$sub" --app "$CDK_APP" "${ctx[@]}" "$@"
  )
}

# The CDK app is compiled TypeScript and bundles the real Lambda handlers from functions/*.
build_infra() {
  log "building @starter/infra and its workspace dependencies"
  pnpm_run --filter "@starter/infra..." build >&2
}

ensure_suite_built() {
  if [[ -z "${AWS_INTEGRATION_VERIFY_CMD:-}" && ! -f "${SUITE_DIR}/dist/cleanup-verify.js" ]]; then
    log "building @starter/tests-aws-integration"
    pnpm_run --filter @starter/workflow-processing --filter @starter/tests-aws-integration build >&2
  fi
}
