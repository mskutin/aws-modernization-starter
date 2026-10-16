/**
 * Per-test results and not-applicable GOVERNANCE of a MiniStack EMULATOR run
 * (tests/aws-integration/emulator/ci.sh workflows, run.sh). NOT AWS.
 *
 * Reads the vitest JSON report and the not-applicable assertions recorded by `unlessEmulatorGap`,
 * and writes one JSON record per test plus a summary — every record labelled target
 * "ministack-emulator". A skipped test whose title carries `emulator-not-applicable: <why>` is
 * `not-applicable`, never `pass`; a passing test lists the assertions the emulator could not check.
 * Full passes and passes with not-applicable assertions are counted separately.
 *
 * With `--baseline tests/aws-integration/emulator/expected-not-applicable.json` the run FAILS
 * (exit 1) when:
 *  - a not-applicable test or assertion is not listed in the baseline (the untested surface grew);
 *  - a baseline entry did not occur (stale: the emulator or the test changed — update the file);
 *  - a not-applicable item names an unknown gap, or another gap than its baseline entry;
 *  - a test was skipped for any reason other than a declared gap;
 *  - fewer tests passed (in total, or fully) than the baseline's minimum.
 *
 *   node dist/emulator-results.js --vitest <vitest.json> --not-applicable <jsonl> --out <dir> \
 *     [--baseline <json>] [--run-id <id>] [--duration-seconds <n>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  EMULATOR_GAPS,
  EXECUTOR_SPECIFIC_GAPS,
  emulatorLambdaExecutor,
  gapOfReason,
  type EmulatorGap,
  type LambdaExecutor,
} from './emulator-gaps.js';

export type ResultStatus = 'pass' | 'fail' | 'not-applicable' | 'skipped';

export interface NotApplicableAssertion {
  what: string;
  gap?: string;
  reason: string;
}

export interface TestResult {
  target: 'ministack-emulator';
  file: string;
  /** Full test name WITHOUT the not-applicable marker (stable across gap wording changes). */
  test: string;
  status: ResultStatus;
  /** `emulator-not-applicable: <why>` for a not-applicable test. */
  reason?: string;
  /** The declared gap of a not-applicable test (undefined: the marker names no known gap). */
  gap?: string;
  /** Assertions the emulator could not check (each with its gap and reason). */
  notApplicableAssertions?: NotApplicableAssertion[];
  durationMs?: number;
  failure?: string;
}

interface VitestAssertion {
  ancestorTitles?: string[];
  title?: string;
  status?: string;
  duration?: number;
  failureMessages?: string[];
}
interface VitestFile {
  name?: string;
  assertionResults?: VitestAssertion[];
}

const NA_MARKER = /\s*\[(emulator-not-applicable: [^\]]+)\]/;
const stripMarker = (name: string) => name.replace(new RegExp(NA_MARKER.source, 'g'), '');

