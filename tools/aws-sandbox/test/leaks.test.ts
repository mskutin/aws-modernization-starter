/**
 * Responses carry values that must never reach a report — the origin-verify header
 * value (CloudFront origin custom headers, stack events), Lambda environment variables, stack
 * outputs and parameters, RDS master user names. Canary values prove the projections drop them,
 * and the run-directory backstop refuses to write a report that would contain the run's secret.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/cli.js';
import { assertNoSecrets, LeakError } from '../src/mask.js';
import {
  arn,
  awsArgs,
  fakeAws,
  fakeGuard,
  ok,
  RUN_ID,
  runCli,
  runTags,
  stackArn,
  workspace,
} from './support.js';

// Canaries are assembled at runtime so that no scanner sees them as literals in the source.
const canary = (name: string) => ['CANARY', name, 'f00dfeed0123456789abcdef'].join('-');
const ORIGIN_VERIFY = canary('origin-verify');
const LAMBDA_ENV = canary('lambda-env');
const STACK_OUTPUT = canary('stack-output');
const STACK_PARAMETER = canary('stack-parameter');
const EVENT_REASON = canary('event-reason');
const MASTER_USER = canary('master-user');
const ALL = [ORIGIN_VERIFY, LAMBDA_ENV, STACK_OUTPUT, STACK_PARAMETER, EVENT_REASON, MASTER_USER];

const stack = {
  StackName: 'Sandbox-Frontend',
  StackId: stackArn('Sandbox-Frontend'),
  StackStatus: 'DELETE_FAILED',
  CreationTime: '2026-10-20T08:00:00Z',
  Tags: runTags(),
  Outputs: [{ OutputKey: 'DistributionDomainName', OutputValue: STACK_OUTPUT }],
  Parameters: [{ ParameterKey: 'OriginVerify', ParameterValue: STACK_PARAMETER }],
};

const responses = {
  'cloudformation describe-stacks': ok({ Stacks: [stack] }),
  'cloudformation list-stack-resources': ok({
    StackResourceSummaries: [
      {
        LogicalResourceId: 'Distribution',
        ResourceType: 'AWS::CloudFront::Distribution',
        PhysicalResourceId: 'E111111ABCDEF8',
        ResourceStatus: 'DELETE_FAILED',
      },
    ],
  }),
  'cloudformation describe-stack-events': ok({
    StackEvents: [
      {
        LogicalResourceId: 'Distribution',
        ResourceStatus: 'UPDATE_FAILED',
        ResourceStatusReason: `Invalid header value ${ORIGIN_VERIFY}`,
        Timestamp: '2026-10-20T08:10:00Z',
      },
    ],
  }),
  'cloudfront list-distributions': ok({
    DistributionList: {
      IsTruncated: false,
      Items: [
        {
          Id: 'E111111ABCDEF8',
          ARN: 'arn:aws:cloudfront::111122223333:distribution/E111111ABCDEF8',
          Status: 'Deployed',
          Enabled: true,
          DomainName: 'd111111abcdef8.cloudfront.net',
          Comment: 'starter-sbx SPA + same-origin API',
          Origins: {
            Quantity: 1,
            Items: [
              {
                Id: 'api',
                DomainName: 'starter-sbx-api.ap-southeast-1.elb.amazonaws.com',
                CustomHeaders: {
                  Quantity: 1,
                  Items: [{ HeaderName: 'X-Origin-Verify', HeaderValue: ORIGIN_VERIFY }],
                },
              },
            ],
          },
        },
      ],
    },
  }),
  'cloudfront list-tags-for-resource': ok({ Tags: { Items: runTags() } }),
  'lambda list-functions': ok({
    Functions: [
      {
        FunctionName: 'Sandbox-Workflow-ProcessingWorkflowValidat-0A1B2C3D',
        FunctionArn: arn('lambda', 'function:Sandbox-Workflow-ProcessingWorkflowValidat-0A1B2C3D'),
        LastModified: '2026-10-20T08:00:00.000+0000',
        Environment: { Variables: { ORIGIN_VERIFY_HINT: LAMBDA_ENV } },
      },
    ],
  }),
  'rds describe-db-instances': ok({
    DBInstances: [
      {
        DBInstanceIdentifier: 'starter-sbx-postgres',
        DBInstanceClass: 'db.t4g.micro',
        DBInstanceStatus: 'available',
        MasterUsername: MASTER_USER,
        TagList: runTags(),
      },
    ],
  }),
};

describe('values the projections must drop', () => {
  it('verify-clean writes none of them, in JSON or Markdown', async () => {
    const ws = workspace();
    const r = await runCli(
      [
        'verify-clean',
        '--run-id',
        RUN_ID,
        '--out',
        join(ws.dir, 'v.json'),
        '--markdown',
        join(ws.dir, 'v.md'),
        ...awsArgs(ws),
      ],
      { aws: fakeAws(responses), guard: fakeGuard(), cwd: ws.dir },
    );
    expect(r.code).toBe(EXIT.NOT_CLEAN); // the distribution, the function and the instance remain
    for (const file of ['v.json', 'v.md']) {
      const text = readFileSync(join(ws.dir, file), 'utf8');
      expect(text).toContain('E111111ABCDEF8');
      for (const c of ALL) expect(text, `${file} ${c}`).not.toContain(c);
    }
    for (const c of ALL) expect(r.out).not.toContain(c);
  });

  it('inventory writes none of them, in JSON or Markdown', async () => {
    const ws = workspace();
    const r = await runCli(
      [
        'inventory',
        '--run-id',
        RUN_ID,
        '--out',
        join(ws.dir, 'i.json'),
        '--markdown',
        join(ws.dir, 'i.md'),
        ...awsArgs(ws),
      ],
      { aws: fakeAws(responses), guard: fakeGuard(), cwd: ws.dir },
    );
    expect(r.code).toBe(EXIT.OK);
    for (const file of ['i.json', 'i.md']) {
      const text = readFileSync(join(ws.dir, file), 'utf8');
      expect(text).toContain('Distribution');
      for (const c of ALL) expect(text, `${file} ${c}`).not.toContain(c);
    }
  });

  it('refuses to write a report that would contain the run’s origin-verify value (backstop)', async () => {
    const ws = workspace();
    const sandboxHome = join(ws.dir, 'sbx');
    mkdirSync(join(sandboxHome, 'runs', RUN_ID), { recursive: true });
    const value = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    writeFileSync(join(sandboxHome, 'runs', RUN_ID, 'origin-verify'), `${value}\n`, {
      mode: 0o600,
    });
    // A resource name that happens to carry the value would otherwise be written.
    const leaky = { 's3api list-buckets': ok({ Buckets: [{ Name: `starter-sbx-${value}` }] }) };
    const r = await runCli(
      ['verify-clean', '--run-id', RUN_ID, '--out', join(ws.dir, 'v.json'), ...awsArgs(ws)],
      {
        aws: fakeAws(leaky),
        guard: fakeGuard(),
        cwd: ws.dir,
        env: { HOME: ws.dir, PATH: '/usr/bin', SANDBOX_HOME: sandboxHome },
      },
    );
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toMatch(/contains the run's origin-verify value/);
    expect(r.err).not.toContain(value);
    expect(existsSync(join(ws.dir, 'v.json'))).toBe(false);
  });

  it('the leak check refuses literals, e-mail addresses and unmasked caller sessions', () => {
    const d = ['private', 'component', 'abcdefghij'].join('-');
    expect(() =>
      assertNoSecrets(`{"x":"${d}"}`, 'x', [{ label: 'the issuer key', value: d }]),
    ).toThrow(LeakError);
    expect(() => assertNoSecrets('owner jane.doe@example.com', 'x')).toThrow(/e-mail/);
    expect(() => assertNoSecrets('arn:aws:sts::********3333:assumed-role/R/jane.doe', 'x')).toThrow(
      /caller session/,
    );
    expect(() =>
      assertNoSecrets('arn:aws:sts::********3333:assumed-role/R/<session>', 'x'),
    ).not.toThrow();
  });
});
