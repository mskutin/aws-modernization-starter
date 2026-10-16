/**
 * Estimated vs billed. The billed figures are typed in by the finance / account owner from the
 * Billing console (`reconcile --template` writes the input file). This tool never calls the Cost
 * Explorer API: its requests are billed per request. Billing data lags
 * (refreshes at least every 24 h, some data later), so a low or zero billed figure shortly after
 * teardown is reported as PROVISIONAL or INCONCLUSIVE — never as "zero spend".
 */
import { totalForHours, type Estimate } from './model/estimate.js';
import type { BilledInput, Reconciliation } from './schemas.js';

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const HOUR = 3_600_000;

export const NEVER_ZERO_NOTE =
  'A billed figure of zero or close to zero does NOT mean zero spend: billing data refreshes at least once every 24 hours and some charges arrive later; attribution by tags needs activated cost allocation tags. Re-read at T+48 h, T+7 d and on the invoice.';

export function billedTemplate(runId: string, phase: 1 | 2): BilledInput {
  return {
    kind: 'starter-aws-sandbox/billed-input',
    schemaVersion: 1,
    runId,
    phase,
    source: 'billing-console',
    readAt: '2026-01-01T00:00:00.000Z',
    readBy: '<finance or account owner: name or role>',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-01',
    resourcesCreatedAt: '2026-01-01T00:00:00.000Z',
    teardownCompletedAt: '2026-01-01T00:00:00.000Z',
    baselineUsdPerDay: 0,
    accountTotalUsd: 0,
    taxIncluded: false,
    byService: {},
    notes:
      'Fill in from the AWS Billing console (Bills or the Cost Explorer CONSOLE, unblended, daily). Do not use the Cost Explorer API (billed per request). Leave values at 0 only if the console really shows 0; the report will still not claim zero spend.',
  };
}

