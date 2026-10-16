import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { budgetNamesOf } from '../src/discover.ts';
import { PROBES } from '../src/probes.ts';
import { EXIT } from '../src/types.ts';
import {
  argOf,
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
  ssoExpired,
  UNRELATED,
  valueOf,
  type FakeCall,
} from './support.ts';

interface Evidence {
  complete: boolean;
  incompleteReason?: string;
  gate: { principalRecheck: string };
  identity: { recheck?: { status: string } };
  summary: { calls: number; byStatus: Record<string, number> };
  probes: {
    id: string;
    probe: string;
    region: string;
    status: string;
    errorCode?: string;
    attempts: number;
    truncated: boolean;
    command: string;
    skipReason?: string;
    data?: unknown;
  }[];
}
const readEvidence = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Evidence;
const allowedPairs = new Set(PROBES.map((p) => `${p.service} ${p.operation}`));

describe('discover', () => {
  it('runs every discovery probe sequentially in allowlist order and writes complete evidence', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses());
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(EXIT.OK);
    const ev = readEvidence(box.evidence);
    expect(ev.complete).toBe(true);
    expect(ev.identity.recheck).toEqual({ status: 'same-principal' });
    expect(ev.gate.principalRecheck).toBe('same-principal');
    // Only allowlisted pairs reached the CLI, each with a permitted region.
    for (const call of fake.awsCalls()) {
      expect(allowedPairs.has(`${call.args[0]} ${call.args[1]}`), call.args.join(' ')).toBe(true);
      expect(['ap-southeast-1', 'us-east-1']).toContain(argOf(call.args, '--region'));
    }
    // Probe order in the evidence follows the allowlist; the first and last calls are STS.
    const calls = ops(fake.awsCalls());
    expect(calls[0]).toBe('sts get-caller-identity');
    expect(calls.at(-1)).toBe('sts get-caller-identity');
    const probeOrder = [...new Set(ev.probes.map((p) => p.probe))];
    const expectedOrder = PROBES.filter(
      (p) => p.phase === 'identity' && p.id !== 'identity.caller-recheck',
    )
      .map((p) => p.id)
      .concat(
        PROBES.filter((p) => p.phase === 'discovery').map((p) => p.id),
        ['identity.caller-recheck'],
      );
    // No customer managed policy is attached in this scenario: those two gate probes do not run.
    expect(probeOrder).toEqual(
      expectedOrder.filter((id) => !id.startsWith('identity.customer-policy')),
    );
    for (const def of PROBES.filter((p) => p.phase === 'discovery')) {
      expect(probeOrder, def.id).toContain(def.id);
    }
    // Both CDK qualifiers, both regions where required.
    expect(ev.probes.filter((p) => p.probe === 'a.cdk.deploy-role').map((p) => p.id)).toEqual([
      'a.cdk.deploy-role[starter]@ap-southeast-1',
      'a.cdk.deploy-role[hnb659fds]@ap-southeast-1',
    ]);
    expect(
      ev.probes.filter((p) => p.probe === 'a.cdk.bootstrap-version').map((p) => [p.id, p.status]),
    ).toEqual([
      ['a.cdk.bootstrap-version[starter]@ap-southeast-1', 'not-found'],
      ['a.cdk.bootstrap-version[starter]@us-east-1', 'not-found'],
      ['a.cdk.bootstrap-version[hnb659fds]@ap-southeast-1', 'ok'],
      ['a.cdk.bootstrap-version[hnb659fds]@us-east-1', 'ok'],
    ]);
    expect(ev.probes.find((p) => p.id === 'a.cfn.cdk-toolkit-stack@us-east-1')?.status).toBe(
      'not-found',
    );
    // Management-only Organizations calls are access-denied from a member account (UNKNOWN).
    expect(ev.probes.find((p) => p.probe === 'a.org.parents')).toMatchObject({
      status: 'access-denied',
      errorCode: 'AccessDeniedException',
    });
    expect(ev.summary.calls).toBe(ev.probes.length);
    // Console status lines show readable call ids (never domain-masked) and no raw values.
    expect(r.out).toContain('  access-denied  a.org.parents@us-east-1 (AccessDeniedException)');
    expect(r.out).toContain('  ok             c.quotas.lambda@ap-southeast-1');
    expect(r.out.join('\n')).not.toMatch(/<domain-\d+>/);
  });

  it('records AccessDenied / UnauthorizedOperation and continues', async () => {
    const box = sandbox();
    const fake = fakeRunner(
      happyResponses({
        'ec2 describe-vpcs': awsError('UnauthorizedOperation'),
        'lambda get-account-settings': awsError('AccessDeniedException'),
      }),
    );
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.OK);
    const ev = readEvidence(box.evidence);
    expect(ev.probes.find((p) => p.probe === 'b.ec2.vpcs')).toMatchObject({
      status: 'access-denied',
      errorCode: 'UnauthorizedOperation',
    });
    expect(ev.probes.find((p) => p.probe === 'c.lambda.account-settings')).toMatchObject({
      status: 'access-denied',
    });
    // Later probes still ran.
    expect(ops(fake.awsCalls())).toContain('budgets describe-budgets');
  });

  it('records a timeout and continues', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses({ 'ec2 describe-subnets': { timedOut: true } }));
    const r = await runCli(liveArgs('discover', box, ['--call-timeout', '7']), fake.runner);
    expect(r.code).toBe(EXIT.OK);
    const ev = readEvidence(box.evidence);
    expect(ev.probes.find((p) => p.probe === 'b.ec2.subnets')).toMatchObject({
      status: 'timeout',
      errorCode: 'Timeout',
    });
    expect(fake.awsCalls().every((c: FakeCall) => c.timeoutMs === 7000)).toBe(true);
    expect(ops(fake.awsCalls())).toContain('ec2 describe-route-tables');
  });

  it('retries throttling once at tool level, then records an error', async () => {
    const box = sandbox();
    const fake = fakeRunner(
      happyResponses({
        'ec2 describe-route-tables': awsError('RequestLimitExceeded'),
        'ecr describe-registry': (_, nth) =>
          nth === 1 ? awsError('ThrottlingException') : ok({ registryId: SANDBOX }),
      }),
    );
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.OK);
    const ev = readEvidence(box.evidence);
    expect(ev.probes.find((p) => p.probe === 'b.ec2.route-tables')).toMatchObject({
      status: 'error',
      errorCode: 'RequestLimitExceeded',
      attempts: 2,
    });
    expect(ev.probes.find((p) => p.probe === 'c.ecr.registry')).toMatchObject({
      status: 'ok',
      attempts: 2,
    });
    expect(ops(fake.awsCalls()).filter((o) => o === 'ec2 describe-route-tables')).toHaveLength(2);
  });

  it('expired credentials mid-run: exit 6, no further calls, partial evidence marked incomplete', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses({ 'ec2 describe-nat-gateways': ssoExpired }));
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.CREDENTIALS);
    expect(r.err.join('\n')).toContain('aws sso login --profile starter-sandbox');
    const calls = ops(fake.awsCalls());
    expect(calls.at(-1)).toBe('ec2 describe-nat-gateways');
    expect(calls.filter((o) => o === 'ec2 describe-nat-gateways')).toHaveLength(1); // never retried
    const ev = readEvidence(box.evidence);
    expect(ev.complete).toBe(false);
    expect(ev.incompleteReason).toContain('credentials expired or invalid');
    expect(ev.probes.some((p) => p.probe === 'b.ec2.vpc-endpoints')).toBe(false);
  });

  it('interrupt: stops after the running call and writes partial evidence (exit 130)', async () => {
    const box = sandbox();
    const controller = new AbortController();
    const fake = fakeRunner(
      happyResponses({
        'ec2 describe-vpcs': () => {
          controller.abort();
          return ok({ Vpcs: [] });
        },
      }),
    );
    const r = await runCli(liveArgs('discover', box), fake.runner, { signal: controller.signal });
    expect(r.code).toBe(EXIT.INTERRUPTED);
    expect(ops(fake.awsCalls()).at(-1)).toBe('ec2 describe-vpcs');
    expect(readEvidence(box.evidence)).toMatchObject({
      complete: false,
      incompleteReason: 'interrupted',
    });
  });

  it('queries notifications per valid budget (max 10) and never subscribers', async () => {
    const box = sandbox();
    const names = Array.from({ length: 12 }, (_, i) => `budget-${i + 1}`);
    const fake = fakeRunner(
      happyResponses({
        'budgets describe-budgets': ok({ Budgets: names.map((BudgetName) => ({ BudgetName })) }),
      }),
    );
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.OK);
    const notif = fake.awsCalls().filter((c) => c.args[1] === 'describe-notifications-for-budget');
    expect(notif.map((c) => c.args.find((a) => a.startsWith('--budget-name=')))).toEqual(
      names.slice(0, 10).map((n) => `--budget-name=${n}`),
    );
    for (const c of notif) expect(valueOf(c.args, '--account-id')).toBe(SANDBOX);
    // The evidence command shows <budget-N>, never the name.
    const ev = readEvidence(box.evidence);
    const commands = ev.probes
      .filter((p) => p.probe === 'd.budgets.notifications')
      .map((p) => p.command);
    expect(commands[0]).toContain('--budget-name=<budget-1>');
    expect(commands[0]).toContain('--account-id=<account>');
    expect(JSON.stringify(ev)).not.toMatch(/(?<!<)budget-\d/);
    expect(ops(fake.awsCalls())).not.toContain('budgets describe-subscribers-for-notification');
    expect(r.out.join('\n')).toContain('2 more budget(s) beyond the first 10');
  });

  it('skips budget names that fail validation and records the reason when budgets are not listed', async () => {
    expect(
      budgetNamesOf({
        Budgets: [{ BudgetName: 'ok-name' }, { BudgetName: '-bad' }, { BudgetName: 'a\nb' }],
      }),
    ).toEqual({
      valid: ['ok-name'],
      invalid: 2,
      more: 0,
    });
    const box = sandbox();
    const fake = fakeRunner(
      happyResponses({ 'budgets describe-budgets': awsError('AccessDeniedException') }),
    );
    await runCli(liveArgs('discover', box), fake.runner);
    const ev = readEvidence(box.evidence);
    expect(ev.probes.find((p) => p.probe === 'd.budgets.notifications')).toMatchObject({
      status: 'skipped',
      skipReason: 'describe-budgets was access-denied',
    });
  });

  it('records optional probes as skipped without their inputs and runs them with', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses());
    await runCli(liveArgs('discover', box), fake.runner);
    const ev = readEvidence(box.evidence);
    expect(ev.probes.find((p) => p.probe === 'a.iam.boundary-policy')).toMatchObject({
      status: 'skipped',
      attempts: 0,
    });
    expect(ev.probes.find((p) => p.probe === 'c.kms.key')).toMatchObject({ status: 'skipped' });
    expect(ops(fake.awsCalls())).not.toContain('kms describe-key');
    expect(ops(fake.awsCalls())).not.toContain('iam get-policy');

    const box2 = sandbox();
    const fake2 = fakeRunner(happyResponses());
    const extra = [
      '--kms-key',
      'alias/starter-data',
      '--kms-key',
      'alias/starter-logs',
      '--boundary-policy-arn',
      `arn:aws:iam::${SANDBOX}:policy/ExamplePermissionsBoundary`,
      '--vpc-id',
      'vpc-00000000000000001',
      '--qualifier',
      'hnb659fds',
    ];
    const r2 = await runCli(liveArgs('discover', box2, extra), fake2.runner);
    expect(r2.code).toBe(EXIT.OK);
    const kms = fake2.awsCalls().filter((c) => c.args[1] === 'describe-key');
    expect(kms.map((c) => valueOf(c.args, '--key-id'))).toEqual([
      'alias/starter-data',
      'alias/starter-logs',
    ]);
    expect(ops(fake2.awsCalls())).toContain('iam get-policy');
    const subnets = fake2.awsCalls().find((c) => c.args[1] === 'describe-subnets');
    expect(argOf(subnets?.args ?? [], '--filters')).toBe(
      'Name=vpc-id,Values=vpc-00000000000000001',
    );
    const nat = fake2.awsCalls().find((c) => c.args[1] === 'describe-nat-gateways');
    expect(argOf(nat?.args ?? [], '--filter')).toBe('Name=vpc-id,Values=vpc-00000000000000001');
    // A qualifier equal to the CDK default is probed once.
    expect(fake2.awsCalls().filter((c) => c.args[1] === 'get-parameter')).toHaveLength(2);
    const ev2 = readEvidence(box2.evidence);
    expect(JSON.stringify(ev2)).not.toContain('vpc-00000000000000001');
  });

  it('discards the run when the profile resolves to another account at the end (exit 3, no evidence)', async () => {
    const box = sandbox();
    const fake = fakeRunner(
      happyResponses({
        'sts get-caller-identity': (_, nth) =>
          ok({
            Account: nth === 1 ? SANDBOX : OTHER,
            Arn: `arn:aws:sts::${nth === 1 ? SANDBOX : OTHER}:assumed-role/${ROLE}/${SESSION}`,
          }),
      }),
    );
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.ACCOUNT_MISMATCH);
    expect(existsSync(box.evidence)).toBe(false);
  });

  it.each([
    [
      'another role of the same account',
      `arn:aws:sts::${SANDBOX}:assumed-role/AWSReservedSSO_Admin_0123456789abcdef/${SESSION}`,
      'role AWSReservedSSO_Admin_0123456789abcdef instead of',
    ],
    [
      'the same role with another session',
      `arn:aws:sts::${SANDBOX}:assumed-role/${ROLE}/someone.else@example.com`,
      'the same role with a different session name',
    ],
  ])(
    'discards the run when the profile resolves to %s at the end (exit 4, no evidence)',
    async (_, laterArn, message) => {
      const box = sandbox();
      const fake = fakeRunner(
        happyResponses({
          'sts get-caller-identity': (_args, nth) =>
            ok({
              Account: SANDBOX,
              Arn: nth === 1 ? `arn:aws:sts::${SANDBOX}:assumed-role/${ROLE}/${SESSION}` : laterArn,
            }),
        }),
      );
      const r = await runCli(liveArgs('discover', box), fake.runner);
      expect(r.code).toBe(EXIT.PRINCIPAL_REJECTED);
      expect(r.err.join('\n')).toContain('PRINCIPAL CHANGED — STOP');
      expect(r.err.join('\n')).toContain(message);
      expect(r.err.join('\n')).not.toContain('someone.else');
      expect(existsSync(box.evidence)).toBe(false);
    },
  );

  it('records the new probes: hooks (names only), log resource policies (count only), Lambda quota default and requests', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses());
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.OK);
    const ev = readEvidence(box.evidence);
    const data = (id: string) => ev.probes.find((p) => p.id === id)?.data;
    expect(data('a.cfn.hook-types-public@ap-southeast-1')).toEqual({
      hookTypeCount: 1,
      hookTypeNames: ['AWS::ControlTower::Hook'],
    });
    expect(data('a.cfn.hook-types-private@ap-southeast-1')).toEqual({
      hookTypeCount: 0,
      hookTypeNames: [],
    });
    expect(data('c.logs.resource-policies@ap-southeast-1')).toEqual({ resourcePolicyCount: 2 });
    expect(data('c.quotas.lambda-concurrency-default@ap-southeast-1')).toMatchObject({
      Quota: { QuotaCode: 'L-B99A9384', Value: 1000 },
    });
    expect(data('c.quotas.lambda-concurrency-requests@ap-southeast-1')).toEqual({
      RequestedQuotas: [
        {
          Status: 'CASE_OPENED',
          DesiredValue: 1000,
          Created: '2026-10-01T00:00:00+00:00',
          LastUpdated: '2026-10-02T00:00:00+00:00',
        },
      ],
    });
    const hooks = fake.awsCalls().filter((c) => c.args[1] === 'list-types');
    expect(hooks.map((c) => c.args.slice(2, 8))).toEqual([
      ['--visibility', 'PUBLIC', '--type', 'HOOK', '--filters', 'Category=ACTIVATED'],
      ['--visibility', 'PRIVATE', '--type', 'HOOK', '--filters', 'Category=ACTIVATED'],
    ]);
    const text = JSON.stringify(ev);
    for (const raw of [
      'case-id-value',
      'request-id-value',
      'AWSLogDeliveryWrite20150319',
      UNRELATED.logPolicy,
    ]) {
      expect(text, raw).not.toContain(raw);
    }
  });

  it('a failed final identity re-check marks the evidence incomplete', async () => {
    const box = sandbox();
    const fake = fakeRunner(
      happyResponses({
        'sts get-caller-identity': (_, nth) =>
          nth === 1
            ? ok({
                Account: SANDBOX,
                Arn: `arn:aws:sts::${SANDBOX}:assumed-role/${ROLE}/${SESSION}`,
              })
            : { timedOut: true },
      }),
    );
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.ERROR);
    const ev = readEvidence(box.evidence);
    expect(ev).toMatchObject({
      complete: false,
      incompleteReason: 'identity re-check failed (Timeout)',
    });
  });

  it('marks probes truncated when a bound stopped the listing', async () => {
    const box = sandbox();
    const fake = fakeRunner(
      happyResponses({ 'kms list-aliases': ok({ Aliases: [], NextToken: 'eyJ4IjoxfQ' }) }),
    );
    await runCli(liveArgs('discover', box), fake.runner);
    expect(
      readEvidence(box.evidence).probes.find((p) => p.probe === 'c.kms.aliases'),
    ).toMatchObject({ status: 'ok', truncated: true });
  });
});
