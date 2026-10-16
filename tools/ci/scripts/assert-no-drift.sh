#!/bin/sh
# usage: assert-no-drift.sh <report-dir> <path>...
# Fails when generated files under <path> differ from what is committed.
set -eu
out="$1"
shift
mkdir -p "$out"
changes="$(git status --porcelain -- "$@")"
if [ -n "$changes" ]; then
  printf '%s\n' "$changes" > "$out/drift-files.txt"
  git --no-pager diff -- "$@" > "$out/drift.diff" || true
  cat "$out/drift.diff"
  echo "ERROR: generated files are out of date ($*). Regenerate them and commit the result:" >&2
  printf '%s\n' "$changes" >&2
  exit 1
fi
echo "no drift: $*"
