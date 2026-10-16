import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EMULATOR_GAPS } from './emulator-gaps.js';
import {
  govern,
  main,
  summarize,
  toResults,
  validateBaseline,
  type Baseline,
  type TestResult,
} from './emulator-results.js';

const NA = `emulator-not-applicable: ${EMULATOR_GAPS.executionTimeout}`;
const report = {
  testResults: [
    {
      name: '/x/src/failure-paths.aws.test.ts',
      assertionResults: [
        { ancestorTitles: ['Suite'], title: 'passes fully', status: 'passed', duration: 10.4 },
        { ancestorTitles: ['Suite'], title: 'passes partly', status: 'passed', duration: 5 },
        { ancestorTitles: ['Suite'], title: 'breaks', status: 'failed', failureMessages: ['boom'] },
        { ancestorTitles: ['Suite'], title: `times out [${NA}]`, status: 'skipped' },
        { ancestorTitles: ['Other [SKIPPED: no gate]'], title: 'gated', status: 'skipped' },
      ],
    },
  ],
};
const naJsonl = `${JSON.stringify({
  test: 'Suite > passes partly',
  what: 'execution error',
  gap: 'failStatePaths',
  reason: `emulator-not-applicable: ${EMULATOR_GAPS.failStatePaths}`,
})}\n`;

describe('emulator results', () => {
  it('maps vitest outcomes; not-applicable is never a pass; partial passes list their n/a checks', () => {
    const results = toResults(report, naJsonl);
    expect(results.map((r) => [r.test, r.status])).toEqual([
      ['Suite > passes fully', 'pass'],
      ['Suite > passes partly', 'pass'],
      ['Suite > breaks', 'fail'],
      // The marker is stripped from the stable test name; the gap is resolved from it.
      ['Suite > times out', 'not-applicable'],
      ['Other [SKIPPED: no gate] > gated', 'skipped'],
    ]);
    expect(results.every((r) => r.target === 'ministack-emulator')).toBe(true);
    expect(results[1]!.notApplicableAssertions).toEqual([
      {
        what: 'execution error',
        gap: 'failStatePaths',
        reason: `emulator-not-applicable: ${EMULATOR_GAPS.failStatePaths}`,
      },
    ]);
    expect(results[0]!.notApplicableAssertions).toBeUndefined();
    expect(results[3]).toMatchObject({ reason: NA, gap: 'executionTimeout' });
    expect(results[2]!.failure).toBe('boom');
    expect(summarize(results)).toEqual({
      pass: 2,
      fullPass: 1,
      passWithNotApplicableAssertions: 1,
      fail: 1,
      'not-applicable': 1,
      skipped: 1,
      notApplicableAssertions: 1,
    });
  });

  it('a marker naming no known gap yields a not-applicable test without a gap', () => {
    const [r] = toResults(
      {
        testResults: [
          {
            name: 'a.aws.test.ts',
            assertionResults: [
              { title: 't [emulator-not-applicable: made up]', status: 'skipped' },
            ],
          },
        ],
      },
      '',
    );
    expect(r).toMatchObject({ status: 'not-applicable' });
    expect(r!.gap).toBeUndefined();
  });
});

