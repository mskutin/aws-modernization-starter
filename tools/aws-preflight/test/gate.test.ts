import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOUNDARY_OPERATIONS } from '../src/boundary.ts';
import {
  ALLOWLISTED_IAM_ACTIONS,
  assess,
  managedPolicyCategory,
  parsePrincipal,
} from '../src/gate.ts';
import { EXIT } from '../src/types.ts';
import {
  AT_ROLE,
  AT_ROLE_PATTERN,
  AT_SSO_ROLE_NAME,
  awsError,
  fakeRunner,
  happyResponses,
  liveArgs,
  MANAGEMENT,
  ok,
  OTHER,
  ops,
  ROLE,
  ROLE_PATTERN,
  runCli,
  sandbox,
  SANDBOX,
  SESSION,
  ssoConfig,
  ssoExpired,
  valueOf,
  type Responder,
} from './support.ts';

const caller = (arn: string, account = SANDBOX) =>
  ok({ UserId: 'AIDAFAKEUSERID0000001', Account: account, Arn: arn });
/** The gate's calls for the recommended permission set (one inline policy). */
const GATE_CALLS = [
  'sts get-caller-identity',
  'iam get-role',
  'iam list-attached-role-policies',
  'iam list-role-policies',
  'iam get-role-policy',
  'organizations describe-organization',
];
const BEFORE_ORG = GATE_CALLS.slice(0, 5);
const rawFiles = (rawDir: string) =>
  readdirSync(rawDir).flatMap((run) =>
    readdirSync(join(rawDir, run)).map((f) => join(rawDir, run, f)),
  );
const readEvidence = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

const ACCEPT = [
  '--accept-write-capable',
  'Developer permission set accepted for this discovery run by J. Tan (account owner), 2026-10-14, dedicated sandbox',
];
const ATTEST = [
  '--attest-read-only',
  'AccountDiscoveryReadOnly permission set (generated policy), checked in IAM Identity Center by J. Tan, platform owner',
];
const AWS = (name: string) => `arn:aws:iam::aws:policy/${name}`;
const managed = (...arns: string[]): Responder =>
  ok({
    AttachedPolicies: arns.map((PolicyArn) => ({
      PolicyName: PolicyArn.slice(PolicyArn.lastIndexOf('/') + 1),
      PolicyArn,
    })),
  });
const inlineDoc = (
  document: unknown,
  names = ['AwsSSOInlinePolicy'],
): Record<string, Responder> => ({
  'iam list-role-policies': ok({ PolicyNames: names }),
  'iam get-role-policy': (args) =>
    ok({ RoleName: ROLE, PolicyName: valueOf(args, '--policy-name'), PolicyDocument: document }),
});
const allow = (Action: unknown, Resource: unknown = '*') => ({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action, Resource }],
});