export function reconcile(
  estimate: Estimate,
  billed: BilledInput,
  options: { hoursRun?: number; now?: Date; stopUsd?: number } = {},
): Reconciliation {
  const now = options.now ?? new Date();
  const stopUsd = options.stopUsd ?? estimate.stopRule.stopUsd;
  const created = Date.parse(billed.resourcesCreatedAt);
  const tornDown = Date.parse(billed.teardownCompletedAt);
  const hoursRun = options.hoursRun ?? Math.max(0, round((tornDown - created) / HOUR));
  const hoursSinceTeardown = round((Date.parse(billed.readAt) - tornDown) / HOUR);
  const workload = totalForHours(estimate.totals, hoursRun);
  const withAccount = workload + estimate.accountLevel.highUsd;
  const periodDays =
    Math.round(
      (Date.parse(`${billed.periodEnd}T00:00:00Z`) -
        Date.parse(`${billed.periodStart}T00:00:00Z`)) /
        (24 * HOUR),
    ) + 1;
  const baselineUsd = round(billed.baselineUsdPerDay * periodDays);
  const attributable = round(billed.accountTotalUsd - baselineUsd);
  const varianceUsd = round(attributable - workload);
  const variancePercent = workload > 0 ? Math.round((varianceUsd / workload) * 1000) / 10 : null;

  let status: Reconciliation['status'];
  let statusReason: string;
  if (attributable >= stopUsd) {
    status = 'STOP_RULE_REACHED';
    statusReason = `attributable spend ${attributable} USD >= stop rule ${stopUsd} USD: no further deployment steps; tear down; human review`;
  } else if (hoursSinceTeardown < 24) {
    status = 'PROVISIONAL';
    statusReason = `read ${hoursSinceTeardown} h after teardown: billing data may not have caught up (refreshes at least every 24 h)`;
  } else if (attributable <= 0.005 && workload > 0.01) {
    status = 'INCONCLUSIVE';
    statusReason = `billed attributable ${attributable} USD against an estimate of ${round(workload)} USD: the charges are not visible or not attributed yet; this is not evidence of zero spend`;
  } else if (attributable > withAccount && (variancePercent ?? 0) > 25) {
    status = 'ABOVE_ESTIMATE';
    statusReason = `attributable ${attributable} USD exceeds the estimate incl. the account-level allowance (${round(withAccount)} USD): find the driver by service before any further run`;
  } else if ((variancePercent ?? 0) < -50) {
    status = 'BELOW_ESTIMATE';
    statusReason = `attributable ${attributable} USD is less than half the estimate (${round(workload)} USD): charges may still be arriving; re-read later before relying on it`;
  } else {
    status = 'WITHIN_ESTIMATE';
    statusReason = `attributable ${attributable} USD vs estimate ${round(workload)} USD (account-level allowance up to ${estimate.accountLevel.highUsd} USD on top)`;
  }

  const byServiceEstimate = new Map<string, number>();
  for (const i of estimate.lineItems) {
    const usd =
      i.kind === 'one-time'
        ? i.oneTimeUsd
        : i.usdPerHour * (hoursRun + (i.kind === 'hourly-partial' ? 1 : 0));
    byServiceEstimate.set(i.billingService, (byServiceEstimate.get(i.billingService) ?? 0) + usd);
  }
  const services = [
    ...new Set([...byServiceEstimate.keys(), ...Object.keys(billed.byService)]),
  ].sort();
  const byService = services.map((service) => {
    const est = round(byServiceEstimate.get(service) ?? 0);
    const b = billed.byService[service];
    return {
      service,
      estimatedUsd: est,
      billedUsd: b === undefined ? null : b,
      differenceUsd: b === undefined ? null : round(b - est),
    };
  });

  const due = (h: number) => new Date(tornDown + h * HOUR).toISOString();
  const invoice = new Date(tornDown);
  const nextMonth = new Date(
    Date.UTC(invoice.getUTCFullYear(), invoice.getUTCMonth() + 1, 1),
  ).toISOString();

  return {
    kind: 'starter-aws-sandbox/reconciliation',
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    runId: billed.runId,
    phase: billed.phase,
    status,
    statusReason,
    hoursRun,
    hoursSinceTeardown,
    estimate: {
      basis: `${estimate.topology.basis.kind}: ${estimate.topology.basis.ref}`,
      priceBasis: `finops ${estimate.priceBasis.snapshot} (${estimate.priceBasis.snapshotCapturedAt}) + supplement ${estimate.priceBasis.supplement} (${estimate.priceBasis.supplementCapturedAt}); not live pricing`,
      workloadUsd: round(workload),
      withAccountLevelHighUsd: round(withAccount),
      accountLevelLowUsd: estimate.accountLevel.lowUsd,
      accountLevelHighUsd: estimate.accountLevel.highUsd,
    },
    billed: {
      source: billed.source,
      readAt: billed.readAt,
      readBy: billed.readBy,
      periodDays,
      accountTotalUsd: billed.accountTotalUsd,
      baselineUsd,
      attributableUsd: attributable,
      taxIncluded: billed.taxIncluded,
    },
    varianceUsd,
    variancePercent,
    stopRule: { stopUsd, reached: attributable >= stopUsd },
    byService,
    checkpoints: [
      {
        id: 'CP-T1',
        due: due(24),
        what: 'attributable cost above the baseline, by service (first look; may still be incomplete)',
      },
      {
        id: 'CP-T2',
        due: due(48),
        what: 'costs should stop growing after the teardown day apart from pending-deletion residue',
      },
      {
        id: 'CP-T3',
        due: due(8 * 24),
        what: 'KMS deletions complete (7-day window + up to 24 h); no new charges',
      },
      {
        id: 'CP-T4',
        due: nextMonth,
        what: 'invoice: final actual against the estimate and the USD 25 envelope',
      },
    ],
    notes: [
      NEVER_ZERO_NOTE,
      'Billed figures come from the Billing console, read by the finance / account owner. This tool never calls the Cost Explorer API: its requests are billed per request.',
      billed.taxIncluded
        ? 'The billed total includes tax; the estimate does not (compare with the tax rate in mind).'
        : 'The billed total excludes tax, like the estimate.',
      'Service names are mapped approximately (NAT gateway and data transfer can appear under "EC2 - Other" or "Data Transfer"). The total is what counts.',
    ],
  };
}
