import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATIONS_BY_KEY } from '../src/aws/allowlist.js';
import { createAwsCli } from '../src/aws/executor.js';
import { GuardRefused, GuardSession } from '../src/aws/guard.js';
import { GuardedSession } from '../src/aws/session.js';
import { EXIT } from '../src/cli.js';
import { loadPriceBook } from '../src/model/prices.js';
import { renderVerify } from '../src/render.js';
import { verifyReportSchema, type VerifyReport } from '../src/schemas.js';
import { arnKey, verifyClean } from '../src/verify.js';
import {
  ACCOUNT,
  arn,
  awsArgs,
  awsError,
  fakeAws,
  fakeGuard,
  ok,
  RUN_ID,
  runCli,
  runTags,
  workspace,
  type Responder,
} from './support.js';

// Assembled at runtime so that secret scanners never see a key-shaped literal.
const FAKE_KEY_ID = ['AKIA', '0'.repeat(16)].join('');
const KEY_PENDING = '00000000-0000-4000-8000-000000000001';
const KEY_ENABLED_OTHER = '00000000-0000-4000-8000-000000000002';
const KEY_AWS = '00000000-0000-4000-8000-000000000003';

/** An account after a successful teardown: only pending-deletion residue and unrelated resources. */
function cleanAccount(): Record<string, Responder> {
  return {
    'resourcegroupstaggingapi get-resources': ok({
      ResourceTagMappingList: [{ ResourceARN: arn('kms', `key/${KEY_PENDING}`), Tags: runTags() }],
    }),
    'cloudformation describe-stacks': ok({
      Stacks: [
        {
          StackName: 'acme-payments-prod',
          StackId: arn('cloudformation', 'stack/acme-payments-prod/1'),
          StackStatus: 'CREATE_COMPLETE',
          Tags: [],
        },
      ],
    }),
    'ec2 describe-vpcs': ok({
      Vpcs: [{ VpcId: 'vpc-00000000000000001', IsDefault: true, OwnerId: ACCOUNT }],
    }),
    'ec2 describe-nat-gateways': ok({
      NatGateways: [
        // Deleted NAT gateways stay listed for about an hour: gone, not remaining.
        {
          NatGatewayId: 'nat-00000000000000001',
          State: 'deleted',
          VpcId: 'vpc-00000000000000009',
          Tags: runTags(),
        },
      ],
    }),
    'kms list-aliases': ok({ Aliases: [{ AliasName: 'alias/aws/s3', TargetKeyId: KEY_AWS }] }),
    'kms list-keys': ok({
      Keys: [{ KeyId: KEY_PENDING }, { KeyId: KEY_ENABLED_OTHER }, { KeyId: KEY_AWS }],
    }),
    'kms describe-key': (args) => {
      const id = args[args.indexOf('--key-id') + 1];
      if (id === KEY_PENDING) {
        return ok({
          KeyMetadata: {
            KeyId: KEY_PENDING,
            Arn: arn('kms', `key/${KEY_PENDING}`),
            KeyManager: 'CUSTOMER',
            KeyState: 'PendingDeletion',
            DeletionDate: '2026-10-27T12:00:00Z',
            CreationDate: '2026-10-20T08:00:00Z',
            Description: 'starter-sbx sandbox CMK for data at rest',
          },
        });
      }
      if (id === KEY_ENABLED_OTHER) {
        return ok({
          KeyMetadata: {
            KeyId: id,
            KeyManager: 'CUSTOMER',
            KeyState: 'Enabled',
            Description: 'acme payments key',
          },
        });
      }
      return ok({ KeyMetadata: { KeyId: id, KeyManager: 'AWS', KeyState: 'Enabled' } });
    },
    'kms list-resource-tags': (args) =>
      args.includes(KEY_PENDING)
        ? ok({ Tags: [{ TagKey: 'starter:run-id', TagValue: RUN_ID }], Truncated: false })
        : ok({ Tags: [], Truncated: false }),
    'secretsmanager list-secrets': ok({
      SecretList: [
        {
          ARN: arn('secretsmanager', 'secret:starter-sbx/rds/master-AbCdEf'),
          Name: 'starter-sbx/rds/master',
          CreatedDate: '2026-10-20T08:10:00Z',
          DeletedDate: '2026-10-20T11:00:00Z',
          Tags: runTags(),
        },
      ],
    }),
    'dynamodb list-tables': ok({ TableNames: ['acme-records'] }),
    'dynamodb list-backups': ok({
      BackupSummaries: [
        {
          TableName: 'starter-sbx-job-state',
          BackupArn: arn('dynamodb', 'table/starter-sbx-job-state/backup/01700000000000-abcdef12'),
          BackupName: 'starter-sbx-job-state$DeletedTableBackup',
          BackupType: 'SYSTEM',
          BackupStatus: 'AVAILABLE',
          BackupCreationDateTime: '2026-10-20T11:30:00Z',
        },
      ],
    }),
    's3api list-buckets': ok({
      Buckets: [{ Name: 'acme-records-archive', CreationDate: '2025-01-01T00:00:00Z' }],
    }),
    'cloudfront list-distributions': ok({
      DistributionList: { Items: [], IsTruncated: false, Marker: '' },
    }),
  };
}