describe('not-applicable governance', () => {
  const pass = (test: string, na?: TestResult['notApplicableAssertions']): TestResult => ({
    target: 'ministack-emulator',
    file: 'f.aws.test.ts',
    test,
    status: 'pass',
    ...(na ? { notApplicableAssertions: na } : {}),
  });
  const naTest = (test: string, gap: string | undefined = 'executionTimeout'): TestResult => ({
    target: 'ministack-emulator',
    file: 'f.aws.test.ts',
    test,
    status: 'not-applicable',
    ...(gap ? { gap } : {}),
    reason: NA,
  });
  type Entry = Baseline['entries'][number];
  const entry = (over: Partial<Entry>): Entry => ({
    id: 'NA-EXT-01',
    kind: 'test',
    file: 'f.aws.test.ts',
    test: 'S > times out',
    gap: 'executionTimeout',
    reason: 'r',
    dependsOn: 'MiniStack 1.5.26',
    ...over,
  });
  const baseline = (entries: Entry[], total = 1, full = 0): Baseline => ({
    schemaVersion: 1,
    revision: 1,
    emulator: { name: 'MiniStack', version: '1.5.26', lambdaExecutor: 'local' },
    minimumPasses: { total, full },
    entries,
  });
  const nameAssertion = { what: 'error name', gap: 'localExecutorErrorNames', reason: 'x' };
  const results = [naTest('S > times out'), pass('S > ok', [nameAssertion])];
  const fullBaseline = baseline([
    entry({}),
    entry({
      id: 'NA-LEN-01',
      kind: 'assertion',
      test: 'S > ok',
      assertion: 'error name',
      gap: 'localExecutorErrorNames',
    }),
  ]);
  const violations = (rs: TestResult[], b: Baseline, executor: 'local' | 'docker' = 'local') =>
    govern(rs, b, executor).violations.join('\n');

  it('passes when every not-applicable item is declared and the passes reach the minimum', () => {
    const g = govern(results, fullBaseline, 'local');
    expect(g.violations).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.items.map((i) => i.baselineId)).toEqual(['NA-EXT-01', 'NA-LEN-01']);
  });

  it('fails on a new, unlisted not-applicable test or assertion', () => {
    const v = violations(
      [
        ...results,
        naTest('S > new gap test'),
        pass('S > other', [{ ...nameAssertion, what: 'new' }]),
      ],
      fullBaseline,
    );
    expect(v).toMatch(/not-applicable test not in the baseline: .*new gap test/);
    expect(v).toMatch(/not-applicable assertion not in the baseline: .*:: new/);
  });

  it('fails on a stale baseline entry (it did not occur)', () => {
    expect(violations([pass('S > ok', [nameAssertion])], fullBaseline)).toMatch(
      /stale baseline entry NA-EXT-01/,
    );
  });

  it('fails when fewer tests pass than the baseline minimum (total or full)', () => {
    expect(violations(results, { ...fullBaseline, minimumPasses: { total: 2, full: 0 } })).toMatch(
      /only 1 tests passed; the baseline expects at least 2/,
    );
    expect(violations(results, { ...fullBaseline, minimumPasses: { total: 1, full: 1 } })).toMatch(
      /only 0 tests passed fully/,
    );
  });

  it('fails on any skip not caused by a declared gap, and on an unknown gap', () => {
    const skipped: TestResult = {
      target: 'ministack-emulator',
      file: 'f.aws.test.ts',
      test: 'S > gated',
      status: 'skipped',
    };
    expect(violations([...results, skipped], fullBaseline)).toMatch(
      /skipped without a declared emulator gap: f.aws.test.ts > S > gated/,
    );
    expect(
      violations([{ ...naTest('S > times out'), gap: undefined }, results[1]!], fullBaseline),
    ).toMatch(/not-applicable without a declared gap/);
  });

  it('fails when an item reports another gap than its entry', () => {
    expect(
      violations([naTest('S > times out', 'sfnExecutionLogs'), results[1]!], fullBaseline),
    ).toMatch(/NA-EXT-01: gap sfnExecutionLogs differs/);
  });

  it('executor-specific entries apply only to their executor', () => {
    // With the docker executor the error-name gap does not exist: its entry is not expected …
    expect(violations([naTest('S > times out')], fullBaseline, 'docker')).not.toMatch(/NA-LEN-01/);
    // … and an entry restricted to docker is not expected on the local executor.
    const onlyDocker = baseline(
      [
        entry({}),
        entry({
          id: 'NA-RJM-01',
          kind: 'assertion',
          test: 'S > retry',
          assertion: 'waits',
          gap: 'retryJitterMaxDelay',
          executors: ['docker'],
        }),
      ],
      0,
    );
    expect(govern([naTest('S > times out')], onlyDocker, 'local').ok).toBe(true);
    expect(violations([naTest('S > times out')], onlyDocker, 'docker')).toMatch(
      /stale baseline entry NA-RJM-01/,
    );
  });

  it('validates the baseline itself', () => {
    const problems = (entries: Entry[]) => validateBaseline(baseline(entries)).join('\n');
    expect(problems([entry({}), entry({})])).toMatch(/duplicate id NA-EXT-01/);
    expect(problems([entry({ gap: 'made-up' })])).toMatch(/unknown gap made-up/);
    expect(problems([entry({ kind: 'assertion' })])).toMatch(/lacks the assertion/);
    expect(problems([entry({ dependsOn: '' })])).toMatch(/lacks dependsOn/);
    expect(problems([entry({ id: 'x' })])).toMatch(/bad id x/);
  });

  it('the committed baseline is valid and declares the socket-less gaps', () => {
    const file = fileURLToPath(
      new URL('../emulator/expected-not-applicable.json', import.meta.url),
    );
    const committed = JSON.parse(readFileSync(file, 'utf8')) as Baseline;
    expect(validateBaseline(committed)).toEqual([]);
    expect(committed.emulator).toEqual({
      name: 'MiniStack',
      version: '1.5.26',
      lambdaExecutor: 'local',
    });
    expect(committed.minimumPasses.total).toBeGreaterThan(0);
    const gaps = new Set(committed.entries.map((e) => e.gap));
    expect(gaps).toContain('localExecutorErrorNames');
    expect(gaps).toContain('retryJitterMaxDelay');
    for (const e of committed.entries) {
      expect(e.test.startsWith('[ministack-emulator] integration stack ')).toBe(true);
      expect(e.reason).toBe(EMULATOR_GAPS[e.gap as keyof typeof EMULATOR_GAPS]);
    }
  });
});

