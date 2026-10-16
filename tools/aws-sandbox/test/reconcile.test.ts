import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/cli.js';
import { estimate } from '../src/model/estimate.js';
import { loadPriceBook } from '../src/model/prices.js';
import { contractTopology } from '../src/model/topology.js';
import { billedTemplate, NEVER_ZERO_NOTE, reconcile } from '../src/reconcile.js';
import { renderReconciliation } from '../src/render.js';
import { billedInputSchema, reconciliationSchema, type BilledInput } from '../src/schemas.js';
import { NOW, RUN_ID, runCli } from './support.js';

const est = estimate(contractTopology(2), loadPriceBook(), { now: NOW });
const billed = (o: Partial<BilledInput> = {}): BilledInput => ({
  ...billedTemplate(RUN_ID, 2),
  readBy: 'finance owner',
  resourcesCreatedAt: '2026-10-20T08:00:00.000Z',
  teardownCompletedAt: '2026-10-20T14:00:00.000Z',
  readAt: '2026-10-22T09:00:00.000Z',
  periodStart: '2026-10-20',
  periodEnd: '2026-10-21',
  ...o,
});

describe('reconcile', () => {
  it('never claims zero spend: a zero bill after the lag window is INCONCLUSIVE', () => {
    const r = reconcile(est, billed({ accountTotalUsd: 0 }), { now: NOW });
    expect(r.status).toBe('INCONCLUSIVE');
    expect(r.statusReason).toMatch(/not evidence of zero spend/);
    expect(r.notes).toContain(NEVER_ZERO_NOTE);
    const md = renderReconciliation(r);
    expect(md).toMatch(/does NOT mean zero spend/);
    expect(md).not.toMatch(/\bspend (is|was) zero\b|\bno spend\b/i);
  });

  it('is PROVISIONAL within 24 h of teardown, whatever the figure', () => {
    const r = reconcile(est, billed({ readAt: '2026-10-21T02:00:00.000Z', accountTotalUsd: 1.5 }));
    expect(r.status).toBe('PROVISIONAL');
    expect(r.hoursSinceTeardown).toBe(12);
  });

  it('compares attributable spend (above the baseline) with the estimate for the hours run', () => {
    const r = reconcile(est, billed({ accountTotalUsd: 3.0, baselineUsdPerDay: 0.5 }));
    expect(r.hoursRun).toBe(6);
    expect(r.billed.periodDays).toBe(2);
    expect(r.billed.baselineUsd).toBe(1);
    expect(r.billed.attributableUsd).toBe(2);
    expect(r.estimate.workloadUsd).toBeCloseTo(
      est.totals.oneTimeUsd + est.totals.partialHourRoundingUsd + 6 * est.totals.perHourUsd,
      5,
    );
    expect(r.status).toBe('WITHIN_ESTIMATE');
    expect(() => reconciliationSchema.parse(r)).not.toThrow();
  });

  it('flags spend above the estimate incl. the account-level allowance, and the stop rule', () => {
    expect(reconcile(est, billed({ accountTotalUsd: 9.5 })).status).toBe('ABOVE_ESTIMATE');
    const stop = reconcile(est, billed({ accountTotalUsd: 13.2 }));
    expect(stop.status).toBe('STOP_RULE_REACHED');
    expect(stop.stopRule.reached).toBe(true);
    expect(reconcile(est, billed({ accountTotalUsd: 0.2 })).status).toBe('BELOW_ESTIMATE');
  });

  it('maps estimated line items to billing services next to the billed figures', () => {
    const r = reconcile(
      est,
      billed({
        accountTotalUsd: 1.6,
        byService: { 'Amazon Relational Database Service': 0.17, Tax: 0 },
      }),
    );
    const rds = r.byService.find((s) => s.service === 'Amazon Relational Database Service');
    expect(rds?.billedUsd).toBe(0.17);
    expect(rds?.estimatedUsd).toBeCloseTo(6 * (0.025 + (20 * 0.138) / 730), 4);
    expect(r.byService.find((s) => s.service === 'Tax')?.estimatedUsd).toBe(0);
    expect(r.checkpoints.map((c) => c.id)).toEqual(['CP-T1', 'CP-T2', 'CP-T3', 'CP-T4']);
    expect(r.notes.join(' ')).toMatch(/never calls the Cost Explorer API/);
  });

  it('CLI: writes a valid template, reconciles, and exits 1 when the stop rule is reached', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'starter-rec-'));
    expect(
      (
        await runCli(['reconcile', '--template', '--run-id', RUN_ID, '--out', 'billed.json'], {
          cwd: dir,
        })
      ).code,
    ).toBe(EXIT.OK);
    expect(() =>
      billedInputSchema.parse(JSON.parse(readFileSync(join(dir, 'billed.json'), 'utf8'))),
    ).not.toThrow();
    expect(
      (await runCli(['estimate', '--phase', '2', '--out', 'est.json', '--quiet'], { cwd: dir }))
        .code,
    ).toBe(EXIT.OK);
    writeFileSync(join(dir, 'b1.json'), JSON.stringify(billed({ accountTotalUsd: 1.2 })));
    const ok = await runCli(
      [
        'reconcile',
        '--estimate',
        'est.json',
        '--billed',
        'b1.json',
        '--out',
        'r.json',
        '--markdown',
        'r.md',
      ],
      { cwd: dir },
    );
    expect(ok.code).toBe(EXIT.OK);
    expect(
      reconciliationSchema.parse(JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'))).status,
    ).toBe('WITHIN_ESTIMATE');
    writeFileSync(join(dir, 'b2.json'), JSON.stringify(billed({ accountTotalUsd: 14 })));
    expect(
      (
        await runCli(['reconcile', '--estimate', 'est.json', '--billed', 'b2.json', '--quiet'], {
          cwd: dir,
        })
      ).code,
    ).toBe(EXIT.NOT_CLEAN);
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...billed(), accountTotalUsd: -1 }));
    expect(
      (await runCli(['reconcile', '--estimate', 'est.json', '--billed', 'bad.json'], { cwd: dir }))
        .code,
    ).toBe(EXIT.USAGE);
  });
});
