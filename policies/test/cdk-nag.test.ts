import { describe, expect, it } from 'vitest';
import { ruleById } from '../src/catalogue.js';
import { RULE_CASES } from './fixtures/cases.js';
import { nagFixture, violationsFor } from './helpers.js';

const nagCases = RULE_CASES.filter((c) => ruleById(c.ruleId)?.engines.includes('cdk-nag'));

describe('BaselineChecks (cdk-nag v3 pack) on fixture templates', () => {
  describe.each(nagCases)('$ruleId', (c) => {
    it('passing fixture: no violation', () => {
      const { report } = nagFixture(c.pass, c.options);
      expect(violationsFor(report, c.ruleId)).toEqual([]);
    });

    it('failing fixture: violation with construct path, property location and severity', () => {
      const { report, pack } = nagFixture(c.fail, c.options);
      const [violation] = violationsFor(report, c.ruleId);
      const rule = ruleById(c.ruleId);
      expect(violation).toBeDefined();
      expect(violation?.severity).toBe(rule?.severity === 'low' ? 'warning' : 'error');
      expect(violation?.description).toContain(rule?.title);
      expect(violation?.violatingResources[0]).toMatchObject({
        constructPath: `Fixture/Template/${c.expect.logicalId}`,
      });
      expect(violation?.violatingResources[0]?.locations).toContain(c.expect.path);
      const detail = pack.lastFindings.find((f) => f.ruleId === c.ruleId);
      expect(detail?.findings[0]?.message).toContain(c.expect.message);
      expect(report.success).toBe(
        rule?.severity === 'low' ? !report.violations.some((v) => v.severity === 'error') : false,
      );
    });
  });
});
