/**
 * Offline stand-in for tools/aws-preflight/scripts/sandbox-guard.sh used by the lifecycle
 * self-tests. The STS call is replaced by a log line, but everything the CALLING scripts must get
 * right is enforced like the real helper does:
 *   - sandbox_guard_init needs SANDBOX_PROFILE (never "default"), SANDBOX_GUARD_LOG and the
 *     expected-account file, and pins AWS_PROFILE / AWS_REGION / AWS_DEFAULT_REGION (SANDBOX_REGION,
 *     default ap-southeast-1);
 *   - a label is one line of at most 200 characters without an account id;
 *   - guarded "<label>" -- <command>: the command must be an executable (shell functions, builtins
 *     and aliases are refused), not a shell or wrapper (sh, bash, env, timeout, nohup, nix, …) nor
 *     an interpreter given inline code (node -e, python -c, …), and must not select another
 *     --profile/--region (abbreviations such as --prof/--reg included), override --endpoint-url
 *     or assign AWS_*; it runs with `exec` in a subshell and its exit code is returned unchanged;
 *     the guard's own output goes to stderr.
 * The real helper itself runs in sandbox-real-guard.test.ts (Phase 2) and lifecycle-scripts.test.ts
 * (Phase 1), so this stand-in cannot hide a shape the real guard refuses.
 * Every check is appended to $FAKE_LOG as `GUARD <label>`, every guarded command is bracketed by
 * `GUARD-BEGIN <label>` / `GUARD-END <label>`, so a test can prove that each mutation ran inside
 * the guard. FAKE_GUARD_REFUSE=<substring> makes checks of matching labels fail like an account
 * mismatch (exit 3).
 */
export const FAKE_GUARD = `#!/usr/bin/env bash
_fake_guard_fail() {
  printf 'sandbox-guard: REFUSED (exit %s) — %s\\n' "$1" "$2" >&2
  exit "$1"
}
sandbox_guard_init() {
  [[ -n "\${SANDBOX_PROFILE:-}" && "\${SANDBOX_PROFILE}" != default ]] ||
    _fake_guard_fail 11 "select the sandbox profile explicitly (SANDBOX_PROFILE)"
  [[ -n "\${SANDBOX_GUARD_LOG:-}" ]] || _fake_guard_fail 2 "SANDBOX_GUARD_LOG must name the run's guard log"
  local account_file="\${SANDBOX_EXPECTED_ACCOUNT_FILE:-\${SANDBOX_HOME:-$HOME/.config/starter-aws-sandbox}/expected-account}"
  [[ -f "$account_file" ]] || _fake_guard_fail 2 "expected-account file missing"
  echo "GUARD-INIT log=\${SANDBOX_GUARD_LOG} profile=\${SANDBOX_PROFILE}" >> "$FAKE_LOG"
  local region="\${SANDBOX_REGION:-ap-southeast-1}"
  export AWS_PROFILE="$SANDBOX_PROFILE" AWS_REGION="$region" AWS_DEFAULT_REGION="$region"
  sandbox_guard sandbox_guard_init
}
sandbox_guard() {
  [[ $# -eq 1 && -n "$1" && \${#1} -le 200 && "$1" != *$'\\n'* ]] || _fake_guard_fail 2 "bad label"
  [[ ! "$1" =~ [0-9]{12} ]] || _fake_guard_fail 2 "the label contains an account id"
  echo "GUARD $1" >> "$FAKE_LOG"
  if [[ -n "\${FAKE_GUARD_REFUSE:-}" && "$1" == *"$FAKE_GUARD_REFUSE"* ]]; then
    printf 'sandbox-guard: STOP — the guard refused "%s" (exit 3); nothing was run\\n' "$1" >&2
    exit 3
  fi
  echo '{"result":"verified","account":"********3333"}' >&2
}
guarded() {
  [[ $# -ge 3 && "$2" == "--" ]] || _fake_guard_fail 2 'usage: guarded "<label>" -- <command> [args...]'
  local label="$1"
  shift 2
  local cmd="$1" prev="" arg
  [[ "$cmd" != -* ]] || _fake_guard_fail 2 "guarded: the command must not start with -"
  if [[ "$cmd" == */* ]]; then
    [[ -f "$cmd" && -x "$cmd" ]] || _fake_guard_fail 2 "guarded: \${cmd} is not an executable file"
  elif [[ -z "$(type -P -- "$cmd" || true)" ]]; then
    _fake_guard_fail 2 "guarded: \${cmd} is not an executable on PATH (shell functions, builtins and aliases are refused)"
  fi
  case "\${cmd##*/}" in
    sh | bash | zsh | dash | ksh | mksh | fish | csh | tcsh | env | sudo | doas | su | xargs | \
      timeout | gtimeout | nohup | nice | ionice | stdbuf | chrt | taskset | setsid | time | \
      command | nix | coreutils | busybox | script | watch | flock | chroot | unshare | \
      caffeinate | arch | deno | bun | osascript) _fake_guard_fail 2 "guarded: \${cmd##*/} is refused" ;;
    python | python[0-9]* | node | nodejs | perl | perl[0-9]* | ruby | php | lua | lua[0-9]*)
      for arg in "\${@:2}"; do
        case "$arg" in
          --eval | --eval=* | --print | --print=* | --command | --command=* | -[ceEp] | -[A-Za-z]*[ceEp])
            _fake_guard_fail 2 "guarded: \${cmd##*/} with inline code is refused" ;;
          -*) ;;
          *) break ;;
        esac
      done ;;
  esac
  local name opt
  for arg in "$@"; do
    if [[ -n "$prev" ]]; then
      [[ "$prev" == profile && "$arg" != "$AWS_PROFILE" ]] && _fake_guard_fail 12 "guarded: another --profile"
      [[ "$prev" == region && "$arg" != ap-southeast-1 ]] && _fake_guard_fail 10 "guarded: another --region"
      prev=""
      continue
    fi
    case "$arg" in
      AWS_*=*) _fake_guard_fail 12 "guarded: AWS_* assignment" ;;
    esac
    [[ "$arg" == --?* ]] || continue
    # AWS CLI argparse prefix matching: --prof / --reg / --endp count as the full option.
    name="\${arg#--}"
    name="\${name%%=*}"
    [[ \${#name} -ge 3 ]] || continue
    opt=""
    if [[ "profile" == "$name"* ]]; then opt=profile
    elif [[ "region" == "$name"* ]]; then opt=region
    elif [[ "endpoint-url" == "$name"* ]]; then _fake_guard_fail 12 "guarded: --endpoint-url"
    fi
    [[ -n "$opt" ]] || continue
    if [[ "$arg" == *=* ]]; then
      [[ "$opt" == profile && "\${arg#*=}" != "$AWS_PROFILE" ]] && _fake_guard_fail 12 "guarded: another --profile"
      [[ "$opt" == region && "\${arg#*=}" != ap-southeast-1 ]] && _fake_guard_fail 10 "guarded: another --region"
    else
      prev="$opt"
    fi
  done
  sandbox_guard "$label"
  echo "GUARD-BEGIN $label" >> "$FAKE_LOG"
  local rc=0
  (
    export AWS_PROFILE AWS_REGION AWS_DEFAULT_REGION
    exec -- "$@"
  ) || rc=$?
  echo "GUARD-END $label" >> "$FAKE_LOG"
  return "$rc"
}
`;

