import { describe, expect, it } from 'vitest';
import {
  CHAIN_STEPS,
  type CloneEvidence,
  cloneEvidence,
  evaluateChain,
  type PipelineJob,
  protectedRunnerTags,
  renderChainMarkdown,
} from '../src/chain-report.ts';

const FRESH: CloneEvidence = { gitStrategy: 'clone', reflogLines: 1 };
const REUSED: CloneEvidence = { gitStrategy: 'fetch', reflogLines: 4 };
// Adopter-chosen tags (STARTER_PROTECTED_RUNNER_TAG, STARTER_SIGNER_RUNNER_TAG).
const allowed = ['release-protected', 'release-signer'];

function chain(overrides: Partial<Record<string, Partial<PipelineJob>>> = {}): PipelineJob[] {
  return CHAIN_STEPS.map((step, i) => ({
    id: 100 + i,
    name: `container:${step}:api`,
    status: 'success',
    tag_list: [step === 'sign' ? 'release-signer' : 'release-protected'],
    runner: {
      id: 7,
      description: step === 'sign' ? 'signer-runner' : 'protected-runner',
    },
    ...overrides[step],
  }));
}
const traces = (
  jobs: PipelineJob[],
  e: CloneEvidence = FRESH,
): Map<number, CloneEvidence | undefined> => new Map(jobs.map((j) => [j.id, e]));

describe('release chain report', () => {
  it('passes when every chain job ran on a protected runner from a fresh clone', () => {
    const jobs = chain();
    const r = evaluateChain('api', jobs, traces(jobs), allowed);
    expect(r.ok).toBe(true);
    expect(r.rows.map((row) => row.step)).toEqual([...CHAIN_STEPS]);
    expect(renderChainMarkdown(r)).toContain('PASSED');
  });

  it('fails when a chain job ran on the default runner (regression)', () => {
    const jobs = chain({
      build: { tag_list: ['generic'], runner: { description: 'generic-runner' } },
    });
    const r = evaluateChain('api', jobs, traces(jobs), allowed);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/container:build:api tags \[generic\]/);
  });

  it('fails when a chain job was untagged (STARTER_RELEASE_RUNNER_TAG unset)', () => {
    const jobs = chain({ scan: { tag_list: [] } });
    const r = evaluateChain('api', jobs, traces(jobs), allowed);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/container:scan:api tags \[\] are not limited/);
  });

  it('fails closed when no protected runner tag is configured', () => {
    expect(protectedRunnerTags({})).toEqual([]);
    expect(
      protectedRunnerTags({ STARTER_PROTECTED_RUNNER_TAG: ' p ', STARTER_SIGNER_RUNNER_TAG: '' }),
    ).toEqual(['p']);
    const jobs = chain();
    const r = evaluateChain('api', jobs, traces(jobs), protectedRunnerTags({}));
    expect(r.ok).toBe(false);
    expect(r.problems).toContain(
      'container:build:api: no protected runner tag is configured (STARTER_PROTECTED_RUNNER_TAG, STARTER_SIGNER_RUNNER_TAG)',
    );
  });

  it('fails when a chain job reused a working copy', () => {
    const jobs = chain();
    const t = traces(jobs);
    t.set(jobs[0]?.id ?? 0, REUSED);
    const r = evaluateChain('api', jobs, t, allowed);
    expect(r.ok).toBe(false);
    expect(r.rows[0]?.freshClone).toBe('no');
  });

  it('fails when a step is missing, failed or its log is unreadable', () => {
    const jobs = chain({ sign: { status: 'failed' } }).filter(
      (j) => j.name !== 'container:verify:api',
    );
    const t = traces(jobs);
    t.set(jobs[2]?.id ?? 0, undefined);
    const r = evaluateChain('api', jobs, t, allowed);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(
      expect.arrayContaining([
        'container:verify:api is not in this pipeline',
        'container:sign:api status is failed',
        'container:sbom:api: fresh clone not proven (no clone evidence)',
      ]),
    );
  });

  it('uses the newest attempt of a retried job', () => {
    const jobs = [
      ...chain({ scan: { status: 'failed' } }),
      { ...chain()[1]!, id: 999, status: 'success' },
    ];
    const r = evaluateChain('api', jobs, traces(jobs), allowed);
    expect(r.rows.find((row) => row.step === 'scan')?.id).toBe(999);
    expect(r.ok).toBe(true);
  });

  it('classifies clone evidence', () => {
    expect(cloneEvidence(FRESH)).toBe('yes');
    expect(cloneEvidence(REUSED)).toBe('no');
    expect(cloneEvidence({ gitStrategy: 'fetch', reflogLines: 1 })).toBe('unknown');
    expect(cloneEvidence({ gitStrategy: 'clone' })).toBe('unknown');
    expect(cloneEvidence(undefined)).toBe('unknown');
  });
});
