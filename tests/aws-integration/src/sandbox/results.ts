/**
 * Test-result records of the Phase 2 sandbox run (tests/aws-integration/sandbox/test.sh).
 *
 * Every check the run attempted becomes one JSON line in `results.jsonl`:
 *   { check, name, status, evidence, detail?, at }
 * `status` is what HAPPENED, never what was intended:
 *   passed   the check ran and its assertions held
 *   failed   the check ran and an assertion did not hold
 *   skipped  the check ran but skipped itself, with the reason (e.g. a self-mode-only test)
 *   not-run  the check was required but could not run (missing tool, earlier failure)
 *   error    the runner itself broke (crash, unparsable report)
 * A summary is green only when nothing failed, errored or was required and not run, and at least
 * one check passed — a run that executed nothing is never reported as passed.
 */
import { appendFileSync, readFileSync } from 'node:fs';

export const RESULT_STATUSES = ['passed', 'failed', 'skipped', 'not-run', 'error'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export interface ResultRecord {
  /** Mission check this result contributes to (e.g. "security", "db-probe", "e2e"). */
  check: string;
  /** Unique name of the individual test or assertion. */
  name: string;
  status: ResultStatus;
  /** Path (relative to the run directory) or log reference that proves the result. */
  evidence: string;
  detail?: string | undefined;
  /** ISO-8601 time the result was recorded. */
  at: string;
}

export function isResultStatus(value: unknown): value is ResultStatus {
  return typeof value === 'string' && (RESULT_STATUSES as readonly string[]).includes(value);
}

/** Single-line, bounded detail: results are evidence, not log dumps. */
export function boundedDetail(detail: string | undefined, max = 500): string | undefined {
  if (detail === undefined) return undefined;
  const one = detail.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function makeRecord(
  r: Omit<ResultRecord, 'at' | 'detail'> & { detail?: string | undefined },
  now: () => Date = () => new Date(),
): ResultRecord {
  const detail = boundedDetail(r.detail);
  return {
    check: r.check,
    name: r.name,
    status: r.status,
    evidence: r.evidence,
    ...(detail ? { detail } : {}),
    at: now().toISOString(),
  };
}

export function appendRecords(file: string, records: readonly ResultRecord[]): void {
  if (records.length === 0) return;
  appendFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

export function readRecords(file: string): ResultRecord[] {
  const out: ResultRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as Partial<ResultRecord>;
    if (
      typeof parsed.check !== 'string' ||
      typeof parsed.name !== 'string' ||
      !isResultStatus(parsed.status) ||
      typeof parsed.evidence !== 'string'
    ) {
      throw new Error(`malformed result line: ${line.slice(0, 200)}`);
    }
    out.push(parsed as ResultRecord);
  }
  return out;
}

export interface CheckSummary {
  check: string;
  status: ResultStatus;
  counts: Record<ResultStatus, number>;
}

export interface Summary {
  ok: boolean;
  counts: Record<ResultStatus, number>;
  checks: CheckSummary[];
}

const zero = (): Record<ResultStatus, number> => ({
  passed: 0,
  failed: 0,
  skipped: 0,
  'not-run': 0,
  error: 0,
});

/** A check's status: the worst of its results; only-skipped stays skipped. */
function checkStatus(c: Record<ResultStatus, number>): ResultStatus {
  if (c.error > 0) return 'error';
  if (c.failed > 0) return 'failed';
  if (c['not-run'] > 0) return 'not-run';
  if (c.passed > 0) return 'passed';
  return 'skipped';
}

export function summarize(records: readonly ResultRecord[]): Summary {
  const counts = zero();
  const byCheck = new Map<string, Record<ResultStatus, number>>();
  for (const r of records) {
    counts[r.status] += 1;
    const c = byCheck.get(r.check) ?? zero();
    c[r.status] += 1;
    byCheck.set(r.check, c);
  }
  const checks = [...byCheck.entries()].map(([check, c]) => ({
    check,
    status: checkStatus(c),
    counts: c,
  }));
  const ok =
    counts.passed > 0 && counts.failed === 0 && counts.error === 0 && counts['not-run'] === 0;
  return { ok, counts, checks };
}

// ── Converters from test-runner reports ─────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Vitest `--reporter=json` (Jest-compatible) → one record per test. Skipped/pending/todo tests
 * are `skipped` (their reason is in the name by repo convention); a report without any test is
 * an `error`, never a pass.
 */
export function fromVitestJson(report: unknown, check: string, evidence: string): ResultRecord[] {
  if (!isRecord(report) || !Array.isArray(report.testResults)) {
    return [
      makeRecord({
        check,
        name: `${check}: report`,
        status: 'error',
        evidence,
        detail: 'not a Vitest JSON report',
      }),
    ];
  }
  const out: ResultRecord[] = [];
  for (const file of report.testResults as unknown[]) {
    if (!isRecord(file)) continue;
    const assertions = Array.isArray(file.assertionResults)
      ? (file.assertionResults as unknown[])
      : [];
    for (const a of assertions) {
      if (!isRecord(a)) continue;
      const name = typeof a.fullName === 'string' ? a.fullName : String(a.title ?? '?');
      const raw = String(a.status);
      const status: ResultStatus =
        raw === 'passed' ? 'passed' : raw === 'failed' ? 'failed' : 'skipped';
      const failure = Array.isArray(a.failureMessages) ? String(a.failureMessages[0] ?? '') : '';
      out.push(
        makeRecord({
          check,
          name,
          status,
          evidence,
          detail: status === 'failed' ? failure.split('\n')[0] : undefined,
        }),
      );
    }
    // A file that failed to load (syntax error, failing beforeAll without tests) has no assertions.
    if (assertions.length === 0 && file.status === 'failed') {
      out.push(
        makeRecord({
          check,
          name: `${check}: ${String(file.name ?? 'test file')} did not run`,
          status: 'error',
          evidence,
          detail: typeof file.message === 'string' ? file.message.split('\n')[0] : undefined,
        }),
      );
    }
  }
  if (out.length === 0) {
    out.push(
      makeRecord({
        check,
        name: `${check}: report`,
        status: 'error',
        evidence,
        detail: 'the report contains no test',
      }),
    );
  }
  return out;
}

interface PlaywrightSpecLike {
  title?: unknown;
  tests?: unknown;
}

/**
 * Playwright `--reporter=json` → one record per test. `expected` = passed, `skipped` = skipped,
 * `unexpected` = failed, `flaky` = failed (the repo's flake policy: a pass on retry still fails).
 */
export function fromPlaywrightJson(
  report: unknown,
  check: string,
  evidence: string,
): ResultRecord[] {
  const out: ResultRecord[] = [];
  const walk = (suite: unknown, path: string[]): void => {
    if (!isRecord(suite)) return;
    const title = typeof suite.title === 'string' && suite.title ? [suite.title] : [];
    for (const spec of Array.isArray(suite.specs) ? (suite.specs as PlaywrightSpecLike[]) : []) {
      const specTitle = typeof spec.title === 'string' ? spec.title : '?';
      for (const t of Array.isArray(spec.tests) ? (spec.tests as unknown[]) : []) {
        if (!isRecord(t)) continue;
        const raw = String(t.status);
        const status: ResultStatus =
          raw === 'expected' ? 'passed' : raw === 'skipped' ? 'skipped' : 'failed';
        const results = Array.isArray(t.results) ? (t.results as unknown[]) : [];
        const last = results.at(-1);
        const error =
          isRecord(last) && isRecord(last.error) && typeof last.error.message === 'string'
            ? last.error.message.split('\n')[0]
            : undefined;
        out.push(
          makeRecord({
            check,
            name: [...path, ...title, specTitle].join(' › '),
            status,
            evidence,
            detail: raw === 'flaky' ? `flaky (passed on retry; fails by policy)` : error,
          }),
        );
      }
    }
    for (const child of Array.isArray(suite.suites) ? (suite.suites as unknown[]) : []) {
      walk(child, [...path, ...title]);
    }
  };
  if (isRecord(report) && Array.isArray(report.suites)) {
    for (const s of report.suites as unknown[]) walk(s, []);
  }
  const errors =
    isRecord(report) && Array.isArray(report.errors) ? (report.errors as unknown[]) : [];
  for (const e of errors) {
    const message = isRecord(e) && typeof e.message === 'string' ? e.message : String(e);
    out.push(
      makeRecord({
        check,
        name: `${check}: run error`,
        status: 'error',
        evidence,
        detail: message.split('\n')[0],
      }),
    );
  }
  if (out.length === 0) {
    out.push(
      makeRecord({
        check,
        name: `${check}: report`,
        status: 'error',
        evidence,
        detail: 'the report contains no test',
      }),
    );
  }
  return out;
}
