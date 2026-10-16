/**
 * Strict execution profile: byte-for-byte regression against golden outputs recorded with the
 * code BEFORE the execution-profile switch was added (tool revision 2).
 *
 * The goldens hold the sanitized evidence and every console line of representative strict runs.
 * Only values that legitimately differ between checkouts and machines are normalized: the tool's
 * own provenance (commit, source digest, dirty flag) and temporary directory paths. Everything
 * else -- schema version, gate fields, masking, call order, messages, exit codes -- must stay
 * identical. Regenerate only for an intended change of the strict profile (vitest -u), never to
 * make a personal-sandbox change pass.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatJson } from '../src/evidence.ts';
import { EXIT } from '../src/types.ts';
import {
  awsError,
  fakeRunner,
  happyResponses,
  liveArgs,
  ok,
  OTHER,
  ops,
  ROLE,
  runCli,
  sandbox,
  SANDBOX,
  SESSION,
  type Responder,
  type Sandbox,
} from './support.ts';

const GOLDEN = './__golden__/strict';

/** Stacks and a VPC Name tag shaped like the sandbox stage, plus the qualifier toolkit. */
const SANDBOX_SHAPED: Record<string, Responder> = {
  'cloudformation list-stacks': ok({
    StackSummaries: [
      {
        StackId: `arn:aws:cloudformation:ap-southeast-1:${SANDBOX}:stack/CDKToolkit/00000000-0000-4000-8000-000000000007`,
        StackName: 'CDKToolkit',
        StackStatus: 'UPDATE_COMPLETE',
        CreationTime: '2026-01-01T00:00:00+00:00',
      },
      {
        StackId: `arn:aws:cloudformation:ap-southeast-1:${SANDBOX}:stack/starter-cdk-toolkit/00000000-0000-4000-8000-000000000021`,
        StackName: 'starter-cdk-toolkit',
        StackStatus: 'CREATE_COMPLETE',
        CreationTime: '2026-01-02T00:00:00+00:00',
      },
      {
        StackId: `arn:aws:cloudformation:ap-southeast-1:${SANDBOX}:stack/Sandbox-Foundation/00000000-0000-4000-8000-000000000022`,
        StackName: 'Sandbox-Foundation',
        StackStatus: 'CREATE_COMPLETE',
        CreationTime: '2026-01-03T00:00:00+00:00',
      },
      {
        StackId: `arn:aws:cloudformation:ap-southeast-1:${SANDBOX}:stack/acme-patient-records-prod/00000000-0000-4000-8000-000000000008`,
        StackName: 'acme-patient-records-prod',
        StackStatus: 'CREATE_COMPLETE',
        CreationTime: '2026-02-01T00:00:00+00:00',
      },
    ],
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
      {
        VpcId: 'vpc-00000000000000002',
        OwnerId: SANDBOX,
        CidrBlock: '10.30.0.0/16',
        IsDefault: false,
        State: 'available',
        Tags: [{ Key: 'Name', Value: 'starter-sbx-vpc' }],
      },
    ],
  }),
};

/** Environment variables the strict profile ignores (the child environment is built from scratch). */
const POLLUTED_ENV = {
  AWS_ACCESS_KEY_ID: 'unused',
  AWS_SECRET_ACCESS_KEY: 'unused',
  AWS_SESSION_TOKEN: 'unused',
  AWS_PROFILE: 'admin',
  AWS_DEFAULT_PROFILE: 'admin',
  AWS_REGION: 'eu-west-1',
  AWS_CONFIG_FILE: '/tmp/other-config',
};

const ACCEPT = [
  '--accept-write-capable',
  'Developer permission set accepted for this discovery run by J. Tan (account owner), 2026-10-14, dedicated sandbox',
];

