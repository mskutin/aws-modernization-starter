/**
 * `--execution-profile personal-sandbox` for identity/discover: an administrator-equivalent
 * identity is accepted only with the exact account, an explicit profile, the allowed region, a
 * clean environment and the owner's statement; discovery stays on the same allowlist. Every
 * refusal happens before any AWS process. The strict profile is covered by strict-regression.
 */
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERSONAL_SANDBOX_NOTE } from '../src/evidence.ts';
import { EXIT } from '../src/types.ts';
import {
  awsError,
  fakeRunner,
  happyResponses,
  liveArgs,
  MANAGEMENT,
  ok,
  OTHER,
  ops,
  ROLE,
  runCli,
  sandbox,
  SANDBOX,
  SESSION,
  ssoExpired,
  type Responder,
  type Sandbox,
} from './support.ts';

const OWNER_TEXT =
  'Developer permission set authorized by M. Tan (account owner) on 2026-10-15 for the live validation in this dedicated sandbox only';
const OWNER = ['--owner-authorization', OWNER_TEXT];
const PERSONAL = ['--execution-profile', 'personal-sandbox'];
const ACCEPT = [
  '--accept-write-capable',
  'Developer permission set accepted for this discovery run by J. Tan (account owner), 2026-10-14, dedicated sandbox',
];

/** The real Developer permission set's shape: full-access managed policies + inline iam:* on *. */
const ADMIN_EQUIVALENT: Record<string, Responder> = {
  'iam list-attached-role-policies': ok({
    AttachedPolicies: ['AdministratorAccess', 'AmazonDynamoDBFullAccess'].map((n) => ({
      PolicyName: n,
      PolicyArn: `arn:aws:iam::aws:policy/${n}`,
    })),
  }),
  'iam list-role-policies': ok({ PolicyNames: ['AwsSSOInlinePolicy'] }),
  'iam get-role-policy': ok({
    RoleName: ROLE,
    PolicyName: 'AwsSSOInlinePolicy',
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: ['iam:*', 's3:*'], Resource: '*' }],
    },
  }),
};

const SANDBOX_STACKS: Record<string, Responder> = {
  'cloudformation list-stacks': ok({
    StackSummaries: ['Sandbox-Foundation', 'starter-cdk-toolkit', 'acme-payments-prod'].map(
      (StackName, i) => ({
        StackId: `arn:aws:cloudformation:ap-southeast-1:${SANDBOX}:stack/${StackName}/00000000-0000-4000-8000-00000000003${i}`,
        StackName,
        StackStatus: 'CREATE_COMPLETE',
        CreationTime: '2026-01-01T00:00:00+00:00',
      }),
    ),
  }),
  'ec2 describe-vpcs': ok({
    Vpcs: [
      {
        VpcId: 'vpc-00000000000000001',
        OwnerId: SANDBOX,
        CidrBlock: '10.20.0.0/16',
        IsDefault: false,
        State: 'available',
        Tags: [{ Key: 'Name', Value: 'Sandbox-Foundation/Network/Vpc' }],
      },
    ],
  }),
};

const env = (box: Sandbox, extra: Record<string, string> = {}) => ({
  env: { HOME: box.home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...extra },
});

const readEvidence = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

function accountFile(box: Sandbox, content = `${SANDBOX}\n`, mode = 0o600): string {
  const path = join(box.dir, 'expected-account');
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}