describe('identity gate, step 1: caller', () => {
  it('ACCOUNT MISMATCH: exit 3 after exactly one call, no evidence, nothing about it persisted', async () => {
    const box = sandbox();
    const fake = fakeRunner(
      happyResponses({
        'sts get-caller-identity': caller(
          `arn:aws:sts::${OTHER}:assumed-role/${ROLE}/${SESSION}`,
          OTHER,
        ),
      }),
    );
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.ACCOUNT_MISMATCH);
    expect(ops(fake.awsCalls())).toEqual(['sts get-caller-identity']);
    expect(r.err.join('\n')).toContain('ACCOUNT MISMATCH — STOP');
    expect(r.err.join('\n')).toContain('********6666');
    expect(r.err.join('\n')).not.toContain(OTHER);
    expect(existsSync(box.evidence)).toBe(false);
    // Only run.json: the other account's response is not written to the raw directory either.
    expect(rawFiles(box.rawDir).map((f) => f.slice(f.lastIndexOf('/') + 1))).toEqual([
      '001-run.json',
    ]);
  });

  it.each([
    ['the root user', `arn:aws:iam::${SANDBOX}:root`],
    ['an IAM user (long-lived keys)', `arn:aws:iam::${SANDBOX}:user/ci-deployer`],
    ['a federated user', `arn:aws:sts::${SANDBOX}:federated-user/someone`],
    ['an ARN of another account', `arn:aws:sts::${OTHER}:assumed-role/${ROLE}/${SESSION}`],
    ['another partition', `arn:aws-us-gov:sts::${SANDBOX}:assumed-role/${ROLE}/${SESSION}`],
  ])('rejects %s with exit 4 and no further calls', async (_, arn) => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses({ 'sts get-caller-identity': caller(arn) }));
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.PRINCIPAL_REJECTED);
    expect(ops(fake.awsCalls())).toEqual(['sts get-caller-identity']);
    expect(existsSync(box.evidence)).toBe(false);
  });

  it.each([
    ['another permission set', 'AWSReservedSSO_AdministratorAccess_0123456789abcdef'],
    ['a longer permission-set name', 'AWSReservedSSO_AccountDiscoveryAdmin_0123456789abcdef'],
    // The glob is anchored: text before the pattern is not ignored.
    ['a prefix before the pattern', `x${ROLE}`],
  ])('rejects a role that does not match --expected-role-pattern: %s (exit 4)', async (_, role) => {
    const box = sandbox();
    const fake = fakeRunner(
      happyResponses({
        'sts get-caller-identity': caller(
          `arn:aws:sts::${SANDBOX}:assumed-role/${role}/${SESSION}`,
        ),
      }),
    );
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.PRINCIPAL_REJECTED);
    expect(r.err.join('\n')).toContain('does not match --expected-role-pattern');
    expect(r.err.join('\n')).not.toContain(SESSION);
    expect(ops(fake.awsCalls())).toEqual(['sts get-caller-identity']);
  });

  it('an expired SSO token stops with exit 6 and is never retried', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses({ 'sts get-caller-identity': ssoExpired }));
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.CREDENTIALS);
    expect(r.err.join('\n')).toContain('aws sso login --profile starter-sandbox-developer');
    expect(ops(fake.awsCalls())).toEqual(['sts get-caller-identity']);
    expect(existsSync(box.evidence)).toBe(false);
  });

  it('an STS failure that is not about credentials stops the run (exit 1)', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses({ 'sts get-caller-identity': { timedOut: true } }));
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.ERROR);
    expect(ops(fake.awsCalls())).toEqual(['sts get-caller-identity']);
  });
});

