# shellcheck shell=bash
# Account guard for every mutating AWS command of a personal-sandbox run
# (tools/aws-preflight/README.md "Mutation guard").
#
#   source tools/aws-preflight/scripts/sandbox-guard.sh
#   sandbox_guard_init            # checks the environment, pins AWS_PROFILE / AWS_REGION /
#                                 # AWS_DEFAULT_REGION, runs a first STS check
#   sandbox_guard "<label>"       # STS check now; dies on any refusal; appends to the guard log
#   guarded "<label>" -- cmd ...  # sandbox_guard, then cmd (an executable, never eval'd; no shell,
#                                 # wrapper or inline interpreter code; no other --profile/--region,
#                                 # no --endpoint-url, abbreviations included), with the pinned
#                                 # variables; returns cmd's exit code unchanged
#
# Configuration (sandbox_guard_init options win over the environment):
#   --profile <name>                SANDBOX_PROFILE          required; never "default"
#   --region <region>               SANDBOX_REGION           default ap-southeast-1 (STARTER_DEFAULT_REGION
#                                                            of region.sh); any aws-partition region
#   --expected-account-file <file>  SANDBOX_EXPECTED_ACCOUNT_FILE
#                                   default ${SANDBOX_HOME:-$HOME/.config/starter-aws-sandbox}/expected-account
#   --log <file>                    SANDBOX_GUARD_LOG        required (the run's guard.log)
#   --expected-role-pattern <glob>  SANDBOX_ROLE_PATTERN     optional, e.g. 'AWSReservedSSO_<set>_*'
#
# Every check runs `node dist/guard-cli.js check` (build first: pnpm --filter
# @starter/tool-aws-preflight build): one sts get-caller-identity through the pinned AWS CLI (the
# first `aws` on PATH, exactly 2.35.11). Its JSON line goes to stderr, so the stdout of a guarded
# command stays clean. Exit codes are the guard's (README): 2 usage, 3 account mismatch,
# 4 principal, 6 SSO expired, 10 region, 11 profile, 12 environment, 13 STS failure, 14 AWS CLI,
# 15 ~/.aws configuration, 16 log, 17 guard not built / stale. A refusal exits the script; in an
# interactive shell the function returns the code instead. Inside $(...) or a pipeline a refusal
# ends only that subshell: capture with a plain assignment under set -e (out="$(guarded ...)"),
# never `local out=$(...)` (hides the status), and never pipe guarded.

if [ -z "${BASH_VERSION:-}" ]; then
  echo 'sandbox-guard.sh: bash is required' >&2
  # `return` ends a sourced file; `exit` is for a shell that executes it instead.
  # shellcheck disable=SC2317
  return 2 2>/dev/null || exit 2
fi
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf 'sandbox-guard.sh must be sourced, not executed: source %s\n' "$0" >&2
  exit 2
fi

# The region default and rules (region.sh next to this file). Missing: every init refuses (exit 17).
if [[ -f "$(dirname "${BASH_SOURCE[0]}")/region.sh" ]]; then
  # shellcheck source=region.sh
  source "$(dirname "${BASH_SOURCE[0]}")/region.sh"
fi

_sandbox_guard_fail() {
  local code="$1"
  shift
  printf 'sandbox-guard: REFUSED (exit %s) — %s\n' "$code" "$*" >&2
  case "$-" in
    *i*) return "$code" ;;
  esac
  exit "$code"
}

# Refuses static keys, profile/credential/config/endpoint/model redirects, and an AWS_PROFILE,
# AWS_REGION or AWS_DEFAULT_REGION that differs from the selection. Names only, never values.
_sandbox_guard_env_check() {
  local profile="$1" region="$2" name found=""
  for name in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN; do
    if [[ -n "${!name+x}" ]]; then found="${found} ${name}"; fi
  done
  if [[ -n "$found" ]]; then
    _sandbox_guard_fail 12 "static credentials in the environment (${found# }); unset them" || return $?
  fi
  for name in AWS_DEFAULT_PROFILE AWS_ROLE_ARN AWS_WEB_IDENTITY_TOKEN_FILE \
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI \
    AWS_CONTAINER_AUTHORIZATION_TOKEN AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE \
    AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE AWS_DATA_PATH PYTHONPATH \
    $(compgen -v AWS_ENDPOINT_URL || true); do
    if [[ -n "${!name+x}" ]]; then found="${found} ${name}"; fi
  done
  if [[ -n "$found" ]]; then
    _sandbox_guard_fail 12 "the environment selects another profile, credential source, configuration, endpoint or model (${found# }); unset them" || return $?
  fi
  if [[ -n "${AWS_PROFILE+x}" && "${AWS_PROFILE}" != "$profile" ]]; then
    _sandbox_guard_fail 12 "AWS_PROFILE is set to a different profile than the selected one" || return $?
  fi
  for name in AWS_REGION AWS_DEFAULT_REGION; do
    if [[ -n "${!name+x}" && "${!name}" != "$region" ]]; then
      _sandbox_guard_fail 10 "${name} is set to a different region than ${region}" || return $?
    fi
  done
}

