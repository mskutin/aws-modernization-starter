import { describe, expect, it } from 'vitest';
import { findLeaks, findLeaksInValue } from '../leaks.js';

// Test inputs are synthetic look-alikes, assembled at runtime so no literal matches a scanner.
const jwt = [
  'eyJhbGciOiJSUzI1NiJ9',
  'eyJzdWIiOiJhbGljZSIsImV4cCI6MX0',
  'c2lnbmF0dXJlLXBhcnQtZm9yLXRlc3Rz',
].join('.');
const pem = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const gitlab = ['glpat', 'aaaaaaaaaaaaaaaaaaaaaaaa'].join('-');

describe('findLeaks', () => {
  it('detects well-known secret formats and reports only a redacted preview', () => {
    const text = [
      `token=${jwt}`,
      `authorization: Bearer ${jwt}`,
      pem,
      `key ${awsKey}`,
      `aws_secret_access_key = ${'a'.repeat(40)}`,
      `url postgres://app:${'s3cr3t'}@db:5432/x`,
      `gitlab ${gitlab}`,
    ].join('\n');
    const findings = findLeaks(text);
    expect(new Set(findings.map((f) => f.kind))).toEqual(
      new Set([
        'jwt',
        'bearer-header',
        'private-key',
        'aws-access-key-id',
        'aws-secret-access-key',
        'postgres-url-credentials',
        'gitlab-token',
      ]),
    );
    for (const f of findings) {
      expect(f.preview).not.toContain(jwt);
      expect(f.preview).not.toContain('s3cr3t');
    }
    expect(findings.find((f) => f.kind === 'private-key')?.line).toBe(3);
  });

  it('finds explicit secret values and canaries case-insensitively, with line numbers', () => {
    const text = 'line one\nThe Quiet Lantern ab12~cd34 must never leave\npassword=hunter2hunter2';
    const findings = findLeaks(text, {
      secrets: [{ label: 'db', value: 'hunter2hunter2' }],
      canaries: [{ label: 'sentence', value: 'the quiet lantern ab12~cd34' }],
      patterns: false,
    });
    expect(findings.map((f) => [f.kind, f.line])).toEqual([
      ['secret:db', 3],
      ['canary:sentence', 2],
    ]);
  });

  it('ignores explicit values too short to be meaningful and clean text', () => {
    expect(findLeaks('abc 12345', { secrets: [{ label: 's', value: '12345' }] })).toEqual([]);
    expect(findLeaks('{"status":"ok","jobId":"3f1c"}')).toEqual([]);
  });

  it('scans structured values (e.g. DynamoDB items) via JSON', () => {
    expect(
      findLeaksInValue(
        { pk: 'JOB#1', nested: { note: 'cnry~aa~bb' } },
        { canaries: [{ label: 't', value: 'cnry~aa~bb' }] },
      ),
    ).toHaveLength(1);
  });
});
