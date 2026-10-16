/**
 * Region handling: the sandbox tooling runs only in a region with committed price data (today the
 * default, ap-southeast-1), refuses every other region before any AWS call, and never prices one
 * region with another region's data.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PRICES, DEFAULT_REGION, loadPriceTable } from '@starter/tool-finops';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_REGIONS,
  assertArgvSafe,
  buildArgv,
  parentEnvProblems,
} from '../src/aws/executor.js';
import { OPERATIONS_BY_KEY } from '../src/aws/allowlist.js';
import {
  DEFAULT_SUPPLEMENT,
  PriceBookError,
  buildPriceBook,
  loadPriceBook,
  loadSupplement,
  sandboxRegions,
  supplementFileFor,
} from '../src/model/prices.js';
import { assembly, awsArgs, fakeAws, fakeGuard, runCli, workspace } from './support.js';

const def = (service: string, operation: string) => {
  const d = OPERATIONS_BY_KEY.get(`${service} ${operation}`);
  if (!d) throw new Error(`no ${service} ${operation}`);
  return d;
};

describe('sandbox regions', () => {
  it('are the regions with committed price data: the default only', () => {
    expect(DEFAULT_REGION).toBe('ap-southeast-1');
    expect(sandboxRegions()).toEqual(['ap-southeast-1']);
    expect(ALLOWED_REGIONS).toEqual(['ap-southeast-1']);
    expect(DEFAULT_SUPPLEMENT.endsWith('pricing/supplement.ap-southeast-1.json')).toBe(true);
  });

  it('loads the default region price book unchanged', () => {
    const book = loadPriceBook();
    expect(book.snapshot.region).toBe('ap-southeast-1');
    expect(loadPriceBook({ region: 'ap-southeast-1' }).snapshot.version).toBe(
      book.snapshot.version,
    );
  });

  it('fails closed for a region without price data, naming the missing files', () => {
    expect(() => loadPriceBook({ region: 'eu-west-1' })).toThrow(PriceBookError);
    expect(() => loadPriceBook({ region: 'eu-west-1' })).toThrow(
      /tools\/finops\/pricing\/eu-west-1\.yaml does not exist/,
    );
    expect(() => supplementFileFor('eu-west-1')).toThrow(
      /tools\/aws-sandbox\/pricing\/supplement\.eu-west-1\.json does not exist.*public AWS Price List offer files/,
    );
    for (const bad of ['../../finops/pricing/ap-southeast-1', '', 'ap-southeast-1/..']) {
      expect(() => supplementFileFor(bad)).toThrow(PriceBookError);
    }
  });

  it('refuses a snapshot and a supplement of different regions', () => {
    const table = loadPriceTable(DEFAULT_PRICES);
    const supplement = { ...loadSupplement(DEFAULT_SUPPLEMENT), region: 'eu-west-1' };
    expect(() => buildPriceBook(table, supplement, { snapshot: 'a', supplement: 'b' })).toThrow(
      /differs from the supplement region eu-west-1/,
    );
    expect(() => loadPriceBook({ region: 'eu-west-1', snapshotFile: DEFAULT_PRICES })).toThrow(
      /is for ap-southeast-1, not eu-west-1/,
    );
  });

  it('the supplement provenance names the public price list, the retrieval date and "not live"', () => {
    const s = loadSupplement(DEFAULT_SUPPLEMENT);
    expect(s.source).toMatch(
      /^Public AWS Price List offer files, retrieved 2026-10-14; not live pricing\./,
    );
    expect(readFileSync(DEFAULT_SUPPLEMENT, 'utf8')).not.toMatch(/docs\//);
  });

  it('the AWS boundary refuses another region, and an argv for another region', () => {
    const argv = buildArgv(def('ec2', 'describe-vpcs'), [], 'p', 'ap-southeast-1');
    expect(() => assertArgvSafe(argv, 'p', 'ap-southeast-1')).not.toThrow();
    expect(() => assertArgvSafe(argv, 'p', 'eu-west-1')).toThrow(/region eu-west-1 is not allowed/);
    const forged = buildArgv(def('ec2', 'describe-vpcs'), [], 'p', 'eu-west-1');
    expect(() => assertArgvSafe(forged, 'p', 'ap-southeast-1')).toThrow(/--region does not match/);
  });

  it('ambient AWS_REGION / AWS_DEFAULT_REGION must equal the configured --region', () => {
    expect(parentEnvProblems({ AWS_REGION: 'eu-west-1' }, 'p')).toEqual([
      'AWS_REGION is set to a different region than --region',
    ]);
    expect(
      parentEnvProblems({ AWS_DEFAULT_REGION: 'ap-southeast-1' }, 'p', 'ap-southeast-1'),
    ).toEqual([]);
  });
});

describe('CLI region refusals', () => {
  it.each([
    [[], /tools\/finops\/pricing\/eu-west-1\.yaml does not exist/],
    [
      ['--prices', DEFAULT_PRICES, '--supplement', DEFAULT_SUPPLEMENT],
      /is for ap-southeast-1, not eu-west-1/,
    ],
  ])(
    'inventory --region <unpriced region> %#: refused before the guard or any AWS call',
    async (extra, message) => {
      const ws = workspace();
      const aws = fakeAws({});
      const guard = fakeGuard('ok');
      const r = await runCli(
        [
          'inventory',
          '--run-id',
          'sbx-a1b2c3',
          '--out',
          join(ws.dir, 'inv.json'),
          '--region',
          'eu-west-1',
          ...extra,
          ...awsArgs(ws),
        ],
        { aws, guard, cwd: ws.dir },
      );
      expect(r.code).toBe(2);
      expect(r.err).toMatch(message);
      expect(aws.calls).toHaveLength(0);
      expect(guard.calls).toHaveLength(0);
    },
  );

  it('estimate --region <unpriced region> fails closed (exit 2) naming the missing price table', async () => {
    const ws = workspace();
    const r = await runCli(['estimate', '--phase', '1', '--region', 'eu-west-1'], { cwd: ws.dir });
    expect(r.code).toBe(2);
    expect(r.err).toContain('tools/finops/pricing/eu-west-1.yaml does not exist');
  });

  it('estimate --synth of another region takes its region from the assembly (and fails closed)', async () => {
    const ws = workspace();
    const dir = assembly({});
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: '50.0.0',
        artifacts: {
          S: { type: 'aws:cloudformation:stack', environment: 'aws://111122223333/eu-west-1' },
        },
      }),
    );
    const r = await runCli(['estimate', '--phase', '2', '--synth', dir], { cwd: ws.dir });
    expect(r.code).toBe(2);
    expect(r.err).toContain('eu-west-1');
    const mismatch = await runCli(
      ['estimate', '--phase', '2', '--synth', dir, '--region', 'ap-southeast-1'],
      { cwd: ws.dir },
    );
    expect(mismatch.code).toBe(2);
    expect(mismatch.err).toContain(
      '--region ap-southeast-1 does not match --synth, whose stacks are in eu-west-1',
    );
  });
});
