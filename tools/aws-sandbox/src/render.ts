/**
 * Markdown renderers (e.g. a resource-inventory.md from inventory.json).
 * Input is the masked JSON report; nothing is added that the report does not contain.
 */
import type { Estimate } from './model/estimate.js';
import type { Finding, Inventory, Reconciliation, VerifyReport } from './schemas.js';

const cell = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
};
const code = (v: unknown) =>
  v === null || v === undefined || v === '' ? '—' : `\`${String(v).replace(/`/g, "'")}\``;
const usd = (n: number | null | undefined, digits = 4) =>
  n === null || n === undefined ? '—' : n.toFixed(digits);
const table = (head: readonly string[], rows: readonly (readonly unknown[])[]) => [
  `| ${head.join(' | ')} |`,
  `| ${head.map(() => '---').join(' | ')} |`,
  ...rows.map(
    (r) =>
      `| ${r.map((c) => (typeof c === 'string' && c.startsWith('`') ? c : cell(c))).join(' | ')} |`,
  ),
];

const guardLine = (guard: Inventory['guard']) =>
  guard.refusal
    ? `REFUSED — ${guard.refusal}`
    : guard.checks.length === 0
      ? 'no verification recorded'
      : `${guard.checks.length} verification(s) (${guard.maxAgeSeconds > 0 ? `reused for up to ${guard.maxAgeSeconds} s — operator opt-in` : 'one before every AWS call'}); first ${guard.checks[0]?.time}, principal type ${guard.checks[0]?.principalType}, profile ${guard.checks[0]?.executionProfile}`;

