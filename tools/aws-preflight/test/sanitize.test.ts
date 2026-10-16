import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { maskedCommand, maskLocalPath, writeEvidence } from '../src/evidence.ts';
import { HEX_DIGEST_RE, leakRulesIn, scanText, scanValue } from '../src/leak.ts';
import { P, trustSummary } from '../src/projections.ts';
import { PROBES_BY_ID } from '../src/probes.ts';
import { createSanitizer, preGateConsoleMask } from '../src/sanitize.ts';
import { EXIT } from '../src/types.ts';
import {
  fakeRunner,
  fakeUuid,
  happyResponses,
  liveArgs,
  MANAGEMENT,
  OTHER,
  PROFILE,
  rid,
  runCli,
  sandbox,
  SANDBOX,
  SESSION,
  UNRELATED,
} from './support.ts';

// Credential-shaped test values are assembled at runtime (never literal in source).
const ACCESS_KEY_ID = ['AK', 'IA', 'Z'.repeat(16)].join('');
const PEM_HEADER = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');

const s = () => createSanitizer({ sandboxAccount: SANDBOX, sessionName: SESSION });

describe('sanitizer', () => {
  it('masks the sandbox account, other accounts (stable numbering) and ARN accounts', () => {
    const z = s();
    expect(z.account(SANDBOX)).toBe('<sandbox-account>');
    expect(z.account(OTHER)).toBe('<other-account-1>');
    expect(z.account(MANAGEMENT)).toBe('<other-account-2>');
    expect(z.account(OTHER)).toBe('<other-account-1>');
    expect(z.account('aws')).toBe('aws');
    expect(z.arn(`arn:aws:iam::${OTHER}:role/deployer`)).toBe(
      'arn:aws:iam::<other-account-1>:role/deployer',
    );
    expect(z.arn('arn:aws:iam::aws:policy/job-function/ViewOnlyAccess')).toBe(
      'arn:aws:iam::aws:policy/job-function/ViewOnlyAccess',
    );
    expect(z.text(`cdk-hnb659fds-assets-${SANDBOX}-ap-southeast-1`)).toBe(
      'cdk-hnb659fds-assets-<sandbox-account>-ap-southeast-1',
    );
  });

  it('masks e-mails, the session name, key IDs, IAM unique IDs, resource IDs and UUIDs consistently', () => {
    const z = s();
    expect(z.text(`owner ${SESSION} / other@example.com`)).toBe('owner <session> / <email>');
    expect(z.text(`key ${ACCESS_KEY_ID}`)).toBe('key <access-key-id>');
    expect(z.text('AROAFAKEROLEID00000001')).toBe('<iam-unique-id-1>');
    expect(z.text(`${rid('vpc', 1)} ${rid('subnet', 1)} ${rid('vpc', 1)} ${rid('vpc', 2)}`)).toBe(
      '<vpc-1> <subnet-1> <vpc-1> <vpc-2>',
    );
    expect(z.text('legacy vpc-0a1b2c3d')).toBe('legacy <vpc-3>');
    // A 17-hex ID containing exactly 12 decimal digits is a resource, not an account.
    expect(z.text('vpc-0a123456789012b45')).toBe('<vpc-4>');
    expect(z.arn(`arn:aws:kms:ap-southeast-1:${SANDBOX}:key/${fakeUuid(12)}`)).toBe(
      'arn:aws:kms:ap-southeast-1:<sandbox-account>:key/<uuid-1>',
    );
    expect(z.text(fakeUuid(12))).toBe('<uuid-1>');
    expect(z.text('o-exampleorgid1 ou-ab12-cdefgh34 r-ab12')).toBe('<org-1> <ou-1> <org-root-1>');
    expect(z.arn('arn:aws:route53:::hostedzone/Z0000000000000000001')).toBe(
      'arn:aws:route53:::hostedzone/<hostedzone-1>',
    );
  });

  it('masks customer domains (stable, TLD kept) and keeps AWS-owned names', () => {
    const z = s();
    expect(z.domain('sandbox.example.com.')).toBe('<domain-1>.com');
    expect(z.domain('*.sandbox.example.com')).toBe('*.<domain-1>.com');
    expect(z.domain('api.example.com')).toBe('<domain-2>.com');
    expect(z.text('see https://portal.example.com/x')).toBe('see https://<domain-3>.com/x');
    expect(z.text('bucket.s3.ap-southeast-1.amazonaws.com')).toBe(
      'bucket.s3.ap-southeast-1.amazonaws.com',
    );
    expect(z.text('com.amazonaws.ap-southeast-1.s3')).toBe('com.amazonaws.ap-southeast-1.s3');
    expect(z.text('db.t4g.micro', { domains: false })).toBe('db.t4g.micro');
  });

  it('masks 12-digit integers', () => {
    const z = s();
    expect(z.number(Number(SANDBOX))).toBe('<sandbox-account>');
    expect(z.number(123456789012)).toBe('<12-digit-number>');
    expect(z.number(80530636800)).toBe(80530636800);
    expect(z.number(1712345678901)).toBe(1712345678901);
  });

  it('reduces a trust policy to a principal-type summary', () => {
    const summary = trustSummary(
      {
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              AWS: [`arn:aws:iam::${SANDBOX}:root`, `arn:aws:iam::${OTHER}:role/ci`],
              Service: 'cloudformation.amazonaws.com',
            },
            Action: 'sts:AssumeRole',
            Condition: { StringEquals: { 'sts:ExternalId': 'secret-external-id' } },
          },
        ],
      },
      s(),
    );
    expect(summary).toEqual({
      statementCount: 1,
      effects: ['Allow'],
      actions: ['sts:AssumeRole'],
      principalTypes: { AWS: 2, Service: 1 },
      awsPrincipals: { sameAccount: 1, otherAccount: 1 },
      conditionKeys: ['sts:ExternalId'],
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /secret-external-id|444455556666|cloudformation\.amazonaws/,
    );
  });

  it('projections drop descriptions, documents, IPs, spend, lock tokens and non-Name tag values', () => {
    const z = s();
    const budgets = P.budgets(
      {
        Budgets: [
          {
            BudgetName: 'sandbox-monthly',
            BudgetLimit: { Amount: '100.0', Unit: 'USD' },
            CalculatedSpend: { ActualSpend: { Amount: '42.17', Unit: 'USD' } },
            CostFilters: { LinkedAccount: [SANDBOX] },
          },
        ],
      },
      z,
    );
    expect(budgets).toEqual({
      Budgets: [
        {
          BudgetName: '<budget-1>',
          BudgetLimit: { Amount: '100.0', Unit: 'USD' },
          CostFilters: ['LinkedAccount'],
        },
      ],
    });
    const nat = P.natGateways(
      {
        NatGateways: [
          {
            NatGatewayId: rid('nat', 1),
            NatGatewayAddresses: [
              { PublicIp: '203.0.113.10', PrivateIp: '10.0.0.5', IsPrimary: true },
            ],
          },
        ],
      },
      z,
    );
    expect(JSON.stringify(nat)).not.toMatch(/203\.0\.113|10\.0\.0\.5/);
    const acls = P.webAcls(
      {
        WebACLs: [
          { Name: 'a', Id: fakeUuid(1), Description: SESSION, LockToken: 'lock-token-value' },
        ],
      },
      z,
    );
    expect(acls).toEqual({ WebACLs: [{ Name: '<web-acl-1>', Id: '<uuid-1>', fmsManaged: false }] });
    const vpcs = P.vpcs(
      {
        Vpcs: [
          {
            VpcId: rid('vpc', 1),
            Tags: [
              { Key: 'Name', Value: 'main' },
              { Key: 'owner', Value: SESSION },
            ],
          },
        ],
      },
      z,
    );
    expect(vpcs).toEqual({
      Vpcs: [{ VpcId: '<vpc-1>', Tags: { keys: ['Name', 'owner'], name: '<name-1>' } }],
    });
    const org = P.organization(
      { Organization: { MasterAccountId: MANAGEMENT, MasterAccountEmail: 'root@example.com' } },
      z,
    );
    expect(org).toEqual({ Organization: { MasterAccountId: '<other-account-1>' } });
    const param = P.bootstrapVersion(
      { Parameter: { Name: '/x', Type: 'SecureString', Value: 'AQICAHh-ciphertext' } },
      z,
    );
    expect(param).toEqual({ Parameter: { Name: '/x', Type: 'SecureString' } });
  });
});

