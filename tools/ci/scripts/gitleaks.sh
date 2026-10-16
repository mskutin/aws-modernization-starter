#!/bin/sh
# Secret scan with the repo's .gitleaks.toml. MR pipelines scan the MR's commits,
# feature-branch pushes the pushed range, default branch/schedules/tags the full history.
set -eu
mkdir -p reports/secrets
log_opts=""
scope="full history"
if [ "${CI_PIPELINE_SOURCE:-}" = "merge_request_event" ] && [ -n "${CI_MERGE_REQUEST_DIFF_BASE_SHA:-}" ]; then
  log_opts="${CI_MERGE_REQUEST_DIFF_BASE_SHA}..${CI_COMMIT_SHA}"
  scope="merge request commits ${log_opts}"
elif [ -n "${CI_COMMIT_BEFORE_SHA:-}" ] && ! printf '%s' "$CI_COMMIT_BEFORE_SHA" | grep -Eq '^0+$' &&
  [ "${CI_COMMIT_BRANCH:-}" != "${CI_DEFAULT_BRANCH:-}" ]; then
  log_opts="${CI_COMMIT_BEFORE_SHA}..${CI_COMMIT_SHA}"
  scope="pushed commits ${log_opts}"
fi
echo "gitleaks $(gitleaks version) — scanning ${scope}"
set -- git --config .gitleaks.toml --redact --no-banner --exit-code 1 \
  --report-format junit --report-path reports/secrets/gitleaks-junit.xml
if [ -n "$log_opts" ]; then set -- "$@" "--log-opts=${log_opts}"; fi
gitleaks "$@" .
