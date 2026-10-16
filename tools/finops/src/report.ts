import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BudgetCoverage } from './budgets.js';
import type { PriceTable, Thresholds, UsageFile } from './config.js';
import type { TemplateDiff } from './diff.js';
import type { CostLine, Estimate } from './estimate.js';
import type { GateDecision } from './gate.js';

export const ESTIMATE_DISCLAIMER =
  'Estimates use a manually maintained price snapshot and explicit usage assumptions; they are NOT live AWS prices ' +
  'and NOT a bill forecast (no free tiers, discounts, taxes or unmodelled resources).';

export interface FinOpsReport {
  generatedAt: string;
  disclaimer: string;
  priceTable: { version: string; region: string; capturedAt: string; source: string };
  /** Only when the base templates are in another region than the head (priced with their own table). */
  basePriceTable?: { version: string; region: string; capturedAt: string; source: string };
  usageAssumptions: { version: string; hoursPerMonth: number };
  decision: GateDecision;
  costChanges: {
    stack: string;
    logicalId: string;
    type: string;
    cdkPath?: string;
    baseUsd: number;
    headUsd: number;
    deltaUsd: number;
    basis: string;
  }[];
  diff: TemplateDiff;
  base: Estimate;
  head: Estimate;
  budgets: BudgetCoverage[];
  thresholds: Thresholds;
}

const round = (n: number) => Math.round(n * 100) / 100;

export function costChanges(base: Estimate, head: Estimate): FinOpsReport['costChanges'] {
  const key = (l: CostLine) => `${l.stack}|${l.logicalId}`;
  const b = new Map(base.lines.map((l) => [key(l), l]));
  const h = new Map(head.lines.map((l) => [key(l), l]));
  const out: FinOpsReport['costChanges'] = [];
  for (const k of new Set([...b.keys(), ...h.keys()])) {
    const bl = b.get(k);
    const hl = h.get(k);
    const delta = round((hl?.monthlyUsd ?? 0) - (bl?.monthlyUsd ?? 0));
    if (delta === 0) continue;
    const ref = (hl ?? bl) as CostLine;
    out.push({
      stack: ref.stack,
      logicalId: ref.logicalId,
      type: ref.type,
      ...(ref.cdkPath ? { cdkPath: ref.cdkPath } : {}),
      baseUsd: bl?.monthlyUsd ?? 0,
      headUsd: hl?.monthlyUsd ?? 0,
      deltaUsd: delta,
      basis: hl ? hl.basis : `removed (was: ${bl?.basis ?? ''})`,
    });
  }
  return out.sort((x, y) => Math.abs(y.deltaUsd) - Math.abs(x.deltaUsd));
}

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
const signed = (n: number) => `${n > 0 ? '+' : ''}${money(n)}`;
const cell = (v: unknown) =>
  (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v))
    .replaceAll('|', '\\|')
    .slice(0, 120);

export function buildReport(
  input: Omit<
    FinOpsReport,
    'generatedAt' | 'disclaimer' | 'priceTable' | 'usageAssumptions' | 'costChanges'
  > & { prices: PriceTable; basePrices?: PriceTable; usage: UsageFile; now?: Date },
): FinOpsReport {
  const { prices, basePrices, usage, now, ...rest } = input;
  const tableOf = (t: PriceTable) => ({
    version: t.version,
    region: t.region,
    capturedAt: t.capturedAt,
    source: t.source,
  });
  return {
    generatedAt: (now ?? new Date()).toISOString(),
    disclaimer: ESTIMATE_DISCLAIMER,
    priceTable: tableOf(prices),
    ...(basePrices && basePrices !== prices ? { basePriceTable: tableOf(basePrices) } : {}),
    usageAssumptions: { version: usage.version, hoursPerMonth: usage.hoursPerMonth },
    costChanges: costChanges(rest.base, rest.head),
    ...rest,
  };
}