describe('identity gate, step 2: assessment levels', () => {
  it('recommended permission set (metadata-only managed + generated inline policy): verified-read-only without any override', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses());
    const r = await runCli(liveArgs('identity', box), fake.runner);
    expect(r.code).toBe(EXIT.OK);
    const evidence = readEvidence(box.evidence);
    expect(evidence.gate).toEqual({
      organization: 'member',
      readOnlyAssessment: 'verified-read-only',
      computedLevel: 'verified-read-only',
      roleKind: 'iam-identity-center-permission-set',
      principalRecheck: 'not-run',
    });
    expect(evidence.identity).toMatchObject({
      account: '********3333',
      principalType: 'assumed-role',
      role: 'AccountDiscovery',
      roleKind: 'iam-identity-center-permission-set',
      sessionName: '<masked>',
      readOnlyAssessment: 'verified-read-only',
      computedLevel: 'verified-read-only',
      reasons: { writeCapable: [], dataCapable: [], unverified: [] },
      organization: {
        status: 'member',
        managementAccount: '<other-account-1>',
        organizationId: '<org-1>',
      },
    });
    expect(evidence.identity.policies).toEqual([
      {
        kind: 'aws-managed',
        name: 'AWSBudgetsReadOnlyAccess',
        arn: AWS('AWSBudgetsReadOnlyAccess'),
        category: 'metadata-only',
      },
      {
        kind: 'aws-managed',
        name: 'ServiceQuotasReadOnlyAccess',
        arn: AWS('ServiceQuotasReadOnlyAccess'),
        category: 'metadata-only',
      },
      {
        kind: 'inline',
        name: 'AwsSSOInlinePolicy',
        category: 'allowlisted-only',
        documentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        allowStatements: 4,
        denyStatements: 0,
        nonAllowlistedActions: [],
      },
    ]);
    expect(evidence.identity).not.toHaveProperty('attestation');
    expect(evidence.identity).not.toHaveProperty('acceptance');
    // identity: exactly the gate calls, nothing else; the inline document is read with '='.
    expect(ops(fake.awsCalls())).toEqual(GATE_CALLS);
    const getRolePolicy = fake.awsCalls().find((c) => c.args[1] === 'get-role-policy');
    expect(getRolePolicy?.args.slice(2, 4)).toEqual([
      `--role-name=${ROLE}`,
      '--policy-name=AwsSSOInlinePolicy',
    ]);
    expect(evidence.probes.map((p: { probe: string }) => p.probe)).toEqual([
      'identity.caller',
      'identity.role',
      'identity.role-managed-policies',
      'identity.role-inline-policies',
      'identity.role-inline-policy',
      'identity.organization',
    ]);
    // The policy document itself never reaches the evidence (derived facts only).
    const text = readFileSync(box.evidence, 'utf8');
    expect(text).not.toContain('"PolicyDocument"');
    expect(text).not.toContain('AwsPreflightReadOnlyDiscovery');
  });

  it('an override given for a verified identity is recorded as unused', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses());
    const r = await runCli(liveArgs('identity', box, ACCEPT), fake.runner);
    expect(r.code).toBe(EXIT.OK);
    const evidence = readEvidence(box.evidence);
    expect(evidence.identity).toMatchObject({
      readOnlyAssessment: 'verified-read-only',
      overrideUnused: true,
    });
    expect(evidence.identity).not.toHaveProperty('acceptance');
    expect(r.out.join('\n')).toContain('the override was not needed');
  });

  it.each([['job-function/ViewOnlyAccess'], ['SecurityAudit'], ['AWSOrganizationsReadOnlyAccess']])(
    '%s is read-only-data-capable: exit 5 without a statement, attested with --attest-read-only',
    async (name) => {
      const overrides = {
        'iam list-attached-role-policies': managed(AWS(name)),
        'iam list-role-policies': ok({ PolicyNames: [] }),
      };
      const box = sandbox();
      const fake = fakeRunner(happyResponses(overrides));
      const r = await runCli(liveArgs('discover', box), fake.runner);
      expect(r.code).toBe(EXIT.PRIVILEGE_CHECK_FAILED);
      expect(r.err.join('\n')).toContain('read-only-data-capable identity');
      expect(r.err.join('\n')).toContain('--attest-read-only');
      expect(existsSync(box.evidence)).toBe(false);

      const box2 = sandbox();
      const fake2 = fakeRunner(happyResponses(overrides));
      const r2 = await runCli(liveArgs('identity', box2, ATTEST), fake2.runner);
      expect(r2.code).toBe(EXIT.OK);
      const evidence = readEvidence(box2.evidence);
      expect(evidence.identity).toMatchObject({
        readOnlyAssessment: 'attested',
        computedLevel: 'read-only-data-capable',
        attestation: ATTEST[1],
        reasons: { dataCapable: [`AWS managed policy ${name}`] },
      });
      expect(evidence.identity.note).toContain('NOT a verification');
    },
  );

  it.each([
    ['ReadOnlyAccess', 'reads data and changes SQS state'],
    ['PowerUserAccess', 'AWS managed policy PowerUserAccess'],
    ['AmazonS3FullAccess', 'not in the reviewed list'],
    ['job-function/DataScientist', 'not in the reviewed list'],
    ['AmazonEC2ReadOnlyAccess', 'not in the reviewed list'],
  ])(
    '%s is write-capable: attestation is not enough, --accept-write-capable is',
    async (name, reason) => {
      const overrides = {
        'iam list-attached-role-policies': managed(AWS(name)),
        'iam list-role-policies': ok({ PolicyNames: [] }),
      };
      for (const extra of [[], ATTEST]) {
        const box = sandbox();
        const fake = fakeRunner(happyResponses(overrides));
        const r = await runCli(liveArgs('discover', box, extra), fake.runner);
        expect(r.code).toBe(EXIT.PRIVILEGE_CHECK_FAILED);
        expect(r.err.join('\n')).toContain(reason);
        expect(r.err.join('\n')).toContain('--accept-write-capable');
        expect(ops(fake.awsCalls())).toEqual(GATE_CALLS.slice(0, 4));
        expect(existsSync(box.evidence)).toBe(false);
      }
      const box = sandbox();
      const fake = fakeRunner(happyResponses(overrides));
      const r = await runCli(liveArgs('identity', box, ACCEPT), fake.runner);
      expect(r.code).toBe(EXIT.OK);
      const evidence = readEvidence(box.evidence);
      expect(evidence.gate.readOnlyAssessment).toBe('write-capable-accepted');
      expect(evidence.identity).toMatchObject({
        readOnlyAssessment: 'write-capable-accepted',
        computedLevel: 'write-capable',
        acceptance: ACCEPT[1],
        policies: [{ kind: 'aws-managed', arn: AWS(name) }],
      });
      expect(evidence.identity.note).toContain('rests on the tool alone');
    },
  );

  it.each([
    ['AdministratorAccess'],
    ['AdministratorAccess-Amplify'],
    ['IAMFullAccess'],
    ['AWSOrganizationsFullAccess'],
  ])('AWS managed %s: exit 5 even with --accept-write-capable (no override)', async (name) => {
    for (const extra of [[], ATTEST, ACCEPT]) {
      const box = sandbox();
      const fake = fakeRunner(
        happyResponses({
          'iam list-attached-role-policies': managed(AWS('ReadOnlyAccess'), AWS(name)),
        }),
      );
      const r = await runCli(liveArgs('discover', box, extra), fake.runner);
      expect(r.code).toBe(EXIT.PRIVILEGE_CHECK_FAILED);
      expect(r.err.join('\n')).toContain(
        `administrator-equivalent identity: AWS managed policy ${name}`,
      );
      expect(r.err.join('\n')).toContain('No override');
      expect(ops(fake.awsCalls())).toEqual(BEFORE_ORG);
      expect(existsSync(box.evidence)).toBe(false);
    }
  });

  it.each([
    ['Action "*" on "*"', allow('*')],
    ['iam:* on "*"', allow(['ec2:DescribeVpcs', 'iam:*'])],
    ['organizations:* on "*"', allow('organizations:*')],
    ['*:* on an all-resources ARN', allow('*:*', 'arn:aws:iam::*:*')],
    [
      'NotAction that keeps IAM',
      { Statement: { Effect: 'Allow', NotAction: 'organizations:*', Resource: '*' } },
    ],
  ])(
    'an administrator-equivalent inline policy (%s): exit 5 even with --accept-write-capable',
    async (_, doc) => {
      for (const extra of [[], ACCEPT]) {
        const box = sandbox();
        const fake = fakeRunner(happyResponses(inlineDoc(doc)));
        const r = await runCli(liveArgs('discover', box, extra), fake.runner);
        expect(r.code).toBe(EXIT.PRIVILEGE_CHECK_FAILED);
        expect(r.err.join('\n')).toContain(
          'inline policy AwsSSOInlinePolicy is administrator-equivalent',
        );
        expect(ops(fake.awsCalls())).toEqual(BEFORE_ORG);
      }
    },
  );

  it('an administrator-equivalent customer managed policy (default version): exit 5 even with --accept-write-capable', async () => {
    const arn = `arn:aws:iam::${SANDBOX}:policy/team/DeveloperBoundaryless`;
    const box = sandbox();
    const versionArgs: (string | undefined)[] = [];
    const fake = fakeRunner(
      happyResponses({
        'iam list-attached-role-policies': managed(arn),
        'iam list-role-policies': ok({ PolicyNames: [] }),
        'iam get-policy-version': (args) => {
          versionArgs.push(valueOf(args, '--policy-arn'), valueOf(args, '--version-id'));
          return ok({
            PolicyVersion: {
              Document: encodeURIComponent(JSON.stringify(allow('iam:*'))),
              VersionId: 'v3',
              IsDefaultVersion: true,
            },
          });
        },
      }),
    );
    const r = await runCli(liveArgs('discover', box, ACCEPT), fake.runner);
    expect(r.code).toBe(EXIT.PRIVILEGE_CHECK_FAILED);
    expect(r.err.join('\n')).toContain(
      'customer managed policy DeveloperBoundaryless is administrator-equivalent',
    );
    expect(versionArgs).toEqual([arn, 'v3']);
    expect(ops(fake.awsCalls())).toEqual([
      'sts get-caller-identity',
      'iam get-role',
      'iam list-attached-role-policies',
      'iam list-role-policies',
      'iam get-policy',
      'iam get-policy-version',
    ]);
  });

  it('a write-capable inline policy runs only with --accept-write-capable; the evidence keeps derived facts, not the document', async () => {
    const doc = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'MarkerSidNotInEvidence',
          Effect: 'Allow',
          Action: ['ec2:RunInstances', 'ec2:DescribeVpcs'],
          Resource: '*',
          Condition: { StringEquals: { 'aws:PrincipalTag/team': 'marker-condition-value' } },
        },
        { Effect: 'Deny', Action: 's3:*', Resource: '*' },
      ],
    };
    const box = sandbox();
    const fake = fakeRunner(happyResponses(inlineDoc(doc)));
    const r0 = await runCli(liveArgs('discover', box, ATTEST), fake.runner);
    expect(r0.code).toBe(EXIT.PRIVILEGE_CHECK_FAILED);
    expect(r0.err.join('\n')).toContain('cannot be attested as read-only');

    const box2 = sandbox();
    const fake2 = fakeRunner(happyResponses(inlineDoc(doc)));
    const r = await runCli(liveArgs('discover', box2, ACCEPT), fake2.runner);
    expect(r.code).toBe(EXIT.OK);
    const evidence = readEvidence(box2.evidence);
    expect(evidence.identity.computedLevel).toBe('write-capable');
    expect(evidence.identity.readOnlyAssessment).toBe('write-capable-accepted');
    expect(evidence.identity.policies).toContainEqual({
      kind: 'inline',
      name: 'AwsSSOInlinePolicy',
      category: 'write-capable',
      documentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      allowStatements: 1,
      denyStatements: 1,
      nonAllowlistedActions: ['ec2:RunInstances'],
    });
    const text = readFileSync(box2.evidence, 'utf8');
    expect(text).not.toContain('MarkerSidNotInEvidence');
    expect(text).not.toContain('marker-condition-value');
    // Discovery ran (the tool's allowlist is now the only boundary); the human text is verbatim.
    expect(ops(fake2.awsCalls())).toContain('ec2 describe-vpcs');
    expect(evidence.identity.acceptance).toBe(ACCEPT[1]);
  });

  it('--accept-write-capable is refused when an administrator-equivalent policy cannot be ruled out', async () => {
    const elevenInline = inlineDoc(
      allow('ec2:DescribeVpcs'),
      Array.from({ length: 11 }, (_, i) => `Inline${i + 1}`),
    );
    for (const [what, overrides] of [
      ['inline document denied', { 'iam get-role-policy': awsError('AccessDenied') }],
      ['inline list denied', { 'iam list-role-policies': awsError('AccessDenied') }],
      [
        'managed list truncated',
        {
          'iam list-attached-role-policies': ok({
            AttachedPolicies: [],
            IsTruncated: true,
            Marker: 'm',
          }),
        },
      ],
      ['more than 10 inline policies', elevenInline],
      [
        'customer policy of another account',
        { 'iam list-attached-role-policies': managed(`arn:aws:iam::${OTHER}:policy/CrossAccount`) },
      ],
    ] as const) {
      const box = sandbox();
      const fake = fakeRunner(happyResponses(overrides));
      const r = await runCli(liveArgs('discover', box, ACCEPT), fake.runner);
      expect(r.code, what).toBe(EXIT.PRIVILEGE_CHECK_FAILED);
      expect(r.err.join('\n'), what).toContain('to rule out an administrator-equivalent identity');
      expect(existsSync(box.evidence), what).toBe(false);
    }
    // At most 10 inline documents are read.
    const box = sandbox();
    const fake = fakeRunner(happyResponses(elevenInline));
    await runCli(liveArgs('discover', box, ACCEPT), fake.runner);
    expect(ops(fake.awsCalls()).filter((o) => o === 'iam get-role-policy')).toHaveLength(10);
  });

  it('IAM reads denied without a statement: exit 5 before any discovery call', async () => {
    const box = sandbox();
    const fake = fakeRunner(
      happyResponses({
        'iam get-role': awsError('AccessDenied'),
        'iam list-attached-role-policies': awsError('AccessDenied'),
        'iam list-role-policies': awsError('AccessDenied'),
      }),
    );
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.PRIVILEGE_CHECK_FAILED);
    expect(r.err.join('\n')).toContain('unverified identity');
    expect(r.err.join('\n')).toContain('--attest-read-only');
    expect(ops(fake.awsCalls())).toEqual(GATE_CALLS.slice(0, 4));
    expect(existsSync(box.evidence)).toBe(false);
  });

  it('IAM reads denied with attestation: proceeds and records the attestation verbatim', async () => {
    const box = sandbox();
    const fake = fakeRunner(
      happyResponses({
        'iam get-role': awsError('AccessDenied'),
        'iam list-attached-role-policies': awsError('AccessDenied'),
        'iam list-role-policies': awsError('AccessDenied'),
      }),
    );
    const r = await runCli(liveArgs('discover', box, ATTEST), fake.runner);
    expect(r.code).toBe(EXIT.OK);
    const evidence = readEvidence(box.evidence);
    expect(evidence.identity.readOnlyAssessment).toBe('attested');
    expect(evidence.identity.computedLevel).toBe('unverified');
    expect(evidence.identity.roleKind).toBe('unknown');
    expect(evidence.identity.attestation).toBe(ATTEST[1]);
    expect(evidence.identity.reasons.unverified).toEqual([
      'list-attached-role-policies: access-denied (AccessDenied)',
      'list-role-policies: access-denied (AccessDenied)',
      'get-role: access-denied (AccessDenied)',
    ]);
    expect(fake.awsCalls().length).toBeGreaterThan(GATE_CALLS.length);
  });

  it("masks the caller's session name inside the attestation (otherwise verbatim)", async () => {
    const box = sandbox();
    const fake = fakeRunner(
      happyResponses({
        'sts get-caller-identity': caller(
          `arn:aws:sts::${SANDBOX}:assumed-role/${ROLE}/aexample01`,
        ),
        'iam get-role-policy': awsError('AccessDenied'),
      }),
    );
    const attestation =
      'AccountDiscoveryReadOnly (generated policy) requested by aexample01, approved by platform owner';
    const r = await runCli(
      liveArgs('identity', box, ['--attest-read-only', attestation]),
      fake.runner,
    );
    expect(r.code).toBe(EXIT.OK);
    const evidence = readEvidence(box.evidence);
    expect(evidence.identity.attestation).toBe(
      'AccountDiscoveryReadOnly (generated policy) requested by <session>, approved by platform owner',
    );
    expect(readFileSync(box.evidence, 'utf8')).not.toContain('aexample01');
  });

  it('roleKind comes from the role path, not from the name', async () => {
    const box = sandbox();
    const fake = fakeRunner(
      happyResponses({
        'iam get-role': ok({
          Role: { Path: '/', RoleName: ROLE, Arn: `arn:aws:iam::${SANDBOX}:role/${ROLE}` },
        }),
      }),
    );
    const r = await runCli(liveArgs('identity', box), fake.runner);
    expect(r.code).toBe(EXIT.OK);
    const evidence = readEvidence(box.evidence);
    expect(evidence.identity.roleKind).toBe('iam-role');
    expect(evidence.identity.role).toBe(ROLE);
  });

  it("works with a permission-set name containing '@' (profile, pattern, role, argv)", async () => {
    const box = sandbox({ config: ssoConfig({ ssoRoleName: AT_SSO_ROLE_NAME }) });
    const fake = fakeRunner(
      happyResponses({
        'sts get-caller-identity': caller(
          `arn:aws:sts::${SANDBOX}:assumed-role/${AT_ROLE}/${SESSION}`,
        ),
      }),
    );
    const argv = liveArgs('discover', box).map((t) => (t === ROLE_PATTERN ? AT_ROLE_PATTERN : t));
    const r = await runCli(argv, fake.runner);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(EXIT.OK);
    const evidence = readEvidence(box.evidence);
    expect(evidence.identity.role).toBe(AT_SSO_ROLE_NAME);
    expect(evidence.identity.roleKind).toBe('iam-identity-center-permission-set');
    expect(evidence.identity.readOnlyAssessment).toBe('verified-read-only');
    for (const op of [
      'get-role',
      'list-attached-role-policies',
      'list-role-policies',
      'get-role-policy',
    ]) {
      const call = fake.awsCalls().find((c) => c.args[1] === op);
      expect(call?.args[2], op).toBe(`--role-name=${AT_ROLE}`);
    }
  });
});

