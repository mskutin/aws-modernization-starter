import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { RULES, evaluateTemplate, ruleById } from '../src/catalogue.js';
import { GUARD_RULES_DIR, GUARD_TESTS_DIR } from '../src/guard/layout.js';
import {
  resolveGuardBinary,
  runGuardTests,
  runGuardValidate,
  type GuardValidateResult,
} from '../src/guard/runner.js';
import { RULE_CASES, templateOf, type Resources } from './fixtures/cases.js';
import { buildGuardTests } from './guard-test-model.js';
import { tempDir } from './helpers.js';

const guard = (() => {
  try {
    return resolveGuardBinary();
  } catch {
    return undefined;
  }
})();
if (!guard && process.env['REQUIRE_CFN_GUARD'] === '1') {
  throw new Error('REQUIRE_CFN_GUARD=1 but cfn-guard is not installed (pnpm guard:install).');
}

const guardCases = RULE_CASES.filter((c) => ruleById(c.ruleId)?.engines.includes('guard'));

describe('Guard unit-test files', () => {
  it('are generated from the shared fixtures and up to date', () => {
    for (const [file, cases] of buildGuardTests()) {
      const committed: unknown = parse(
        readFileSync(join(GUARD_TESTS_DIR, `${file}_tests.yaml`), 'utf8'),
      );
      expect(committed, `${file}_tests.yaml is stale: run pnpm guard:gen-tests`).toEqual(cases);
    }
  });

  it('every Guard-engine rule is defined in a rule file', () => {
    const defined = readdirSync(GUARD_RULES_DIR)
      .filter((f) => f.endsWith('.guard'))
      .flatMap((f) => [
        ...readFileSync(join(GUARD_RULES_DIR, f), 'utf8').matchAll(/^rule (BASE_\w+)/gm),
      ])
      .map((m) => m[1]?.replaceAll('_', '-'));
    const expected = RULES.filter((r) => r.engines.includes('guard')).map((r) => r.id);
    expect([...defined].sort()).toEqual([...expected].sort());
  });
});

describe.runIf(guard)(`CloudFormation Guard ${guard?.version ?? ''} rules`, () => {
  it('cfn-guard test: every rule passes its unit tests', () => {
    const r = runGuardTests();
    expect(r.stdout).not.toMatch(/FAIL Rules/);
    expect(r.status).toBe(0);
    const total = [...buildGuardTests().values()].reduce((n, c) => n + c.length, 0);
    expect(r.junit).toContain(`tests="${total}"`);
    expect(r.junit).toContain('failures="0"');
  });

  const results = new Map<string, GuardValidateResult>();
  const dir = tempDir('starter-guard-fixtures-');
  const fixtures: { key: string; resources: Resources }[] = guardCases.flatMap((c) => [
    { key: `${c.ruleId}-pass`, resources: c.pass },
    { key: `${c.ruleId}-fail`, resources: c.fail },
    ...(c.variants ?? []).map((v, i) => ({
      key: `${c.ruleId}-variant-${i}`,
      resources: v.resources,
    })),
  ]);

  beforeAll(() => {
    for (const f of fixtures) {
      const file = join(dir, `${f.key}.template.json`);
      writeFileSync(file, JSON.stringify(templateOf(f.resources)));
      results.set(f.key, runGuardValidate({ templates: [file], baseDir: dir }));
    }
  });

  describe.each(guardCases)('$ruleId', (c) => {
    it('failing fixture: Guard reports the rule on the expected resource', () => {
      const findings = results
        .get(`${c.ruleId}-fail`)
        ?.findings.filter((f) => f.ruleId === c.ruleId);
      expect(findings?.length).toBeGreaterThan(0);
      const onResource = findings?.filter((f) => f.logicalId === c.expect.logicalId) ?? [];
      expect(onResource.length).toBeGreaterThan(0);
      expect(onResource[0]?.message.startsWith(`${c.ruleId}:`)).toBe(true);
      expect(onResource[0]?.severity).toBe(ruleById(c.ruleId)?.severity);
    });

    it('passing fixture: no Guard finding for the rule', () => {
      const findings = results
        .get(`${c.ruleId}-pass`)
        ?.findings.filter((f) => f.ruleId === c.ruleId);
      expect(findings).toEqual([]);
    });

    it('failing variants with an expected diagnostic: Guard reports the rule on that resource', () => {
      for (const [i, v] of (c.variants ?? []).entries()) {
        if (!v.expect) continue;
        const onResource =
          results
            .get(`${c.ruleId}-variant-${i}`)
            ?.findings.filter(
              (f) => f.ruleId === c.ruleId && f.logicalId === v.expect?.logicalId,
            ) ?? [];
        expect(onResource.length, v.name).toBeGreaterThan(0);
        expect(onResource[0]?.message.startsWith(`${c.ruleId}:`), v.name).toBe(true);
      }
    });
  });

  it('parity: TypeScript (cdk-nag) and Guard agree on every rule for every fixture', () => {
    const mismatches: string[] = [];
    for (const f of fixtures) {
      const ts = new Set(
        evaluateTemplate(templateOf(f.resources), {}, 'guard').map((x) => x.ruleId),
      );
      const gd = new Set(results.get(f.key)?.findings.map((x) => x.ruleId));
      for (const id of new Set([...ts, ...gd])) {
        if (ts.has(id) !== gd.has(id)) {
          mismatches.push(`${f.key}: ${id} ts=${ts.has(id)} guard=${gd.has(id)}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