describe('names of unrelated workloads are masked', () => {
  it('stacks: project and platform stacks keep their names, others become <stack-N> (also in ARNs)', () => {
    const z = s();
    const out = P.stackSummaries(
      {
        StackSummaries: [
          'CDKToolkit',
          'starter-it-mini-stack',
          'starter-dev-network',
          'StackSet-AWSControlTowerBP-BASELINE-CLOUDWATCH-0000',
          'AWSAccelerator-SecurityStack-111122223333-ap-southeast-1',
          UNRELATED.stack,
          'starterx-other',
        ].map((StackName, i) => ({
          StackName,
          StackId: `arn:aws:cloudformation:ap-southeast-1:${SANDBOX}:stack/${StackName}/${fakeUuid(i + 1)}`,
          StackStatus: 'CREATE_COMPLETE',
        })),
      },
      z,
    ) as { StackSummaries: { StackName: string; StackId: string }[] };
    expect(out.StackSummaries.map((x) => x.StackName)).toEqual([
      'CDKToolkit',
      'starter-it-mini-stack',
      'starter-dev-network',
      'StackSet-AWSControlTowerBP-BASELINE-CLOUDWATCH-0000',
      'AWSAccelerator-SecurityStack-<sandbox-account>-ap-southeast-1',
      '<stack-1>',
      '<stack-2>',
    ]);
    expect(out.StackSummaries[5]?.StackId).toBe(
      'arn:aws:cloudformation:ap-southeast-1:<sandbox-account>:stack/<stack-1>/<uuid-6>',
    );
    expect(JSON.stringify(out)).not.toContain('patient');
  });

  it('KMS aliases: alias/aws/* and project aliases kept, others alias/<kms-alias-N> (also in AliasArn)', () => {
    const z = s();
    const out = P.kmsAliases(
      {
        Aliases: [
          'alias/aws/s3',
          'alias/starter-data',
          'alias/starter',
          'alias/starterx',
          UNRELATED.kmsAlias,
        ].map((AliasName) => ({
          AliasName,
          AliasArn: `arn:aws:kms:ap-southeast-1:${SANDBOX}:${AliasName}`,
        })),
      },
      z,
    ) as { Aliases: { AliasName: string; AliasArn: string }[] };
    expect(out.Aliases.map((a) => a.AliasName)).toEqual([
      'alias/aws/s3',
      'alias/starter-data',
      'alias/starter',
      'alias/<kms-alias-1>',
      'alias/<kms-alias-2>',
    ]);
    expect(out.Aliases[4]?.AliasArn).toBe(
      'arn:aws:kms:ap-southeast-1:<sandbox-account>:alias/<kms-alias-2>',
    );
  });

  it('web ACLs: always <web-acl-N>, with the Firewall Manager fact kept (also in ARNs)', () => {
    const z = s();
    const out = P.webAcls(
      {
        WebACLs: [
          {
            Name: UNRELATED.webAcl,
            Id: fakeUuid(1),
            ARN: `arn:aws:wafv2:us-east-1:${SANDBOX}:global/webacl/${UNRELATED.webAcl}/${fakeUuid(1)}`,
          },
          { Name: 'starter-alb', Id: fakeUuid(2) },
        ],
      },
      z,
    );
    expect(out).toEqual({
      WebACLs: [
        {
          Name: '<web-acl-1>',
          Id: '<uuid-1>',
          ARN: 'arn:aws:wafv2:us-east-1:<sandbox-account>:global/webacl/<web-acl-1>/<uuid-1>',
          fmsManaged: true,
        },
        { Name: '<web-acl-2>', Id: '<uuid-2>', fmsManaged: false },
      ],
    });
  });

  it('budgets and Name tags: project names kept, others masked; the command masks them too', () => {
    const z = s();
    expect(z.name('budget', 'starter-monthly')).toBe('starter-monthly');
    expect(z.name('budget', UNRELATED.budget)).toBe('<budget-1>');
    expect(z.name('name', 'starter-it-vpc')).toBe('starter-it-vpc');
    expect(z.name('name', UNRELATED.vpcName)).toBe('<name-1>');
    const def = PROBES_BY_ID.get('d.budgets.notifications');
    if (!def) throw new Error('missing probe');
    const command = maskedCommand(
      def,
      { account: SANDBOX, budgetName: UNRELATED.budget },
      'us-east-1',
      z,
    );
    expect(command).toBe(
      'aws budgets describe-notifications-for-budget --account-id=<account> --budget-name=<budget-1> --max-items 10 --profile <profile> --region us-east-1 --output json --no-cli-pager --cli-connect-timeout 10 --cli-read-timeout 30',
    );
    expect(command).not.toContain('example');
  });

  it('local paths: home and user names are masked', () => {
    expect(maskLocalPath('/Users/jdoe/.nix-profile/bin/aws', '/Users/jdoe')).toBe(
      '~/.nix-profile/bin/aws',
    );
    expect(maskLocalPath('/etc/profiles/per-user/jdoe/bin/aws', '/Users/jdoe')).toBe(
      '/etc/profiles/per-user/<user>/bin/aws',
    );
    expect(maskLocalPath('/home/jdoe/bin/aws', '/root')).toBe('/home/<user>/bin/aws');
    expect(maskLocalPath('/nix/store/x-awscli2-2.35.11/bin/aws', '/Users/jdoe')).toBe(
      '/nix/store/x-awscli2-2.35.11/bin/aws',
    );
  });
});

