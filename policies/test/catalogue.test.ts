import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DISCLAIMER, RULES } from '../src/catalogue.js';
import { GUARD_RULES_DIR } from '../src/guard/layout.js';
import { TAGGED_RESOURCE_TYPES } from '../src/rules/governance.js';
import { RESOURCE_WILDCARD_ALLOWED_ACTIONS } from '../src/rules/iam.js';
import {
  ARN_SUB_TEMPLATE,
  PRINCIPAL_GETATT_ARN_TYPES,
  PRINCIPAL_KEYS,
  PRINCIPAL_REF_TYPES,
  SAFE_PSEUDO_PARAMETERS,
} from '../src/rules/principals.js';
import { DEFAULT_ALLOWED_RUNTIMES, DEFAULT_MAX_TIMEOUT_SECONDS } from '../src/rules/lambda.js';
import { RULE_CASES } from './fixtures/cases.js';

const guardFile = (name: string) => readFileSync(join(GUARD_RULES_DIR, `${name}.guard`), 'utf8');
const quoted = (text: string) => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]);

describe('rule catalogue', () => {
  it('has unique, well-formed IDs and complete metadata', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of RULES) {
      expect(r.id).toMatch(/^BASE-[A-Z0-9]+-\d{3}$/);
      expect(r.title.length).toBeGreaterThan(10);
      expect(r.description.length).toBeGreaterThan(20);
      expect(r.rationale.length).toBeGreaterThan(20);
      expect(r.remediation.length).toBeGreaterThan(10);
      expect(r.engines.length).toBeGreaterThan(0);
      expect(r.resourceTypes.length).toBeGreaterThan(0);
    }
  });

  it('every rule has a passing and a failing fixture with an expected diagnostic', () => {
    expect(RULE_CASES.map((c) => c.ruleId).sort()).toEqual(RULES.map((r) => r.id).sort());
  });

  it('the disclaimer states this is not an official control set', () => {
    expect(DISCLAIMER).toMatch(/NOT an approved control set of any organization or regulator/);
  });

  it('the shared Guard principal allowlist is identical in iam.guard and s3.guard', () => {
    // Guard has no includes: BASE-IAM-006 and BASE-S3-002 carry copies of one block.
    const region = (text: string, name: string) => {
      const begin = text.indexOf(`# BEGIN ${name} (`);
      const end = text.indexOf(`# END ${name}\n`);
      expect(begin, name).toBeGreaterThanOrEqual(0);
      expect(end, name).toBeGreaterThan(begin);
      return text
        .slice(begin, end)
        .replaceAll('BASE-IAM-006: Role trust policies never trust "*"', '<RULE>')
        .replaceAll('BASE-S3-002: Bucket policies never allow anonymous principals', '<RULE>');
    };
    const iam = guardFile('iam');
    const s3 = guardFile('s3');
    for (const name of ['shared principal allowlist variables', 'shared principal allowlist']) {
      expect(region(s3, name), name).toEqual(region(iam, name));
    }
    expect(region(iam, 'shared principal allowlist')).toContain('<RULE>');
  });

  it('Guard constants stay in sync with the TypeScript rules', () => {
    const iam = guardFile('iam');
    const list = iam.slice(
      iam.indexOf('let starter_iam_resource_wildcard_actions'),
      iam.indexOf(']', iam.indexOf('let starter_iam_resource_wildcard_actions')),
    );
    expect(quoted(list).sort()).toEqual(Object.keys(RESOURCE_WILDCARD_ALLOWED_ACTIONS).sort());
    const listAfter = (text: string, marker: string) =>
      quoted(text.slice(text.indexOf(marker), text.indexOf(']', text.indexOf(marker))));
    for (const [name, text] of [
      ['iam', iam],
      ['s3', guardFile('s3')],
    ] as const) {
      expect(listAfter(text, 'let starter_principal_safe_pseudo_parameters'), name).toEqual([
        ...SAFE_PSEUDO_PARAMETERS,
      ]);
      expect(listAfter(text, 'let starter_principal_keys'), name).toEqual([...PRINCIPAL_KEYS]);
      expect(listAfter(text, 'let starter_principal_ref_types'), name).toEqual([
        ...PRINCIPAL_REF_TYPES,
      ]);
      expect(listAfter(text, 'let starter_principal_getatt_arn_types'), name).toEqual([
        ...PRINCIPAL_GETATT_ARN_TYPES,
      ]);
      expect(text, name).toContain(`this.'Fn::Sub' == /${ARN_SUB_TEMPLATE.source}/`);
    }

    const lambda = guardFile('lambda');
    const runtimes = lambda.slice(
      lambda.indexOf('Properties.Runtime IN'),
      lambda.indexOf(']', lambda.indexOf('Properties.Runtime IN')),
    );
    expect(quoted(runtimes)).toEqual([...DEFAULT_ALLOWED_RUNTIMES]);
    expect(lambda).toContain(`Properties.Timeout <= ${DEFAULT_MAX_TIMEOUT_SECONDS}`);

    const gov = guardFile('governance');
    const tagged = gov.slice(
      gov.indexOf('let starter_tagged_resources'),
      gov.indexOf(']', gov.indexOf('Type IN [')),
    );
    expect(quoted(tagged)).toEqual([...TAGGED_RESOURCE_TYPES]);
  });
});