/** The same account with a forgotten NAT gateway, its EIP, the RDS instance and a failed stack. */
function leakyAccount(): Record<string, Responder> {
  return {
    ...cleanAccount(),
    'cloudformation describe-stacks': ok({
      Stacks: [
        {
          StackName: 'Sandbox-Foundation',
          StackId: arn('cloudformation', 'stack/Sandbox-Foundation/1'),
          StackStatus: 'DELETE_FAILED',
          CreationTime: '2026-10-20T08:00:00Z',
          Tags: runTags(),
        },
      ],
    }),
    'ec2 describe-vpcs': ok({
      Vpcs: [
        {
          VpcId: 'vpc-00000000000000009',
          OwnerId: ACCOUNT,
          State: 'available',
          Tags: [{ Key: 'Name', Value: 'Sandbox/Foundation/Vpc' }, ...runTags()],
        },
      ],
    }),
    'ec2 describe-nat-gateways': ok({
      NatGateways: [
        {
          NatGatewayId: 'nat-00000000000000002',
          State: 'available',
          VpcId: 'vpc-00000000000000009',
          CreateTime: '2026-10-20T08:05:00Z',
          NatGatewayAddresses: [{ AllocationId: 'eipalloc-00000000000000001' }],
          Tags: [],
        },
      ],
    }),
    'ec2 describe-addresses': ok({
      Addresses: [
        {
          AllocationId: 'eipalloc-00000000000000001',
          PublicIp: '203.0.113.10',
          AssociationId: 'eipassoc-1',
        },
      ],
    }),
    'rds describe-db-instances': ok({
      DBInstances: [
        {
          DBInstanceIdentifier: 'starter-sbx-postgres',
          DBInstanceArn: arn('rds', 'db:starter-sbx-postgres'),
          DBInstanceClass: 'db.t4g.micro',
          DBInstanceStatus: 'available',
          AllocatedStorage: 20,
          StorageType: 'gp3',
          MultiAZ: false,
          InstanceCreateTime: '2026-10-20T08:20:00Z',
          TagList: runTags(),
          MasterUsername: 'never-read',
          Endpoint: { Address: 'db.internal.example' },
        },
      ],
    }),
  };
}

async function verify(
  responses: Record<string, Responder>,
  extra: string[] = [],
  guardMode: Parameters<typeof fakeGuard>[0] = 'ok',
) {
  const ws = workspace();
  const aws = fakeAws(responses);
  const guard = fakeGuard(guardMode);
  const outFile = join(ws.dir, 'out', 'verify-clean.json');
  const r = await runCli(
    ['verify-clean', '--run-id', RUN_ID, '--out', outFile, ...awsArgs(ws), ...extra],
    { aws, guard, cwd: ws.dir },
  );
  const text = readFileSync(outFile, 'utf8');
  const report = verifyReportSchema.parse(JSON.parse(text)) as VerifyReport;
  return { ...r, ws, aws, guard, report, text };
}

