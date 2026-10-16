#!/bin/sh
# Advisory AI review of the merge request diff with PR-Agent (posts one MR note).
# Secrets come from masked CI variables and are passed via environment only;
# the log is not kept as an artifact.
set -eu
: "${AI_REVIEW_GITLAB_TOKEN:?}" "${AI_REVIEW_API_BASE:?}" "${AI_REVIEW_MODEL:?}" "${CI_MERGE_REQUEST_IID:?}"
export GITLAB__PERSONAL_ACCESS_TOKEN="$AI_REVIEW_GITLAB_TOKEN"
export OPENAI__API_BASE="$AI_REVIEW_API_BASE"
export OPENAI__KEY="${AI_REVIEW_API_KEY:-unused}"
export CONFIG__MODEL="openai/${AI_REVIEW_MODEL}"
export CONFIG__FALLBACK_MODELS="[\"openai/${AI_REVIEW_MODEL}\"]"
url="${CI_MERGE_REQUEST_PROJECT_URL}/-/merge_requests/${CI_MERGE_REQUEST_IID}"
mkdir -p reports/review
echo "PR-Agent review of ${url} with model openai/${AI_REVIEW_MODEL} (advisory; deterministic gates stay authoritative)"
cd /app
python -m pr_agent.cli --pr_url="$url" review
printf '{"reviewed":true,"mr":"%s","model":"openai/%s"}\n' "$url" "$AI_REVIEW_MODEL" > "${CI_PROJECT_DIR}/reports/review/ai-review.json"
