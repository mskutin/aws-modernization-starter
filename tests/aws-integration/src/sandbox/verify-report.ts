/**
 * Reading the finops verify-clean report (tools/aws-sandbox, `verify-clean.schema.json`) for the
 * operator: exit 5 (`clean-with-unverifiable`) means nothing of the run was found, but some
 * categories (KMS keys, Secrets Manager secrets) could only be settled through fallbacks because
 * the role cannot list them. verify.sh / cleanup.sh print exactly those categories and their
 * evidence. The report is another tool's output: parsed defensively, account ids masked, one line
 * per entry, never more than 300 characters.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One printable line: no control characters, 12-digit account ids masked, bounded length. */
function printable(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/(?<![0-9])\d{12}(?![0-9])/g, (a) => `********${a.slice(-4)}`)
      .slice(0, 300)
  );
}

/** `UNVERIFIABLE <category> (<status>)` and its `evidence:` lines; [] when there is none. */
export function unverifiableLines(report: unknown): string[] {
  const summary = isRecord(report) ? report['summary'] : undefined;
  const list = isRecord(summary) ? summary['unverifiable'] : undefined;
  if (!Array.isArray(list)) return [];
  const lines: string[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry['category'] !== 'string') continue;
    const status = typeof entry['status'] === 'string' ? entry['status'] : 'unverifiable';
    lines.push(`UNVERIFIABLE ${printable(entry['category'])} (${printable(status)})`);
    const evidence = Array.isArray(entry['evidence'])
      ? entry['evidence'].filter((e): e is string => typeof e === 'string')
      : [];
    if (evidence.length === 0) lines.push('  evidence: none recorded');
    for (const e of evidence) lines.push(`  evidence: ${printable(e)}`);
  }
  return lines;
}