describe('personal-sandbox: administrator-equivalent identity accepted on the owner authorization', () => {
  it('discover proceeds with exactly the strict allowlist and records the acceptance (schema 5)', async () => {
    const strictBox = sandbox();
    const strict = fakeRunner(happyResponses());
    expect((await runCli(liveArgs('discover', strictBox), strict.runner)).code).toBe(EXIT.OK);

    const box = sandbox();
    const fake = fakeRunner(happyResponses(ADMIN_EQUIVALENT));
    const r = await runCli(liveArgs('discover', box, [...PERSONAL, ...OWNER]), fake.runner);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(EXIT.OK);
    // Same calls, same order: discovery stays on the read-only allowlist.
    expect(ops(fake.awsCalls())).toEqual(ops(strict.awsCalls()));
    for (const c of fake.awsCalls()) expect(c.args[1]).toMatch(/^(get|list|describe)-/);

    const text = readFileSync(box.evidence, 'utf8');
    expect(text).not.toContain(SESSION);
    expect(text).not.toContain(SANDBOX);
    const e = readEvidence(box.evidence);
    expect(e.schemaVersion).toBe(5);
    expect(e.executionProfile).toBe('personal-sandbox');
    expect(e.gate).toEqual({
      organization: 'member',
      readOnlyAssessment: 'personal-sandbox-accepted',
      computedLevel: 'administrator-equivalent',
      accepted: 'personal-sandbox',
      roleKind: 'iam-identity-center-permission-set',
      principalRecheck: 'same-principal',
    });
    expect(e.identity).toMatchObject({
      executionProfile: 'personal-sandbox',
      readOnlyAssessment: 'personal-sandbox-accepted',
      computedLevel: 'administrator-equivalent',
      accepted: 'personal-sandbox',
      principalArn: `arn:aws:sts::********3333:assumed-role/${ROLE}/<session>`,
      ownerAuthorization: OWNER_TEXT,
    });
    expect(e.identity.reasons.administratorEquivalent).toEqual([
      'AWS managed policy AdministratorAccess',
      'inline policy AwsSSOInlinePolicy is administrator-equivalent',
    ]);
    expect(e.identity.note).toContain('rests entirely on the tool');
    expect(e.notes).toContain(PERSONAL_SANDBOX_NOTE);
    expect(e.inputs).toMatchObject({
      ownerAuthorizationGiven: true,
      expectedAccountSource: 'argument',
    });
    expect(e.inputs.attestationGiven).toBe(false);
    expect(e.inputs.acceptanceGiven).toBe(false);
    const console = r.out.join('\n');
    expect(console).toContain('execution profile personal-sandbox');
    expect(console).toContain(
      'computed level administrator-equivalent; recorded as personal-sandbox-accepted',
    );
    expect(console).toContain('gate: executionProfile personal-sandbox, organization member');
    expect(console).not.toContain(SESSION);
  });

  it('identity only: gate passes; the strict profile on the same identity stops with exit 5', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses(ADMIN_EQUIVALENT));
    const r = await runCli(liveArgs('identity', box, [...PERSONAL, ...OWNER]), fake.runner);
    expect(r.code).toBe(EXIT.OK);
    expect(readEvidence(box.evidence).gate.accepted).toBe('personal-sandbox');

    for (const extra of [[], ['--execution-profile', 'strict'], ACCEPT]) {
      const strictBox = sandbox();
      const strict = fakeRunner(happyResponses(ADMIN_EQUIVALENT));
      const s = await runCli(liveArgs('discover', strictBox, extra), strict.runner);
      expect(s.code).toBe(EXIT.PRIVILEGE_CHECK_FAILED);
      expect(s.err.join('\n')).toContain('administrator-equivalent identity');
      expect(s.err.join('\n')).toContain('No override');
      expect(ops(strict.awsCalls())).not.toContain('organizations describe-organization');
      expect(existsSync(strictBox.evidence)).toBe(false);
    }
  });

  it('a verified read-only identity stays verified-read-only (no acceptance recorded)', async () => {
    const box = sandbox();
    const r = await runCli(
      liveArgs('identity', box, [...PERSONAL, ...OWNER]),
      fakeRunner(happyResponses()).runner,
    );
    expect(r.code).toBe(EXIT.OK);
    const e = readEvidence(box.evidence);
    expect(e.schemaVersion).toBe(5);
    expect(e.gate.readOnlyAssessment).toBe('verified-read-only');
    expect(e.gate.computedLevel).toBe('verified-read-only');
    expect(e.gate.accepted).toBeUndefined();
    expect(e.identity.ownerAuthorization).toBe(OWNER_TEXT);
  });

  it('keeps Sandbox-* stack and Name-tag names readable (pre-existence check); strict masks them', async () => {
    const box = sandbox();
    const r = await runCli(
      liveArgs('discover', box, [...PERSONAL, ...OWNER]),
      fakeRunner(happyResponses({ ...ADMIN_EQUIVALENT, ...SANDBOX_STACKS })).runner,
    );
    expect(r.code).toBe(EXIT.OK);
    const e = readEvidence(box.evidence);
    const stacks = e.probes.find((p: { id: string }) => p.id === 'a.cfn.stacks@ap-southeast-1').data
      .StackSummaries;
    expect(stacks.map((s: { StackName: string }) => s.StackName)).toEqual([
      'Sandbox-Foundation',
      'starter-cdk-toolkit',
      '<stack-1>',
    ]);
    const vpcs = e.probes.find((p: { id: string }) => p.id === 'b.ec2.vpcs@ap-southeast-1').data;
    expect(vpcs.Vpcs[0].Tags.name).toBe('Sandbox-Foundation/Network/Vpc');

    const strictBox = sandbox();
    await runCli(
      liveArgs('discover', strictBox),
      fakeRunner(happyResponses(SANDBOX_STACKS)).runner,
    );
    const strict = readEvidence(strictBox.evidence);
    expect(JSON.stringify(strict)).not.toContain('Sandbox-Foundation');
  });
});

