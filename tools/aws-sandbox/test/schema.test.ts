import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertNoSecrets, LeakError, maskDeep, maskString } from '../src/mask.js';
import { jsonSchemaFor, SCHEMAS, type SchemaName } from '../src/schemas.js';

describe('published JSON Schemas', () => {
  it('schema/*.schema.json are up to date (regenerate: pnpm --filter @starter/tool-aws-sandbox schema:write)', () => {
    for (const name of Object.keys(SCHEMAS) as SchemaName[]) {
      const file = new URL(`../schema/${name}.schema.json`, import.meta.url);
      const committed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      expect(committed, name).toEqual(JSON.parse(JSON.stringify(jsonSchemaFor(name))));
    }
  });
});

describe('masking', () => {
  it('masks account ids anywhere in strings and redacts IPv4 addresses', () => {
    expect(maskString('arn:aws:kms:ap-southeast-1:111122223333:key/x')).toBe(
      'arn:aws:kms:ap-southeast-1:********3333:key/x',
    );
    expect(maskString('cdk-starter-assets-111122223333-ap-southeast-1')).toBe(
      'cdk-starter-assets-********3333-ap-southeast-1',
    );
    expect(maskString('egress 203.0.113.10')).toBe('egress <ipv4-redacted>');
    expect(maskString('finops 2026.10.13-1, 1234567890123')).toBe(
      'finops 2026.10.13-1, 1234567890123',
    );
    expect(maskDeep({ a: ['111122223333'], n: 111122223333 })).toEqual({
      a: ['********3333'],
      n: 111122223333,
    });
  });

  it('masks the caller session / user name and e-mail addresses of AWS error text', () => {
    const denied =
      'aws: [ERROR]: An error occurred (AccessDeniedException) when calling the ListKeys operation: User: arn:aws:sts::111122223333:assumed-role/AWSReservedSSO_acme-aws@Developer-0a1b2c3_0123456789abcdef/jane.doe@example.com is not authorized to perform: kms:ListKeys on resource: * because no identity-based policy allows it';
    const m = maskString(denied);
    expect(m).toContain(
      'arn:aws:sts::********3333:assumed-role/AWSReservedSSO_acme-aws@Developer-0a1b2c3_0123456789abcdef/<session> is not authorized',
    );
    expect(m).not.toMatch(/jane|example\.com|111122223333/);
    expect(maskString('arn:aws:iam::111122223333:user/jdoe denied')).toBe(
      'arn:aws:iam::********3333:user/<user> denied',
    );
    expect(maskString('contact ops.team+aws@acme.example.com now')).toBe('contact <email> now');
  });

  it('keeps UUIDs whose last group is all digits usable (key and stack ids)', () => {
    const key = 'arn:aws:kms:ap-southeast-1:111122223333:key/1234abcd-12ab-34cd-56ef-123456789012';
    expect(maskString(key)).toBe(
      'arn:aws:kms:ap-southeast-1:********3333:key/1234abcd-12ab-34cd-56ef-123456789012',
    );
    expect(() => assertNoSecrets('1234abcd-12ab-34cd-56ef-123456789012', 'x')).not.toThrow();
  });

  it('refuses to write secret-shaped content or an unmasked account id', () => {
    const akid = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    expect(() => assertNoSecrets(`{"k":"${akid}"}`, 'x')).toThrow(LeakError);
    expect(() => assertNoSecrets('-----BEGIN EC PRIVATE KEY-----', 'x')).toThrow(LeakError);
    expect(() =>
      assertNoSecrets('{"kty":"EC","d":"abcdefghijklmnopqrstuvwxyz012345"}', 'x'),
    ).toThrow(LeakError);
    expect(() => assertNoSecrets('account 111122223333', 'x')).toThrow(/unmasked/);
    expect(() => assertNoSecrets('account ********3333', 'x')).not.toThrow();
  });
});
