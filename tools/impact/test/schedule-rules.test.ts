import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SCHEDULE_TASK_IF, SCHEDULE_TASKS } from '../src/generate.ts';

// Real repository files (read-only): the committed CI definition and the schedule script.
const repo = join(import.meta.dirname, '..', '..', '..');
const ciFiles = [
  '.gitlab-ci.yml',
  ...readdirSync(join(repo, '.gitlab/ci'))
    .filter((f) => f.endsWith('.yml'))
    .map((f) => `.gitlab/ci/${f}`),
  '.gitlab/ci/generated/components.yml',
];

/** Every `if:` condition of every rules list (workflow and jobs) in a parsed CI file. */
function ruleConditions(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'rules' && Array.isArray(value)) {
          for (const rule of value) {
            const cond = (rule as { if?: unknown }).if;
            if (typeof cond === 'string') out.push(cond);
          }
        }
        walk(value);
      }
    }
  };
  walk(doc);
  return out;
}

describe('schedule task rules (ADR 0412)', () => {
  const conditions = ciFiles.flatMap((file) =>
    ruleConditions(parse(readFileSync(join(repo, file), 'utf8'))).map((cond) => ({ file, cond })),
  );
  const taskConditions = conditions.filter(({ cond }) => cond.includes('$SCHEDULE_TASK'));

  it('finds the task rules it is meant to check', () => {
    expect(taskConditions.length).toBeGreaterThan(10);
  });

  it('never tests $SCHEDULE_TASK bare: only the task allowlist or one known task', () => {
    // A bare `$SCHEDULE_TASK` was true for the empty YAML default in workflow:rules (observed on a
    // scheduled pipeline) but false in job rules, and an unknown value gave a near-empty pipeline.
    const allowed = new RegExp(
      `\\$SCHEDULE_TASK(?: =~ ${SCHEDULE_TASK_IF.slice('$SCHEDULE_TASK =~ '.length).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}| == "(?:${SCHEDULE_TASKS.join('|')})")`,
      'g',
    );
    for (const { file, cond } of taskConditions) {
      const uses = cond.match(/\$SCHEDULE_TASK/g)?.length ?? 0;
      const vetted = cond.match(allowed)?.length ?? 0;
      expect({ file, cond, vetted }).toEqual({ file, cond, vetted: uses });
    }
  });

  it('workflow:rules and job rules use the same task allowlist', () => {
    const workflow = ruleConditions(
      (parse(readFileSync(join(repo, '.gitlab-ci.yml'), 'utf8')) as { workflow: unknown }).workflow,
    ).filter((c) => c.includes('$SCHEDULE_TASK'));
    expect(workflow.length).toBeGreaterThan(0);
    for (const cond of workflow) expect(cond).toContain(SCHEDULE_TASK_IF);
  });
});