const AWS_MUTATION =
  /^(create|delete|put|update|register|deregister|run|start|stop|schedule|batch-delete|tag|untag)/;

/** Whether a `CALL <tool> <args>` line of the fakes' call log is an AWS mutation. */
export function isMutation(line: string): boolean {
  const m = /^CALL (\S+) (.*)$/.exec(line);
  if (!m) return false;
  const tool = m[1] as string;
  const rest = m[2] as string;
  if (tool === 'pnpm') return /exec cdk (deploy|destroy|bootstrap)/.test(rest);
  if (tool === 'skopeo') return /^copy /.test(rest) && / docker:\/\/\S+$/.test(rest);
  if (tool !== 'aws') return false;
  // `aws [--profile P] [--region R] [--no-cli-pager] <service> <operation> …`
  const words = rest.split(' ');
  const positional: string[] = [];
  for (let i = 0; i < words.length && positional.length < 2; i += 1) {
    const w = words[i] as string;
    if (w === '--profile' || w === '--region') i += 1;
    else if (!w.startsWith('--')) positional.push(w);
  }
  const [service, op] = positional;
  if (service === 's3') return ['cp', 'sync', 'rm', 'mv', 'mb', 'rb'].includes(op ?? '');
  return AWS_MUTATION.test(op ?? '');
}

/** Mutations of the call log that ran outside a GUARD-BEGIN/END bracket (must be none). */
export function unguardedMutations(lines: readonly string[]): string[] {
  let depth = 0;
  const bad: string[] = [];
  for (const l of lines) {
    if (l.startsWith('GUARD-BEGIN ')) depth += 1;
    else if (l.startsWith('GUARD-END ')) depth = Math.max(0, depth - 1);
    else if (isMutation(l) && depth === 0) bad.push(l);
  }
  return bad;
}