describe('identity gate, step 3: organization', () => {
  it('the management account: exit 7, no discovery', async () => {
    const box = sandbox();
    const fake = fakeRunner(
      happyResponses({
        'organizations describe-organization': ok({
          Organization: { Id: 'o-exampleorgid1', MasterAccountId: SANDBOX },
        }),
      }),
    );
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.ORGANIZATION);
    expect(r.err.join('\n')).toContain(
      'STOP — management: this is the organization MANAGEMENT account',
    );
    expect(ops(fake.awsCalls())).toEqual(GATE_CALLS);
    expect(existsSync(box.evidence)).toBe(false);
  });

  it('not in an organization: exit 7 with its own message', async () => {
    const box = sandbox();
    const fake = fakeRunner(
      happyResponses({
        'organizations describe-organization': awsError('AWSOrganizationsNotInUseException'),
      }),
    );
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.ORGANIZATION);
    expect(r.err.join('\n')).toContain(
      'STOP — not-in-org: the account is not a member of an AWS Organization',
    );
    expect(ops(fake.awsCalls())).toEqual(GATE_CALLS);
  });

  it('AccessDenied: organization UNKNOWN, stated prominently, the run continues', async () => {
    const box = sandbox();
    const fake = fakeRunner(
      happyResponses({ 'organizations describe-organization': awsError('AccessDeniedException') }),
    );
    const r = await runCli(liveArgs('identity', box), fake.runner);
    expect(r.code).toBe(EXIT.OK);
    const evidence = readEvidence(box.evidence);
    expect(evidence.gate.organization).toBe('unknown');
    expect(evidence.identity.organization).toEqual({
      status: 'unknown',
      errorCode: 'AccessDeniedException',
    });
    expect(evidence.notes.join(' ')).toContain('is then NOT evidenced');
    expect(r.out.join('\n')).toContain('organization UNKNOWN');
  });

  it('any other failure: exit 7 (fail closed)', async () => {
    const box = sandbox();
    const fake = fakeRunner(
      happyResponses({ 'organizations describe-organization': awsError('ServiceException') }),
    );
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.ORGANIZATION);
    expect(r.err.join('\n')).toContain('organization membership could not be determined');
  });

  it('management account other than the caller is recorded masked', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses());
    await runCli(liveArgs('identity', box), fake.runner);
    const text = readFileSync(box.evidence, 'utf8');
    expect(text).not.toContain(MANAGEMENT);
    expect(text).not.toContain('aws-root@example.com');
  });
});

