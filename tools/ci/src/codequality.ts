import { createHash } from 'node:crypto';
import { relative } from 'node:path';

/** GitLab Code Quality (CodeClimate subset) issue. */
export interface CodeQualityIssue {
  description: string;
  check_name: string;
  fingerprint: string;
  severity: 'info' | 'minor' | 'major' | 'critical' | 'blocker';
  location: { path: string; lines: { begin: number } };
}

interface EslintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line?: number;
}

interface EslintResult {
  filePath: string;
  messages: EslintMessage[];
}

function fingerprint(...parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

export function eslintToCodeQuality(results: EslintResult[], root: string): CodeQualityIssue[] {
  const issues: CodeQualityIssue[] = [];
  for (const result of results) {
    const path = relative(root, result.filePath).split('\\').join('/');
    for (const m of result.messages) {
      const rule = m.ruleId ?? 'eslint';
      const line = m.line ?? 1;
      issues.push({
        description: `${rule}: ${m.message}`,
        check_name: rule,
        fingerprint: fingerprint(path, line, rule, m.message),
        severity: m.severity >= 2 ? 'major' : 'minor',
        location: { path, lines: { begin: line } },
      });
    }
  }
  return issues;
}

export function summarize(issues: CodeQualityIssue[]): string {
  if (issues.length === 0) return 'code quality: no findings';
  const lines = issues
    .slice(0, 200)
    .map((i) => `  ${i.location.path}:${i.location.lines.begin} [${i.severity}] ${i.description}`);
  return [`code quality: ${issues.length} finding(s)`, ...lines].join('\n');
}
