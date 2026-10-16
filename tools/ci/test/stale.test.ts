import { describe, expect, it } from 'vitest';
import { evaluateStale, renderStaleMarkdown, type StaleInput } from '../src/stale.ts';

const now = new Date('2026-10-14T00:00:00Z');
const daysAgo = (d: number): string => new Date(now.getTime() - d * 86_400_000).toISOString();

const base: StaleInput = {
  defaultBranch: 'main',
  branches: [
    {
      name: 'main',
      merged: false,
      protected: true,
      default: true,
      commit: { committed_date: daysAgo(400) },
    },
    {
      name: 'feature/done',
      merged: true,
      protected: false,
      default: false,
      commit: { committed_date: daysAgo(2) },
    },
    {
      name: 'feature/old',
      merged: false,
      protected: false,
      default: false,
      commit: { committed_date: daysAgo(45) },
    },
    {
      name: 'feature/new',
      merged: false,
      protected: false,
      default: false,
      commit: { committed_date: daysAgo(1) },
    },
  ],
  mergeRequests: [
    { iid: 7, title: 'quiet MR', updated_at: daysAgo(20) },
    { iid: 8, title: 'active MR', updated_at: daysAgo(1) },
  ],
  jobs: [
    {
      id: 1,
      name: 'container:build:api',
      created_at: daysAgo(40),
      artifacts: [{ file_type: 'archive', size: 4096 }],
      artifacts_expire_at: null,
    },
    {
      id: 2,
      name: 'lint',
      created_at: daysAgo(40),
      artifacts: [{ file_type: 'archive', size: 2048 }],
      artifacts_expire_at: daysAgo(-3),
    },
    {
      id: 3,
      name: 'impact',
      created_at: daysAgo(40),
      artifacts: [{ file_type: 'trace', size: 9000 }],
      artifacts_expire_at: null,
    },
    {
      id: 4,
      name: 'test:api',
      created_at: daysAgo(2),
      artifacts: [{ file_type: 'archive', size: 1024 }],
      artifacts_expire_at: null,
    },
  ],
  registryTags: [
    { repository: 'root/x/api', name: 'main', created_at: daysAgo(90), total_size: 50 << 20 },
    { repository: 'root/x/api', name: 'abc123', created_at: daysAgo(90), total_size: 50 << 20 },
    { repository: 'root/x/api', name: 'def456', created_at: daysAgo(5), total_size: 50 << 20 },
    {
      repository: 'root/x/api',
      name: `sha256-${'a'.repeat(64)}`,
      created_at: daysAgo(90),
      total_size: 1,
    },
  ],
  keepTags: ['main'],
};

describe('stale-resource report (report only)', () => {
  it('finds merged and inactive branches, quiet MRs, unexpiring artifacts and old tags', () => {
    const r = evaluateStale(base, now);
    expect(r.findings.map((f) => `${f.kind} ${f.subject}`)).toEqual([
      'merged-branch feature/done',
      'inactive-branch feature/old',
      'stale-merge-request !7',
      'artifacts-without-expiry job 1 container:build:api',
      'old-registry-tag root/x/api:abc123',
    ]);
    expect(r.counts['old-registry-tag']).toBe(1);
  });

  it('never reports protected/default branches, moving tags, referrer indexes or trace-only jobs', () => {
    const subjects = evaluateStale(base, now).findings.map((f) => f.subject);
    expect(subjects).not.toContain('main');
    expect(subjects.some((s) => s.includes(':main') || s.includes('sha256-'))).toBe(false);
    expect(subjects.some((s) => s.includes('impact'))).toBe(false);
  });

  it('is clean for an empty project and says it deleted nothing', () => {
    const r = evaluateStale(
      { ...base, branches: [], mergeRequests: [], jobs: [], registryTags: [] },
      now,
    );
    expect(r.findings).toEqual([]);
    const md = renderStaleMarkdown(r);
    expect(md).toContain('No stale resources found.');
    expect(md).toContain('nothing was deleted');
  });
});
