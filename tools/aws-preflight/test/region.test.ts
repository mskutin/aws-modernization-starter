/**
 * The workload region: configurable (default ap-southeast-1), any aws-partition region. This tool
 * and the shell scripts carry copies of the default and of the validation of
 * `@starter/config/region` (the single source of truth); these tests fail when a copy disagrees.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { iamPolicy, renderPlanJson } from '../src/plan.ts';
import { assertArgvSafe, BoundaryViolation, probeDefProblems } from '../src/policy.ts';
import { probesFor, PROBES, PROBES_BY_ID } from '../src/probes.ts';
import { isWorkloadRegion, workloadRegionProblem } from '../src/region.ts';
import { allowedRegions, DEFAULT_WORKLOAD_REGION, EXIT, GLOBAL_REGION } from '../src/types.ts';
import { buildArgv } from '../src/executor.ts';
import { fakeRunner, happyResponses, liveArgs, runCli, sandbox } from './support.ts';

const CANONICAL = fileURLToPath(new URL('../../../packages/config/src/region.ts', import.meta.url));
const SHELL_HELPER = fileURLToPath(new URL('../scripts/region.sh', import.meta.url));

/** Inputs every copy must classify exactly like the canonical validation. */
const CORPUS = [
  'ap-southeast-1',
  'ap-southeast-5',
  'eu-west-1',
  'us-east-1',
  'me-central-1',
  'il-central-1',
  'ca-west-1',
  'cn-north-1',
  'cn-northwest-1',
  'us-gov-west-1',
  'us-gov-1',
  'us-iso-east-1',
  'us-iso-1',
  'us-isob-east-1',
  'eu-isoe-west-1',
  'us-isofoo-1',
  'eusc-de-east-1',
  'ap-southeast-1a',
  'ap-southeast',
  'ap-southeast-100',
  'AP-SOUTHEAST-1',
  ' ap-southeast-1',
  'ap-southeast-1\n',
  'ap_southeast_1',
  'Nowhere',
  '--region',
  '',
];

interface Canonical {
  readonly DEFAULT_AWS_REGION: string;
  validateAwsRegion(value: unknown): string;
}
const canonical = (await import(pathToFileURL(CANONICAL).href)) as Canonical;
const canonicalAccepts = (value: string): boolean => {
  try {
    canonical.validateAwsRegion(value);
    return true;
  } catch {
    return false;
  }
};

