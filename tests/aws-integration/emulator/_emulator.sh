#!/usr/bin/env bash
# Shared helpers of the MiniStack EMULATOR runs (sourced by ci.sh, up.sh, run.sh, down.sh, all.sh).
#
# THIS IS AN EMULATOR, NOT AWS. Results only say how the integration stack
# behaves on MiniStack; every record carries target "ministack-emulator".
#
# What these scripts guarantee — and what they do not:
#  - Every entry point runs the SHARED emulator guard (infra/lib/emulator-guard.ts, through its CLI)
#    before any `cdk`, SDK or HTTP call: the AWS SDK/CDK of THIS process tree is pointed only at the
#    loopback emulator (or, in GitLab CI, exactly STARTER_EMULATOR_ALLOWED_ENDPOINT) with the fake
#    keys; profiles, tokens, roles, per-service endpoints, proxies, a telemetry endpoint and
#    real-looking keys are refused (exit 5).
#  - The CDK CLI's own phone-home (telemetry, notices, npm version check) is switched off for every
#    `cdk` call (emulator_cli_isolation, cdk_run), and ci.sh PROVES the result: every Node process
#    of the run is preloaded with egress-audit.mjs, which blocks and records any connection or DNS
#    query to anything but the emulator endpoint; the `egress audit` step fails the run on one.
#    Non-Node executables (esbuild, pnpm, sh) are recorded, not intercepted; no container engine
#    is used (CDK_DOCKER is a refusing stub).
#  - That says nothing about the MiniStack IMAGE: it is a third-party process running as root in
#    its container. The default (and the CI service) is therefore SOCKET-LESS: no container-engine
#    socket, no host directory and no credentials are given to it, and the Lambda functions run in
#    its own `local` executor. ci.sh's preflight proves that from inside the service (socket probe).
#  - The real-AWS path (scripts/, the account guard) is never sourced from here.
# Bash 3.2 compatible (macOS /bin/bash).
# shellcheck disable=SC2034  # variables are used by the sourcing scripts

EM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE_DIR="$(cd "${EM_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SUITE_DIR}/../.." && pwd)"
INFRA_DIR="${REPO_ROOT}/infra"

# MiniStack 1.5.26 (released 2026-10-11), pinned by multi-arch index digest (amd64 + arm64).
MINISTACK_VERSION="1.5.26"
MINISTACK_IMAGE_DIGEST="sha256:f90981c85c9b431d819afa8bdad9735d1434e22e42f1deb8c99a0bcaf30363e7"
MINISTACK_IMAGE="docker.io/ministackorg/ministack:${MINISTACK_VERSION}@${MINISTACK_IMAGE_DIGEST}"
# AWS Lambda Node.js 24 base image, tag 24.2026.10.11.12 — ONLY for the opt-in socket mode
# (up.sh --socket-mode), whose docker executor runs every function in the real runtime image.
LAMBDA_NODE_IMAGE_DIGEST="sha256:d7f51a5206c4f2ec79fba12024bfc38fb9a46b38a4b20a76e2b3860a1c5c1bc2"
LAMBDA_NODE_IMAGE="public.ecr.aws/lambda/nodejs@${LAMBDA_NODE_IMAGE_DIGEST}"
IMAGE_PREFIX="localhost/starter-ministack"
LAMBDA_NODE_LOCAL_TAG="${IMAGE_PREFIX}/public.ecr.aws/lambda/nodejs:24"

# Fake identity: MiniStack derives the account id from a 12-digit access key. Same values as
# infra/lib/emulator-guard.ts (EMULATOR_ACCOUNT / EMULATOR_SECRET / EMULATOR_REGION).
EMULATOR_ACCOUNT="000000000001"
EMULATOR_SECRET="ministack-local-only"
EMULATOR_REGION="ap-southeast-1"
EMULATOR_PORT="${STARTER_EMULATOR_PORT:-45660}"
EMULATOR_ENDPOINT="http://127.0.0.1:${EMULATOR_PORT}"
EMULATOR_OPERATOR_ARN="arn:aws:iam::${EMULATOR_ACCOUNT}:role/starter-emulator-operator"
CDK_QUALIFIER="starter"
CDK_TOOLKIT_STACK="starter-cdk-toolkit"