export function toMarkdown(r: FinOpsReport): string {
  const d = r.decision;
  const status = !d.requiresApproval
    ? 'PASSED — no FinOps approval required'
    : d.approval.approved
      ? `APPROVED — approval required and granted via ${d.approval.via ?? 'signal'}`
      : `BLOCKED — FinOps approval required (add MR label \`${r.thresholds.approvalSignals.mergeRequestLabel}\` after review)`;
  const lines: string[] = [
    '## FinOps cost-impact and destructive-change check',
    '',
    `**${status}**`,
    '',
    `> ${r.disclaimer} Price table \`${r.priceTable.version}\` (${r.priceTable.region}, captured ${r.priceTable.capturedAt})${r.basePriceTable ? `; base priced with \`${r.basePriceTable.version}\` (${r.basePriceTable.region}, captured ${r.basePriceTable.capturedAt})` : ''}; usage assumptions \`${r.usageAssumptions.version}\`.`,
    '',
  ];
  if (d.reasons.length > 0) {
    lines.push('### Why approval is required', '');
    for (const reason of d.reasons) {
      if (reason.kind === 'destructive')
        lines.push(`- ${reason.count} destructive change(s) (always require approval)`);
      if (reason.kind === 'cost-increase') {
        lines.push(
          `- ${reason.environment}: estimated monthly increase ${signed(reason.deltaUsd)}${reason.deltaPercent !== null ? ` (${reason.deltaPercent}%)` : ''} exceeds the threshold`,
        );
      }
      if (reason.kind === 'new-resource-type')
        lines.push(`- new ${reason.type} \`${reason.logicalId}\` in ${reason.stack}`);
    }
    lines.push('');
  }
  lines.push(
    '### Estimated monthly cost by environment',
    '',
    '| Environment | Base | Head | Delta | Delta % | Threshold |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...d.environments.map(
      (e) =>
        `| ${e.environment} | ${money(e.baseUsd)} | ${money(e.headUsd)} | ${signed(e.deltaUsd)} | ${e.deltaPercent === null ? 'n/a' : `${e.deltaPercent}%`} | ${money(e.thresholdUsd)} or ${e.thresholdPercent}%${e.exceeds ? ' **exceeded**' : ''} |`,
    ),
    '',
  );
  if (r.diff.destructive.length > 0) {
    lines.push(
      '### Destructive changes',
      '',
      '| Kind | Stack | Resource | Type | Detail |',
      '| --- | --- | --- | --- | --- |',
      ...r.diff.destructive.map(
        (x) =>
          `| ${x.kind} | ${x.stack} | ${x.cdkPath ?? x.logicalId} | ${x.type} | ${cell(x.detail)} |`,
      ),
      '',
    );
  }
  if (r.costChanges.length > 0) {
    lines.push(
      '### Cost changes by resource',
      '',
      '| Stack | Resource | Type | Base | Head | Delta | Basis |',
      '| --- | --- | --- | ---: | ---: | ---: | --- |',
      ...r.costChanges
        .slice(0, 50)
        .map(
          (c) =>
            `| ${c.stack} | ${c.cdkPath ?? c.logicalId} | ${c.type} | ${money(c.baseUsd)} | ${money(c.headUsd)} | ${signed(c.deltaUsd)} | ${cell(c.basis)} |`,
        ),
      '',
    );
  }
  const props = r.diff.costRelevant.filter((c) => c.kind === 'modified');
  if (r.diff.costRelevant.length > 0) {
    lines.push(
      '### Cost-relevant template changes',
      '',
      '| Change | Stack | Resource | Type | Property | Before | After |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...r.diff.costRelevant
        .filter((c) => c.kind !== 'modified')
        .map(
          (c) => `| ${c.kind} | ${c.stack} | ${c.cdkPath ?? c.logicalId} | ${c.type} | — | — | — |`,
        ),
      ...props.flatMap((c) =>
        c.changes
          .filter((p) => p.costRelevant)
          .map(
            (p) =>
              `| modified | ${c.stack} | ${c.cdkPath ?? c.logicalId} | ${c.type} | ${p.property} | ${cell(p.before)} | ${cell(p.after)} |`,
          ),
      ),
      '',
    );
  }
  if (r.budgets.length > 0) {
    lines.push(
      '### Budget alignment (advisory)',
      '',
      '| Environment | Budget | Limit | Estimated | Utilisation | Status |',
      '| --- | --- | ---: | ---: | ---: | --- |',
      ...r.budgets.map(
        (b) =>
          `| ${b.environment} | ${b.budgetName} | ${money(b.limitUsd)} | ${money(b.estimatedUsd)} | ${b.utilisationPercent}% | ${b.status} |`,
      ),
      '',
    );
  }
  const unpriced = [...new Set(r.head.unpriced.map((u) => `${u.type} (${u.reason})`))].sort();
  if (unpriced.length > 0) {
    lines.push('### Not priced (excluded from totals)', '', ...unpriced.map((u) => `- ${u}`), '');
  }
  return lines.join('\n');
}

export function writeReports(r: FinOpsReport, outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const json = join(outDir, 'finops-report.json');
  const md = join(outDir, 'finops-report.md');
  writeFileSync(json, JSON.stringify(r, null, 2));
  writeFileSync(md, toMarkdown(r));
  return [json, md];
}