sandbox_guard_init() {
  local profile="${SANDBOX_PROFILE:-}" region="${SANDBOX_REGION:-${STARTER_DEFAULT_REGION:-}}"
  local account_file="${SANDBOX_EXPECTED_ACCOUNT_FILE:-}" log_file="${SANDBOX_GUARD_LOG:-}"
  local role_pattern="${SANDBOX_ROLE_PATTERN:-}"
  local sandbox_home="${SANDBOX_HOME:-${HOME:-}/.config/starter-aws-sandbox}"
  while [[ $# -gt 0 ]]; do
    if [[ $# -lt 2 ]]; then
      _sandbox_guard_fail 2 "sandbox_guard_init: $1 needs a value" || return $?
    fi
    case "$1" in
      --profile) profile="$2" ;;
      --region) region="$2" ;;
      --expected-account-file) account_file="$2" ;;
      --log) log_file="$2" ;;
      --expected-role-pattern) role_pattern="$2" ;;
      *) _sandbox_guard_fail 2 "sandbox_guard_init: unknown option $1" || return $? ;;
    esac
    shift 2
  done
  if [[ -z "${profile//[[:space:]]/}" ]]; then
    _sandbox_guard_fail 11 "select the sandbox profile explicitly (SANDBOX_PROFILE or --profile)" || return $?
  fi
  if [[ "$profile" == "default" ]]; then
    _sandbox_guard_fail 11 "the default profile is never used; select the sandbox profile by name" || return $?
  fi
  if ! [[ "$profile" =~ ^[A-Za-z0-9_.+][A-Za-z0-9_.+-]{0,63}$ ]]; then
    _sandbox_guard_fail 11 "invalid profile name" || return $?
  fi
  if ! declare -F starter_region_ok >/dev/null; then
    _sandbox_guard_fail 17 "region.sh (next to sandbox-guard.sh) is missing" || return $?
  fi
  if ! starter_region_ok "$region"; then
    _sandbox_guard_fail 10 "the region must be an aws-partition region name (SANDBOX_REGION or --region)" || return $?
  fi
  if [[ -z "$log_file" ]]; then
    _sandbox_guard_fail 2 "SANDBOX_GUARD_LOG (or --log) must name the run's guard log" || return $?
  fi
  [[ -n "$account_file" ]] || account_file="${sandbox_home}/expected-account"
  [[ "$account_file" == /* ]] || account_file="${PWD}/${account_file}"
  [[ "$log_file" == /* ]] || log_file="${PWD}/${log_file}"
  if [[ -n "${_SANDBOX_GUARD_READY:-}" ]] &&
    [[ "$profile" != "$_SANDBOX_GUARD_PROFILE" || "$region" != "$_SANDBOX_GUARD_REGION" ||
      "$account_file" != "$_SANDBOX_GUARD_ACCOUNT_FILE" || "$log_file" != "$_SANDBOX_GUARD_LOG_FILE" ||
      "$role_pattern" != "$_SANDBOX_GUARD_ROLE_PATTERN" ]]; then
    _sandbox_guard_fail 2 "already initialized with a different selection in this shell" || return $?
  fi
  _sandbox_guard_env_check "$profile" "$region" || return $?

  # The guard CLI next to this file (BASH_SOURCE of a function is the file that defined it).
  local tool_dir cli node
  tool_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cli="${tool_dir}/dist/guard-cli.js"
  if [[ ! -f "$cli" ]]; then
    _sandbox_guard_fail 17 "dist/guard-cli.js is missing; run: pnpm --filter @starter/tool-aws-preflight build" || return $?
  fi
  node="$(type -P node || true)"
  if [[ -z "$node" ]]; then
    _sandbox_guard_fail 17 "node is not on PATH" || return $?
  fi

  if [[ -z "${_SANDBOX_GUARD_READY:-}" ]]; then
    readonly _SANDBOX_GUARD_PROFILE="$profile" _SANDBOX_GUARD_REGION="$region"
    readonly _SANDBOX_GUARD_ACCOUNT_FILE="$account_file" _SANDBOX_GUARD_LOG_FILE="$log_file"
    readonly _SANDBOX_GUARD_ROLE_PATTERN="$role_pattern"
    readonly _SANDBOX_GUARD_CLI="$cli" _SANDBOX_GUARD_NODE="$node" _SANDBOX_GUARD_READY=1
  fi
  export AWS_PROFILE="$profile" AWS_REGION="$region" AWS_DEFAULT_REGION="$region"
  sandbox_guard "sandbox_guard_init" || return $?
}

sandbox_guard() {
  if [[ -z "${_SANDBOX_GUARD_READY:-}" ]]; then
    _sandbox_guard_fail 2 "call sandbox_guard_init first" || return $?
  fi
  if [[ $# -ne 1 || -z "${1//[[:space:]]/}" ]]; then
    _sandbox_guard_fail 2 'usage: sandbox_guard "<label>"' || return $?
  fi
  local label="$1" rc=0
  if [[ "$label" == *[[:cntrl:]]* || ${#label} -gt 200 ]]; then
    _sandbox_guard_fail 2 "the label must be one line of at most 200 characters" || return $?
  fi
  _sandbox_guard_env_check "$_SANDBOX_GUARD_PROFILE" "$_SANDBOX_GUARD_REGION" || return $?
  if [[ "${AWS_PROFILE:-}" != "$_SANDBOX_GUARD_PROFILE" ]]; then
    _sandbox_guard_fail 12 "AWS_PROFILE no longer holds the pinned profile" || return $?
  fi
  if [[ "${AWS_REGION:-}" != "$_SANDBOX_GUARD_REGION" || "${AWS_DEFAULT_REGION:-}" != "$_SANDBOX_GUARD_REGION" ]]; then
    _sandbox_guard_fail 10 "AWS_REGION / AWS_DEFAULT_REGION no longer hold the pinned region" || return $?
  fi
  local args=(check --execution-profile personal-sandbox --profile "$_SANDBOX_GUARD_PROFILE"
    --expected-account-file "$_SANDBOX_GUARD_ACCOUNT_FILE" --region "$_SANDBOX_GUARD_REGION"
    --label "$label" --log "$_SANDBOX_GUARD_LOG_FILE")
  if [[ -n "$_SANDBOX_GUARD_ROLE_PATTERN" ]]; then
    args+=(--expected-role-pattern "$_SANDBOX_GUARD_ROLE_PATTERN")
  fi
  # NODE_OPTIONS could preload code into the guard itself.
  env -u NODE_OPTIONS "$_SANDBOX_GUARD_NODE" "$_SANDBOX_GUARD_CLI" "${args[@]}" >&2 || rc=$?
  if [[ $rc -ne 0 ]]; then
    printf 'sandbox-guard: STOP — the guard refused "%s" (exit %s); nothing was run\n' "$label" "$rc" >&2
    case "$-" in
      *i*) return "$rc" ;;
    esac
    exit "$rc"
  fi
}

# The guarded command must use the pinned selection. AWS CLI 2.35.11 parses options with argparse
# prefix matching, so an abbreviation of at least three characters (--prof, --reg, --endp) counts
# as the option: --profile / --region (or an abbreviation) only with the pinned value, no
# --endpoint-url (or an abbreviation), no AWS_*=... assignment (for a wrapper such as env).
# A best-effort check against mistakes, not a sandbox: an executable can still do anything.
_sandbox_guard_pinned_value() {
  if [[ "$1" == "profile" && "$2" != "$_SANDBOX_GUARD_PROFILE" ]]; then
    _sandbox_guard_fail 12 "guarded: the command selects another profile (--${3})" || return $?
  fi
  if [[ "$1" == "region" && "$2" != "$_SANDBOX_GUARD_REGION" ]]; then
    _sandbox_guard_fail 10 "guarded: the command selects another region (--${3})" || return $?
  fi
}

_sandbox_guard_args_check() {
  local expect="" given="" arg name opt
  for arg in "$@"; do
    if [[ -n "$expect" ]]; then
      _sandbox_guard_pinned_value "$expect" "$arg" "$given" || return $?
      expect=""
      continue
    fi
    case "$arg" in
      AWS_*=*)
        _sandbox_guard_fail 12 "guarded: the command line assigns an AWS_* variable" || return $?
        ;;
    esac
    [[ "$arg" == --?* ]] || continue
    name="${arg#--}"
    name="${name%%=*}"
    [[ ${#name} -ge 3 ]] || continue
    opt=""
    if [[ "profile" == "$name"* ]]; then
      opt="profile"
    elif [[ "region" == "$name"* ]]; then
      opt="region"
    elif [[ "endpoint-url" == "$name"* ]]; then
      _sandbox_guard_fail 12 "guarded: the command overrides the endpoint (--${name})" || return $?
    fi
    [[ -n "$opt" ]] || continue
    if [[ "$arg" == *=* ]]; then
      _sandbox_guard_pinned_value "$opt" "${arg#*=}" "$name" || return $?
    else
      expect="$opt"
      given="$name"
    fi
  done
}

# Follows symbolic links (bash 3.2 and BSD readlink have no -f), so a link named otherwise
# (myenv -> env) is judged by its target's name.
_sandbox_guard_resolve() {
  local path="$1" target hops=0
  while [[ -L "$path" && $hops -lt 40 ]]; do
    target="$(readlink "$path")" || break
    case "$target" in
      /*) path="$target" ;;
      *) path="$(dirname "$path")/${target}" ;;
    esac
    hops=$((hops + 1))
  done
  printf '%s\n' "$path"
}

# Shells, command runners and environment rewriters cannot be guarded: they run any command or
# can drop the pinned variables.
_sandbox_guard_wrapper() {
  case "$1" in
    sh | bash | zsh | dash | ksh | mksh | fish | csh | tcsh | env | sudo | doas | su | xargs | \
      timeout | gtimeout | nohup | nice | ionice | stdbuf | chrt | taskset | setsid | time | \
      command | nix | coreutils | busybox | script | watch | flock | chroot | unshare | \
      caffeinate | arch | deno | bun | osascript) return 0 ;;
  esac
  return 1
}

# An interpreter given inline code (python3 -c, node -e/-p, perl -e, ruby -e) before its first
# non-option argument; running a script file stays allowed.
_sandbox_guard_inline_code() {
  local base="$1" arg
  shift
  case "$base" in
    python | python[0-9]* | node | nodejs | perl | perl[0-9]* | ruby | php | lua | lua[0-9]*) ;;
    *) return 1 ;;
  esac
  for arg in "$@"; do
    case "$arg" in
      --eval | --eval=* | --print | --print=* | --command | --command=*) return 0 ;;
      --*) ;;
      -[ceEp] | -[A-Za-z]*[ceEp]) return 0 ;;
      -*) ;;
      *) return 1 ;;
    esac
  done
  return 1
}

guarded() {
  if [[ $# -lt 3 || "$2" != "--" ]]; then
    _sandbox_guard_fail 2 'usage: guarded "<label>" -- <command> [args...]' || return $?
  fi
  local label="$1"
  shift 2
  local cmd="$1"
  if [[ "$cmd" == -* ]]; then
    _sandbox_guard_fail 2 "guarded: the command must not start with -" || return $?
  fi
  if [[ "$cmd" == */* ]]; then
    if [[ ! -f "$cmd" || ! -x "$cmd" ]]; then
      _sandbox_guard_fail 2 "guarded: ${cmd} is not an executable file" || return $?
    fi
  elif [[ -z "$(type -P -- "$cmd" || true)" ]]; then
    _sandbox_guard_fail 2 "guarded: ${cmd} is not an executable on PATH (shell functions, builtins and aliases are refused)" || return $?
  fi
  local path base resolved
  if [[ "$cmd" == */* ]]; then path="$cmd"; else path="$(type -P -- "$cmd")"; fi
  base="${cmd##*/}"
  resolved="$(_sandbox_guard_resolve "$path")"
  resolved="${resolved##*/}"
  if _sandbox_guard_wrapper "$base" || _sandbox_guard_wrapper "$resolved"; then
    _sandbox_guard_fail 2 "guarded: ${base} is refused (a shell or wrapper can run any command or change the pinned variables)" || return $?
  fi
  if _sandbox_guard_inline_code "$base" "${@:2}" || _sandbox_guard_inline_code "$resolved" "${@:2}"; then
    _sandbox_guard_fail 2 "guarded: ${base} with inline code is refused (run a script file instead)" || return $?
  fi
  if [[ -n "${_SANDBOX_GUARD_READY:-}" ]]; then
    _sandbox_guard_args_check "$@" || return $?
  fi
  sandbox_guard "$label" || return $?
  local rc=0
  (
    export AWS_PROFILE="$_SANDBOX_GUARD_PROFILE" AWS_REGION="$_SANDBOX_GUARD_REGION"
    export AWS_DEFAULT_REGION="$_SANDBOX_GUARD_REGION"
    exec -- "$@"
  ) || rc=$?
  return "$rc"
}
