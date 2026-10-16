import { CONTAINER_BUILD_OPT_OUT_NOTICE, type ImpactResult, requiredGateJobs } from './analyze.ts';

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderMarkdown(result: ImpactResult): string {
  const lines: string[] = [];
  const selectedComponents = result.components.filter((c) => c.selected);
  const selectedJobs = result.jobs.filter((j) => j.selected);
  lines.push('# CI impact report', '');
  lines.push(`- **Mode:** \`${result.mode}\``);
  lines.push(
    `- **Base:** ${result.base ? `\`${result.base}\`` : '_none_'}  **Head:** ${result.head ? `\`${result.head}\`` : '_n/a_'}`,
  );
  lines.push(`- **Changed files:** ${result.changedFiles.length}`);
  lines.push(`- **Components selected:** ${selectedComponents.length}/${result.components.length}`);
  lines.push(
    `- **Jobs selected:** ${selectedJobs.length}/${result.jobs.length} (gate requires ${requiredGateJobs(result).length})`,
  );
  lines.push('');
  if (result.errors.length > 0) {
    lines.push('## Errors (pipeline fails)', '');
    for (const e of result.errors) lines.push(`- ${e}`);
    lines.push('');
  }
  if ((result.notices ?? []).length > 0) {
    lines.push('## Notices (deliberate coverage reductions)', '');
    for (const n of result.notices ?? []) lines.push(`- ${n}`);
    lines.push('');
  }
  if (result.reasons.length > 0) {
    lines.push('## Why everything runs', '');
    for (const r of result.reasons) lines.push(`- ${r}`);
    lines.push('');
  }
  lines.push(
    '## Components',
    '',
    '| Component | Kind | Selected | Why |',
    '| --- | --- | --- | --- |',
  );
  for (const c of result.components) {
    lines.push(
      `| \`${c.id}\` | ${c.kind} | ${c.selected ? 'yes' : 'no'} | ${escapeCell(c.reasons.join('; ') || '—')} |`,
    );
  }
  lines.push(
    '',
    '## Jobs',
    '',
    '| Job | Source | Gate | Selected | Why |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const j of result.jobs) {
    const name = j.matrix ? `${j.name} [${j.matrix.values.join(', ')}]` : j.name;
    lines.push(
      `| \`${name}\` | ${j.source} | ${j.gated ? 'required' : '—'} | ${j.selected ? 'yes' : 'no'} | ${escapeCell(j.reason)} |`,
    );
  }
  if (result.files.length > 0) {
    lines.push(
      '',
      '## Changed files',
      '',
      '| File | Category | Components |',
      '| --- | --- | --- |',
    );
    for (const f of result.files.slice(0, 500)) {
      lines.push(
        `| \`${escapeCell(f.file)}\` | ${f.category} | ${f.components.join(', ') || '—'} |`,
      );
    }
    if (result.files.length > 500) lines.push(`| … ${result.files.length - 500} more | | |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** dotenv consumed by downstream jobs (`needs: impact`). Values must be single-line. */
export function renderDotenv(result: ImpactResult): string {
  const components = result.components.filter((c) => c.selected).map((c) => c.id);
  return [
    `IMPACT_MODE=${result.mode}`,
    `IMPACT_COMPONENTS=${components.join(',')}`,
    `IMPACT_BASE_SHA=${result.base ?? ''}`,
    `IMPACT_REQUIRED_JOBS=${requiredGateJobs(result).length}`,
    `IMPACT_CONTAINER_BUILD=${(result.notices ?? []).includes(CONTAINER_BUILD_OPT_OUT_NOTICE) ? 'disabled' : 'enabled'}`,
    '',
  ].join('\n');
}