describe('assessment and managed-policy categories (unit)', () => {
  const okResult = (data: unknown) => ({ kind: 'ok' as const, data, truncated: false });
  const role = okResult({ Role: { Path: '/aws-reserved/sso.amazonaws.com/', RoleName: ROLE } });

  it.each([
    ['AWSBudgetsReadOnlyAccess', 'metadata-only'],
    ['ServiceQuotasReadOnlyAccess', 'metadata-only'],
    ['job-function/ViewOnlyAccess', 'data-capable'],
    ['SecurityAudit', 'data-capable'],
    ['AWSOrganizationsReadOnlyAccess', 'data-capable'],
    ['ReadOnlyAccess', 'read-all'],
    ['PowerUserAccess', 'write-capable'],
    ['job-function/SystemAdministrator', 'write-capable'],
    ['AmazonEC2ReadOnlyAccess', 'write-capable'],
    ['AdministratorAccess', 'hard-stop'],
    ['AdministratorAccess-AWSElasticBeanstalk', 'hard-stop'],
    ['IAMFullAccess', 'hard-stop'],
    ['AWSOrganizationsFullAccess', 'hard-stop'],
  ])('%s -> %s', (name, category) => {
    expect(managedPolicyCategory(AWS(name))).toBe(category);
  });

  it('the allowlisted IAM actions come from the independent boundary list', () => {
    expect([...ALLOWLISTED_IAM_ACTIONS].sort()).toEqual(
      [...new Set(BOUNDARY_OPERATIONS.map((e) => e.split(' ')[2]))].sort(),
    );
    expect(ALLOWLISTED_IAM_ACTIONS.has('iam:GetRolePolicy')).toBe(true);
  });

  it('levels: the worst policy wins; unreadable documents leave admin-equivalence open', () => {
    const base = {
      role,
      managed: okResult({ AttachedPolicies: [] }),
      inline: okResult({ PolicyNames: [] }),
    };
    expect(assess({ ...base, documents: [] })).toMatchObject({
      level: 'verified-read-only',
      adminRuledOut: true,
      roleKind: 'iam-identity-center-permission-set',
    });
    expect(
      assess({ ...base, documents: [{ kind: 'inline', name: 'P', result: { unreadable: 'x' } }] }),
    ).toMatchObject({ level: 'unverified', adminRuledOut: false });
    expect(
      assess({
        ...base,
        documents: [
          {
            kind: 'inline',
            name: 'AwsSSOInlinePolicy',
            result: {
              classification: 'allowlisted-only',
              sha256: 'a'.repeat(64),
              allowStatements: 4,
              denyStatements: 0,
              nonAllowlistedActions: [],
            },
          },
        ],
      }),
    ).toMatchObject({ level: 'verified-read-only', adminRuledOut: true });
    expect(
      assess({
        ...base,
        managed: okResult({
          AttachedPolicies: [
            { PolicyArn: AWS('PowerUserAccess') },
            { PolicyArn: AWS('IAMFullAccess') },
          ],
        }),
        documents: [],
      }),
    ).toMatchObject({ level: 'hard-stop', hardStops: ['AWS managed policy IAMFullAccess'] });
  });

  it('extracts role and session from an assumed-role ARN only', () => {
    expect(
      parsePrincipal(`arn:aws:sts::${SANDBOX}:assumed-role/${ROLE}/${SESSION}`, SANDBOX),
    ).toEqual({
      type: 'assumed-role',
      roleName: ROLE,
      sessionName: SESSION,
    });
    expect(parsePrincipal(`arn:aws:sts::${SANDBOX}:assumed-role/${AT_ROLE}/jdoe`, SANDBOX)).toEqual(
      { type: 'assumed-role', roleName: AT_ROLE, sessionName: 'jdoe' },
    );
    expect(parsePrincipal(`arn:aws:iam::${SANDBOX}:role/${ROLE}`, SANDBOX)).toEqual({
      type: 'other',
    });
  });
});