describe('sanitizer and leak-scanner gaps closed', () => {
  it('separated account IDs are masked and flagged', () => {
    const z = s();
    expect(z.text('account 1111-2222-3333 and 4444 5555 6666')).toBe(
      'account <sandbox-account> and <other-account-1>',
    );
    expect(leakRulesIn('account 1111-2222-3333')).toContain('separated-account-id');
    expect(leakRulesIn('account 1111 2222 3333')).toContain('separated-account-id');
    // A UUID is masked before the separated-digit rule sees it.
    expect(z.text(fakeUuid(3))).toMatch(/^<uuid-\d+>$/);
  });

  it('%40-encoded e-mail addresses are masked completely and flagged', () => {
    const z = s();
    expect(z.text('owner=jane.doe%40example.com')).toBe('owner=<email>');
    expect(z.text('owner=JANE.DOE%40EXAMPLE.COM')).toBe('owner=<email>');
    expect(leakRulesIn('owner=jane.doe%40example.com')).toContain('url-encoded-email-address');
  });

  it('short session names are masked as whole identifiers only', () => {
    const z = createSanitizer({ sandboxAccount: SANDBOX, sessionName: 'dev' });
    expect(z.text('Environment=dev')).toBe('Environment=dev');
    expect(z.text('devops pipeline')).toBe('devops pipeline');
    expect(z.text('assumed-role/Role/dev')).toBe('assumed-role/Role/<session>');
    expect(z.text('dev logged in')).toBe('<session> logged in');
    const two = createSanitizer({ sandboxAccount: SANDBOX, sessionName: 'jd' });
    expect(two.text('by jd today')).toBe('by <session> today');
    expect(leakRulesIn('by jd today', { sessionName: 'jd' })).toEqual(['session-name']);
    expect(leakRulesIn('jdoe', { sessionName: 'jd' })).toEqual([]);
  });

  it('tool digests (git commit, SHA-256) are not account IDs; the same digits elsewhere are', () => {
    const digest = `ab${'123456789012'}${'c'.repeat(26)}`;
    expect(HEX_DIGEST_RE.test(digest)).toBe(true);
    expect(scanValue({ tool: { gitCommit: digest } })).toEqual([]);
    expect(scanText(JSON.stringify({ gitCommit: digest }, null, 2))).toEqual([]);
    expect(scanValue({ note: `x ${digest}` }).map((f) => f.rule)).toContain('twelve-digit-number');
    expect(
      scanValue({ tool: { gitCommit: digest } }, { account: '123456789012' }).map((f) => f.rule),
    ).toEqual(['sandbox-account-id']);
  });

  it('pre-gate console masking removes 12-digit runs, separated IDs and e-mails', () => {
    expect(preGateConsoleMask(`profile 'admin-${SANDBOX}' 1111-2222-3333 a@example.com`)).toBe(
      "profile 'admin-<12-digit-number>' <12-digit-number> <email>",
    );
  });
});