describe('verify-clean', () => {
  it('is clean with only pending-deletion residue, and reports dates and residual cost', async () => {
    const { code, report, aws, guard } = await verify(cleanAccount());
    expect(code).toBe(EXIT.OK);
    expect(report.status).toBe('clean');
    const pending = report.findings.filter((f) => f.class === 'pending-deletion');
    expect(pending.map((f) => f.resourceType).sort()).toEqual([
      'AWS::DynamoDB::Backup',
      'AWS::KMS::Key',
      'AWS::SecretsManager::Secret',
    ]);
    const key = pending.find((f) => f.resourceType === 'AWS::KMS::Key');
    expect(key?.deletionDate).toBe('2026-10-27T12:00:00.000Z');
    expect(key?.residualLikelyUsd).toBe(0);
    // Worst case prices the key until its deletion date (7 days x 24 h / 730 h per month).
    expect(key?.residualWorstUsd).toBeCloseTo((7 * 24) / 730, 5);
    expect(key?.note).toMatch(/no charge for customer managed KMS keys/);
    // The latest date: the DynamoDB system backup (created + 35 days); the secret's is
    // DeletedDate + the 30-day maximum recovery window.
    expect(
      pending.find((f) => f.resourceType === 'AWS::SecretsManager::Secret')?.deletionDate,
    ).toBe('2026-11-19T11:00:00.000Z');
    expect(report.summary.pendingDeletionUntil).toBe('2026-11-24T11:30:00.000Z');
    // The unrelated enabled key and the AWS managed key are not findings at all.
    expect(report.findings.some((f) => f.id === KEY_ENABLED_OTHER)).toBe(false);
    // The deleted NAT gateway is gone, not remaining.
    expect(report.findings.some((f) => f.id === 'nat-00000000000000001')).toBe(false);
    expect(report.findings.some((f) => f.id === 'acme-records-archive')).toBe(false);
    expect(guard.calls.length).toBeGreaterThanOrEqual(1);
    expect(aws.calls.length).toBeGreaterThan(40);
  });

  it('fails (exit 1) when experiment resources remain, and prices what they cost per hour', async () => {
    const { code, report, out } = await verify(leakyAccount());
    expect(code).toBe(EXIT.NOT_CLEAN);
    expect(report.status).toBe('not-clean');
    const remaining = report.findings
      .filter((f) => f.class === 'remaining')
      .map((f) => f.resourceType);
    expect(remaining).toEqual(
      expect.arrayContaining([
        'AWS::CloudFormation::Stack',
        'AWS::EC2::VPC',
        'AWS::EC2::NatGateway',
        'AWS::EC2::EIP',
        'AWS::RDS::DBInstance',
      ]),
    );
    const nat = report.findings.find((f) => f.resourceType === 'AWS::EC2::NatGateway');
    expect(nat?.match).toContain('in-experiment-vpc');
    expect(report.findings.find((f) => f.resourceType === 'AWS::EC2::EIP')?.match).toContain(
      'in-experiment-vpc',
    );
    expect(
      report.findings.find((f) => f.resourceType === 'AWS::CloudFormation::Stack')?.note,
    ).toMatch(/DELETE_FAILED/);
    // NAT 0.059 + EIP 0.005 + RDS 0.025 + 20 GiB gp3 (20 x 0.138 / 730).
    expect(report.summary.remainingUsdPerHour).toBeCloseTo(
      0.059 + 0.005 + 0.025 + (20 * 0.138) / 730,
      5,
    );
    expect(out).toMatch(/remaining\s+AWS::EC2::NatGateway nat-00000000000000002/);
  });

  it('renders the verification as Markdown', async () => {
    const { report } = await verify(leakyAccount());
    const md = renderVerify(report);
    expect(md).toMatch(/\*\*NOT-CLEAN\*\*/);
    expect(md).toMatch(/\| remaining \| AWS::EC2::NatGateway \| nat-00000000000000002 \|/);
    expect(md).toMatch(/it deletes nothing/);
    expect(md).not.toContain(ACCOUNT);
  });

  it('never runs anything but allowlisted read-only operations, with the fixed global options', async () => {
    const { aws } = await verify(leakyAccount());
    for (const c of aws.calls) {
      const def = OPERATIONS_BY_KEY.get(`${c.args[0]} ${c.args[1]}`);
      expect(def, `${c.args[0]} ${c.args[1]}`).toBeDefined();
      expect(c.args[1]).toMatch(/^(list|describe|get)-/);
      expect(c.args).toEqual(
        expect.arrayContaining([
          '--profile',
          'starter-sandbox-developer',
          '--region',
          'ap-southeast-1',
          '--output',
          'json',
        ]),
      );
      expect(c.args).not.toContain('--endpoint-url');
      expect(c.args).not.toContain('--query');
      expect(
        Object.keys(c.env).filter((k) =>
          /^AWS_(ACCESS|SECRET|SESSION|PROFILE|DEFAULT_PROFILE)/.test(k),
        ),
      ).toEqual([]);
    }
    expect(
      aws
        .ops()
        .some((o) => /\b(delete|put|create|update|remove|terminate|schedule|cancel)-/.test(o)),
    ).toBe(false);
    expect(aws.ops()).not.toContain('ce get-cost-and-usage');
  });

  it('masks the account id everywhere and keeps no operator IP or secret material', async () => {
    const { text } = await verify(leakyAccount());
    expect(text).not.toContain(ACCOUNT);
    expect(text).toContain('********3333');
    expect(text).not.toContain('203.0.113.10');
    expect(text).not.toContain('never-read');
    expect(text).not.toContain('db.internal.example');
  });

  it('fails by default on billed retained residue (final RDS snapshot); --lenient is the explicit opt-out', async () => {
    const responses = {
      ...cleanAccount(),
      'rds describe-db-snapshots': ok({
        DBSnapshots: [
          {
            DBSnapshotIdentifier: 'sandbox-data-databaseinstanceaa8a5fde-snapshot-1a2b3c',
            DBInstanceIdentifier: 'starter-sbx-postgres',
            SnapshotType: 'manual',
            Status: 'available',
            AllocatedStorage: 20,
            SnapshotCreateTime: '2026-10-20T11:40:00Z',
          },
        ],
      }),
    };
    const strictByDefault = await verify(responses);
    expect(strictByDefault.code).toBe(EXIT.NOT_CLEAN);
    expect(strictByDefault.report.strict).toBe(true);
    const snap = strictByDefault.report.findings.find(
      (f) => f.resourceType === 'AWS::RDS::DBSnapshot',
    );
    expect(snap?.class).toBe('retained-by-design');
    expect(snap?.residualWorstUsd).toBeCloseTo(20 * 0.095, 5);
    expect(strictByDefault.report.statusReason).toMatch(/1 retained-by-design \(strict\)/);
    // --strict is still accepted (a no-op).
    expect((await verify(responses, ['--strict'])).code).toBe(EXIT.NOT_CLEAN);
    const lenient = await verify(responses, ['--lenient']);
    expect(lenient.code).toBe(EXIT.OK);
    expect(lenient.report.strict).toBe(false);
    expect(lenient.report.statusReason).toMatch(/retained-by-design flagged/);
    const ws = workspace();
    const both = await runCli(
      [
        'verify-clean',
        '--run-id',
        RUN_ID,
        '--out',
        join(ws.dir, 'x.json'),
        '--strict',
        '--lenient',
      ],
      { cwd: ws.dir },
    );
    expect(both.code).toBe(EXIT.USAGE);
  });

  it('reports the CDK toolkit separately, and counts it with --include-bootstrap', async () => {
    const responses = {
      ...cleanAccount(),
      'cloudformation describe-stacks': ok({
        Stacks: [
          {
            StackName: 'starter-cdk-toolkit',
            StackId: arn('cloudformation', 'stack/starter-cdk-toolkit/1'),
            StackStatus: 'CREATE_COMPLETE',
            Tags: runTags(),
          },
        ],
      }),
      's3api list-buckets': ok({
        Buckets: [{ Name: `cdk-starter-assets-${ACCOUNT}-ap-southeast-1` }],
      }),
    };
    const separate = await verify(responses);
    expect(separate.code).toBe(EXIT.OK);
    expect(separate.report.bootstrap.map((f) => f.resourceType).sort()).toEqual([
      'AWS::CloudFormation::Stack',
      'AWS::S3::Bucket',
    ]);
    expect(separate.report.bootstrap.find((f) => f.resourceType === 'AWS::S3::Bucket')?.id).toBe(
      'cdk-starter-assets-********3333-ap-southeast-1',
    );
    const included = await verify(responses, ['--include-bootstrap']);
    expect(included.code).toBe(EXIT.NOT_CLEAN);
    expect(included.report.findings.filter((f) => f.scope === 'bootstrap')).toHaveLength(2);
  });

  it('treats weak name matches from the baseline or before --since as not-owned (never deleted, never failing)', async () => {
    const ws = workspace();
    // A pre-existing bucket whose name happens to start with "sandbox-": a weak match only.
    const weak = {
      ...cleanAccount(),
      's3api list-buckets': ok({
        Buckets: [{ Name: 'sandbox-team-notes', CreationDate: '2025-01-01T00:00:00Z' }],
      }),
    };
    const without = await verify(weak);
    expect(without.code).toBe(EXIT.NOT_CLEAN);
    expect(without.report.findings.find((f) => f.id === 'sandbox-team-notes')?.match).toEqual([
      'name:Sandbox-',
      'weak:name-only',
    ]);
    const baselineFile = join(ws.dir, 'baseline.json');
    writeFileSync(baselineFile, JSON.stringify({ ids: ['sandbox-team-notes'] }));
    const withBaseline = await verify(weak, ['--baseline', baselineFile]);
    expect(withBaseline.code).toBe(EXIT.OK);
    expect(withBaseline.report.findings.find((f) => f.id === 'sandbox-team-notes')?.class).toBe(
      'not-owned',
    );
    expect(withBaseline.report.summary.notOwned).toBe(1);
    const withSince = await verify(weak, ['--since', '2026-10-19T00:00:00Z']);
    expect(withSince.report.findings.find((f) => f.id === 'sandbox-team-notes')?.class).toBe(
      'not-owned',
    );
    // A strongly tagged resource is never downgraded by the baseline.
    writeFileSync(baselineFile, JSON.stringify(['nat-00000000000000002']));
    const leaky = await verify(leakyAccount(), ['--baseline', baselineFile]);
    expect(leaky.report.findings.find((f) => f.id === 'nat-00000000000000002')?.class).toBe(
      'remaining',
    );
  });

  it('marks experiment-tagged resources of another run as remaining', async () => {
    const responses = {
      ...cleanAccount(),
      'sns list-topics': ok({ Topics: [{ TopicArn: arn('sns', 'starter-sbx-alarms') }] }),
      'resourcegroupstaggingapi get-resources': ok({
        ResourceTagMappingList: [
          { ResourceARN: arn('sns', 'starter-sbx-alarms'), Tags: runTags('sbx-ffffff') },
        ],
      }),
    };
    const { code, report } = await verify(responses);
    expect(code).toBe(EXIT.NOT_CLEAN);
    expect(report.findings.find((f) => f.resourceType === 'AWS::SNS::Topic')?.match).toContain(
      'other-run:sbx-ffffff',
    );
  });

  it('is incomplete (exit 4) when a sweep is denied: no clean verdict without full coverage', async () => {
    const { code, report } = await verify({
      ...cleanAccount(),
      'rds describe-db-instances': awsError(
        'AccessDenied',
        `User arn:aws:iam::${ACCOUNT}:user/x is not authorized`,
      ),
    });
    expect(code).toBe(EXIT.INCOMPLETE);
    expect(report.status).toBe('incomplete');
    const rds = report.coverage.find((c) => c.service === 'rds');
    expect(rds?.status).toBe('error');
    expect(rds?.errors[0]?.kind).toBe('access-denied');
    expect(rds?.errors[0]?.message).not.toContain(ACCOUNT);
  });

  it('is incomplete when the tag index lists a tagged resource type that is not swept', async () => {
    const responses = {
      ...cleanAccount(),
      'resourcegroupstaggingapi get-resources': ok({
        ResourceTagMappingList: [
          { ResourceARN: arn('sqs', 'starter-sbx-dlq'), Tags: runTags() },
          // Covered type missing from its listing: index lag, a warning only.
          { ResourceARN: arn('logs', 'log-group:/starter/starter-sbx/ecs/api:*'), Tags: runTags() },
        ],
      }),
    };
    const { code, report } = await verify(responses);
    expect(code).toBe(EXIT.INCOMPLETE);
    expect(report.tagIndexOnly.map((t) => [t.service, t.covered])).toEqual([
      ['sqs', false],
      ['logs', true],
    ]);
  });

  it('treats a truncated listing as incomplete', async () => {
    const { code, report } = await verify({
      ...cleanAccount(),
      'events list-rules': ok({ Rules: [], NextToken: 'more' }),
    });
    expect(code).toBe(EXIT.INCOMPLETE);
    expect(report.coverage.find((c) => c.service === 'events')?.errors[0]?.kind).toBe('truncated');
  });

  it('refuses (exit 3) without any AWS call when the guard refuses, and says it is not a clean verdict', async () => {
    const { code, report, aws, err } = await verify(cleanAccount(), [], 'refuse');
    expect(code).toBe(EXIT.REFUSED);
    expect(aws.calls).toHaveLength(0);
    expect(report.status).toBe('guard-refused');
    expect(report.guard.refusal).toMatch(/exit 12: ACCOUNT MISMATCH/);
    expect(report.notes.join(' ')).toMatch(/NOT a clean verdict/);
    expect(err).toMatch(/refused/);
  });

  it('refuses when the guard record does not match the request', async () => {
    for (const mode of ['wrong-region', 'unmasked'] as const) {
      const { code, aws, report } = await verify(cleanAccount(), [], mode);
      expect(code).toBe(EXIT.REFUSED);
      expect(aws.calls).toHaveLength(0);
      expect(report.guard.refusal).toBeTruthy();
    }
  });

  it('stops before the next AWS call when a guard re-verification is refused', async () => {
    const ws = workspace();
    const aws = fakeAws(cleanAccount());
    const guard = fakeGuard('refuse-after-first');
    const info = { path: ws.aws, realpath: ws.aws, sha256: '0'.repeat(64) };
    const cli = createAwsCli({
      info,
      profile: 'starter-sandbox-developer',
      region: 'ap-southeast-1',
      parentEnv: {},
      cwd: ws.dir,
      runner: aws.runner,
    });
    // maxAgeMs 0: every call needs a fresh verification; the second one is refused.
    const session = new GuardSession(
      {
        guardCli: ws.guard,
        profile: 'starter-sandbox-developer',
        region: 'ap-southeast-1',
        expectedAccountFile: ws.expected,
      },
      { runner: guard.runner, parentEnv: {}, cwd: ws.dir, maxAgeMs: -1 },
    );
    const guarded = new GuardedSession(cli, session, 'starter-aws-sandbox verify-clean test');
    await expect(
      verifyClean(guarded, loadPriceBook(), {
        runId: RUN_ID,
        region: 'ap-southeast-1',
        includeBootstrap: false,
        strict: false,
      }),
    ).rejects.toBeInstanceOf(GuardRefused);
    expect(guard.calls).toHaveLength(2);
    expect(aws.calls).toHaveLength(1);
  });

  it('refuses ambient credentials and CI before any process starts', async () => {
    const ws = workspace();
    for (const env of [
      { HOME: ws.dir, PATH: '/usr/bin', AWS_ACCESS_KEY_ID: FAKE_KEY_ID },
      { HOME: ws.dir, PATH: '/usr/bin', CI: 'true' },
      { HOME: ws.dir, PATH: '/usr/bin', AWS_PROFILE: 'default' },
    ]) {
      const aws = fakeAws(cleanAccount());
      const guard = fakeGuard();
      const r = await runCli(
        ['verify-clean', '--run-id', RUN_ID, '--out', join(ws.dir, 'x.json'), ...awsArgs(ws)],
        { aws, guard, env, cwd: ws.dir },
      );
      expect(r.code).toBe(EXIT.REFUSED);
      expect(guard.calls).toHaveLength(0);
      expect(aws.calls).toHaveLength(0);
      expect(r.err).not.toContain(FAKE_KEY_ID);
    }
  });

  it('rejects an invalid run id (usage error)', async () => {
    const ws = workspace();
    const r = await runCli(
      ['verify-clean', '--run-id', 'Bad_Id', '--out', join(ws.dir, 'x.json')],
      { cwd: ws.dir },
    );
    expect(r.code).toBe(EXIT.USAGE);
  });
});

describe('arnKey', () => {
  it('normalizes ARNs for the tag-index cross-check', () => {
    expect(arnKey(arn('logs', 'log-group:/starter/x/y:*'))).toBe('logs:/starter/x/y');
    expect(arnKey(arn('ecs', 'task-definition/starter-sbx-api:3'))).toBe('ecs:starter-sbx-api');
    expect(arnKey(arn('ec2', 'natgateway/nat-1'))).toBe('ec2:nat-1');
    expect(arnKey('arn:aws:s3:::bucket-a')).toBe('s3:bucket-a');
  });
});
