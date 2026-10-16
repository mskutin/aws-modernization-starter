import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/** tools/ci/scripts/sast-gate.py: waivers bind to rule + path + the flagged code. */
const gate = join(import.meta.dirname, '../scripts/sast-gate.py');
const RULE = 'nodejs_scan.javascript-redirect-rule-express_open_redirect2';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(source: string, line: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'sast-gate-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/routes.ts'), source);
  writeFileSync(
    join(dir, 'gl-sast-report.json'),
    JSON.stringify({
      scan: { status: 'success', analyzer: { name: 'Semgrep', version: 'test' } },
      vulnerabilities: [
        {
          severity: 'Critical',
          name: 'open redirect',
          location: { file: 'src/routes.ts', start_line: line },
          identifiers: [{ type: 'semgrep_id', value: RULE }],
        },
      ],
    }),
  );
  return dir;
}

function run(dir: string, ...args: string[]): { status: number | null; out: string } {
  const r = spawnSync('python3', [gate, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, SAST_TODAY: '2026-10-14' },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function exceptions(dir: string, entries: Array<Record<string, unknown>>): void {
  writeFileSync(join(dir, 'exceptions.json'), JSON.stringify({ exceptions: entries }));
}

const evaluate = (dir: string) =>
  spawnSync('python3', [gate, 'gl-sast-report.json', 'out'], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      SAST_TODAY: '2026-10-14',
      SAST_EXCEPTIONS_FILE: join(dir, 'exceptions.json'),
    },
  });

describe('SAST gate waivers', () => {
  const source =
    "import x from 'y';\nconst a = 1;\nreply.header('location', `/v1/jobs/${job.jobId}`);\n";

  it('waives exactly the fingerprinted code, also after it moved', () => {
    const dir = workspace(source, 3);
    const fp = run(dir, '--fingerprint', 'src/routes.ts', '3').out.trim();
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
    exceptions(dir, [
      {
        rule: RULE,
        path: 'src/routes.ts',
        fingerprint: fp,
        reason: 'reviewed',
        expires: '2026-12-31',
      },
    ]);
    const r = evaluate(dir);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/WAIVED/);
    // Same code two lines lower: still waived.
    writeFileSync(join(dir, 'src/routes.ts'), `// a\n// b\n${source}`);
    const moved = JSON.parse(readFileSync(join(dir, 'gl-sast-report.json'), 'utf8'));
    moved.vulnerabilities[0].location.start_line = 5;
    writeFileSync(join(dir, 'gl-sast-report.json'), JSON.stringify(moved));
    expect(evaluate(dir).status).toBe(0);
  });

  it('blocks when the flagged code changed, for a whole-file entry, and after expiry', () => {
    const dir = workspace(source, 3);
    const fp = run(dir, '--fingerprint', 'src/routes.ts', '3').out.trim();
    writeFileSync(join(dir, 'src/routes.ts'), source.replace('${job.jobId}', '${req.query.next}'));
    exceptions(dir, [
      {
        rule: RULE,
        path: 'src/routes.ts',
        fingerprint: fp,
        reason: 'reviewed',
        expires: '2026-12-31',
      },
    ]);
    let r = evaluate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/BLOCKING/);
    exceptions(dir, [
      { rule: RULE, path: 'src/routes.ts', reason: 'whole file', expires: '2026-12-31' },
    ]);
    r = evaluate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/IGNORED whole-file SAST exception/);
    exceptions(dir, [
      { rule: RULE, path: 'src/routes.ts', line: 3, reason: 'line-scoped', expires: '2026-01-01' },
    ]);
    expect(evaluate(dir).status).toBe(1);
  });

  it('honours an exact line for an entry without a fingerprint', () => {
    const dir = workspace(source, 3);
    exceptions(dir, [
      { rule: RULE, path: 'src/routes.ts', line: 3, reason: 'line-scoped', expires: '2026-12-31' },
    ]);
    expect(evaluate(dir).status).toBe(0);
    exceptions(dir, [
      { rule: RULE, path: 'src/routes.ts', line: 4, reason: 'other line', expires: '2026-12-31' },
    ]);
    expect(evaluate(dir).status).toBe(1);
  });

  it('prints usage and exits 2 on bad arguments instead of crashing', () => {
    const dir = workspace('x\n', 1);
    for (const args of [['--help'], [], ['only-one']]) {
      const r = run(dir, ...args);
      expect({ args, status: r.status }).toEqual({ args, status: 2 });
      expect(r.out).toContain('sast-gate.py --fingerprint');
    }
  });
});

describe('shipped SAST suppressions', () => {
  const repoRoot = join(import.meta.dirname, '../../..');
  // Files that document the suppression syntax rather than use it.
  const DOCUMENTING = new Set([
    '.gitlab/security/sast-exceptions.json',
    'tools/ci/scripts/sast-gate.py',
    'tools/ci/test/sast-gate.test.ts',
  ]);
  const INLINE = /\/\/ nosemgrep: ([a-z0-9_-]+(?:\.[a-z0-9_-]+)+) -- (\S.{19,})$/;

  it('the shipped waiver register is valid and empty (nothing expires for an adopter)', () => {
    const doc = JSON.parse(
      readFileSync(join(repoRoot, '.gitlab/security/sast-exceptions.json'), 'utf8'),
    ) as { exceptions?: unknown };
    expect(doc.exceptions).toEqual([]);
  });

  it('applies no waiver and reports no expiry at any date with the shipped register', () => {
    const dir = workspace("reply.header('location', next);\n", 1);
    for (const today of ['2026-10-17', '2027-01-01', '2030-01-01']) {
      const r = spawnSync('python3', [gate, 'gl-sast-report.json', 'out'], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          SAST_TODAY: today,
          SAST_EXCEPTIONS_FILE: join(repoRoot, '.gitlab/security/sast-exceptions.json'),
        },
      });
      // A real finding still blocks; the register neither waives it nor ages.
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/BLOCKING/);
      expect(r.stdout).not.toMatch(/WAIVED|expired/);
    }
  });

  it('every inline nosemgrep names exactly one rule id and gives a reason (never bare)', () => {
    const files = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
    expect(files.status, files.stderr).toBe(0);
    const found: Array<{ file: string; rule: string }> = [];
    for (const file of files.stdout.split('\0').filter(Boolean)) {
      if (DOCUMENTING.has(file) || file.endsWith('.md')) continue;
      const text = readFileSync(join(repoRoot, file), 'utf8');
      if (!/nosem/i.test(text)) continue;
      for (const line of text.split('\n')) {
        if (!/nosem/i.test(line)) continue;
        const m = INLINE.exec(line);
        expect(m, `${file}: ${line.trim()}`).not.toBeNull();
        if (m?.[1]) found.push({ file, rule: m[1] });
      }
    }
    expect(found).toEqual(
      expect.arrayContaining([
        { file: 'apps/api/src/routes/jobs.ts', rule: RULE },
        { file: 'tests/smoke/src/smoke.ts', rule: 'nodejs_scan.javascript-ssrf-rule-node_ssrf' },
      ]),
    );
  });
});
