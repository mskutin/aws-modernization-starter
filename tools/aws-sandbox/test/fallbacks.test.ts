/**
 * verify-clean with a typical sandbox Developer permission set:
 * kms list-keys / list-resource-tags,
 * secretsmanager list-secrets, ssm describe-parameters and scheduler list-schedules are denied.
 * The fallbacks must never turn a category that could not be listed into a clean verdict.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_VERSION_PARAMETER, OPERATIONS_BY_KEY } from '../src/aws/allowlist.js';
import {
  assertArgsAllowed,
  assertArgvSafe,
  BoundaryViolation,
  buildArgv,
} from '../src/aws/executor.js';
import { EXIT } from '../src/cli.js';
import { renderVerify } from '../src/render.js';
import { verifyReportSchema, type VerifyReport } from '../src/schemas.js';
import { SCHEDULER_JUSTIFICATION } from '../src/sweep/compute.js';
import {
  ACCOUNT,
  arn,
  awsArgs,
  awsError,
  fakeAws,
  fakeGuard,
  inventoryFixture,
  ok,
  RUN_ID,
  runCli,
  runTags,
  stackArn,
  workspace,
  type Responder,
} from './support.js';

const KEY_A = '00000000-0000-4000-8000-00000000000a';
const KEY_B = '00000000-0000-4000-8000-00000000000b';
const KEY_C = '00000000-0000-4000-8000-00000000000c';
const SESSION_ERROR = (op: string, action: string) =>
  awsError(
    'AccessDeniedException',
    `User: arn:aws:sts::${ACCOUNT}:assumed-role/AWSReservedSSO_acme-aws@Developer-0a1b2c3_0123456789abcdef/jane.doe@example.com is not authorized to perform: ${action} on resource: * because no identity-based policy allows the ${action} action (${op})`,
  );

/** A typical sandbox permission set: these four are denied, the rest is readable. */
function developerRole(extra: Record<string, Responder> = {}): Record<string, Responder> {
  return {
    'kms list-keys': SESSION_ERROR('ListKeys', 'kms:ListKeys'),
    'kms list-resource-tags': SESSION_ERROR('ListResourceTags', 'kms:ListResourceTags'),
    'secretsmanager list-secrets': SESSION_ERROR('ListSecrets', 'secretsmanager:ListSecrets'),
    'ssm describe-parameters': SESSION_ERROR('DescribeParameters', 'ssm:DescribeParameters'),
    'scheduler list-schedules': SESSION_ERROR('ListSchedules', 'scheduler:ListSchedules'),
    'ssm get-parameters': ok({ Parameters: [], InvalidParameters: [BOOTSTRAP_VERSION_PARAMETER] }),
    'cloudfront list-distributions': ok({ DistributionList: { Items: [], IsTruncated: false } }),
    ...extra,
  };
}

const describeKey =
  (states: Record<string, { state: string; deletion?: string }>): Responder =>
  (args) => {
    const id = args[args.indexOf('--key-id') + 1] ?? '';
    const s = states[id];
    if (!s) return awsError('NotFoundException', `Key '${id}' does not exist`);
    return ok({
      KeyMetadata: {
        KeyId: id,
        Arn: arn('kms', `key/${id}`),
        KeyManager: 'CUSTOMER',
        KeyState: s.state,
        ...(s.deletion ? { DeletionDate: s.deletion } : {}),
        CreationDate: '2026-10-20T08:01:00Z',
        Description: 'starter-sbx sandbox CMK',
      },
    });
  };

async function verify(
  responses: Record<string, Responder>,
  extra: string[] = [],
  inventory?: ReturnType<typeof inventoryFixture>,
) {
  const ws = workspace();
  const aws = fakeAws(responses);
  const guard = fakeGuard();
  const args = [
    'verify-clean',
    '--run-id',
    RUN_ID,
    '--out',
    join(ws.dir, 'v.json'),
    ...awsArgs(ws),
    ...extra,
  ];
  if (inventory) {
    writeFileSync(join(ws.dir, 'inventory.json'), JSON.stringify(inventory));
    args.push('--inventory', join(ws.dir, 'inventory.json'));
  }
  const r = await runCli(args, { aws, guard, cwd: ws.dir });
  const text = readFileSync(join(ws.dir, 'v.json'), 'utf8');
  return { ...r, aws, text, report: verifyReportSchema.parse(JSON.parse(text)) as VerifyReport };
}

const category = (r: VerifyReport, name: string) => r.coverage.find((c) => c.service === name);