describe('copies of @starter/config/region', () => {
  it('the default workload region is the canonical default (ap-southeast-1)', () => {
    expect(DEFAULT_WORKLOAD_REGION).toBe(canonical.DEFAULT_AWS_REGION);
    expect(DEFAULT_WORKLOAD_REGION).toBe('ap-southeast-1');
    expect(
      /^STARTER_DEFAULT_REGION=([a-z0-9-]+)$/m.exec(readFileSync(SHELL_HELPER, 'utf8'))?.[1],
    ).toBe(canonical.DEFAULT_AWS_REGION);
  });

  it('src/region.ts accepts exactly what the canonical validation accepts', () => {
    for (const value of CORPUS) {
      expect(isWorkloadRegion(value), JSON.stringify(value)).toBe(canonicalAccepts(value));
    }
    expect(workloadRegionProblem('cn-north-1')).toMatch(/aws-cn partition/);
    expect(workloadRegionProblem('x'.repeat(500))).toHaveLength(
      `"${'x'.repeat(40)}" is not an AWS region name (e.g. ap-southeast-1)`.length,
    );
  });

  it('scripts/region.sh accepts exactly what the canonical validation accepts', () => {
    const script = [
      `source ${JSON.stringify(SHELL_HELPER)}`,
      'while IFS= read -r -d "" v; do if starter_region_ok "$v"; then printf "1"; else printf "0"; fi; done',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], {
      input: CORPUS.map((v) => `${v}\0`).join(''),
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(CORPUS.map((v) => (canonicalAccepts(v) ? '1' : '0')).join(''));
  });
});

describe('probe catalogue per workload region', () => {
  it('the default catalogue is unchanged (ap-southeast-1 and us-east-1)', () => {
    expect(probesFor(DEFAULT_WORKLOAD_REGION).probes).toBe(PROBES);
    expect(probesFor(DEFAULT_WORKLOAD_REGION).byId).toBe(PROBES_BY_ID);
    expect(allowedRegions()).toEqual(['ap-southeast-1', 'us-east-1']);
  });

  it('another workload region: same probes, its region instead of the default', () => {
    const eu = probesFor('eu-west-1');
    expect(eu.probes.map((p) => p.id)).toEqual(PROBES.map((p) => p.id));
    const text = JSON.stringify(eu.probes);
    expect(text).not.toContain('ap-southeast-1');
    for (const def of eu.probes) {
      for (const r of def.regions) expect(['eu-west-1', GLOBAL_REGION]).toContain(r);
      expect(probeDefProblems(def, 'eu-west-1'), def.id).toEqual([]);
    }
    expect(eu.byId.get('a.cdk.deploy-role')?.args).toEqual([
      '--role-name=cdk-{qualifier}-deploy-role-{account}-eu-west-1',
    ]);
    // The IAM policy and plan follow the region.
    expect(JSON.stringify(iamPolicy('eu-west-1'))).toContain(
      '"aws:RequestedRegion":["eu-west-1","us-east-1"]',
    );
    expect(JSON.stringify(iamPolicy('eu-west-1'))).not.toContain('ap-southeast-1');
    expect(renderPlanJson('eu-west-1')).toMatchObject({ regions: { workload: 'eu-west-1' } });
  });

  it('us-east-1 as the workload region targets it once', () => {
    const use1 = probesFor('us-east-1');
    for (const def of use1.probes) expect(def.regions).toEqual(['us-east-1']);
    expect(JSON.stringify(iamPolicy('us-east-1'))).toContain('"aws:RequestedRegion":["us-east-1"]');
  });

  it.each(['cn-north-1', 'us-gov-west-1', 'Nowhere'])('has no catalogue for %s', (region) => {
    expect(() => probesFor(region)).toThrow(/probe allowlist is invalid/);
  });

  it('the exec boundary refuses a region the run is not pinned to', () => {
    const def = PROBES_BY_ID.get('b.ec2.vpcs');
    const eu = probesFor('eu-west-1').byId.get('b.ec2.vpcs');
    if (!def || !eu) throw new Error('missing probe');
    const argv = buildArgv(def, { region: 'ap-southeast-1', values: {} }, 'p');
    expect(() => assertArgvSafe(argv, def, 'ap-southeast-1')).not.toThrow();
    // A default-region probe in an eu-west-1 run, and an eu-west-1 argv in a default run.
    expect(() => assertArgvSafe(argv, def, 'ap-southeast-1', 'eu-west-1')).toThrow(
      BoundaryViolation,
    );
    const euArgv = buildArgv(eu, { region: 'eu-west-1', values: {} }, 'p');
    expect(() => assertArgvSafe(euArgv, eu, 'eu-west-1', 'eu-west-1')).not.toThrow();
    expect(() => assertArgvSafe(euArgv, eu, 'eu-west-1')).toThrow(
      /region eu-west-1 is not allowed/,
    );
    expect(() => assertArgvSafe(euArgv, eu, 'eu-west-1', 'cn-north-1')).toThrow(BoundaryViolation);
  });
});

describe('CLI --region', () => {
  const regionsOf = (calls: readonly { args: readonly string[] }[]) =>
    [
      ...new Set(
        calls
          .filter((c) => c.args[0] !== '--version')
          .map((c) => c.args[c.args.indexOf('--region') + 1]),
      ),
    ].sort();

  it('identity in another aws-partition region: every call goes to it or to us-east-1', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses());
    const argv = liveArgs('identity', box).map((t, i, a) =>
      a[i - 1] === '--region' ? 'eu-west-1' : t,
    );
    const r = await runCli(argv, fake.runner);
    expect(r.code, r.err.join('\n')).toBe(EXIT.OK);
    expect(regionsOf(fake.calls)).toEqual(['eu-west-1', 'us-east-1']);
    expect(r.out.join('\n')).toContain('workload region eu-west-1 (global endpoints: us-east-1)');
    const evidence = JSON.parse(readFileSync(box.evidence, 'utf8')) as {
      regions: { workload: string; global: string };
    };
    expect(evidence.regions).toEqual({ workload: 'eu-west-1', global: 'us-east-1' });
  });

  it('the default region and the evidence default (gitignored reports/, never docs/)', async () => {
    const box = sandbox();
    const repo = mkdtempSync(join(tmpdir(), 'aws-preflight-repo-'));
    const fake = fakeRunner(happyResponses());
    const argv = liveArgs('identity', box)
      .filter((t, i, a) => t !== '--evidence-out' && a[i - 1] !== '--evidence-out')
      .filter((t, i, a) => t !== '--region' && a[i - 1] !== '--region');
    const r = await runCli(argv, fake.runner, {
      repoRoot: repo,
      env: { HOME: box.home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
    expect(r.code, r.err.join('\n')).toBe(EXIT.OK);
    expect(regionsOf(fake.calls)).toEqual(['ap-southeast-1', 'us-east-1']);
    expect(readdirSync(join(repo, 'reports', 'aws-preflight'))).toEqual([
      'identity-20261014T053000Z-a1b2c3.json',
    ]);
    expect(existsSync(join(repo, 'docs'))).toBe(false);
  });

  it('plan prints the plan and IAM policy for --region; --write stays on the default region', async () => {
    const fake = fakeRunner({});
    const policy = await runCli(
      ['plan', '--format', 'iam-policy', '--region', 'eu-west-1'],
      fake.runner,
    );
    expect(policy.code).toBe(EXIT.OK);
    expect(policy.out.join('\n')).toContain('"eu-west-1"');
    expect(policy.out.join('\n')).not.toContain('ap-southeast-1');
    const write = await runCli(['plan', '--write', '--region', 'eu-west-1'], fake.runner);
    expect(write.code).toBe(EXIT.REFUSED);
    expect(write.err.join('\n')).toMatch(
      /--write regenerates the committed plan of the default region/,
    );
    const bad = await runCli(['plan', '--region', 'cn-north-1'], fake.runner);
    expect(bad.code).toBe(EXIT.REFUSED);
    expect(bad.err.join('\n')).toMatch(/aws-cn partition/);
    expect(fake.calls).toEqual([]);
  });
});
