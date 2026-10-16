/**
 * Budget alignment: compares the head estimate with the AWS::Budgets::Budget
 * created by infra's CostGuardrails construct (one per environment). Advisory
 * only — it does not gate the pipeline.
 */
import type { Environment } from './config.js';
import type { Estimate } from './estimate.js';
import type { LoadedTemplate } from './templates.js';

export interface BudgetCoverage {
  environment: Environment | 'unknown';
  stack: string;
  budgetName: string;
  limitUsd: number;
  estimatedUsd: number;
  utilisationPercent: number;
  status: 'ok' | 'warning' | 'over';
}

/** Default warning level; matches the 80 % ACTUAL notification in CostGuardrails. */
export const BUDGET_WARN_PERCENT = 80;

export function budgetCoverage(
  head: Map<string, LoadedTemplate>,
  estimate: Estimate,
  warnPercent = BUDGET_WARN_PERCENT,
): BudgetCoverage[] {
  const out: BudgetCoverage[] = [];
  for (const { key, template, environment } of head.values()) {
    for (const r of Object.values(template.Resources ?? {})) {
      if (r.Type !== 'AWS::Budgets::Budget') continue;
      const budget = r.Properties?.['Budget'] as Record<string, unknown> | undefined;
      const limit = (budget?.['BudgetLimit'] as Record<string, unknown> | undefined)?.['Amount'];
      const limitUsd = typeof limit === 'number' ? limit : Number(limit);
      if (!Number.isFinite(limitUsd) || limitUsd <= 0) continue;
      const env = environment ?? 'unknown';
      const estimatedUsd = estimate.totals[env] ?? 0;
      const utilisationPercent = Math.round((estimatedUsd / limitUsd) * 1000) / 10;
      out.push({
        environment: env,
        stack: key,
        budgetName: String(budget?.['BudgetName'] ?? '(unnamed)'),
        limitUsd,
        estimatedUsd,
        utilisationPercent,
        status:
          utilisationPercent > 100 ? 'over' : utilisationPercent >= warnPercent ? 'warning' : 'ok',
      });
    }
  }
  return out;
}