describe('personal-sandbox: refusals before any AWS process (exit 2)', () => {
  const refused = async (
    extra: string[],
    options: { env?: Record<string, string>; base?: string[] } = {},
  ) => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses(ADMIN_EQUIVALENT));
    const argv = options.base ?? liveArgs('discover', box, extra);
    const r = await runCli(options.base ? [...argv, ...extra] : argv, fake.runner, {
      ...env(box, options.env),
    });
    expect(r.code, r.err.join('\n')).toBe(EXIT.REFUSED);
    expect(fake.calls).toEqual([]);
    expect(existsSync(box.evidence)).toBe(false);
    return r.err.join('\n');
  };

  it('owner authorization: missing, invalid or a placeholder', async () => {
    expect(await refused(PERSONAL)).toContain(
      '--owner-authorization "<who, when, why>" is required',
    );
    for (const [text, why] of [
      ['ok by me', 'must be 10-500 characters'],
      ['Authorized by jane.doe@example.com for the sandbox', 'email-address'],
      [`Authorized for account ${SANDBOX} by the owner`, 'twelve-digit-number'],
      ['<owner statement: who, when, why>', 'template placeholder'],
      ['Authorized by the owner, call +1 202 555 0143 for questions', 'phone-number'],
      ['Authorized by the owner\nsecond line', 'one line'],
    ] as const) {
      const err = await refused([...PERSONAL, '--owner-authorization', text]);
      expect(err).toContain('--owner-authorization');
      expect(err).toContain(why);
      expect(err).not.toContain('jane.doe');
      expect(err).not.toContain(SANDBOX);
    }
  });

  it('owner authorization and the expected-account file are refused in the strict profile', async () => {
    expect(await refused(OWNER)).toContain(
      '--owner-authorization and --expected-account-file only apply to --execution-profile personal-sandbox',
    );
    expect(await refused(['--execution-profile', 'strict', ...OWNER])).toContain(
      'only apply to --execution-profile personal-sandbox',
    );
  });

  it('the strict human statements are refused with personal-sandbox', async () => {
    expect(await refused([...PERSONAL, ...OWNER, ...ACCEPT])).toContain(
      'personal-sandbox uses --owner-authorization',
    );
  });

  it('an unknown execution profile', async () => {
    expect(await refused(['--execution-profile', 'starter', ...OWNER])).toContain(
      '--execution-profile must be strict or personal-sandbox',
    );
  });

  it('--profile default (the default-profile fallback) and a missing profile', async () => {
    const box = sandbox();
    const args = liveArgs('discover', box, [...PERSONAL, ...OWNER]);
    const i = args.indexOf('--profile');
    const withDefault = [...args.slice(0, i + 1), 'default', ...args.slice(i + 2)];
    expect(await refused([], { base: withDefault })).toContain('--profile default is refused');
    const without = [...args.slice(0, i), ...args.slice(i + 2)];
    expect(await refused([], { base: without })).toContain('--profile is required');
  });

  it.each([
    [{ AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y' }, 'static credentials'],
    [{ AWS_SESSION_TOKEN: 'x' }, 'static credentials in the environment (the AWS session token'],
    [{ AWS_DEFAULT_PROFILE: 'starter-sandbox-developer' }, 'AWS_DEFAULT_PROFILE'],
    [{ AWS_PROFILE: 'admin' }, 'AWS_PROFILE is set to a different profile'],
    [{ AWS_PROFILE: '' }, 'AWS_PROFILE is set to a different profile'],
    [{ AWS_REGION: 'us-east-1' }, 'AWS_REGION is set to a different region'],
    [{ AWS_DEFAULT_REGION: 'eu-west-1' }, 'AWS_DEFAULT_REGION is set to a different region'],
    [{ AWS_ENDPOINT_URL_STS: 'http://127.0.0.1:4566' }, 'AWS_ENDPOINT_URL_STS'],
    [{ AWS_CONFIG_FILE: '/tmp/x' }, 'AWS_CONFIG_FILE'],
    [{ AWS_ROLE_ARN: `arn:aws:iam::${OTHER}:role/admin` }, 'AWS_ROLE_ARN'],
  ])('environment %o is refused', async (extraEnv, message) => {
    const err = await refused([...PERSONAL, ...OWNER], { env: extraEnv });
    expect(err).toContain(message);
    for (const value of Object.values(extraEnv))
      if (value.length > 1) expect(err).not.toContain(value);
  });

  it('accepts AWS_PROFILE / AWS_REGION equal to the selected profile and region', async () => {
    const box = sandbox();
    const r = await runCli(
      liveArgs('identity', box, [...PERSONAL, ...OWNER]),
      fakeRunner(happyResponses(ADMIN_EQUIVALENT)).runner,
      env(box, {
        AWS_PROFILE: 'starter-sandbox-developer',
        AWS_REGION: 'ap-southeast-1',
        AWS_DEFAULT_REGION: 'ap-southeast-1',
      }),
    );
    expect(r.code, r.err.join('\n')).toBe(EXIT.OK);
  });

  it('--expected-account-file: private 12-digit file only; never echoed; not with --expected-account', async () => {
    const box = sandbox();
    const args = liveArgs('identity', box, [...PERSONAL, ...OWNER]);
    const i = args.indexOf('--expected-account');
    const withoutAccount = [...args.slice(0, i), ...args.slice(i + 2)];
    const good = accountFile(box);
    const r = await runCli(
      [...withoutAccount, '--expected-account-file', good],
      fakeRunner(happyResponses(ADMIN_EQUIVALENT)).runner,
    );
    expect(r.code, r.err.join('\n')).toBe(EXIT.OK);
    expect(readEvidence(box.evidence).inputs.expectedAccountSource).toBe('file');

    const cases: [string, (b: Sandbox) => string][] = [
      ['must be private', (b) => accountFile(b, `${SANDBOX}\n`, 0o644)],
      ['exactly one 12-digit account ID', (b) => accountFile(b, '12345678901x\n')],
      ['does not exist', (b) => join(b.dir, 'missing')],
      [
        'symbolic link',
        (b) => {
          const link = join(b.dir, 'link');
          symlinkSync(accountFile(b), link);
          return link;
        },
      ],
    ];
    for (const [message, make] of cases) {
      const b = sandbox();
      const a = liveArgs('identity', b, [...PERSONAL, ...OWNER]);
      const j = a.indexOf('--expected-account');
      const err = await refused([], {
        base: [...a.slice(0, j), ...a.slice(j + 2), '--expected-account-file', make(b)],
      });
      expect(err).toContain(message);
      expect(err).not.toContain('12345678901x');
    }
    expect(
      await refused([...PERSONAL, ...OWNER, '--expected-account-file', accountFile(sandbox())]),
    ).toContain('not both');
  });
});