/** The real Developer permission set's shape (account-inventory.md): full-access managed + iam:*. */
const DEVELOPER_SHAPED: Record<string, Responder> = {
  'iam list-attached-role-policies': ok({
    AttachedPolicies: ['AWSCloudFormationFullAccess', 'AmazonDynamoDBFullAccess'].map((n) => ({
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
      Statement: [
        { Effect: 'Allow', Action: ['iam:*', 's3:*', 'ec2:*'], Resource: '*' },
        { Effect: 'Allow', Action: ['ssm:PutParameter', 'ssm:DeleteParameter'], Resource: '*' },
      ],
    },
  }),
};

function normalizer(box: Sandbox) {
  const dirs = [realpathSync(box.dir), box.dir, basename(box.dir)];
  const paths = (s: string) => dirs.reduce((acc, d) => acc.split(d).join('<box>'), s);
  const line = (l: string) =>
    paths(l).replace(
      /tool (\S+), commit \S+, sources sha256 [0-9a-f]{64}, (?:clean|dirty: .*)$/,
      'tool $1, commit <commit>, sources sha256 <source-sha256>, <clean-or-dirty>',
    );
  const consoleText = (r: { code: number; out: string[]; err: string[] }) =>
    [
      `exit ${r.code}`,
      '--- stdout',
      ...r.out
        .filter((l) => !l.startsWith('  note: the tool sources are not a clean checkout'))
        .map(line),
      '--- stderr',
      ...r.err.map(line),
      '',
    ].join('\n');
  const evidence = async () => {
    const e = JSON.parse(readFileSync(box.evidence, 'utf8')) as {
      tool: Record<string, unknown>;
      awsCli: Record<string, string>;
    };
    e.tool = {
      ...e.tool,
      gitCommit: '<commit>',
      sourceSha256: '<source-sha256>',
      gitDirty: '<clean-or-dirty>',
    };
    delete e.tool['gitDirtyReason'];
    e.awsCli = {
      ...e.awsCli,
      path: paths(e.awsCli['path'] ?? ''),
      realpath: paths(e.awsCli['realpath'] ?? ''),
    };
    return formatJson(e);
  };
  return { consoleText, evidence };
}

describe('strict execution profile: unchanged output (golden, recorded before the switch)', () => {
  it('discover, verified-read-only identity: evidence and console', async () => {
    for (const env of [{}, POLLUTED_ENV]) {
      const box = sandbox();
      const fake = fakeRunner(happyResponses(SANDBOX_SHAPED));
      const r = await runCli(liveArgs('discover', box), fake.runner, {
        env: { HOME: box.home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...env },
      });
      expect(r.code).toBe(EXIT.OK);
      const n = normalizer(box);
      await expect(await n.evidence()).toMatchFileSnapshot(`${GOLDEN}/discover.evidence.json`);
      await expect(n.consoleText(r)).toMatchFileSnapshot(`${GOLDEN}/discover.console.txt`);
      // The same calls in the same order, with or without unrelated AWS_* variables.
      await expect(`${ops(fake.awsCalls()).join('\n')}\n`).toMatchFileSnapshot(
        `${GOLDEN}/discover.calls.txt`,
      );
    }
  });

  it('identity, write-capable identity accepted by a human statement', async () => {
    const box = sandbox();
    const fake = fakeRunner(
      happyResponses({
        'iam list-attached-role-policies': ok({
          AttachedPolicies: [
            {
              PolicyName: 'PowerUserAccess',
              PolicyArn: 'arn:aws:iam::aws:policy/PowerUserAccess',
            },
          ],
        }),
      }),
    );
    const r = await runCli(liveArgs('identity', box, ACCEPT), fake.runner);
    expect(r.code).toBe(EXIT.OK);
    const n = normalizer(box);
    await expect(await n.evidence()).toMatchFileSnapshot(
      `${GOLDEN}/identity-accepted.evidence.json`,
    );
    await expect(n.consoleText(r)).toMatchFileSnapshot(`${GOLDEN}/identity-accepted.console.txt`);
  });

  it('administrator-equivalent identity: exit 5, no override, no discovery call', async () => {
    for (const [name, extra] of [
      ['no-statement', []],
      ['with-acceptance', ACCEPT],
    ] as const) {
      const box = sandbox();
      const fake = fakeRunner(happyResponses(DEVELOPER_SHAPED));
      const r = await runCli(liveArgs('discover', box, [...extra]), fake.runner);
      expect(r.code).toBe(EXIT.PRIVILEGE_CHECK_FAILED);
      await expect(normalizer(box).consoleText(r)).toMatchFileSnapshot(
        `${GOLDEN}/admin-${name}.console.txt`,
      );
      await expect(`${ops(fake.awsCalls()).join('\n')}\n`).toMatchFileSnapshot(
        `${GOLDEN}/admin.calls.txt`,
      );
    }
  });

  it('account mismatch: exit 3 after one call; organization not a member: exit 7', async () => {
    const mismatch = sandbox();
    const r1 = await runCli(
      liveArgs('discover', mismatch),
      fakeRunner(
        happyResponses({
          'sts get-caller-identity': ok({
            Account: OTHER,
            Arn: `arn:aws:sts::${OTHER}:assumed-role/${ROLE}/${SESSION}`,
          }),
        }),
      ).runner,
    );
    expect(r1.code).toBe(EXIT.ACCOUNT_MISMATCH);
    await expect(normalizer(mismatch).consoleText(r1)).toMatchFileSnapshot(
      `${GOLDEN}/account-mismatch.console.txt`,
    );
    const noOrg = sandbox();
    const r2 = await runCli(
      liveArgs('identity', noOrg),
      fakeRunner(
        happyResponses({
          'organizations describe-organization': awsError('AWSOrganizationsNotInUseException'),
        }),
      ).runner,
    );
    expect(r2.code).toBe(EXIT.ORGANIZATION);
    await expect(normalizer(noOrg).consoleText(r2)).toMatchFileSnapshot(
      `${GOLDEN}/not-in-org.console.txt`,
    );
  });

  it('argument refusals before any AWS call (exit 2)', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses());
    const r = await runCli(
      [
        'discover',
        '--profile',
        'default',
        '--expected-role-pattern',
        'x',
        '--region',
        'cn-north-1',
        '--attest-read-only',
        'short',
        '--evidence-out',
        box.evidence,
      ],
      fake.runner,
    );
    expect(r.code).toBe(EXIT.REFUSED);
    expect(fake.calls).toEqual([]);
    await expect(normalizer(box).consoleText(r)).toMatchFileSnapshot(
      `${GOLDEN}/refused-arguments.console.txt`,
    );
  });
});