# Exit codes: 5 = refused by the guard (something could reach real AWS), 3 = prerequisite missing
# (workspace not built), 6 = not rootless / unsafe socket mode, 7 = port busy, 1 = failure.
REFUSED_EXIT=5
PREREQ_EXIT=3

# The ROOTLESS Podman connection; never the (rootful) default connection. Local scripts only:
# ci.sh never calls Podman (MiniStack is a GitLab service there).
PODMAN_CONNECTION="${STARTER_EMULATOR_PODMAN_CONNECTION:-podman-machine-default}"
REPORT_ROOT="${STARTER_EMULATOR_REPORT_DIR:-${REPO_ROOT}/reports/aws-integration/emulator}"
LOCAL_RUN_ID_RE='^em-[0-9a-f]{6}$'
read -r -a PNPM_CMD <<<"${PNPM:-pnpm}"

GUARD_CLI="${INFRA_DIR}/dist/lib/emulator-guard-cli.js"
EMULATOR_CI_CLI="${SUITE_DIR}/dist/emulator-ci.js"
RESULTS_CLI="${SUITE_DIR}/dist/emulator-results.js"
CDK_APP_JS="${INFRA_DIR}/dist/bin/integration.js"
BASELINE_FILE="${EM_DIR}/expected-not-applicable.json"
EGRESS_HOOK="${EM_DIR}/egress-audit.mjs"
EGRESS_REPORT="${EM_DIR}/egress-report.mjs"
NO_CONTAINER_ENGINE="${EM_DIR}/no-container-engine.sh"

log() { printf '[emulator] %s\n' "$*" >&2; }
die() {
  log "ERROR: $1"
  exit "${2:-1}"
}

p() { podman --connection "$PODMAN_CONNECTION" "$@"; }

# require_build — the guard and the CLIs are compiled TypeScript; fail fast without them.
require_build() {
  local f missing=""
  for f in "$GUARD_CLI" "$EMULATOR_CI_CLI" "$RESULTS_CLI" "$CDK_APP_JS"; do
    [[ -f "$f" ]] || missing="${missing} ${f#"${REPO_ROOT}/"}"
  done
  [[ -z "$missing" ]] ||
    die "workspace not built (missing:${missing}); run: pnpm --filter '@starter/infra...' --filter '@starter/tests-aws-integration...' build" "$PREREQ_EXIT"
}

# guard <incoming|effective> — the SHARED guard; exit 5 on refusal, before anything else runs.
guard() {
  [[ -f "$GUARD_CLI" ]] ||
    die "the emulator guard is not built (${GUARD_CLI#"${REPO_ROOT}/"}); run: pnpm --filter '@starter/infra...' build" "$PREREQ_EXIT"
  local rc=0
  node "$GUARD_CLI" --phase "$1" >/dev/null || rc=$?
  if [[ $rc -ne 0 ]]; then
    [[ $rc -eq $REFUSED_EXIT ]] &&
      die "refusing: the emulator guard rejected this environment (see above)" "$REFUSED_EXIT"
    die "the emulator guard failed (exit ${rc})" "$rc"
  fi
}

# The incoming environment must already be harmless (unset values are fine).
refuse_real_aws() { guard incoming; }

# Every AWS SDK / CDK call of this process goes to the LOOPBACK emulator with fake static keys; no
# config or credentials file and no instance metadata can supply anything else. (In CI the job
# provides the equivalent environment for the service endpoint; ci.sh does not overwrite it.)
emulator_env() {
  export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null
  export AWS_EC2_METADATA_DISABLED=true
  export AWS_ACCESS_KEY_ID="$EMULATOR_ACCOUNT" AWS_SECRET_ACCESS_KEY="$EMULATOR_SECRET"
  export AWS_REGION="$EMULATOR_REGION" AWS_DEFAULT_REGION="$EMULATOR_REGION"
  export AWS_ENDPOINT_URL="$EMULATOR_ENDPOINT"
}

