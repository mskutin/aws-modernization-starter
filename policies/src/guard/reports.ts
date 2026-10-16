import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DISCLAIMER, POLICY_BASELINE_VERSION, RULES, ruleById } from '../catalogue.js';
import { guardRuleName, ruleIdFromGuardName } from '../types.js';
import { summarize, type GuardFinding, type GuardValidateResult } from './runner.js';

const xml = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const describeFinding = (f: GuardFinding): string =>
  `${f.logicalId}${f.cdkPath ? ` (${f.cdkPath})` : ''} ${f.path}: ${f.message}`;

/** JUnit XML: one test suite per template, one test case per Guard rule. */
export function toJUnit(result: GuardValidateResult): string {
  const suites = result.templates.map((template) => {
    const statuses = result.ruleStatus.filter((s) => s.template === template);
    const cases = statuses.map(({ guardRule, status }) => {
      const ruleId = ruleIdFromGuardName(guardRule);
      const found = result.findings.filter(
        (f) => f.template === template && f.guardRule === guardRule,
      );
      const open = found.filter((f) => !f.exception);
      const name = `${ruleId} ${ruleById(ruleId)?.title ?? ''}`.trim();
      const head = `    <testcase classname="${xml(template)}" name="${xml(name)}">`;
      if (status === 'SKIP') return `${head}<skipped message="not applicable"/></testcase>`;
      if (status === 'FAIL' && open.some((f) => f.blocking)) {
        const body = open.map(describeFinding).join('\n');
        return `${head}<failure message="${xml(`${open.length} finding(s)`)}">${xml(body)}</failure></testcase>`;
      }
      if (status === 'FAIL' && open.length > 0) {
        return `${head}<system-out>${xml(`ADVISORY:\n${open.map(describeFinding).join('\n')}`)}</system-out></testcase>`;
      }
      if (status === 'FAIL') {
        const body = found
          .map((f) => `${describeFinding(f)} [waived by ${f.exception?.id ?? '?'}]`)
          .join('\n');
        return `${head}<skipped message="waived by governed exception"/><system-out>${xml(body)}</system-out></testcase>`;
      }
      return `${head}</testcase>`;
    });
    const failures = cases.filter((c) => c.includes('<failure')).length;
    const skipped = cases.filter((c) => c.includes('<skipped')).length;
    return [
      `  <testsuite name="${xml(template)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}" errors="0">`,
      ...cases,
      '  </testsuite>',
    ].join('\n');
  });
  const governance = result.exceptionIssues
    .filter((i) => i.level === 'error')
    .map(
      (i) =>
        `    <testcase classname="policies/exceptions/exceptions.yaml" name="${xml(`${i.code} ${i.exceptionId ?? ''}`.trim())}"><failure message="${xml(i.message)}"/></testcase>`,
    );
  if (governance.length > 0) {
    suites.push(
      [
        `  <testsuite name="exception-governance" tests="${governance.length}" failures="${governance.length}" errors="0">`,
        ...governance,
        '  </testsuite>',
      ].join('\n'),
    );
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="starter-policies guard">',
    ...suites,
    '</testsuites>',
    '',
  ].join('\n');
}

/** SARIF 2.1.0 (waived findings carry an external suppression with the exception justification). */
export function toSarif(result: GuardValidateResult): object {
  const guardRules = RULES.filter((r) => r.engines.includes('guard'));
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'starter-policies/cfn-guard',
            version: POLICY_BASELINE_VERSION,
            informationUri: 'https://github.com/aws-cloudformation/cloudformation-guard',
            properties: { guardVersion: result.guardVersion, disclaimer: DISCLAIMER },
            rules: guardRules.map((r) => ({
              id: r.id,
              name: guardRuleName(r.id),
              shortDescription: { text: r.title },
              fullDescription: { text: r.description },
              help: { text: `${r.rationale} Remediation: ${r.remediation}` },
              defaultConfiguration: { level: r.severity === 'low' ? 'warning' : 'error' },
              properties: { severity: r.severity, tags: ['proposed-baseline'] },
            })),
          },
        },
        results: result.findings.map((f) => ({
          ruleId: f.ruleId,
          level: f.blocking ? 'error' : 'warning',
          message: { text: f.message || f.ruleId },
          locations: [
            {
              physicalLocation: { artifactLocation: { uri: f.template } },
              logicalLocations: [
                {
                  name: f.logicalId,
                  fullyQualifiedName: f.cdkPath ?? f.logicalId,
                  kind: 'resource',
                },
              ],
              properties: { propertyPath: f.path, environment: f.environment ?? null },
            },
          ],
          ...(f.exception
            ? {
                suppressions: [
                  {
                    kind: 'external',
                    status: 'accepted',
                    justification: `${f.exception.id} (${f.exception.ticket}, expires ${f.exception.expiresAt}): ${f.exception.justification}`,
                  },
                ],
              }
            : {}),
        })),
      },
    ],
  };
}

export function toMarkdown(result: GuardValidateResult, failOnAdvisory = false): string {
  const s = summarize(result, failOnAdvisory);
  const lines = [
    '## Policy-as-code: CloudFormation Guard',
    '',
    `> ${DISCLAIMER}`,
    '',
    `**Result: ${s.passed ? 'PASSED' : 'FAILED'}** — templates: ${s.templates}, blocking: ${s.blocking}, advisory: ${s.advisory}, waived: ${s.excepted}, exception errors: ${s.exceptionErrors} (cfn-guard ${result.guardVersion}, baseline ${POLICY_BASELINE_VERSION})`,
    '',
  ];
  const errors = result.exceptionIssues.filter((i) => i.level === 'error');
  if (errors.length > 0) {
    lines.push('### Exception governance errors', '', ...errors.map((i) => `- ${i.message}`), '');
  }
  if (result.findings.length > 0) {
    lines.push(
      '| Rule | Severity | Template | Resource | Property | Message | Status |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...result.findings.map(
        (f) =>
          `| ${f.ruleId} | ${f.severity} | ${f.template} | ${f.cdkPath ?? f.logicalId} | ${f.path} | ${f.message.replaceAll('|', '\\|')} | ${f.exception ? `waived (${f.exception.id})` : f.blocking ? 'BLOCKING' : 'advisory'} |`,
      ),
      '',
    );
  }
  return lines.join('\n');
}

export function writeGuardReports(
  result: GuardValidateResult,
  outDir: string,
  failOnAdvisory = false,
): string[] {
  mkdirSync(outDir, { recursive: true });
  const files = {
    'guard-results.json': JSON.stringify(
      { summary: summarize(result, failOnAdvisory), disclaimer: DISCLAIMER, ...result },
      null,
      2,
    ),
    'guard-junit.xml': toJUnit(result),
    'guard.sarif': JSON.stringify(toSarif(result), null, 2),
    'guard-summary.md': toMarkdown(result, failOnAdvisory),
  };
  return Object.entries(files).map(([name, content]) => {
    const path = join(outDir, name);
    writeFileSync(path, content);
    return path;
  });
}
