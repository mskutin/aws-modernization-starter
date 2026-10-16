import { type ImpactResult, requiredGateJobs } from './analyze.ts';

/**
 * Mandatory gate verification.
 *
 * Every gated job writes a dotenv marker `GATE_<CI_JOB_ID>=<CI_JOB_NAME>` in
 * after_script when it succeeds (see `.gated` in .gitlab/ci/templates.yml).
 * `gates:mandatory` needs all gated jobs with `optional: true`, so it only
 * starts once every present job passed and inherits all their markers. This
 * function checks that every job the runtime impact analysis requires is among
 * them — catching rules that skipped a job the analysis says is needed.
 */

/**
 * How to force every job. MR pipelines accept no run-time variables, and no branch
 * pipeline is created while an MR is open, so the "Run pipeline" form does not help an MR.
 */
export const RUN_ALL_HELP =
  'MR: a Maintainer sets the project CI/CD variable IMPACT_RUN_ALL=true, re-runs the MR pipeline and deletes the variable afterwards (MR pipelines accept no run-time variables), or the MR includes a change to a global path (components.yaml `global:`; that is a gate-defining change and needs gate-policy approval). Branch without an open MR: a Maintainer runs a pipeline with IMPACT_RUN_ALL=true from the Run pipeline form.';

export interface GateOutcome {
  ok: boolean;
  required: string[];
  passed: string[];
  missing: string[];
  messages: string[];
  /** Deliberate coverage reductions from the impact analysis (project opt-outs), shown, not failed. */
  notices: string[];
}

export function passedJobsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(
      ([key, value]) => /^GATE_\d+$/.test(key) && typeof value === 'string' && value.length > 0,
    )
    .map(([, value]) => (value as string).trim())
    .sort();
}

function satisfied(required: string, passed: string[]): boolean {
  // Matrix jobs are named "<job>: [value]".
  return passed.some((p) => p === required || p.startsWith(`${required}: [`));
}

export function evaluateGate(result: ImpactResult, passed: string[]): GateOutcome {
  const messages: string[] = [];
  const required = requiredGateJobs(result);
  const missing = required.filter((r) => !satisfied(r, passed));
  if (result.errors.length > 0) {
    messages.push(...result.errors.map((e) => `impact analysis error: ${e}`));
  }
  for (const job of result.jobs.filter((j) => j.selected && j.gated && j.matrix)) {
    const instances = passed.filter((p) => p.startsWith(`${job.name}: [`)).length;
    const expected = job.matrix?.values.length ?? 0;
    if (instances > 0 && instances < expected) {
      messages.push(`${job.name}: only ${instances}/${expected} matrix instances reported success`);
      missing.push(job.name);
    }
  }
  if (missing.length > 0) {
    messages.push(
      `required job(s) did not run or did not report success: ${[...new Set(missing)].join(', ')}.`,
      result.mode === 'all'
        ? `Impact analysis is in run-all mode (${result.reasons.join('; ')}) but the pipeline did not contain every job. ${RUN_ALL_HELP}`
        : `The generated rules and the runtime analysis disagree. Regenerate .gitlab/ci/generated/components.yml (pnpm ci:generate), or force every job: ${RUN_ALL_HELP}`,
    );
  }
  return {
    ok: messages.length === 0,
    required,
    passed,
    missing: [...new Set(missing)],
    messages,
    notices: [...(result.notices ?? [])],
  };
}

export function renderGateMarkdown(outcome: GateOutcome): string {
  const lines = ['# Mandatory gate', '', `**Result:** ${outcome.ok ? 'PASSED' : 'FAILED'}`, ''];
  for (const m of outcome.messages) lines.push(`- ${m}`);
  for (const n of outcome.notices) lines.push(`- NOTICE: ${n}`);
  lines.push('', '| Required job | Status |', '| --- | --- |');
  for (const r of outcome.required) {
    lines.push(`| \`${r}\` | ${outcome.missing.includes(r) ? 'MISSING' : 'passed'} |`);
  }
  lines.push('');
  return lines.join('\n');
}