# emulator_cli_isolation — both modes, after the incoming guard and before any `cdk`/pnpm call: the
# CDK CLI's phone-home off (the values the guard requires: EMULATOR_CLI_ENV), every proxy variable
# removed (the guard refuses any left), no container engine (asset bundling must stay local), and
# no pnpm/corepack network (update check, downloads).
emulator_cli_isolation() {
  export CDK_DISABLE_CLI_TELEMETRY=true CDK_DISABLE_VERSION_CHECK=true
  export CDK_DOCKER="$NO_CONTAINER_ENGINE"
  export npm_config_update_notifier=false COREPACK_ENABLE_NETWORK=0
  local name lower
  for name in $(compgen -e); do
    lower="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
    case "$lower" in
      proxy | http_proxy | https_proxy | all_proxy | npm_config_proxy | npm_config_http_proxy | \
        npm_config_https_proxy | npm_config_all_proxy) unset "$name" ;;
    esac
  done
}

# egress_audit_start <log> <host:port>… — preloads the egress audit into every Node process started
# from here on; only the given emulator host:port pairs may be reached (ci.sh, after the guard).
egress_audit_start() {
  local log="$1" allow
  shift
  [[ "$EGRESS_HOOK" != *[[:space:]]* ]] ||
    die "the egress audit cannot be preloaded from a path with whitespace (${EGRESS_HOOK})" 2
  allow="$(
    IFS=,
    printf '%s' "$*"
  )"
  touch "$log"
  export STARTER_EMULATOR_EGRESS_LOG="$log" STARTER_EMULATOR_EGRESS_ALLOW="$allow"
  case " ${NODE_OPTIONS:-} " in
    *" --import=${EGRESS_HOOK} "*) ;;
    *) export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--import=${EGRESS_HOOK}" ;;
  esac
}

# endpoint_host_port <url> — host:port of an http(s) endpoint URL (default port by scheme).
endpoint_host_port() {
  # shellcheck disable=SC2016  # JavaScript, not shell
  node -e '
    const u = new URL(process.argv[1]);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    process.stdout.write(`${u.hostname.replace(/^\[|\]$/g, "")}:${port}`);' "$1"
}

require_rootless() {
  [[ "$(p info --format '{{.Host.Security.Rootless}}' 2>/dev/null)" == "true" ]] ||
    die "the Podman connection ${PODMAN_CONNECTION} is not rootless (or not reachable)" 6
}

new_run_id() { printf 'em-%s' "$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"; }

container_name() { printf 'starter-ministack-%s' "$1"; }

# load_run [runId] — sets RUN_ID, RUN_DIR, CONTAINER, NETWORK (from the argument, or the last run).
load_run() {
  RUN_ID="${1:-${STARTER_EMULATOR_RUN_ID:-}}"
  if [[ -z "$RUN_ID" && -f "${REPORT_ROOT}/current" ]]; then
    RUN_ID="$(cat "${REPORT_ROOT}/current")"
  fi
  [[ -n "$RUN_ID" ]] || die "no emulator run id (pass one, or run up.sh first)"
  [[ "$RUN_ID" =~ $LOCAL_RUN_ID_RE ]] || die "invalid emulator run id '${RUN_ID}' (expected em-<6 hex>)"
  RUN_DIR="${REPORT_ROOT}/${RUN_ID}"
  CONTAINER="$(container_name "$RUN_ID")"
  NETWORK="$CONTAINER"
  if [[ -f "${RUN_DIR}/run.env" ]]; then
    local port
    port="$(sed -n 's/^EMULATOR_PORT=//p' "${RUN_DIR}/run.env")"
    if [[ -n "$port" ]]; then
      EMULATOR_PORT="$port"
      EMULATOR_ENDPOINT="http://127.0.0.1:${EMULATOR_PORT}"
    fi
  fi
}

emulator_healthy() {
  curl -fsS --max-time 3 "${EMULATOR_ENDPOINT}/_ministack/health" 2>/dev/null |
    grep -q "\"version\": *\"${MINISTACK_VERSION}\""
}

# ── CDK against the emulator (callers have passed the guard and exported the emulator env) ──────

