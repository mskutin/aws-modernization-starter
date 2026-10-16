/**
 * Approval gate: combines cost deltas, destructive changes and new expensive
 * resource types with the configured thresholds and approval signals.
 */
import { ENVIRONMENTS, thresholdsFor, type Environment, type Thresholds } from './config.js';
import type { TemplateDiff } from './diff.js';
import type { Estimate } from './estimate.js';

export interface EnvironmentDelta {
  environment: Environment | 'unknown';
  baseUsd: number;
  headUsd: number;
  deltaUsd: number;
  /** null when the base estimate is 0 (percentage undefined). */
  deltaPercent: number | null;
  thresholdUsd: number;
  thresholdPercent: number;
  exceeds: boolean;
}

export type ApprovalReason =
  | { kind: 'destructive'; count: number }
  | { kind: 'cost-increase'; environment: string; deltaUsd: number; deltaPercent: number | null }
  | { kind: 'new-resource-type'; type: string; stack: string; logicalId: string };

export interface ApprovalSignal {
  approved: boolean;
  /** Which signal granted approval (label or variable), for the audit trail. */
  via?: string;
}

export interface GateDecision {
  requiresApproval: boolean;
  reasons: ApprovalReason[];
  approval: ApprovalSignal;
  /** True when the pipeline may proceed (no approval needed, or approved). */
  passed: boolean;
  environments: EnvironmentDelta[];
}

const round = (n: number) => Math.round(n * 100) / 100;

export function environmentDeltas(
  base: Estimate,
  head: Estimate,
  t: Thresholds,
): EnvironmentDelta[] {
  const envs = [...ENVIRONMENTS, 'unknown'] as const;
  return envs
    .filter((e) => base.totals[e] !== undefined || head.totals[e] !== undefined)
    .map((environment) => {
      const baseUsd = base.totals[environment] ?? 0;
      const headUsd = head.totals[environment] ?? 0;
      const deltaUsd = round(headUsd - baseUsd);
      const deltaPercent = baseUsd > 0 ? round((deltaUsd / baseUsd) * 100) : null;
      const th = thresholdsFor(t, environment === 'unknown' ? undefined : environment);
      const exceeds =
        deltaUsd > 0 &&
        (deltaUsd >= th.monthlyIncreaseUsd ||
          (deltaPercent !== null && deltaPercent >= th.monthlyIncreasePercent));
      return {
        environment,
        baseUsd,
        headUsd,
        deltaUsd,
        deltaPercent,
        thresholdUsd: th.monthlyIncreaseUsd,
        thresholdPercent: th.monthlyIncreasePercent,
        exceeds,
      };
    });
}

/**
 * Approval signals: the MR label in `CI_MERGE_REQUEST_LABELS` (comma-separated,
 * set by GitLab for merge request pipelines) or `<approvalVariable>=true`.
 */
export function readApproval(t: Thresholds, env: NodeJS.ProcessEnv = process.env): ApprovalSignal {
  const labels = (env['CI_MERGE_REQUEST_LABELS'] ?? '')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
  if (labels.includes(t.approvalSignals.mergeRequestLabel)) {
    return { approved: true, via: `merge request label "${t.approvalSignals.mergeRequestLabel}"` };
  }
  const variable = t.approvalSignals.approvalVariable;
  if (variable && (env[variable] ?? '').toLowerCase() === 'true') {
    return { approved: true, via: `variable ${variable}=true` };
  }
  return { approved: false };
}

export function decide(
  diff: TemplateDiff,
  base: Estimate,
  head: Estimate,
  t: Thresholds,
  approval: ApprovalSignal,
): GateDecision {
  const environments = environmentDeltas(base, head, t);
  const reasons: ApprovalReason[] = [];
  if (diff.destructive.length > 0)
    reasons.push({ kind: 'destructive', count: diff.destructive.length });
  for (const e of environments.filter((x) => x.exceeds)) {
    reasons.push({
      kind: 'cost-increase',
      environment: e.environment,
      deltaUsd: e.deltaUsd,
      deltaPercent: e.deltaPercent,
    });
  }
  for (const r of diff.resources) {
    if (r.kind === 'added' && t.approval.newResourceTypesRequiringApproval.includes(r.type)) {
      reasons.push({
        kind: 'new-resource-type',
        type: r.type,
        stack: r.stack,
        logicalId: r.logicalId,
      });
    }
  }
  const requiresApproval = reasons.length > 0;
  return {
    requiresApproval,
    reasons,
    approval,
    passed: !requiresApproval || approval.approved,
    environments,
  };
}
