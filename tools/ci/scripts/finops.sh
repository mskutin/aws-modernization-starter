#!/bin/sh
# usage: finops.sh <baseline-cdk.out> <head-cdk.out>
# FinOps cost-impact + destructive-change gate (@starter/tool-finops, part of the
# policy tooling): exit 0 pass/approved, 1 approval required, 2 usage/config.
# Approval: MR label `finops-approved` (CI_MERGE_REQUEST_LABELS, captured when the
# pipeline is created -> add the label, then run a NEW pipeline). The label is an audit
# signal; Maintainer-only merge is the control. No approval variable is configured
# (tools/finops/thresholds.yaml). An empty/unavailable baseline means every resource
# counts as new.
set -eu
base="${1:?}"
head="${2:?}"
if [ -f "${base}/BASELINE_UNAVAILABLE" ]; then
  echo "NOTE: baseline unavailable ($(cat "${base}/BASELINE_UNAVAILABLE")) — every resource is reported as new."
fi
# Compare the same long-lived environments on both sides (the ephemeral
# integration mini-stack is not part of the cost/destructive-change gate).
envs="${FINOPS_ENVIRONMENTS:-dev staging prod}"
cmp_head=.cache/finops/head
rm -rf "${cmp_head:?}"
mkdir -p "$cmp_head"
for env in $envs; do
  [ -d "${head}/${env}" ] && cp -R "${head}/${env}" "${cmp_head}/${env}"
done
status=0
pnpm -C tools/finops run finops:check --base "$base" --head "$cmp_head" || status=$?
case "$status" in
  0) echo "FinOps gate: passed" ;;
  1)
    if [ "${CI_PIPELINE_SOURCE:-}" != "merge_request_event" ] && [ -n "${CI_PIPELINE_SOURCE:-}" ]; then
      # The approval gate is enforced in merge request pipelines (where the label
      # lives). Pipelines on branches/tags after merge only report.
      echo "FinOps: REPORT-ONLY in a ${CI_PIPELINE_SOURCE} pipeline — the change would need 'finops-approved' in its merge request (see report above)."
      status=0
    else
      echo "FinOps gate: APPROVAL REQUIRED — review reports/finops/finops-report.md, then add the MR label 'finops-approved' and start a new pipeline." >&2
    fi
    ;;
  *) echo "FinOps gate: usage/configuration error (exit ${status})" >&2 ;;
esac
exit "$status"