describe('verify-clean with the sandbox Developer role', () => {
  it('a typical sandbox account: exit 5 clean-with-unverifiable naming KMS and Secrets Manager, never 0', async () => {
    const { code, report, aws, out } = await verify(developerRole());
    expect(code).toBe(EXIT.CLEAN_WITH_UNVERIFIABLE);
    expect(report.status).toBe('clean-with-unverifiable');
    expect(report.summary.unverifiable.map((u) => [u.category, u.status])).toEqual([
      ['kms', 'fallback'],
      ['secretsmanager', 'unverifiable-with-this-role'],
    ]);
    expect(report.statusReason).toMatch(
      /not provable with this role for: kms \(fallback\), secretsmanager/,
    );
    expect(category(report, 'kms')?.denied).toEqual(['kms list-keys']);
    expect(category(report, 'ssm')?.status).toBe('ok');
    expect(category(report, 'scheduler')).toMatchObject({
      status: 'not-used-by-experiment',
      operations: [],
    });
    expect(category(report, 'scheduler')?.justification).toBe(SCHEDULER_JUSTIFICATION);
    // The replaced operations are never called.
    expect(aws.ops()).not.toContain('scheduler list-schedules');
    expect(aws.ops()).not.toContain('ssm describe-parameters');
    expect(aws.ops()).toContain('ssm get-parameters');
    expect(report.coverage.every((c) => c.errors.length === 0)).toBe(true);
    expect(out).toMatch(/fallback\s+kms: kms list-keys: AccessDeniedException/);
  });

  it('redacts the caller session (e-mail) and account from AWS error text', async () => {
    const { text } = await verify(developerRole());
    expect(text).not.toContain('jane.doe');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain(ACCOUNT);
    expect(text).toContain('kms list-keys: AccessDeniedException');
  });

  describe('KMS fallback (list-keys denied)', () => {
    const responses = () =>
      developerRole({
        'resourcegroupstaggingapi get-resources': ok({
          ResourceTagMappingList: [{ ResourceARN: arn('kms', `key/${KEY_A}`), Tags: runTags() }],
        }),
        'kms list-aliases': ok({
          Aliases: [{ AliasName: 'alias/starter-sbx/logs', TargetKeyId: KEY_C }],
        }),
        'kms describe-key': describeKey({
          [KEY_A]: { state: 'PendingDeletion', deletion: '2026-10-27T12:00:00Z' },
          [KEY_B]: { state: 'Enabled' },
        }),
      });

    it('finds keys through the tag index, the inventory and aliases, and classifies each described key', async () => {
      const inv = inventoryFixture([
        {
          name: 'Sandbox-Foundation',
          resources: [{ logicalId: 'LogsKey', type: 'AWS::KMS::Key', physicalId: KEY_B }],
        },
      ]);
      const { code, report } = await verify(responses(), [], inv);
      expect(code).toBe(EXIT.NOT_CLEAN);
      const a = report.findings.find((f) => f.id === KEY_A);
      const b = report.findings.find((f) => f.id === KEY_B);
      expect(a).toMatchObject({
        class: 'pending-deletion',
        deletionDate: '2026-10-27T12:00:00.000Z',
      });
      expect(a?.match).toContain('tag:starter:run-id');
      expect(b).toMatchObject({ class: 'remaining', state: 'Enabled' });
      expect(b?.match).toContain('inventory');
      const kms = category(report, 'kms');
      expect(kms?.status).toBe('fallback');
      expect(kms?.denied).toEqual(['kms list-keys', 'kms list-resource-tags']);
      expect(kms?.evidence.join('\n')).toMatch(
        /3 key\(s\) found through the tag index \(1\), the inventory \(1\), experiment aliases \(1\)/,
      );
      expect(kms?.evidence.join('\n')).toContain(`key ${KEY_C}: not found (deleted)`);
      expect(kms?.evidence.join('\n')).toMatch(
        /list-resource-tags: AccessDeniedException — key tags are taken from the tag index only/,
      );
      expect(kms?.errors).toEqual([]);
    });

    it('stays exit 5 when every found key is pending deletion: a fallback is not exhaustive', async () => {
      const r = responses();
      r['kms list-aliases'] = ok({ Aliases: [] }); // deleted with the stack
      r['kms describe-key'] = describeKey({
        [KEY_A]: { state: 'PendingDeletion', deletion: '2026-10-27T12:00:00Z' },
      });
      const { code, report } = await verify(r);
      expect(code).toBe(EXIT.CLEAN_WITH_UNVERIFIABLE);
      expect(report.summary.pendingDeletion).toBe(1);
      expect(report.summary.unverifiable.find((u) => u.category === 'kms')?.evidence[0]).toMatch(
        /cannot be found with this role/,
      );
    });

    it('is incomplete when describe-key itself is denied', async () => {
      const r = responses();
      r['kms list-aliases'] = ok({ Aliases: [] });
      r['kms describe-key'] = SESSION_ERROR('DescribeKey', 'kms:DescribeKey');
      const { code, report } = await verify(r);
      expect(code).toBe(EXIT.INCOMPLETE);
      expect(category(report, 'kms')?.status).toBe('error');
    });

    it('with list-keys allowed but list-resource-tags denied, the category stays exhaustive (ok)', async () => {
      const r = responses();
      r['kms list-aliases'] = ok({ Aliases: [] });
      r['kms list-keys'] = ok({ Keys: [{ KeyId: KEY_A }] });
      r['kms describe-key'] = describeKey({
        [KEY_A]: { state: 'PendingDeletion', deletion: '2026-10-27T12:00:00Z' },
      });
      r['secretsmanager list-secrets'] = ok({ SecretList: [] });
      const { code, report } = await verify(r);
      expect(code).toBe(EXIT.OK);
      expect(category(report, 'kms')).toMatchObject({
        status: 'ok',
        denied: ['kms list-resource-tags'],
      });
    });
  });

  describe('Secrets Manager without any read', () => {
    const secretArn = arn('secretsmanager', 'secret:starter-sbx/rds/master-AbCdEf');
    const inventory = () =>
      inventoryFixture([
        {
          name: 'Sandbox-Data',
          resources: [
            {
              logicalId: 'MasterSecret',
              type: 'AWS::SecretsManager::Secret',
              physicalId: secretArn,
            },
            {
              logicalId: 'DbLogs',
              type: 'AWS::Logs::LogGroup',
              physicalId: '/aws/rds/instance/starter-sbx-postgres/postgresql',
            },
          ],
        },
      ]);
    const deleted = (status: string) =>
      developerRole({
        'cloudformation list-stacks': ok({
          StackSummaries: [
            {
              StackName: 'Sandbox-Data',
              StackId: stackArn('Sandbox-Data'),
              StackStatus: 'DELETE_COMPLETE',
              DeletionTime: '2026-10-20T14:00:00Z',
            },
            {
              StackName: 'Sandbox-Data',
              StackId: arn('cloudformation', 'stack/Sandbox-Data/older'),
              StackStatus: 'DELETE_COMPLETE',
            },
          ],
        }),
        'cloudformation list-stack-resources': (args) => {
          expect(args[args.indexOf('--stack-name') + 1]).toBe(stackArn('Sandbox-Data'));
          return ok({
            StackResourceSummaries: [
              {
                LogicalResourceId: 'MasterSecret',
                ResourceType: 'AWS::SecretsManager::Secret',
                PhysicalResourceId: secretArn,
                ResourceStatus: status,
              },
              {
                LogicalResourceId: 'DbLogs',
                ResourceType: 'AWS::Logs::LogGroup',
                PhysicalResourceId: '/aws/rds/instance/starter-sbx-postgres/postgresql',
                ResourceStatus: 'DELETE_COMPLETE',
              },
            ],
          });
        },
      });

    it('reports the category unverifiable with the tag index, inventory and CloudFormation evidence (exit 5)', async () => {
      const { code, report } = await verify(deleted('DELETE_COMPLETE'), [], inventory());
      expect(code).toBe(EXIT.CLEAN_WITH_UNVERIFIABLE);
      const sm = report.summary.unverifiable.find((u) => u.category === 'secretsmanager');
      expect(sm?.status).toBe('unverifiable-with-this-role');
      const evidence = sm?.evidence.join('\n') ?? '';
      expect(evidence).toMatch(
        /no Secrets Manager read; whether experiment secrets remain cannot be proven/,
      );
      expect(evidence).toMatch(/tag index: no secret tagged starter:run-id=sbx-a1b2c3/);
      expect(evidence).toContain(
        'inventory recorded 1 secret(s): Sandbox-Data/MasterSecret arn:aws:secretsmanager:ap-southeast-1:********3333:secret:starter-sbx/rds/master-AbCdEf',
      );
      expect(evidence).toContain(
        'CloudFormation final status: Sandbox-Data/MasterSecret DELETE_COMPLETE',
      );
      expect(report.deletionEvidence?.stacks).toEqual([
        { name: 'Sandbox-Data', status: 'DELETE_COMPLETE', deletedAt: '2026-10-20T14:00:00.000Z' },
      ]);
      expect(report.findings.filter((f) => f.class === 'remaining')).toEqual([]);
      const md = renderVerify(report);
      expect(md).toMatch(/### secretsmanager — unverifiable-with-this-role/);
      expect(md).toMatch(/\*\*CLEAN-WITH-UNVERIFIABLE\*\*/);
    });

    it('treats a secret CloudFormation did not delete as remaining (fail-safe, exit 1)', async () => {
      const { code, report } = await verify(deleted('DELETE_SKIPPED'), [], inventory());
      expect(code).toBe(EXIT.NOT_CLEAN);
      const f = report.findings.find((x) => x.resourceType === 'AWS::SecretsManager::Secret');
      expect(f).toMatchObject({ class: 'remaining', state: 'CloudFormation DELETE_SKIPPED' });
      expect(f?.match).toContain('inventory');
    });

    it('accounts for tagged secrets in the evidence instead of the tag-index warnings', async () => {
      const tagged = arn('secretsmanager', 'secret:starter-sbx/rds/master-AbCdEf');
      const { code, report } = await verify(
        developerRole({
          'resourcegroupstaggingapi get-resources': ok({
            ResourceTagMappingList: [{ ResourceARN: tagged, Tags: runTags() }],
          }),
        }),
      );
      expect(code).toBe(EXIT.CLEAN_WITH_UNVERIFIABLE);
      expect(report.tagIndexOnly).toEqual([]);
      expect(category(report, 'secretsmanager')?.evidence.join('\n')).toMatch(
        /tag index lists 1 secret\(s\).*\*{8}3333/,
      );
    });

    it('reports a failed list-stacks as missing evidence, not as a failed sweep', async () => {
      const { code, report } = await verify(
        { ...deleted('DELETE_COMPLETE'), 'cloudformation list-stacks': awsError('AccessDenied') },
        [],
        inventory(),
      );
      expect(code).toBe(EXIT.CLEAN_WITH_UNVERIFIABLE);
      expect(report.deletionEvidence).toMatchObject({ available: false });
      expect(category(report, 'secretsmanager')?.evidence.join('\n')).toMatch(
        /list-stacks failed \(AccessDenied\)/,
      );
    });
  });

  describe('SSM bootstrap parameter through the pinned get-parameters', () => {
    it('reports the parameter by name without its value; counted only with --include-bootstrap', async () => {
      const responses = developerRole({
        'ssm get-parameters': ok({
          Parameters: [
            {
              Name: BOOTSTRAP_VERSION_PARAMETER,
              Type: 'String',
              Value: 'VALUE-MUST-NOT-APPEAR',
              Version: 3,
              LastModifiedDate: '2026-10-19T00:00:00Z',
            },
          ],
          InvalidParameters: [],
        }),
      });
      const separate = await verify(responses);
      expect(separate.code).toBe(EXIT.CLEAN_WITH_UNVERIFIABLE);
      expect(separate.report.bootstrap.map((f) => f.id)).toEqual([BOOTSTRAP_VERSION_PARAMETER]);
      expect(separate.report.bootstrap[0]?.note).toMatch(/version 3/);
      expect(separate.text).not.toContain('VALUE-MUST-NOT-APPEAR');
      const included = await verify(responses, ['--include-bootstrap']);
      expect(included.code).toBe(EXIT.NOT_CLEAN);
      const call = included.aws.calls.find((c) => c.args[1] === 'get-parameters');
      expect(call?.args.slice(0, 4)).toEqual([
        'ssm',
        'get-parameters',
        '--names',
        BOOTSTRAP_VERSION_PARAMETER,
      ]);
      expect(call?.args).not.toContain('--with-decryption');
    });

    it('refuses any other parameter name or option at both checks', () => {
      const def = OPERATIONS_BY_KEY.get('ssm get-parameters');
      if (!def) throw new Error('missing');
      expect(() => assertArgsAllowed(def, ['--names', '/starter-sbx/db/password'])).toThrow(
        BoundaryViolation,
      );
      expect(() =>
        assertArgsAllowed(def, ['--names', BOOTSTRAP_VERSION_PARAMETER, '/other']),
      ).toThrow(BoundaryViolation);
      expect(() =>
        assertArgsAllowed(def, ['--names', BOOTSTRAP_VERSION_PARAMETER, '--with-decryption']),
      ).toThrow(BoundaryViolation);
      const argv = buildArgv(def, ['--names', BOOTSTRAP_VERSION_PARAMETER], 'p', 'ap-southeast-1');
      expect(() => assertArgvSafe(argv, 'p', 'ap-southeast-1')).not.toThrow();
      const forged = ['ssm', 'get-parameters', '--names', '/x', ...argv.slice(4)];
      expect(() => assertArgvSafe(forged, 'p', 'ap-southeast-1')).toThrow(/pinned values/);
      expect(OPERATIONS_BY_KEY.has('ssm get-parameter')).toBe(false);
      expect(OPERATIONS_BY_KEY.has('ssm describe-parameters')).toBe(false);
      expect(OPERATIONS_BY_KEY.has('scheduler list-schedules')).toBe(false);
    });
  });

  it('a tagged EventBridge schedule (an unswept type) makes the run incomplete, not clean', async () => {
    const { code, report } = await verify(
      developerRole({
        'resourcegroupstaggingapi get-resources': ok({
          ResourceTagMappingList: [
            { ResourceARN: arn('scheduler', 'schedule/default/starter-sbx-x'), Tags: runTags() },
          ],
        }),
      }),
    );
    expect(code).toBe(EXIT.INCOMPLETE);
    expect(report.tagIndexOnly).toMatchObject([{ service: 'scheduler', covered: false }]);
  });

  describe('--inventory', () => {
    it('makes the run’s own resources strong matches and dates weak matches from the first stack', async () => {
      const inv = inventoryFixture(
        [
          {
            name: 'Sandbox-Frontend',
            resources: [
              { logicalId: 'WebBucket', type: 'AWS::S3::Bucket', physicalId: 'webbucket-0a1b2c3d' },
            ],
          },
        ],
        { startedAt: '2026-10-20T08:00:00.000Z' },
      );
      const { report } = await verify(
        developerRole({
          's3api list-buckets': ok({
            Buckets: [
              { Name: 'webbucket-0a1b2c3d', CreationDate: '2026-10-20T08:20:00Z' },
              { Name: 'sandbox-team-notes', CreationDate: '2025-01-01T00:00:00Z' },
            ],
          }),
        }),
        [],
        inv,
      );
      expect(report.inventory?.runId).toBe(RUN_ID);
      expect(report.since).toBe('2026-10-20T08:00:00.000Z');
      expect(report.sinceSource).toBe('inventory');
      expect(report.findings.find((f) => f.id === 'webbucket-0a1b2c3d')).toMatchObject({
        class: 'remaining',
        match: ['inventory'],
      });
      expect(report.findings.find((f) => f.id === 'sandbox-team-notes')?.class).toBe('not-owned');
    });

    it('rejects an inventory of another run or a file that is not an inventory', async () => {
      const ws = workspace();
      writeFileSync(
        join(ws.dir, 'other.json'),
        JSON.stringify(inventoryFixture([], { runId: 'sbx-ffffff' })),
      );
      writeFileSync(join(ws.dir, 'junk.json'), JSON.stringify({ kind: 'nope' }));
      for (const f of ['other.json', 'junk.json']) {
        const r = await runCli(
          [
            'verify-clean',
            '--run-id',
            RUN_ID,
            '--out',
            join(ws.dir, 'v.json'),
            '--inventory',
            join(ws.dir, f),
            ...awsArgs(ws),
          ],
          { aws: fakeAws({}), guard: fakeGuard(), cwd: ws.dir },
        );
        expect(r.code).toBe(EXIT.USAGE);
      }
    });
  });
});

describe('justifications stay true for the infrastructure code', () => {
  const infra = fileURLToPath(new URL('../../../infra/', import.meta.url));
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (['node_modules', 'dist', 'cdk.out', 'test'].includes(name)) return [];
      return statSync(full).isDirectory() ? sources(full) : full.endsWith('.ts') ? [full] : [];
    });

  it('no EventBridge Scheduler schedule and no SSM parameter is defined by the CDK app', () => {
    const files = sources(infra);
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(
        /aws-scheduler|aws_scheduler|AWS::Scheduler::Schedule|CfnSchedule\b/,
      );
      expect(text, f).not.toMatch(/aws-ssm|aws_ssm|AWS::SSM::Parameter|StringParameter/);
    }
  });
});