describe('personal-sandbox: no identity to fall back to; strict unaffected', () => {
  const STATIC = 'aws_access_key_id = placeholder-not-a-key\naws_secret_access_key = placeholder\n';

  it('refuses a [default] profile, ~/.aws/credentials and a CDK "profile" setting before any process', async () => {
    const cases: [string, (b: Sandbox) => void][] = [
      [
        'has a [default] section',
        (b) =>
          writeFileSync(
            join(b.home, '.aws', 'config'),
            `${readFileSync(join(b.home, '.aws', 'config'), 'utf8')}\n[default]\nregion = ap-southeast-1\n`,
          ),
      ],
      [
        'has 1 section(s)',
        (b) => writeFileSync(join(b.home, '.aws', 'credentials'), `[default]\n${STATIC}`),
      ],
      [
        '~/.cdk.json sets "profile"',
        (b) => writeFileSync(join(b.home, '.cdk.json'), JSON.stringify({ profile: 'admin' })),
      ],
    ];
    for (const [message, prepare] of cases) {
      const box = sandbox();
      prepare(box);
      const fake = fakeRunner(happyResponses(ADMIN_EQUIVALENT));
      const r = await runCli(liveArgs('discover', box, [...PERSONAL, ...OWNER]), fake.runner);
      expect(r.code, r.err.join('\n')).toBe(EXIT.REFUSED);
      expect(r.err.join('\n')).toContain(message);
      expect(r.err.join('\n')).not.toContain('placeholder');
      expect(fake.calls).toEqual([]);
      expect(existsSync(box.evidence)).toBe(false);

      // The strict profile does not apply this check (unchanged behavior).
      const strictBox = sandbox();
      prepare(strictBox);
      const strict = await runCli(
        liveArgs('identity', strictBox),
        fakeRunner(happyResponses()).runner,
      );
      expect(strict.code, strict.err.join('\n')).toBe(EXIT.OK);
    }
  });
});