export function renderInventory(inv: Inventory): string {
  const c = inv.cost;
  const r = inv.runtime;
  const lines = [
    `# Live validation — resource inventory, run \`${inv.runId}\` (Phase ${inv.phase})`,
    '',
    ...table(
      ['Field', 'Value'],
      [
        ['Generated', inv.generatedAt],
        ['Account', inv.account ?? 'not verified'],
        ['Region', inv.region],
        ['Execution profile', inv.executionProfile],
        ['Status', `${inv.status} — ${inv.statusReason}`],
        ['Account guard', guardLine(inv.guard)],
        [
          'AWS calls',
          `${inv.tool.awsCalls.length} read-only call(s), ${inv.tool.awsCalls.filter((x) => !x.ok).length} failed`,
        ],
      ],
    ),
    '',
    '> Produced by `starter-aws-sandbox inventory` with read-only CloudFormation calls after the account',
    '> guard. Costs are **estimates** from dated list-price snapshots and stated assumptions',
    `> (${c.priceBasis}), not a bill. This experiment validates functional behaviour on ordinary AWS;`,
    '> it does not demonstrate compliance with any organizational control set.',
    '',
    '## Cost and runtime',
    '',
    ...table(
      ['Item', 'Value'],
      [
        ['Time-based resources (sum of the rows below)', `${usd(c.resourcesUsdPerHour)} USD/h`],
        ['Usage and non-resource lines (estimate)', `${usd(c.otherUsdPerHour)} USD/h`],
        ['Expected total', `${usd(c.totalUsdPerHour)} USD/h`],
        ['One-time + partial-hour rounding', `${usd(c.oneTimeUsd + c.partialHourRoundingUsd)} USD`],
        ['Account-level allowance (UNKNOWN services)', `${usd(c.accountLevelUsd, 2)} USD`],
        ['Estimate basis', c.estimateBasis],
        ['Started (first stack created)', c.startedAt],
        ['Elapsed', c.elapsedHours === null ? null : `${c.elapsedHours.toFixed(2)} h`],
        [
          'Estimated workload spend so far',
          c.estimatedSpendSoFarUsd === null ? null : `${usd(c.estimatedSpendSoFarUsd, 2)} USD`,
        ],
        [
          `Maximum runtime under the stop rule (USD ${r.stopUsd}, spent ${r.spentUsd}, margin ${r.marginPercent} %, tax ${r.taxRatePercent} %)`,
          `${r.maxRuntimeHours} h`,
        ],
        ['Time box', `${r.timeBoxHours} h`],
        ['Effective limit', `${r.effectiveMaxRuntimeHours} h (binding: ${r.bindingLimit})`],
        ['Start teardown by', r.teardownStartBy],
        ['Everything deleted by', r.allDeletedBy],
        ['`starter:expires-at` tag', r.expiresAtTag],
      ],
    ),
    '',
    '## Teardown',
    '',
    `- Owner: ${inv.teardown.owner}`,
    `- Command: ${code(inv.teardown.command)}`,
    `- Verification: ${code(inv.teardown.verifyCommand)}`,
    ...inv.teardown.notes.map((n) => `- ${n}`),
    '',
    '## Stacks',
    '',
    ...table(
      ['Stack', 'Status', 'Created', 'Resources', 'USD/h', 'Termination protection'],
      inv.stacks.map((s) => [
        s.name,
        s.status,
        s.createdAt,
        s.resources.length,
        usd(s.hourlyUsd),
        s.terminationProtection ? 'on' : 'off',
      ]),
    ),
    '',
  ];
  if (inv.bootstrap) {
    lines.push(
      `Bootstrap stack \`${inv.bootstrap.name}\`: ${inv.bootstrap.status}, created ${inv.bootstrap.createdAt ?? '—'} (not part of the run teardown).`,
      '',
    );
  }
  for (const s of inv.stacks) {
    lines.push(
      `### ${s.name}`,
      '',
      `Tags: ${
        Object.entries(s.tags)
          .map(([k, v]) => `\`${k}=${v}\``)
          .join(', ') || '—'
      }`,
      '',
      ...table(
        ['Logical id', 'Type', 'Physical id', 'Created', 'Status', 'USD/h'],
        s.resources.map((x) => [
          x.nestedStack ? `${x.nestedStack} / ${x.logicalId}` : x.logicalId,
          x.type,
          x.physicalId,
          x.createdAt,
          x.status,
          x.hourlyUsd > 0 ? usd(x.hourlyUsd) : '0',
        ]),
      ),
      '',
    );
  }
  const er = inv.experimentResources;
  lines.push(
    '## Ids recorded for verify-clean',
    '',
    'verify-clean `--inventory` uses these after the stacks are gone (the role may not list KMS keys or secrets).',
    '',
    ...table(
      ['Kind', 'Stack / logical id', 'Id'],
      [
        ...er.kmsKeys.map((k) => ['KMS key', `${k.stack}/${k.logicalId}`, k.arn ?? k.keyId]),
        ...er.secrets.map((x) => ['Secret', `${x.stack}/${x.logicalId}`, x.arn]),
        ...er.logGroups.map((x) => ['Log group', `${x.stack}/${x.logicalId}`, x.name]),
      ],
    ),
    '',
  );
  if (inv.otherRunStacks.length) {
    lines.push(
      '## Stacks of other runs (not inventoried)',
      '',
      ...inv.otherRunStacks.map((o) => `- \`${o.name}\` (run ${o.runId ?? 'untagged'})`),
      '',
    );
  }
  if (inv.errors.length) {
    lines.push(
      '## Failed calls',
      '',
      ...table(
        ['Operation', 'Kind', 'Code', 'Message'],
        inv.errors.map((e) => [e.operation, e.kind, e.code, e.message]),
      ),
      '',
    );
  }
  if (inv.notes.length) lines.push('## Notes', '', ...inv.notes.map((n) => `- ${n}`), '');
  return `${lines.join('\n').trimEnd()}\n`;
}

const findingRows = (list: readonly Finding[]) =>
  list.map((f) => [
    f.class,
    f.resourceType,
    f.id,
    f.state,
    f.deletionDate ?? f.createdAt,
    f.match.join(', '),
    f.hourlyUsdIfLeft !== undefined && f.hourlyUsdIfLeft > 0
      ? usd(f.hourlyUsdIfLeft)
      : f.residualWorstUsd !== undefined
        ? `residual ≤ ${usd(f.residualWorstUsd)}`
        : '0',
    f.note,
  ]);