describe('organization policy summaries (no policy documents)', () => {
  const responses = happyResponses();
  const effective = responses['organizations describe-effective-policy'];
  const respond = (type: string) =>
    typeof effective === 'function'
      ? effective(['organizations', 'describe-effective-policy', '--policy-type', type], 1)
      : effective;

  it('tag policy -> tag keys, enforced resource types, whether allowed values exist', () => {
    const data = respond('TAG_POLICY')?.stdout;
    expect(P.effectiveTagPolicy(data, s())).toEqual({
      EffectivePolicy: {
        LastUpdatedTimestamp: '2026-09-01T00:00:00+00:00',
        TargetId: '<sandbox-account>',
        PolicyType: 'TAG_POLICY',
        summary: [{ tag: 'CostCenter', hasAllowedValues: true, enforcedFor: ['ec2:instance'] }],
      },
    });
  });

  it('EC2 declarative policy -> attribute = enum value; free text and account lists dropped', () => {
    const data = respond('DECLARATIVE_POLICY_EC2')?.stdout;
    const out = P.effectiveDeclarativePolicy(data, s());
    expect(out).toEqual({
      EffectivePolicy: {
        TargetId: '<sandbox-account>',
        PolicyType: 'DECLARATIVE_POLICY_EC2',
        summary: {
          'ec2_attributes.vpc_block_public_access.internet_gateway_block.mode': 'block_ingress',
        },
      },
    });
    expect(JSON.stringify(out)).not.toMatch(/444455556666|example\.com|Contact/);
  });
});

