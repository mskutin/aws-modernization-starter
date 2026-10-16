import { describe, expect, it } from 'vitest';
import { evaluateTemplate } from '../src/catalogue.js';
import { RULE_CASES, templateOf } from './fixtures/cases.js';

const findingsFor = (ruleId: string, resources: Parameters<typeof templateOf>[0], options = {}) =>
  evaluateTemplate(templateOf(resources), options).filter((f) => f.ruleId === ruleId);

describe('TypeScript rule implementations (shared by the cdk-nag pack)', () => {
  describe.each(RULE_CASES)('$ruleId', (c) => {
    it('passing fixture has no findings', () => {
      expect(findingsFor(c.ruleId, c.pass, c.options)).toEqual([]);
    });

    it('failing fixture produces the expected diagnostic', () => {
      const findings = findingsFor(c.ruleId, c.fail, c.options);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]).toMatchObject({
        ruleId: c.ruleId,
        logicalId: c.expect.logicalId,
        path: c.expect.path,
      });
      expect(findings[0]?.message).toContain(c.expect.message);
    });

    for (const v of c.variants ?? []) {
      it(`variant: ${v.name} → ${v.compliant ? 'compliant' : 'non-compliant'}`, () => {
        const findings = findingsFor(c.ruleId, v.resources, c.options);
        expect(findings.length === 0).toBe(v.compliant);
        if (v.expect) {
          expect(findings[0]).toMatchObject({
            ruleId: c.ruleId,
            logicalId: v.expect.logicalId,
            path: v.expect.path,
          });
          expect(findings[0]?.message).toContain(v.expect.message);
        }
      });
    }
  });

  it('BASE-IAM-004 is not applicable when no permissions boundary is configured', () => {
    const c = RULE_CASES.find((x) => x.ruleId === 'BASE-IAM-004');
    expect(findingsFor('BASE-IAM-004', c?.fail ?? {})).toEqual([]);
  });

  it('the environment option is a fallback when a resource has no Environment tag', () => {
    const db = {
      Type: 'AWS::RDS::DBInstance',
      Properties: { StorageEncrypted: true, PubliclyAccessible: false, DeletionProtection: false },
    };
    expect(findingsFor('BASE-RDS-003', { Db: db })).toEqual([]);
    expect(findingsFor('BASE-RDS-003', { Db: db }, { environment: 'prod' })).toHaveLength(1);
  });

  it('configurable Lambda bounds are honoured', () => {
    const fn = {
      Type: 'AWS::Lambda::Function',
      Properties: { Runtime: 'python3.12', Timeout: 120 },
    };
    expect(findingsFor('BASE-LMB-001', { Fn: fn })).toHaveLength(1);
    expect(
      findingsFor('BASE-LMB-001', { Fn: fn }, { lambda: { allowedRuntimes: ['python3.12'] } }),
    ).toEqual([]);
    expect(
      findingsFor('BASE-LMB-003', { Fn: fn }, { lambda: { maxTimeoutSeconds: 60 } }),
    ).toHaveLength(1);
  });
});
