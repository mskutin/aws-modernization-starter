/**
 * starter-policies CLI (used by CI). Exit codes:
 *   0 = passed, 1 = policy/exception failures, 2 = usage or environment error.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { DISCLAIMER, POLICY_BASELINE_VERSION, RULES } from '../catalogue.js';
import { checkApprovals, entryDigest, loadApprovals, rawEntries } from '../exceptions/approvals.js';
import { REFERENCE_ENTRY_DIGESTS } from '../exceptions/reference-pins.js';
import { auditSuppressions, unusedSuppressions } from '../exceptions/audit.js';
import {
  DEFAULT_WARN_WITHIN_DAYS,
  loadExceptionsFile,
  type ExceptionIssue,
  type ExceptionsCheckResult,
} from '../exceptions/exceptions.js';
import { loadSuppressionsFile, type SuppressionRegister } from '../exceptions/suppressions.js';
import {
  DEFAULT_EXCEPTIONS_PATH,
  DEFAULT_SUPPRESSIONS_PATH,
  GUARD_RULES_DIR,
  repoRoot,
  userPath,
} from '../guard/layout.js';
import { writeGuardReports } from '../guard/reports.js';
import {
  GuardUnavailableError,
  findTemplates,
  runGuardTests,
  runGuardValidate,
  summarize,
} from '../guard/runner.js';

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2 } as const;

const USAGE = `starter-policies <command> [options]   (baseline ${POLICY_BASELINE_VERSION})

Commands:
  check-exceptions   Validate the governed exceptions (exceptions.yaml) and the suppression
                     register (suppressions.yaml): schema, expiry/review dates, governance
      --file <path>             exceptions file (default: policies/exceptions/exceptions.yaml)
      --suppressions <path>     suppression register (default: policies/exceptions/suppressions.yaml)
      --today <YYYY-MM-DD>      evaluation date (default: today, UTC)
      --warn-within-days <n>    warn about exceptions expiring soon (default ${DEFAULT_WARN_WITHIN_DAYS})
      --templates <dir>         also audit every cdk_nag suppression in synthesized templates
      --audit-scope all|baseline every suppression (default) or BASE-* suppressions only (legacy)
      --approvals <path>        fail on project entries (not reference-design ones) whose exact
                                content has no approval recorded in this file (kept OUTSIDE the
                                MR, e.g. the gate project)
      --report <path>           write a JSON report (issues + suppression inventory)
  approval-digests   Print id + sha256 of every project exception and register entry (to record
                     approvals); reference-design entries need none
      --file <path>  --suppressions <path>
  guard-validate     Run CloudFormation Guard over synthesized templates
      --dir <path>              cdk.out directory or template file (default: <repo>/infra/cdk.out)
      --rules <dir>             Guard rules directory (default: policies/guard/rules)
      --exceptions <path>       exceptions file (default: policies/exceptions/exceptions.yaml)
      --no-exceptions           ignore exceptions
      --out <dir>               report directory (default: <repo>/reports/policies)
      --today <YYYY-MM-DD>      evaluation date for exception expiry
      --fail-on-advisory        also fail on low-severity (advisory) findings
  guard-test         Run Guard unit tests for every rule (cfn-guard test)
      --rules <dir>  --out <dir>
  catalogue          Print the rule catalogue (--format md|json)

${DISCLAIMER}
`;

function issueLines(issues: readonly ExceptionIssue[]): string[] {
  return issues.map((i) => `  [${i.level.toUpperCase()}] ${i.code}: ${i.message}`);
}

/** Reference-design entries are part of the code: listed, never approved by digest. */
const isUndatedRaw = (raw: unknown): boolean =>
  (raw as { status?: unknown } | null)?.status !== undefined;
const referenceCount = (entries: readonly { status?: string | undefined }[]): string => {
  const n = entries.filter((e) => e.status === 'reference').length;
  return n > 0 ? ` (${n} reference design: part of the code, no expiry, no approval)` : '';
};

function exceptionsText(result: ExceptionsCheckResult, register: SuppressionRegister): string {
  return [
    `exceptions: ${result.exceptions.length} defined, ${result.active.length} active${referenceCount(result.active)}`,
    ...issueLines(result.issues),
    `suppressions: ${register.suppressions.length} defined, ${register.active.length} active${referenceCount(register.active)}`,
    ...issueLines(register.issues),
  ].join('\n');
}

