/**
 * Stale-resource report (SCHEDULE_TASK=stale, ADR 0412). REPORT ONLY: nothing is ever deleted.
 *
 * Inputs come from the GitLab API with the scheduled job's own CI_JOB_TOKEN (it can read branches,
 * merge requests, jobs and registry repositories of its own project; verified on CE 19.4.1).
 * Untagged registry manifests are not visible through the API; the report says so instead of
 * claiming a clean registry.
 */

export interface StaleThresholds {
  branchDays: number;
  mergeRequestDays: number;
  artifactDays: number;
  registryTagDays: number;
}

export const DEFAULT_THRESHOLDS: StaleThresholds = {
  branchDays: 30,
  mergeRequestDays: 14,
  artifactDays: 30,
  registryTagDays: 60,
};

export interface BranchInfo {
  name: string;
  merged: boolean;
  protected: boolean;
  default: boolean;
  commit?: { committed_date?: string };
}
export interface MergeRequestInfo {
  iid: number;
  title: string;
  updated_at: string;
  draft?: boolean;
  source_branch?: string;
}
export interface JobInfo {
  id: number;
  name: string;
  created_at: string;
  ref?: string;
  artifacts?: Array<{ file_type: string; size: number }>;
  artifacts_expire_at?: string | null;
}
export interface RegistryTagInfo {
  repository: string;
  name: string;
  created_at?: string | null;
  total_size?: number | null;
}

export interface StaleInput {
  defaultBranch: string;
  branches: BranchInfo[];
  mergeRequests: MergeRequestInfo[];
  jobs: JobInfo[];
  registryTags: RegistryTagInfo[];
  /** Tags that are moving pointers (default branch, release tags in use) and never stale. */
  keepTags: string[];
}

export type StaleKind =
  | 'merged-branch'
  | 'inactive-branch'
  | 'stale-merge-request'
  | 'artifacts-without-expiry'
  | 'old-registry-tag';

export interface StaleFinding {
  kind: StaleKind;
  subject: string;
  ageDays: number;
  detail: string;
}

export interface StaleReport {
  generatedAt: string;
  thresholds: StaleThresholds;
  findings: StaleFinding[];
  counts: Record<StaleKind, number>;
  notes: string[];
}

const DAY = 86_400_000;
export const ageInDays = (iso: string | null | undefined, now: Date): number =>
  iso ? Math.floor((now.getTime() - Date.parse(iso)) / DAY) : Number.NaN;

export function evaluateStale(
  input: StaleInput,
  now: Date,
  t: StaleThresholds = DEFAULT_THRESHOLDS,
): StaleReport {
  const findings: StaleFinding[] = [];
  for (const b of input.branches) {
    if (b.protected || b.default || b.name === input.defaultBranch) continue;
    const age = ageInDays(b.commit?.committed_date, now);
    if (b.merged) {
      findings.push({
        kind: 'merged-branch',
        subject: b.name,
        ageDays: age,
        detail: `merged into ${input.defaultBranch} but not deleted`,
      });
    } else if (age >= t.branchDays) {
      findings.push({
        kind: 'inactive-branch',
        subject: b.name,
        ageDays: age,
        detail: `no commit for ${age} days (threshold ${t.branchDays})`,
      });
    }
  }
  for (const mr of input.mergeRequests) {
    const age = ageInDays(mr.updated_at, now);
    if (age >= t.mergeRequestDays) {
      findings.push({
        kind: 'stale-merge-request',
        subject: `!${mr.iid}`,
        ageDays: age,
        detail: `open, not updated for ${age} days: ${mr.title}`,
      });
    }
  }
  for (const job of input.jobs) {
    const size = (job.artifacts ?? [])
      .filter((a) => a.file_type !== 'trace')
      .reduce((sum, a) => sum + a.size, 0);
    if (size === 0 || job.artifacts_expire_at) continue;
    const age = ageInDays(job.created_at, now);
    if (age >= t.artifactDays) {
      findings.push({
        kind: 'artifacts-without-expiry',
        subject: `job ${job.id} ${job.name}`,
        ageDays: age,
        detail: `${Math.round(size / 1024)} KiB kept without expiry (ref ${job.ref ?? '?'})`,
      });
    }
  }
  const keep = new Set(input.keepTags);
  for (const tag of input.registryTags) {
    if (keep.has(tag.name) || /^sha256-[0-9a-f]{64}/.test(tag.name)) continue; // pointers, referrer indexes
    const age = ageInDays(tag.created_at, now);
    if (age >= t.registryTagDays) {
      findings.push({
        kind: 'old-registry-tag',
        subject: `${tag.repository}:${tag.name}`,
        ageDays: age,
        detail: `${Math.round((tag.total_size ?? 0) / 1048576)} MiB, older than ${t.registryTagDays} days`,
      });
    }
  }
  const counts = {
    'merged-branch': 0,
    'inactive-branch': 0,
    'stale-merge-request': 0,
    'artifacts-without-expiry': 0,
    'old-registry-tag': 0,
  } satisfies Record<StaleKind, number>;
  for (const f of findings) counts[f.kind] += 1;
  return {
    generatedAt: now.toISOString(),
    thresholds: t,
    findings,
    counts,
    notes: [
      'Report only: nothing was deleted.',
      'Untagged registry manifests are not visible through the GitLab API; run the registry garbage collector in dry-run mode to size them.',
    ],
  };
}

export function renderStaleMarkdown(r: StaleReport): string {
  const kinds = Object.entries(r.counts) as Array<[StaleKind, number]>;
  return [
    '# Stale resources (report only)',
    '',
    `Generated ${r.generatedAt}; thresholds: branches ${r.thresholds.branchDays} d, MRs ${r.thresholds.mergeRequestDays} d, artifacts ${r.thresholds.artifactDays} d, registry tags ${r.thresholds.registryTagDays} d.`,
    '',
    '| Kind | Count |',
    '| --- | --- |',
    ...kinds.map(([k, n]) => `| ${k} | ${n} |`),
    '',
    ...(r.findings.length
      ? [
          '| Kind | Subject | Age (days) | Detail |',
          '| --- | --- | --- | --- |',
          ...r.findings.map(
            (f) =>
              `| ${f.kind} | \`${f.subject}\` | ${Number.isNaN(f.ageDays) ? '?' : f.ageDays} | ${f.detail.replaceAll('|', '\\|')} |`,
          ),
          '',
        ]
      : ['No stale resources found.', '']),
    ...r.notes.map((n) => `- ${n}`),
    '',
  ].join('\n');
}