cdk_bin() { printf '%s' "${INFRA_DIR}/node_modules/.bin/cdk"; }

# cdk_home_prepare — a private, empty HOME for the `cdk` calls of this run (outside the artifacts).
cdk_home_prepare() {
  CDK_ISOLATED_HOME="$(mktemp -d "${TMPDIR:-/tmp}/starter-emulator-cdk-home.XXXXXX")" || return
  chmod 700 "$CDK_ISOLATED_HOME"
  export CDK_ISOLATED_HOME
}

# cdk_run <dir> <cdk args…> — EVERY emulator `cdk` call: the infra package's CLI with its esbuild on
# PATH (NodejsFunction bundles locally), run from <dir> with an isolated HOME/CDK_HOME (no
# ~/.cdk.json: its proxy, plugin or context settings never apply), and the phone-home switches on
# the command line as well: --no-notices (notices.json is never fetched) and cli-telemetry=false.
# Callers have passed the guard (effective phase) and emulator_cli_isolation.
cdk_run() {
  local dir="$1"
  shift
  [[ -n "${CDK_ISOLATED_HOME:-}" && -d "${CDK_ISOLATED_HOME}" ]] ||
    die "cdk_run: no isolated HOME (cdk_home_prepare was not called)"
  (cd "$dir" && HOME="$CDK_ISOLATED_HOME" CDK_HOME="${CDK_ISOLATED_HOME}/.cdk" \
    PATH="${INFRA_DIR}/node_modules/.bin:${PATH}" \
    "$(cdk_bin)" "$@" --no-notices --context cli-telemetry=false)
}

# emulator_bootstrap <work dir> — the project's qualifier, from an empty directory (no app). There
# is no infra/cdk.json there, so its own cdk.json repeats the phone-home switches.
emulator_bootstrap() {
  local boot_dir rc=0
  boot_dir="$(mktemp -d "${1}/bootstrap.XXXXXX")" || return
  printf '%s\n' '{ "notices": false, "context": { "cli-telemetry": false } }' >"${boot_dir}/cdk.json"
  cdk_run "$boot_dir" bootstrap "aws://${EMULATOR_ACCOUNT}/${EMULATOR_REGION}" \
    --qualifier "$CDK_QUALIFIER" --toolkit-stack-name "$CDK_TOOLKIT_STACK" >&2 || rc=$?
  rm -rf "$boot_dir"
  return "$rc"
}

# emulator_synth <runId> <cdk.out dir> [appVersion] — the emulator variant of the integration app.
emulator_synth() {
  local app_version_args=()
  [[ -n "${3:-}" ]] && app_version_args=(--context "appVersion=${3}")
  cdk_run "$INFRA_DIR" synth --app "node dist/bin/integration.js" \
    --context "runId=${1}" --context "account=${EMULATOR_ACCOUNT}" \
    --context "region=${EMULATOR_REGION}" --context "qualifier=${CDK_QUALIFIER}" \
    --context target=emulator --context "operatorPrincipalArn=${EMULATOR_OPERATOR_ARN}" \
    ${app_version_args[@]+"${app_version_args[@]}"} \
    --output "$2" --quiet >/dev/null
}

# emulator_deploy <cdk.out dir> [outputs file] — deploys exactly the synthesized assembly.
emulator_deploy() {
  local outputs_args=()
  [[ -n "${2:-}" ]] && outputs_args=(--outputs-file "$2")
  cdk_run "$INFRA_DIR" deploy --app "$1" \
    --toolkit-stack-name "$CDK_TOOLKIT_STACK" --require-approval never \
    ${outputs_args[@]+"${outputs_args[@]}"} >&2
}

# emulator_destroy <cdk.out dir>
emulator_destroy() {
  cdk_run "$INFRA_DIR" destroy --app "$1" --force >&2
}

# require_emulator_target <outputs file> — the deployed stack must be the emulator variant.
require_emulator_target() {
  grep -q '"DeployTarget": *"ministack-emulator"' "$1" ||
    die "the deployed stack is not the emulator variant (DeployTarget != ministack-emulator)"
}
