/**
 * Proof, recorded per release (ADR 0411; opt-in with STARTER_RELEASE_SIGNING): on a protected ref
 * every job of the release chain of a component — build -> scan -> SBOM -> provenance -> publish ->
 * sign -> verify — ran on a protected runner (job tags only from the configured protected set, so
 * GitLab could only hand it to a runner carrying those tags; the operator registers those runners
 * `ref_protected`) and started from a fresh clone (no reused working copy).
 */

/**
 * The protected runner tags of this project: STARTER_PROTECTED_RUNNER_TAG and
 * STARTER_SIGNER_RUNNER_TAG (empty entries dropped). STARTER_RELEASE_RUNNER_TAG is not added: on a
 * protected ref it must name one of these runners, which this check proves. An empty set makes
 * every chain job fail the check (fail closed: an untagged job can land on any runner).
 */
export function protectedRunnerTags(env: Record<string, string | undefined>): string[] {
  return [
    ...new Set(
      [env.STARTER_PROTECTED_RUNNER_TAG, env.STARTER_SIGNER_RUNNER_TAG]
        .map((t) => (t ?? '').trim())
        .filter((t) => t.length > 0),
    ),
  ];
}

export const CHAIN_STEPS = [
  'build',
  'scan',
  'sbom',
  'provenance',
  'publish',
  'sign',
  'verify',
] as const;

/**
 * Clone evidence written by each chain job (tools/ci/scripts/clone-evidence.sh) and read back as an
 * artifact: the job token cannot read job logs (HTTP 401). A fresh clone's HEAD reflog has exactly
 * one entry; a reused working copy accumulates one per job.
 */
export interface CloneEvidence {
  job?: string;
  jobId?: number;
  runner?: string;
  gitStrategy?: string;
  reflogLines?: number;
}

export interface PipelineJob {
  id: number;
  name: string;
  status: string;
  tag_list?: string[];
  runner?: { id?: number; description?: string | null } | null;
  web_url?: string;
}

export interface ChainRow {
  step: string;
  job: string;
  id?: number;
  status: string;
  tags: string[];
  runner: string;
  freshClone: 'yes' | 'no' | 'unknown';
  problems: string[];
}

export interface ChainResult {
  ok: boolean;
  component: string;
  rows: ChainRow[];
  problems: string[];
}

export function cloneEvidence(evidence: CloneEvidence | undefined): ChainRow['freshClone'] {
  if (evidence === undefined || typeof evidence.reflogLines !== 'number') return 'unknown';
  if (evidence.reflogLines > 1) return 'no';
  return evidence.reflogLines === 1 && evidence.gitStrategy === 'clone' ? 'yes' : 'unknown';
}

export function evaluateChain(
  component: string,
  jobs: PipelineJob[],
  evidence: Map<number, CloneEvidence | undefined>,
  allowedTags: string[],
): ChainResult {
  const allowed = new Set(allowedTags);
  const rows: ChainRow[] = CHAIN_STEPS.map((step) => {
    const name = `container:${step}:${component}`;
    // The newest attempt counts (retries create a new job with the same name).
    const job = jobs.filter((j) => j.name === name).sort((a, b) => b.id - a.id)[0];
    if (!job) {
      return {
        step,
        job: name,
        status: 'missing',
        tags: [],
        runner: '-',
        freshClone: 'unknown',
        problems: [`${name} is not in this pipeline`],
      };
    }
    const tags = job.tag_list ?? [];
    const problems: string[] = [];
    if (job.status !== 'success') problems.push(`${name} status is ${job.status}`);
    if (allowedTags.length === 0)
      problems.push(
        `${name}: no protected runner tag is configured (STARTER_PROTECTED_RUNNER_TAG, STARTER_SIGNER_RUNNER_TAG)`,
      );
    else if (tags.length === 0 || tags.some((t) => !allowed.has(t)))
      problems.push(
        `${name} tags [${tags.join(', ')}] are not limited to [${allowedTags.join(', ')}]`,
      );
    const runner = job.runner?.description ?? '-';
    if (runner === '-') problems.push(`${name} has no runner recorded`);
    const fresh = cloneEvidence(evidence.get(job.id));
    if (fresh !== 'yes')
      problems.push(
        `${name}: fresh clone ${fresh === 'no' ? 'NOT used (reused working copy)' : 'not proven (no clone evidence)'}`,
      );
    return {
      step,
      job: name,
      id: job.id,
      status: job.status,
      tags,
      runner,
      freshClone: fresh,
      problems,
    };
  });
  const problems = rows.flatMap((r) => r.problems);
  return { ok: problems.length === 0, component, rows, problems };
}

export function renderChainMarkdown(r: ChainResult, pipelineUrl?: string): string {
  return [
    `# Release chain — ${r.component}`,
    '',
    `**Result:** ${r.ok ? 'PASSED — every chain job ran on a protected runner from a fresh clone' : 'FAILED'}`,
    ...(pipelineUrl ? ['', `Pipeline: ${pipelineUrl}`] : []),
    '',
    '| Step | Job | Status | Tags | Runner | Fresh clone |',
    '| --- | --- | --- | --- | --- | --- |',
    ...r.rows.map(
      (row) =>
        `| ${row.step} | \`${row.job}\`${row.id ? ` (#${row.id})` : ''} | ${row.status} | ${row.tags.join(', ') || '—'} | ${row.runner} | ${row.freshClone} |`,
    ),
    '',
    ...(r.problems.length ? ['## Problems', '', ...r.problems.map((p) => `- ${p}`), ''] : []),
  ].join('\n');
}