/** The vitest JSON report + the JSONL of not-applicable assertions → one record per test. */
export function toResults(vitestReport: unknown, notApplicableJsonl: string): TestResult[] {
  const naByTest = new Map<string, NotApplicableAssertion[]>();
  for (const line of notApplicableJsonl.split('\n')) {
    if (line.trim() === '') continue;
    const record = JSON.parse(line) as {
      test?: string;
      what?: string;
      gap?: string;
      reason?: string;
    };
    if (!record.test) continue;
    const key = stripMarker(record.test);
    const list = naByTest.get(key) ?? [];
    list.push({
      what: String(record.what),
      ...(record.gap ? { gap: record.gap } : {}),
      reason: String(record.reason),
    });
    naByTest.set(key, list);
  }
  const files = ((vitestReport ?? {}) as { testResults?: VitestFile[] }).testResults ?? [];
  const results: TestResult[] = [];
  for (const file of files) {
    for (const a of file.assertionResults ?? []) {
      const fullName = [...(a.ancestorTitles ?? []), a.title ?? ''].join(' > ');
      const marker = NA_MARKER.exec(fullName)?.[1];
      const test = stripMarker(fullName);
      const status: ResultStatus =
        a.status === 'passed'
          ? 'pass'
          : a.status === 'failed'
            ? 'fail'
            : marker
              ? 'not-applicable'
              : 'skipped';
      const na = naByTest.get(test);
      const gap = marker ? gapOfReason(marker) : undefined;
      results.push({
        target: 'ministack-emulator',
        file: path.basename(file.name ?? ''),
        test,
        status,
        ...(status === 'not-applicable' && marker ? { reason: marker } : {}),
        ...(status === 'not-applicable' && gap ? { gap } : {}),
        ...(na && status !== 'not-applicable' ? { notApplicableAssertions: na } : {}),
        ...(a.duration !== undefined ? { durationMs: Math.round(a.duration) } : {}),
        ...(status === 'fail'
          ? { failure: (a.failureMessages ?? []).join('\n').slice(0, 2000) }
          : {}),
      });
    }
  }
  return results;
}

export interface Counts {
  pass: number;
  /** Passed with every assertion exercised. */
  fullPass: number;
  /** Passed, but with assertions the emulator could not check. */
  passWithNotApplicableAssertions: number;
  fail: number;
  'not-applicable': number;
  skipped: number;
  notApplicableAssertions: number;
}