describe('personal-sandbox: the other gate stops are unchanged', () => {
  const personal = async (overrides: Record<string, Responder>) => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses({ ...ADMIN_EQUIVALENT, ...overrides }));
    const r = await runCli(liveArgs('discover', box, [...PERSONAL, ...OWNER]), fake.runner);
    return { r, fake, box };
  };

  it('account mismatch: exit 3 after exactly one call, no evidence', async () => {
    const { r, fake, box } = await personal({
      'sts get-caller-identity': ok({
        Account: OTHER,
        Arn: `arn:aws:sts::${OTHER}:assumed-role/${ROLE}/${SESSION}`,
      }),
    });
    expect(r.code).toBe(EXIT.ACCOUNT_MISMATCH);
    expect(ops(fake.awsCalls())).toEqual(['sts get-caller-identity']);
    expect(existsSync(box.evidence)).toBe(false);
  });

  it('a role outside --expected-role-pattern, an IAM user or root: exit 4', async () => {
    for (const arn of [
      `arn:aws:sts::${SANDBOX}:assumed-role/AWSReservedSSO_AdministratorAccess_0123456789abcdef/${SESSION}`,
      `arn:aws:iam::${SANDBOX}:user/deployer`,
      `arn:aws:iam::${SANDBOX}:root`,
    ]) {
      const { r } = await personal({
        'sts get-caller-identity': ok({ Account: SANDBOX, Arn: arn }),
      });
      expect(r.code).toBe(EXIT.PRINCIPAL_REJECTED);
    }
  });

  it('the management account or no organization: exit 7; expired SSO: exit 6', async () => {
    const mgmt = await personal({
      'organizations describe-organization': ok({
        Organization: { Id: 'o-exampleorgid1', MasterAccountId: SANDBOX },
      }),
    });
    expect(mgmt.r.code).toBe(EXIT.ORGANIZATION);
    const noOrg = await personal({
      'organizations describe-organization': awsError('AWSOrganizationsNotInUseException'),
    });
    expect(noOrg.r.code).toBe(EXIT.ORGANIZATION);
    const member = await personal({});
    expect(readEvidence(member.box.evidence).identity.organization.managementAccount).toBe(
      '<other-account-1>',
    );
    expect(MANAGEMENT).not.toBe(SANDBOX);
    const expired = await personal({ 'iam get-role': ssoExpired });
    expect(expired.r.code).toBe(EXIT.CREDENTIALS);
  });
});