describe('CLI', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const setup = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'starter-emu-results-'));
    writeFileSync(path.join(dir, 'vitest.json'), JSON.stringify(report));
    writeFileSync(path.join(dir, 'na.jsonl'), naJsonl);
    return dir;
  };

  it('writes one labelled record per test and a summary with the emulator identity', () => {
    const d = setup();
    const rc = main(
      [
        '--vitest',
        path.join(d, 'vitest.json'),
        '--not-applicable',
        path.join(d, 'na.jsonl'),
        '--out',
        d,
        '--run-id',
        'em-abc123',
        '--duration-seconds',
        '42',
      ],
      { MINISTACK_VERSION: '1.5.26', STARTER_MINISTACK_IMAGE: 'docker.io/x@sha256:abc' },
    );
    expect(rc).toBe(0);
    expect(readdirSync(path.join(d, 'results'))).toHaveLength(5);
    const summary = JSON.parse(readFileSync(path.join(d, 'results.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(summary).toMatchObject({
      target: 'ministack-emulator',
      note: expect.stringMatching(/not AWS/),
      emulator: {
        name: 'MiniStack',
        version: '1.5.26',
        image: 'docker.io/x@sha256:abc',
        lambdaExecutor: 'local',
      },
      runId: 'em-abc123',
      durationSeconds: 42,
      counts: {
        pass: 2,
        fullPass: 1,
        passWithNotApplicableAssertions: 1,
        fail: 1,
        'not-applicable': 1,
        skipped: 1,
      },
    });
    expect(main([], {})).toBe(2);
  });

  it('exits 1 with --baseline when the governance fails, and writes the not-applicable JSONL', () => {
    const d = setup();
    writeFileSync(
      path.join(d, 'baseline.json'),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        emulator: { name: 'MiniStack', version: '1.5.26', lambdaExecutor: 'local' },
        minimumPasses: { total: 0, full: 0 },
        entries: [],
      }),
    );
    const rc = main(
      [
        '--vitest',
        path.join(d, 'vitest.json'),
        '--not-applicable',
        path.join(d, 'na.jsonl'),
        '--out',
        d,
        '--baseline',
        path.join(d, 'baseline.json'),
      ],
      {},
    );
    expect(rc).toBe(1);
    const summary = JSON.parse(readFileSync(path.join(d, 'results.json'), 'utf8')) as {
      governance: { ok: boolean; violations: string[] };
    };
    expect(summary.governance.ok).toBe(false);
    expect(summary.governance.violations.length).toBeGreaterThanOrEqual(3);
    const items = readFileSync(path.join(d, 'not-applicable.jsonl'), 'utf8').trim().split('\n');
    expect(items).toHaveLength(2);
    expect(
      items.map((l) => JSON.parse(l) as { kind: string }).find((i) => i.kind === 'test'),
    ).toMatchObject({
      target: 'ministack-emulator',
      kind: 'test',
      gap: 'executionTimeout',
    });
  });
});