export function renderVerify(v: VerifyReport): string {
  const s = v.summary;
  const lines = [
    `# Live validation — teardown verification, run \`${v.runId}\``,
    '',
    ...table(
      ['Field', 'Value'],
      [
        ['Generated', v.generatedAt],
        ['Account', v.account ?? 'not verified'],
        ['Region', v.region],
        ['Status', `**${v.status.toUpperCase()}** — ${v.statusReason}`],
        [
          'Not provable with this role',
          s.unverifiable.length
            ? s.unverifiable.map((u) => `${u.category} (${u.status})`).join(', ')
            : 'none',
        ],
        ['Inventory used', v.inventory ? `${v.inventory.file} (run ${v.inventory.runId})` : 'none'],
        ['Weak matches before', v.since ? `${v.since} (${v.sinceSource})` : 'not set'],
        ['Remaining (fail)', s.remaining],
        [
          'Pending deletion',
          `${s.pendingDeletion}${s.pendingDeletionUntil ? ` (until ${s.pendingDeletionUntil})` : ''}`,
        ],
        ['Retained by design (flag)', s.retainedByDesign],
        ['Not owned (pre-existing)', s.notOwned],
        [
          'Bootstrap (reported separately)',
          v.includeBootstrap ? 'included in the verdict' : s.bootstrapReported,
        ],
        ['Remaining resources cost', `${usd(s.remainingUsdPerHour)} USD/h while they stay`],
        [
          'Residual (pending / retained)',
          `likely ${usd(s.residualLikelyUsd)} / worst ${usd(s.residualWorstUsd)} USD`,
        ],
        ['Account guard', guardLine(v.guard)],
        [
          'AWS calls',
          `${v.tool.awsCalls.length} read-only call(s), ${v.tool.awsCalls.filter((x) => !x.ok).length} failed`,
        ],
      ],
    ),
    '',
    '> Read-only sweep by `starter-aws-sandbox verify-clean`; it deletes nothing. CLEAN needs every category',
    '> listed exhaustively. CLEAN-WITH-UNVERIFIABLE means nothing was found, but the role could not list the',
    '> categories named below: their fallback evidence is shown, and they are not proven clean.',
    '> `pending-deletion` items are expected (KMS keys, secrets, DynamoDB system backups) and listed with their',
    '> dates. Billing is checked separately (reconcile); this report says nothing about billed spend.',
    '',
    '## Findings',
    '',
    ...(v.findings.length
      ? table(
          ['Class', 'Type', 'Id', 'State', 'Date', 'Match', 'USD/h if left', 'Note'],
          findingRows(v.findings),
        )
      : ['None.']),
    '',
  ];
  if (s.unverifiable.length) {
    lines.push('## Not provable with this role', '');
    for (const u of s.unverifiable) {
      lines.push(
        `### ${u.category} — ${u.status}`,
        '',
        ...u.evidence.map((e) => `- ${cell(e)}`),
        '',
      );
    }
  }
  if (v.deletionEvidence) {
    const d = v.deletionEvidence;
    lines.push('## Deletion evidence (CloudFormation)', '', `${cell(d.note)}`, '');
    if (d.stacks.length) {
      lines.push(
        ...table(
          ['Stack', 'Status', 'Deleted'],
          d.stacks.map((x) => [x.name, x.status, x.deletedAt]),
        ),
        '',
      );
    }
    const kept = d.resources.filter((x) => x.status !== 'DELETE_COMPLETE');
    lines.push(
      `${d.resources.length} recorded resource(s); not DELETE_COMPLETE: ${kept.length ? kept.map((x) => `${x.stack}/${x.logicalId} (${x.type}) ${x.status}`).join(', ') : 'none'}.`,
      '',
    );
  }
  if (v.bootstrap.length) {
    lines.push(
      '## CDK bootstrap (reported separately; pass --include-bootstrap to verify its removal)',
      '',
      ...table(
        ['Class', 'Type', 'Id', 'State', 'Date', 'Match', 'USD/h if left', 'Note'],
        findingRows(v.bootstrap),
      ),
      '',
    );
  }
  if (v.tagIndexOnly.length) {
    lines.push(
      '## Tag index only',
      '',
      ...table(
        ['ARN', 'Service', 'Swept type', 'Note'],
        v.tagIndexOnly.map((t) => [t.arn, t.service, t.covered ? 'yes' : 'NO', t.note]),
      ),
      '',
    );
  }
  lines.push(
    '## Coverage',
    '',
    ...table(
      ['Sweep', 'Status', 'Operations', 'Denied (handled)', 'Errors', 'Justification'],
      v.coverage.map((c) => [
        c.service,
        c.status,
        c.operations.join(', '),
        c.denied.join(', '),
        c.errors.map((e) => `${e.operation}: ${e.code}`).join('; '),
        c.justification,
      ]),
    ),
    '',
  );
  if (v.notes.length) lines.push('## Notes', '', ...v.notes.map((n) => `- ${n}`), '');
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderEstimate(e: Estimate): string {
  const t = e.totals;
  const sr = e.stopRule;
  const lines = [
    `# Live validation — sandbox cost estimate, Phase ${e.phase}`,
    '',
    `> ${e.disclaimer}`,
    '',
    ...table(
      ['Field', 'Value'],
      [
        ['Generated', e.generatedAt],
        ['Basis', `${e.topology.basis.kind}: ${e.topology.basis.ref}`],
        ['Stacks', e.topology.basis.stacks.join(', ')],
        [
          'Price snapshot',
          `tools/finops ${e.priceBasis.snapshot} (captured ${e.priceBasis.snapshotCapturedAt})`,
        ],
        [
          'Price supplement',
          `tools/aws-sandbox ${e.priceBasis.supplement} (captured ${e.priceBasis.supplementCapturedAt})`,
        ],
        [
          'Region / currency',
          `${e.priceBasis.region} / ${e.priceBasis.currency}, ${e.priceBasis.hoursPerMonth} h per month`,
        ],
      ],
    ),
    '',
    '## Summary',
    '',
    ...table(
      ['Item', 'USD'],
      [
        [
          'Per hour (time-based + usage)',
          `${usd(t.perHourUsd)} (${usd(t.perHourFixedUsd)} + ${usd(t.perHourUsageUsd)})`,
        ],
        ['One-time per cycle', usd(t.oneTimeUsd)],
        ['Partial-hour rounding (ALB, LCU, NAT: one extra hour)', usd(t.partialHourRoundingUsd)],
        ...t.byHours.map((h) => [
          `Lifetime ${h.hours} h: workload / + account-level / + tax`,
          `${usd(h.workloadUsd, 2)} / ${usd(h.withAccountLevelUsd, 2)} / ${usd(h.withAccountLevelAndTaxUsd, 2)}`,
        ]),
        [
          `Account-level services (${e.accountLevel.status})`,
          `${usd(e.accountLevel.lowUsd, 2)} – ${usd(e.accountLevel.highUsd, 2)} per cycle; ${usd(e.accountLevel.usedUsd, 2)} used`,
        ],
        [
          `Maximum runtime under USD ${sr.stopUsd} (spent ${sr.spentUsd}, margin ${sr.marginPercent} %, tax ${sr.taxRatePercent} %)`,
          `${sr.maxRuntimeHours} h (${sr.maxRuntimeHoursWithoutAccountLevel} h if no account-level service bills)`,
        ],
        ['Time box', `${sr.timeBoxHours} h — ${sr.timeBoxBasis}`],
        [
          'Effective limit',
          `${sr.effectiveMaxRuntimeHours} h (binding: ${sr.bindingLimit}); start teardown ${sr.teardownHours} h before it`,
        ],
        [
          'Residual after teardown (first 30 days)',
          `likely ${usd(e.residual.likelyUsd)} / worst ${usd(e.residual.worstUsd)}`,
        ],
      ],
    ),
    '',
    `Stop-rule formula: ${sr.formula}.`,
    '',
    '## Line items',
    '',
    ...table(
      [
        'ID',
        'Component',
        'Kind',
        'Quantity',
        'Unit price',
        'Formula',
        'USD/h',
        'One-time',
        'Conf.',
        'Price source',
      ],
      e.lineItems.map((i) => [
        i.id,
        i.component,
        i.kind,
        `${i.quantity} ${i.quantityUnit}`,
        `${i.unitPriceUsd} / ${i.priceUnit}`,
        i.formula,
        usd(i.usdPerHour),
        i.oneTimeUsd ? usd(i.oneTimeUsd) : '—',
        i.confidence,
        i.priceRef,
      ]),
    ),
    '',
    '## Residual after teardown',
    '',
    ...table(
      ['ID', 'Item', 'Likely', 'Worst', 'Basis'],
      e.residual.items.map((r) => [r.id, r.item, usd(r.likelyUsd), usd(r.worstUsd), r.basis]),
    ),
    '',
    `KMS keys pending deletion — price snapshot: ${e.residual.kmsPendingDeletionCharge.status}; repo quote ${e.residual.kmsPendingDeletionCharge.repoQuote} (${e.residual.kmsPendingDeletionCharge.quotedIn}); ${e.residual.kmsPendingDeletionCharge.treatment}.`,
    '',
    '## Assumptions',
    '',
    ...table(
      ['ID', 'Value', 'Unit', 'Basis'],
      e.assumptions.map((a) => [a.id, a.value, a.unit, a.basis]),
    ),
    '',
    '## Notes',
    '',
    ...e.notes.map((n) => `- ${n}`),
    '',
  ];
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderReconciliation(r: Reconciliation): string {
  const lines = [
    `# Live validation — estimated vs billed, run \`${r.runId}\` (Phase ${r.phase})`,
    '',
    ...table(
      ['Field', 'Value'],
      [
        ['Status', `**${r.status}** — ${r.statusReason}`],
        ['Hours run', r.hoursRun],
        [
          'Read',
          `${r.billed.readAt} by ${r.billed.readBy} from ${r.billed.source} (${r.hoursSinceTeardown} h after teardown)`,
        ],
        [
          'Estimate (workload)',
          `${usd(r.estimate.workloadUsd, 2)} USD; with the account-level high bound ${usd(r.estimate.withAccountLevelHighUsd, 2)} USD`,
        ],
        [
          'Billed account total',
          `${usd(r.billed.accountTotalUsd, 2)} USD (${r.billed.taxIncluded ? 'incl.' : 'excl.'} tax)`,
        ],
        ['Baseline', `${usd(r.billed.baselineUsd, 2)} USD over ${r.billed.periodDays} day(s)`],
        ['Attributable', `${usd(r.billed.attributableUsd, 2)} USD`],
        [
          'Variance',
          `${usd(r.varianceUsd, 2)} USD${r.variancePercent === null ? '' : ` (${r.variancePercent} %)`}`,
        ],
        [
          'Stop rule',
          `USD ${r.stopRule.stopUsd}: ${r.stopRule.reached ? 'REACHED' : 'not reached'}`,
        ],
        ['Estimate basis', `${r.estimate.basis}; ${r.estimate.priceBasis}`],
      ],
    ),
    '',
    '## By service (approximate mapping)',
    '',
    ...table(
      ['Service', 'Estimated', 'Billed', 'Difference'],
      r.byService.map((s) => [
        s.service,
        usd(s.estimatedUsd),
        s.billedUsd === null ? '—' : usd(s.billedUsd),
        s.differenceUsd === null ? '—' : usd(s.differenceUsd),
      ]),
    ),
    '',
    '## Checkpoints',
    '',
    ...table(
      ['ID', 'Due', 'What'],
      r.checkpoints.map((c) => [c.id, c.due, c.what]),
    ),
    '',
    '## Notes',
    '',
    ...r.notes.map((n) => `- ${n}`),
    '',
  ];
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Renders any report of this tool by its `kind`. */
export function renderAny(report: { kind?: unknown }): string {
  switch (report.kind) {
    case 'starter-aws-sandbox/inventory':
      return renderInventory(report as Inventory);
    case 'starter-aws-sandbox/verify-clean':
      return renderVerify(report as VerifyReport);
    case 'starter-aws-sandbox/estimate':
      return renderEstimate(report as Estimate);
    case 'starter-aws-sandbox/reconciliation':
      return renderReconciliation(report as Reconciliation);
    default:
      throw new Error(`unknown report kind ${String(report.kind)}`);
  }
}