function checkExceptionsCmd(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      file: { type: 'string' },
      suppressions: { type: 'string' },
      today: { type: 'string' },
      'warn-within-days': { type: 'string' },
      templates: { type: 'string' },
      'audit-scope': { type: 'string', default: 'all' },
      approvals: { type: 'string' },
      report: { type: 'string' },
    },
  });
  const scopeArg = values['audit-scope'];
  if (scopeArg !== 'all' && scopeArg !== 'baseline') {
    console.error(
      `check-exceptions: --audit-scope must be "all" or "baseline" (got "${scopeArg}")`,
    );
    return EXIT.USAGE;
  }
  const dates = values.today ? { today: values.today } : {};
  const file = values.file ? userPath(values.file) : DEFAULT_EXCEPTIONS_PATH;
  const result = loadExceptionsFile(file, {
    ...dates,
    ...(values['warn-within-days'] ? { warnWithinDays: Number(values['warn-within-days']) } : {}),
  });
  const registerFile = values.suppressions
    ? userPath(values.suppressions)
    : DEFAULT_SUPPRESSIONS_PATH;
  const register = loadSuppressionsFile(registerFile, dates);
  let audit: ReturnType<typeof auditSuppressions> | undefined;
  const auditIssues: ExceptionIssue[] = [];
  if (values.templates) {
    const files = findTemplates(userPath(values.templates));
    audit = auditSuppressions(
      files.map((f) => ({ file: f, template: JSON.parse(readFileSync(f, 'utf8')) as never })),
      { scope: scopeArg, exceptions: result.active, suppressions: register.active },
    );
    auditIssues.push(...audit.issues);
    if (scopeArg === 'all')
      auditIssues.push(...unusedSuppressions(audit.inventory, register.active));
  }
  if (values.approvals) {
    const approvals = loadApprovals(userPath(values.approvals));
    auditIssues.push(
      ...checkApprovals(
        [...rawEntries(file, 'exceptions'), ...rawEntries(registerFile, 'suppressions')].filter(
          (e) => !isUndatedRaw(e.raw),
        ),
        approvals,
      ),
    );
  }
  const ok = result.ok && register.ok && !auditIssues.some((i) => i.level === 'error');
  console.log(
    `check-exceptions ${file}\n           ${registerFile}\n${exceptionsText(result, register)}`,
  );
  if (values.approvals && !audit) console.log(issueLines(auditIssues).join('\n'));
  if (audit) {
    const by = (g: string) => audit.inventory.filter((i) => i.governedBy === g).length;
    console.log(
      `template suppressions (${scopeArg}): ${audit.inventory.length} found — ` +
        `${by('register')} register, ${by('exception')} exception, ${by('framework')} aws-cdk-lib CloudFormation Validate (not audited), ` +
        `${auditIssues.filter((i) => i.level === 'error').length} error(s)`,
    );
    console.log(issueLines(auditIssues).join('\n'));
  }
  if (values.report) {
    const out = userPath(values.report);
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(
      out,
      JSON.stringify(
        {
          ...result,
          ok,
          file,
          register: {
            file: registerFile,
            ok: register.ok,
            suppressions: register.suppressions,
            active: register.active.map((e) => e.id),
            issues: register.issues,
          },
          audit: audit
            ? { scope: scopeArg, issues: auditIssues, inventory: audit.inventory }
            : null,
        },
        null,
        2,
      ),
    );
  }
  console.log(ok ? 'OK' : 'FAILED: fix, narrow or renew the entries above.');
  return ok ? EXIT.OK : EXIT.FAILED;
}

function approvalDigestsCmd(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { file: { type: 'string' }, suppressions: { type: 'string' } },
  });
  const file = values.file ? userPath(values.file) : DEFAULT_EXCEPTIONS_PATH;
  const registerFile = values.suppressions
    ? userPath(values.suppressions)
    : DEFAULT_SUPPRESSIONS_PATH;
  for (const { id, raw } of [
    ...rawEntries(file, 'exceptions'),
    ...rawEntries(registerFile, 'suppressions'),
  ]) {
    const status = (raw as { status?: unknown } | null)?.status;
    const digest = entryDigest(raw);
    console.log(
      status === 'reference'
        ? `${id} (no approval: reference entry, ${REFERENCE_ENTRY_DIGESTS[id] === digest ? 'pinned' : `NOT pinned, sha256 ${digest}`})`
        : isUndatedRaw(raw)
          ? `${id} (no approval: not a project entry)`
          : `${id} ${digest}`,
    );
  }
  return EXIT.OK;
}

