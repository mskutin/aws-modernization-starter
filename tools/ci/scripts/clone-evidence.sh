#!/bin/sh
# Clone evidence of a release-chain job (ADR 0411). The job token cannot read job logs
# (HTTP 401), so each chain job records whether its working copy is a fresh clone; the chain report
# reads these artifacts. A fresh clone's HEAD reflog has exactly one entry (the runner's checkout); a
# reused working copy accumulates one entry per job. Needs only sh + wc (every chain image has them).
# This detects misconfiguration (fetch strategy, persistent build volumes); a job could lie about
# itself, but chain jobs on protected refs run reviewed code.
set -eu
dir=reports/chain
mkdir -p "$dir"
lines=0
if [ -f .git/logs/HEAD ]; then lines=$(wc -l < .git/logs/HEAD | tr -d ' '); fi
printf '{"job":"%s","jobId":%s,"runner":"%s","gitStrategy":"%s","reflogLines":%s}\n' \
  "${CI_JOB_NAME:-}" "${CI_JOB_ID:-0}" "${CI_RUNNER_DESCRIPTION:-}" "${GIT_STRATEGY:-}" "$lines" \
  > "${dir}/clone-${CI_JOB_ID:-0}.json"
if [ "$lines" = 1 ]; then state="fresh clone"; else state="NOT a fresh clone"; fi
echo "clone evidence: GIT_STRATEGY=${GIT_STRATEGY:-unset}, HEAD reflog entries ${lines} -> ${state}"
