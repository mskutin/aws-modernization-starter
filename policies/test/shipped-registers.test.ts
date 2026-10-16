/**
 * What the SHIPPED registers do in a fresh project, on a fixed clock: the starter's own
 * reference-design entries apply with no approvals and never expire, nothing ships approved or
 * dated, and the sandbox's relaxations are an example register that nothing loads.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { parse, stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXCEPTIONS_FILE,
  DEFAULT_SUPPRESSIONS_FILE,
  SANDBOX_EXAMPLE_EXCEPTIONS_FILE,
  SANDBOX_EXAMPLE_SUPPRESSIONS_FILE,
  applyBaselinePolicies,
} from '../src/cdk/apply.js';
import { SuppressionAuditPlugin } from '../src/cdk/suppressions.js';
import { EXIT, main } from '../src/cli/main.js';
import { loadExceptionsFile } from '../src/exceptions/exceptions.js';
import { loadSuppressionsFile } from '../src/exceptions/suppressions.js';
import { DEFAULT_EXCEPTIONS_PATH, DEFAULT_SUPPRESSIONS_PATH } from '../src/guard/layout.js';
import { tempDir } from './helpers.js';

/** Today, the dates the private validation entries used to carry, and far beyond. */
const DATES = ['2026-10-17', '2026-12-01', '2027-04-12', '2031-01-01'];
/** Entries the reference code needs in dev/staging/prod (and the integration mini-stack). */
const REFERENCE = { exceptions: 1, suppressions: 22 };
const SANDBOX = { exceptions: 6, suppressions: 29 };

const rawList = (file: string, key: 'exceptions' | 'suppressions') =>
  (parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>[]>)[key] ?? [];
const DATE_FIELDS = ['createdAt', 'expiresAt', 'reviewedAt', 'reviewBy', 'approver'];

describe('shipped registers (fresh project, no approvals configured)', () => {
  it.each(DATES)('on %s: valid, every entry reference design and active, no issue', (today) => {
    const exceptions = loadExceptionsFile(DEFAULT_EXCEPTIONS_PATH, { today });
    const register = loadSuppressionsFile(DEFAULT_SUPPRESSIONS_PATH, { today });
    expect([exceptions.ok, exceptions.issues, register.ok, register.issues]).toEqual([
      true,
      [],
      true,
      [],
    ]);
    expect(exceptions.active).toHaveLength(REFERENCE.exceptions);
    expect(register.active).toHaveLength(REFERENCE.suppressions);
    // An app with no stage at all: register problems would surface here as synth errors.
    const app = new App();
    const { pack } = applyBaselinePolicies(app, { today, register: false });
    expect(pack.validateScope(app).violations).toEqual([]);
    expect(
      new SuppressionAuditPlugin({ register, exceptions: exceptions.active }).validateScope(app)
        .violations,
    ).toEqual([]);
  });

  it('ships no dates, no approver and no sandbox scope in the loaded registers', () => {
    const entries = [
      ...rawList(DEFAULT_EXCEPTIONS_PATH, 'exceptions'),
      ...rawList(DEFAULT_SUPPRESSIONS_PATH, 'suppressions'),
    ];
    expect(entries).toHaveLength(REFERENCE.exceptions + REFERENCE.suppressions);
    for (const e of entries) {
      expect(e['status'], String(e['id'])).toBe('reference');
      for (const f of DATE_FIELDS) expect(e[f], `${String(e['id'])}.${f}`).toBeUndefined();
      expect(e['environments'], String(e['id'])).not.toContain('sandbox');
    }
    // The CDK apps and the CLI load exactly these two files by default.
    expect([DEFAULT_EXCEPTIONS_FILE, DEFAULT_SUPPRESSIONS_FILE]).toEqual([
      DEFAULT_EXCEPTIONS_PATH,
      DEFAULT_SUPPRESSIONS_PATH,
    ]);
  });

  describe('CI gate (check-exceptions)', () => {
    let logs: string[] = [];
    beforeEach(() => {
      logs = [];
      vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
      vi.spyOn(console, 'error').mockImplementation(
        (...a: unknown[]) => void logs.push(a.join(' ')),
      );
    });
    afterEach(() => vi.restoreAllMocks());

    it.each(DATES)('on %s: passes without approvals and with an empty approvals file', (today) => {
      expect(main(['check-exceptions', '--today', today])).toBe(EXIT.OK);
      const approvals = join(tempDir(), 'approvals.yaml');
      writeFileSync(approvals, stringify({ schemaVersion: 1, approvals: [] }));
      expect(main(['check-exceptions', '--today', today, '--approvals', approvals])).toBe(EXIT.OK);
      expect(logs.join('\n')).not.toMatch(/\[(ERROR|WARNING)\]/);
    });
  });
});

describe('sandbox example register (policies/exceptions/examples/sandbox)', () => {
  const exceptions = loadExceptionsFile(SANDBOX_EXAMPLE_EXCEPTIONS_FILE, { today: '2026-10-17' });
  const register = loadSuppressionsFile(SANDBOX_EXAMPLE_SUPPRESSIONS_FILE, {
    today: '2026-10-17',
  });

  it('is all examples scoped to the sandbox, inert when loaded, with ids free in the registers', () => {
    expect(exceptions.exceptions).toHaveLength(SANDBOX.exceptions);
    expect(register.suppressions).toHaveLength(SANDBOX.suppressions);
    expect([exceptions.active, register.active]).toEqual([[], []]);
    for (const r of [exceptions, register]) {
      expect(new Set(r.issues.map((i) => `${i.level} ${i.code}`))).toEqual(
        new Set(['error EXAMPLE_NOT_ADOPTED']),
      );
    }
    for (const e of [...exceptions.exceptions, ...register.suppressions]) {
      expect([e.status, e.environments], e.id).toEqual(['example', ['sandbox']]);
    }
    const loaded = new Set([
      ...loadExceptionsFile(DEFAULT_EXCEPTIONS_PATH).exceptions.map((e) => e.id),
      ...loadSuppressionsFile(DEFAULT_SUPPRESSIONS_PATH).suppressions.map((e) => e.id),
    ]);
    for (const e of [...exceptions.exceptions, ...register.suppressions]) {
      expect(loaded.has(e.id), e.id).toBe(false);
    }
  });

  it('adopted next to the reference entries with the project’s own dates: passes, then expires', () => {
    const dir = tempDir();
    const merged = (key: 'exceptions' | 'suppressions', shipped: string, example: string) => {
      const adopted = rawList(example, key).map(({ status: _s, ...e }) =>
        key === 'exceptions'
          ? { ...e, createdAt: '2026-10-17', expiresAt: '2026-11-16' }
          : { ...e, createdAt: '2026-10-17', reviewedAt: '2026-10-17', reviewBy: '2026-11-16' },
      );
      const path = join(dir, `${key}.yaml`);
      writeFileSync(
        path,
        stringify({ schemaVersion: 1, [key]: [...rawList(shipped, key), ...adopted] }),
      );
      return path;
    };
    const args = [
      'check-exceptions',
      '--file',
      merged('exceptions', DEFAULT_EXCEPTIONS_PATH, SANDBOX_EXAMPLE_EXCEPTIONS_FILE),
      '--suppressions',
      merged('suppressions', DEFAULT_SUPPRESSIONS_PATH, SANDBOX_EXAMPLE_SUPPRESSIONS_FILE),
    ];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main([...args, '--today', '2026-10-17'])).toBe(EXIT.OK);
      expect(main([...args, '--today', '2026-11-17'])).toBe(EXIT.FAILED);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