function guardValidateCmd(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: 'string' },
      rules: { type: 'string' },
      exceptions: { type: 'string' },
      'no-exceptions': { type: 'boolean', default: false },
      out: { type: 'string' },
      today: { type: 'string' },
      'fail-on-advisory': { type: 'boolean', default: false },
    },
  });
  const root = repoRoot();
  const dir = values.dir ? userPath(values.dir) : join(root, 'infra', 'cdk.out');
  const out = values.out ? userPath(values.out) : join(root, 'reports', 'policies');
  const templates = findTemplates(dir);
  if (templates.length === 0) {
    console.error(`guard-validate: no *.template.json found under ${dir} (run cdk synth first).`);
    return EXIT.USAGE;
  }
  const exceptions = values['no-exceptions']
    ? undefined
    : loadExceptionsFile(
        values.exceptions ? userPath(values.exceptions) : DEFAULT_EXCEPTIONS_PATH,
        {
          ...(values.today ? { today: values.today } : {}),
        },
      );
  const result = runGuardValidate({
    templates,
    rulesDir: values.rules ? userPath(values.rules) : GUARD_RULES_DIR,
    activeExceptions: exceptions?.active ?? [],
    exceptionIssues: exceptions?.issues ?? [],
    // Report paths relative to the repo root when the templates live inside it.
    baseDir: dir.startsWith(root + sep) ? root : statSync(dir).isFile() ? dirname(dir) : dir,
  });
  const failOnAdvisory = values['fail-on-advisory'] ?? false;
  const files = writeGuardReports(result, out, failOnAdvisory);
  const s = summarize(result, failOnAdvisory);
  for (const f of result.findings) {
    const status = f.exception ? `WAIVED ${f.exception.id}` : f.blocking ? 'FAIL' : 'WARN';
    console.log(
      `[${status}] ${f.ruleId} ${f.template} ${f.cdkPath ?? f.logicalId} ${f.path}: ${f.message}`,
    );
  }
  for (const i of result.exceptionIssues)
    console.log(`[${i.level.toUpperCase()}] ${i.code}: ${i.message}`);
  console.log(
    `guard-validate: ${s.passed ? 'PASSED' : 'FAILED'} templates=${s.templates} blocking=${s.blocking} advisory=${s.advisory} waived=${s.excepted} exceptionErrors=${s.exceptionErrors} (cfn-guard ${result.guardVersion})`,
  );
  console.log(`reports: ${files.join(', ')}`);
  return s.passed ? EXIT.OK : EXIT.FAILED;
}

function guardTestCmd(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { rules: { type: 'string' }, out: { type: 'string' } },
  });
  const rules = values.rules ? userPath(values.rules) : GUARD_RULES_DIR;
  const out = values.out ? userPath(values.out) : join(repoRoot(), 'reports', 'policies');
  const r = runGuardTests(rules);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'guard-test-junit.xml'), r.junit);
  console.log(r.stdout);
  console.log(`guard-test: ${r.status === 0 ? 'PASSED' : `FAILED (cfn-guard exit ${r.status})`}`);
  return r.status === 0 ? EXIT.OK : EXIT.FAILED;
}

function catalogueCmd(args: string[]): number {
  const { values } = parseArgs({ args, options: { format: { type: 'string', default: 'md' } } });
  if (values.format === 'json') {
    console.log(
      JSON.stringify(
        RULES.map(({ evaluate: _e, ...r }) => r),
        null,
        2,
      ),
    );
    return EXIT.OK;
  }
  console.log('| ID | Title | Severity | Engines | Scope |\n| --- | --- | --- | --- | --- |');
  for (const r of RULES) {
    console.log(
      `| ${r.id} | ${r.title} | ${r.severity} | ${r.engines.join(', ')} | ${r.environments ? r.environments.join('/') : 'all'} |`,
    );
  }
  return EXIT.OK;
}

/** pnpm forwards a literal `--` (`pnpm run x -- --flag`); tolerate it. */
const stripDashDash = (args: string[]) => args.filter((a, i) => !(a === '--' && i === 0));

export function main(argv: string[]): number {
  const [command, ...raw] = argv;
  const rest = stripDashDash(raw);
  try {
    switch (command) {
      case 'check-exceptions':
        return checkExceptionsCmd(rest);
      case 'approval-digests':
        return approvalDigestsCmd(rest);
      case 'guard-validate':
        return guardValidateCmd(rest);
      case 'guard-test':
        return guardTestCmd(rest);
      case 'catalogue':
        return catalogueCmd(rest);
      case undefined:
      case '-h':
      case '--help':
        console.log(USAGE);
        return command === undefined ? EXIT.USAGE : EXIT.OK;
      default:
        console.error(`Unknown command: ${command}\n\n${USAGE}`);
        return EXIT.USAGE;
    }
  } catch (e) {
    if (e instanceof GuardUnavailableError) {
      console.error(e.message);
      return EXIT.USAGE;
    }
    console.error(e instanceof Error ? e.message : String(e));
    return EXIT.USAGE;
  }
}