export function summarize(results: readonly TestResult[]): Counts {
  const count = (s: ResultStatus) => results.filter((r) => r.status === s).length;
  const partial = results.filter(
    (r) => r.status === 'pass' && (r.notApplicableAssertions?.length ?? 0) > 0,
  ).length;
  return {
    pass: count('pass'),
    fullPass: count('pass') - partial,
    passWithNotApplicableAssertions: partial,
    fail: count('fail'),
    'not-applicable': count('not-applicable'),
    skipped: count('skipped'),
    notApplicableAssertions: results.reduce(
      (n, r) => n + (r.notApplicableAssertions?.length ?? 0),
      0,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Baseline governance
// ---------------------------------------------------------------------------------------------

export interface BaselineEntry {
  /** Stable id (never reused). */
  id: string;
  kind: 'test' | 'assertion';
  file: string;
  /** Full test name without the not-applicable marker. */
  test: string;
  /** The `what` of an `unlessEmulatorGap` assertion (kind assertion only). */
  assertion?: string;
  gap: string;
  /** Technical reason this check cannot run on the emulator. */
  reason: string;
  /** The MiniStack version or capability the gap depends on (what would close it). */
  dependsOn: string;
  /** Lambda executors the entry applies to (default: those of its gap, else all). */
  executors?: LambdaExecutor[];
}

export interface Baseline {
  schemaVersion: 1;
  revision: number;
  emulator: { name: string; version: string; lambdaExecutor: LambdaExecutor };
  /** Passing tests below these numbers fail the run (default executor). */
  minimumPasses: { total: number; full: number };
  entries: BaselineEntry[];
}

export interface NotApplicableItem {
  kind: 'test' | 'assertion';
  file: string;
  test: string;
  assertion?: string;
  gap?: string;
  baselineId?: string;
}

export interface Governance {
  baselineRevision: number;
  lambdaExecutor: LambdaExecutor;
  ok: boolean;
  violations: string[];
  items: NotApplicableItem[];
}

const entryKey = (x: {
  kind: string;
  file: string;
  test: string;
  assertion?: string | undefined;
}) => `${x.kind}|${x.file}|${x.test}|${x.kind === 'assertion' ? (x.assertion ?? '') : ''}`;

function appliesTo(entry: BaselineEntry, executor: LambdaExecutor): boolean {
  const executors = entry.executors ?? EXECUTOR_SPECIFIC_GAPS[entry.gap as EmulatorGap];
  return executors === undefined || executors.includes(executor);
}

/** Static validity of the baseline file (ids, gaps, required fields). */
export function validateBaseline(baseline: Baseline): string[] {
  const problems: string[] = [];
  if (baseline.schemaVersion !== 1) problems.push('baseline: schemaVersion must be 1');
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const e of baseline.entries) {
    if (!/^NA-[A-Z0-9-]+$/.test(e.id)) problems.push(`baseline: bad id ${e.id}`);
    if (ids.has(e.id)) problems.push(`baseline: duplicate id ${e.id}`);
    ids.add(e.id);
    const key = entryKey(e);
    if (keys.has(key)) problems.push(`baseline: ${e.id} duplicates another entry`);
    keys.add(key);
    if (!(e.gap in EMULATOR_GAPS)) problems.push(`baseline: ${e.id} names unknown gap ${e.gap}`);
    if (e.kind === 'assertion' && !e.assertion)
      problems.push(`baseline: ${e.id} lacks the assertion`);
    for (const field of ['file', 'test', 'reason', 'dependsOn'] as const) {
      if (!e[field]) problems.push(`baseline: ${e.id} lacks ${field}`);
    }
  }
  return problems;
}

/** Compares the run's not-applicable items and skips with the baseline. */
export function govern(
  results: readonly TestResult[],
  baseline: Baseline,
  executor: LambdaExecutor,
): Governance {
  const violations = validateBaseline(baseline);
  const expected = new Map(
    baseline.entries.filter((e) => appliesTo(e, executor)).map((e) => [entryKey(e), e]),
  );
  const seen = new Set<string>();
  const items: NotApplicableItem[] = [];
  const check = (item: NotApplicableItem) => {
    const key = entryKey(item);
    const entry = expected.get(key);
    const label = `${item.file} > ${item.test}${item.assertion ? ` :: ${item.assertion}` : ''}`;
    if (!item.gap || !(item.gap in EMULATOR_GAPS)) {
      violations.push(`not-applicable without a declared gap: ${label}`);
    }
    if (!entry) {
      violations.push(
        `not-applicable ${item.kind} not in the baseline: ${label} [${item.gap ?? '?'}]`,
      );
    } else {
      seen.add(key);
      item.baselineId = entry.id;
      if (entry.gap !== item.gap) {
        violations.push(
          `${entry.id}: gap ${String(item.gap)} differs from the baseline's ${entry.gap}`,
        );
      }
    }
    items.push(item);
  };
  for (const r of results) {
    if (r.status === 'not-applicable') {
      check({ kind: 'test', file: r.file, test: r.test, ...(r.gap ? { gap: r.gap } : {}) });
    }
    if (r.status === 'skipped') {
      violations.push(`skipped without a declared emulator gap: ${r.file} > ${r.test}`);
    }
    for (const a of r.notApplicableAssertions ?? []) {
      check({
        kind: 'assertion',
        file: r.file,
        test: r.test,
        assertion: a.what,
        ...(a.gap ? { gap: a.gap } : {}),
      });
    }
  }
  for (const [key, entry] of expected) {
    if (!seen.has(key)) {
      violations.push(
        `stale baseline entry ${entry.id} (${entry.kind} ${entry.file} > ${entry.test}${entry.assertion ? ` :: ${entry.assertion}` : ''}): it did not occur — the emulator, the executor or the test changed; review and update expected-not-applicable.json`,
      );
    }
  }
  const counts = summarize(results);
  if (counts.pass < baseline.minimumPasses.total) {
    violations.push(
      `only ${counts.pass} tests passed; the baseline expects at least ${baseline.minimumPasses.total}`,
    );
  }
  if (counts.fullPass < baseline.minimumPasses.full) {
    violations.push(
      `only ${counts.fullPass} tests passed fully; the baseline expects at least ${baseline.minimumPasses.full}`,
    );
  }
  return {
    baselineRevision: baseline.revision,
    lambdaExecutor: executor,
    ok: violations.length === 0,
    violations,
    items,
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  const vitestFile = arg(argv, 'vitest');
  const out = arg(argv, 'out');
  if (!vitestFile || !out) {
    console.error(
      'usage: emulator-results --vitest <json> --out <dir> [--not-applicable <jsonl>] [--baseline <json>]',
    );
    return 2;
  }
  const naFile = arg(argv, 'not-applicable');
  const results = toResults(
    existsSync(vitestFile) ? JSON.parse(readFileSync(vitestFile, 'utf8')) : {},
    naFile && existsSync(naFile) ? readFileSync(naFile, 'utf8') : '',
  );
  const executor = emulatorLambdaExecutor(env);
  const baselineFile = arg(argv, 'baseline');
  const governance = baselineFile
    ? govern(results, JSON.parse(readFileSync(baselineFile, 'utf8')) as Baseline, executor)
    : undefined;
  const identity = {
    target: 'ministack-emulator',
    note: 'EMULATOR — not AWS; these results say nothing about AWS behaviour',
    emulator: {
      name: 'MiniStack',
      version: env.MINISTACK_VERSION ?? env.STARTER_MINISTACK_EXPECTED_VERSION,
      image: env.STARTER_MINISTACK_IMAGE ?? env.MINISTACK_IMAGE,
      lambdaExecutor: executor,
    },
    runId: arg(argv, 'run-id'),
  };
  mkdirSync(path.join(out, 'results'), { recursive: true });
  results.forEach((r, i) => {
    const file = path.join(
      out,
      'results',
      `${String(i + 1).padStart(2, '0')}-${slug(r.test)}.json`,
    );
    writeFileSync(file, `${JSON.stringify({ ...identity, ...r }, null, 2)}\n`);
  });
  if (governance) {
    writeFileSync(
      path.join(out, 'not-applicable.jsonl'),
      governance.items
        .map((i) => JSON.stringify({ target: 'ministack-emulator', ...i }))
        .join('\n') + (governance.items.length > 0 ? '\n' : ''),
    );
  }
  const counts = summarize(results);
  const summary = {
    ...identity,
    finishedAt: new Date().toISOString(),
    durationSeconds: Number(arg(argv, 'duration-seconds') ?? NaN) || undefined,
    counts,
    ...(governance
      ? {
          governance: {
            baselineRevision: governance.baselineRevision,
            lambdaExecutor: governance.lambdaExecutor,
            ok: governance.ok,
            violations: governance.violations,
          },
        }
      : {}),
    tests: results.map((r) => ({
      file: r.file,
      test: r.test,
      status: r.status,
      ...(r.gap ? { gap: r.gap } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.notApplicableAssertions
        ? {
            notApplicableAssertions: r.notApplicableAssertions.map(
              (n) => `${n.what} [${n.gap ?? '?'}]`,
            ),
          }
        : {}),
    })),
  };
  writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`);
  for (const r of results) {
    const extra =
      r.gap ??
      (r.notApplicableAssertions ? `(${r.notApplicableAssertions.length} assertion(s) n/a)` : '');
    console.log(`${r.status.padEnd(14)} ${r.file}  ${r.test} ${extra}`.trimEnd());
  }
  console.log(
    `pass ${counts.pass} (full ${counts.fullPass}, with n/a assertions ${counts.passWithNotApplicableAssertions}), ` +
      `fail ${counts.fail}, not-applicable ${counts['not-applicable']}, skipped ${counts.skipped}`,
  );
  if (governance) {
    for (const v of governance.violations) console.error(`[emulator-results] ${v}`);
    console.log(
      `not-applicable governance: ${governance.ok ? 'ok' : `${governance.violations.length} violation(s)`}`,
    );
    return governance.ok ? 0 : 1;
  }
  return 0;
}

if (process.argv[1] && path.basename(process.argv[1]).startsWith('emulator-results')) {
  process.exitCode = main(process.argv.slice(2));
}
