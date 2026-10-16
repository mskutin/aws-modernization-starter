/** Classification of the caller's own policy documents. */
import { describe, expect, it } from 'vitest';
import { ALLOWLISTED_IAM_ACTIONS } from '../src/gate.ts';
import { iamPolicy } from '../src/plan.ts';
import {
  analyzePolicyDocument,
  isAdminActionPattern,
  isEveryResourcePattern,
  parsePolicyDocument,
  worseClass,
} from '../src/policydoc.ts';

const classify = (doc: unknown) => analyzePolicyDocument(doc, ALLOWLISTED_IAM_ACTIONS);
const statement = (st: Record<string, unknown>) => ({ Version: '2012-10-17', Statement: [st] });
const allow = (Action: unknown, Resource: unknown = '*') =>
  statement({ Effect: 'Allow', Action, Resource });

describe('analyzePolicyDocument', () => {
  it('the generated least-privilege policy is allowlisted-only', () => {
    expect(classify(iamPolicy())).toMatchObject({
      classification: 'allowlisted-only',
      allowStatements: 4,
      denyStatements: 0,
      nonAllowlistedActions: [],
    });
  });

  it('accepts the CLI object form, a JSON string and the URL-encoded IAM form', () => {
    const doc = allow(['ec2:DescribeVpcs']);
    const a = classify(doc);
    expect(classify(JSON.stringify(doc))).toEqual(a);
    expect(classify(encodeURIComponent(JSON.stringify(doc)))).toEqual(a);
    expect(parsePolicyDocument('not json')).toBeUndefined();
  });

  it('hashes the canonical document: key order does not matter, content does', () => {
    const a = classify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 'ec2:DescribeVpcs', Resource: '*' }],
    });
    const b = classify({
      Statement: [{ Resource: '*', Action: 'ec2:DescribeVpcs', Effect: 'Allow' }],
      Version: '2012-10-17',
    });
    const c = classify(allow('ec2:DescribeSubnets'));
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sha256).toBe(b.sha256);
    expect(c.sha256).not.toBe(a.sha256);
  });

  it('ignores Deny statements and conditions (they only restrict)', () => {
    const doc = {
      Statement: [
        {
          Effect: 'Allow',
          Action: ['sts:GetCallerIdentity'],
          Resource: '*',
          Condition: { Bool: { 'aws:ViaAWSService': 'false' } },
        },
        { Effect: 'Deny', Action: '*', Resource: '*' },
        { Effect: 'Deny', NotAction: 'ec2:Describe*', Resource: '*' },
      ],
    };
    expect(classify(doc)).toMatchObject({
      classification: 'allowlisted-only',
      allowStatements: 1,
      denyStatements: 2,
    });
  });

  it.each([
    ['a non-allowlisted read (s3:GetObject)', allow('s3:GetObject'), ['s3:GetObject']],
    ['a wildcard read (ec2:Describe*)', allow('ec2:Describe*'), ['ec2:Describe*']],
    [
      'secretsmanager:GetSecretValue',
      allow('secretsmanager:GetSecretValue'),
      ['secretsmanager:GetSecretValue'],
    ],
    [
      'an allowlisted action with NotResource',
      statement({
        Effect: 'Allow',
        Action: 'ec2:DescribeVpcs',
        NotResource: 'arn:aws:ec2:*:*:vpc/vpc-0',
      }),
      ['NotResource'],
    ],
  ])('read-only-data-capable: %s', (_, doc, actions) => {
    expect(classify(doc)).toMatchObject({
      classification: 'read-only-data-capable',
      nonAllowlistedActions: actions,
    });
  });

  it.each([
    ['a write action', allow(['ec2:DescribeVpcs', 'ec2:RunInstances'])],
    ['a wildcard write', allow('s3:Put*')],
    ['a service wildcard on a scoped resource', allow('iam:*', 'arn:aws:iam::*:role/app-*')],
    ['"*" on a scoped resource', allow('*', 'arn:aws:s3:::bucket/*')],
    [
      'NotAction on a scoped resource',
      statement({ Effect: 'Allow', NotAction: 's3:*', Resource: 'arn:aws:s3:::b' }),
    ],
    [
      'NotAction excluding IAM and Organizations (PowerUserAccess shape)',
      statement({
        Effect: 'Allow',
        NotAction: ['iam:*', 'organizations:*', 'account:*'],
        Resource: '*',
      }),
    ],
    ['iam:PassRole on every resource (escalation path, not a hard stop)', allow('iam:PassRole')],
  ])('write-capable: %s', (_, doc) => {
    expect(classify(doc).classification).toBe('write-capable');
  });

  it.each([
    ['"*" on "*"', allow('*')],
    ['"*:*" on "*"', allow('*:*')],
    ['iam:* on "*"', allow('iam:*')],
    ['IAM:* in another case', allow('IAM:*')],
    ['organizations:* on "*"', allow(['organizations:*'])],
    ['a glob over IAM (i*:*)', allow('i*:*')],
    ['iam:* on an all-IAM ARN', allow('iam:*', 'arn:aws:iam::*:*')],
    [
      'iam:* with NotResource',
      statement({ Effect: 'Allow', Action: 'iam:*', NotResource: 'arn:aws:iam::*:role/x' }),
    ],
    [
      'NotAction that keeps IAM on "*"',
      statement({ Effect: 'Allow', NotAction: ['organizations:*'], Resource: '*' }),
    ],
    [
      'NotAction that keeps Organizations on "*"',
      statement({ Effect: 'Allow', NotAction: ['iam:*'], Resource: ['*'] }),
    ],
  ])('admin-equivalent: %s', (_, doc) => {
    expect(classify(doc).classification).toBe('admin-equivalent');
  });

  it.each([
    ['no statements', { Version: '2012-10-17', Statement: [] }],
    ['a missing Effect', statement({ Action: 'ec2:DescribeVpcs', Resource: '*' })],
    [
      'an unknown Effect',
      statement({ Effect: 'allow', Action: 'ec2:DescribeVpcs', Resource: '*' }),
    ],
    ['a non-string action', allow([1])],
    ['no actions', statement({ Effect: 'Allow', Resource: '*' })],
    ['not an object', 42],
  ])('unparseable: %s', (_, doc) => {
    expect(classify(doc).classification).toBe('unparseable');
  });

  it('reports at most 50 non-allowlisted actions, names only', () => {
    const actions = Array.from(
      { length: 60 },
      (_, i) => `ec2:CreateThing${String(i).padStart(2, '0')}`,
    );
    const r = classify(allow(actions));
    expect(r.nonAllowlistedActions).toHaveLength(50);
    expect(r.classification).toBe('write-capable');
  });

  it('helpers', () => {
    expect(isAdminActionPattern('*')).toBe(true);
    expect(isAdminActionPattern('**')).toBe(true);
    expect(isAdminActionPattern('org*:*')).toBe(true);
    expect(isAdminActionPattern('ec2:*')).toBe(false);
    expect(isAdminActionPattern('iam:Get*')).toBe(false);
    expect(isEveryResourcePattern('*')).toBe(true);
    expect(isEveryResourcePattern('arn:aws:iam::123456789012:*')).toBe(true);
    expect(isEveryResourcePattern('arn:*:*:*:*:*')).toBe(true);
    expect(isEveryResourcePattern('arn:aws:iam::*:role/*')).toBe(false);
    expect(worseClass('allowlisted-only', 'write-capable')).toBe('write-capable');
    expect(worseClass('admin-equivalent', 'unparseable')).toBe('admin-equivalent');
  });
});