describe('leak scanner', () => {
  it.each([
    ['a 12-digit number', `account ${SANDBOX}`, 'twelve-digit-number'],
    ['an e-mail address', 'contact someone@example.com', 'email-address'],
    ['an access key ID', `key ${ACCESS_KEY_ID}`, 'aws-access-key-id'],
    ['SecretAccessKey', '{"SecretAccessKey":"x"}', 'secret-key-material-name'],
    ['SessionToken', '{"SessionToken":"x"}', 'secret-key-material-name'],
    ['a PEM header', PEM_HEADER, 'pem-header'],
  ])('flags %s', (_, text, rule) => {
    expect(leakRulesIn(text)).toContain(rule);
  });

  it('flags the raw account and session name, and reports paths, never values', () => {
    const payload = { probes: [{ data: { note: `by ${SESSION}` } }], [`k-${SANDBOX}`]: 1 };
    const findings = scanValue(payload, { account: SANDBOX, sessionName: SESSION });
    expect(findings).toEqual(
      expect.arrayContaining([
        { rule: 'session-name', path: '$.probes[0].data.note' },
        { rule: 'email-address', path: '$.probes[0].data.note' },
        { rule: 'twelve-digit-number', path: '${key}' },
        { rule: 'sandbox-account-id', path: '${key}' },
      ]),
    );
    expect(JSON.stringify(findings)).not.toContain(SANDBOX);
    expect(JSON.stringify(findings)).not.toContain(SESSION);
    expect(scanText('clean text <sandbox-account>', { account: SANDBOX })).toEqual([]);
  });

  it('a short session name is only matched as a whole token', () => {
    expect(leakRulesIn('user ops logged in', { sessionName: 'ops' })).toEqual(['session-name']);
    expect(leakRulesIn('devops pipeline', { sessionName: 'ops' })).toEqual([]);
  });

  it('blocks a crafted leaky payload: nothing is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aws-preflight-leak-'));
    for (const leak of [SANDBOX, 'x@example.com', ACCESS_KEY_ID, PEM_HEADER, 'SessionToken']) {
      const path = join(dir, `e-${Math.random().toString(16).slice(2)}.json`);
      const outcome = await writeEvidence(
        path,
        { probes: [{ data: { value: leak } }] },
        { account: SANDBOX },
      );
      expect(outcome.written, leak.slice(0, 4)).toBe(false);
      expect(existsSync(path)).toBe(false);
    }
  });
});

describe('evidence of a full run (fixtures full of sensitive values)', () => {
  it('passes the leak scanner and contains none of the raw identifiers', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses());
    const r = await runCli(
      liveArgs('discover', box, ['--kms-key', 'alias/starter-data']),
      fake.runner,
    );
    expect(r.code).toBe(EXIT.OK);
    const text = readFileSync(box.evidence, 'utf8');
    for (const raw of [
      SANDBOX,
      OTHER,
      MANAGEMENT,
      SESSION,
      'jane.doe',
      'example.com',
      'aws-root@',
      'platform@',
      '203.0.113.10',
      '10.20.1.5',
      '42.17',
      'lock-token-value',
      'external-id-value',
      'CC-1234',
      'acme-sandbox-alias',
      rid('vpc', 1),
      fakeUuid(7),
      PROFILE,
      ...Object.values(UNRELATED),
      'patient-records',
      'acme-payments-key',
      'FMManagedWebACL',
      'payments.acme',
      '"Description"',
      '"PolicyDocument"',
      '"AssumeRolePolicyDocument"',
      '"policyDocument"',
      '"Principal"',
      'This stack includes resources',
    ]) {
      expect(text, raw).not.toContain(raw);
    }
    expect(scanText(text, { account: SANDBOX, sessionName: SESSION })).toEqual([]);
    expect(text).toMatch(/<sandbox-account>/);
    // Public AWS identifiers stay.
    expect(text).toContain('apse1-az1');
    expect(text).toContain('pl-31a34658');
    expect(text).toContain('arn:aws:iam::aws:policy/AdministratorAccess'); // CDK bootstrap execution policy
    expect(text).toContain('L-0263D0A3');
    // Project and AWS names stay readable.
    for (const kept of [
      'CDKToolkit',
      'starter-dev-network',
      'alias/aws/s3',
      'alias/starter-data',
    ]) {
      expect(text, kept).toContain(kept);
    }
    expect(text).toContain('"fmsManaged": true');
    // Console output never prints raw values either.
    const console = [...r.out, ...r.err].join('\n');
    for (const raw of [SANDBOX, SESSION, OTHER, MANAGEMENT])
      expect(console, raw).not.toContain(raw);
  });
});
