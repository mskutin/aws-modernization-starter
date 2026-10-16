#!/bin/sh
# Installs the git hooks declared in lefthook.yml as small wrappers that run lefthook from the
# checkout git runs them in. Called by `pnpm install` (root `prepare`); safe to re-run.
#
#   sh scripts/git-hooks/install.sh               install / refresh
#   sh scripts/git-hooks/install.sh --uninstall   remove the hooks this script installed
#
# Why not `lefthook install`: its hooks embed the absolute path of the lefthook binary of the
# checkout that installed them. Worktrees share one hooks directory, so a hook installed from one
# worktree would keep pointing into it. These wrappers contain no absolute paths.
#
# Hooks are an optional local convenience; GitLab CI re-runs every check. Nothing is installed
# when LEFTHOOK=0, outside a git checkout, or when core.hooksPath is set (that directory may be
# shared with other repositories). Existing hooks that neither this script nor lefthook wrote are
# left alone. Skip one run of a hook: LEFTHOOK=0 git commit ...
set -eu

MARKER='installed by scripts/git-hooks/install.sh'
say() { printf 'git hooks: %s\n' "$*" >&2; }

mode=install
case "${1:-}" in
  "") ;;
  --uninstall) mode=uninstall ;;
  *)
    say "usage: $0 [--uninstall]"
    exit 2
    ;;
esac

if [ "$mode" = install ] && [ "${LEFTHOOK:-1}" = 0 ]; then
  say "LEFTHOOK=0: not installing"
  exit 0
fi
if ! top=$(git rev-parse --show-toplevel 2>/dev/null); then
  say "not a git checkout: nothing to do"
  exit 0
fi
if hooks_path=$(git config --get core.hooksPath 2>/dev/null) && [ -n "$hooks_path" ]; then
  say "core.hooksPath is set ($hooks_path): not touching it; hooks are optional (CI runs every check)"
  exit 0
fi
hooks_dir=$(git rev-parse --git-path hooks)
mkdir -p "$hooks_dir"

# Git hooks that lefthook.yml configures (top-level keys).
hooks=$(sed -n -E 's/^(pre-commit|prepare-commit-msg|commit-msg|post-commit|post-checkout|post-merge|pre-rebase|pre-push):.*/\1/p' "$top/lefthook.yml")
[ -n "$hooks" ] || {
  say "no git hooks configured in lefthook.yml"
  exit 0
}

for hook in $hooks; do
  target="$hooks_dir/$hook"
  if [ "$mode" = uninstall ]; then
    if [ -f "$target" ] && grep -q "$MARKER" "$target"; then
      rm -f "$target"
      say "removed $hook"
    fi
    continue
  fi
  # Ours (refresh) or an earlier `lefthook install` (replace: it holds absolute paths).
  if [ -e "$target" ] && ! grep -q -e "$MARKER" -e 'call_lefthook' "$target"; then
    say "$hook: an existing hook was not written by this script or lefthook; left unchanged"
    continue
  fi
  tmp="$target.tmp.$$"
  cat >"$tmp" <<EOF
#!/bin/sh
# $hook: $MARKER (from lefthook.yml).
# Runs lefthook of the checkout git runs this hook in; no absolute paths, so worktrees that share
# this hooks directory each use their own node_modules. Skip once: LEFTHOOK=0 git ...
# GitLab CI re-runs every check; these hooks are a local convenience.
[ "\${LEFTHOOK:-1}" = 0 ] && exit 0
top=\$(git rev-parse --show-toplevel) || exit 1
if [ -n "\${LEFTHOOK_BIN:-}" ]; then exec "\$LEFTHOOK_BIN" run $hook "\$@"; fi
if [ -x "\$top/node_modules/.bin/lefthook" ]; then exec "\$top/node_modules/.bin/lefthook" run $hook "\$@"; fi
if command -v lefthook >/dev/null 2>&1; then exec lefthook run $hook "\$@"; fi
echo "$hook: lefthook not found (run pnpm install in \$top); hook skipped, CI runs every check" >&2
exit 0
EOF
  chmod 755 "$tmp"
  mv -f "$tmp" "$target"
  say "installed $hook"
done
