import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertValidAllowlist,
  DENIED_OPERATIONS,
  iamPolicyDocument,
  OPERATIONS,
  type OperationDef,
} from '../src/aws/allowlist.js';
import {
  assertArgsAllowed,
  assertArgvSafe,
  AWS_CLI_PIN_COMMAND,
  BoundaryViolation,
  buildArgv,
  buildChildEnv,
  classifyError,
  createAwsCli,
  hasContinuation,
  parentEnvProblems,
  resolveAwsCli,
  VERIFIED_AWS_CLI_VERSION,
} from '../src/aws/executor.js';
import { fakeAws, ok, workspace } from './support.js';

const def = (service: string, operation: string) =>
  OPERATIONS.find((o) => o.service === service && o.operation === operation) as OperationDef;

describe('read-only allowlist', () => {
  it('contains only list/describe/get operations with matching read IAM actions', () => {
    for (const o of OPERATIONS) {
      expect(o.operation, `${o.service} ${o.operation}`).toMatch(/^(list|describe|get)-/);
      expect(o.iamAction).toMatch(/^[a-z0-9-]+:(List|Describe|Get)/);
    }
    expect(() => assertValidAllowlist()).not.toThrow();
  });

  it('rejects a mutating, denylisted or duplicate definition', () => {
    const bad = (o: Partial<OperationDef>) => ({ ...def('ec2', 'describe-vpcs'), ...o });
    expect(() =>
      assertValidAllowlist([bad({ operation: 'delete-vpc', iamAction: 'ec2:DeleteVpc' })]),
    ).toThrow(/not list-/);
    expect(() =>
      assertValidAllowlist([
        bad({
          service: 'secretsmanager',
          operation: 'get-secret-value',
          iamAction: 'secretsmanager:GetSecretValue',
        }),
      ]),
    ).toThrow(/denylisted/);
    expect(() =>
      assertValidAllowlist([
        bad({ service: 'ce', operation: 'get-cost-and-usage', iamAction: 'ce:GetCostAndUsage' }),
      ]),
    ).toThrow(/denylisted/);
    expect(() => assertValidAllowlist([bad({ options: ['--endpoint-url'] })])).toThrow(
      /reserved or denied/,
    );
    expect(() =>
      assertValidAllowlist([def('ec2', 'describe-vpcs'), def('ec2', 'describe-vpcs')]),
    ).toThrow(/duplicate/);
  });

  it('never allowlists a denylisted data-reading operation', () => {
    const keys = new Set(OPERATIONS.map((o) => `${o.service} ${o.operation}`));
    for (const d of DENIED_OPERATIONS) expect(keys.has(d), d).toBe(false);
  });

  it('documents the read-only IAM actions', () => {
    const actions = iamPolicyDocument().Statement[0]?.Action ?? [];
    expect(actions).toContain('cloudformation:DescribeStacks');
    expect(actions).toContain('tag:GetResources');
    expect(actions.some((a) => /:(Delete|Put|Create|Update|Schedule|Cancel)/.test(a))).toBe(false);
  });
});

describe('exec boundary', () => {
  const info = { path: '/bin/aws', realpath: '/bin/aws', sha256: '0'.repeat(64) };

  it('refuses options the operation does not use, denied and reserved flags, and odd values', () => {
    const d = def('cloudformation', 'list-stack-resources');
    expect(() => assertArgsAllowed(d, ['--stack-name', 'Sandbox-Api'])).not.toThrow();
    expect(() => assertArgsAllowed(d, ['--stack-name'])).toThrow(/no value/);
    expect(() => assertArgsAllowed(d, ['--endpoint-url', 'http://evil'])).toThrow(/denied flag/);
    expect(() => assertArgsAllowed(d, ['--profile', 'x'])).toThrow(/reserved flag/);
    expect(() => assertArgsAllowed(d, ['--stack-name=Sandbox-Api'])).toThrow(/two tokens/);
    expect(() => assertArgsAllowed(d, ['--max-items', '5'])).toThrow(/not allowed/);
    expect(() => assertArgsAllowed(d, ['--stack-name', 'a b'])).toThrow(/disallowed characters/);
    expect(() => assertArgsAllowed(d, ['-x'])).toThrow(/short option/);
    expect(() =>
      assertArgsAllowed(def('secretsmanager', 'list-secrets'), ['--include-planned-deletion']),
    ).not.toThrow();
  });

  it('builds the argv with the fixed global options and checks it again before spawning', () => {
    const argv = buildArgv(
      def('ec2', 'describe-vpcs'),
      [],
      'starter-sandbox-developer',
      'ap-southeast-1',
    );
    expect(argv).toEqual([
      'ec2',
      'describe-vpcs',
      '--profile',
      'starter-sandbox-developer',
      '--region',
      'ap-southeast-1',
      '--output',
      'json',
      '--no-cli-pager',
      '--cli-connect-timeout',
      '10',
      '--cli-read-timeout',
      '60',
    ]);
    expect(() => assertArgvSafe(argv, 'starter-sandbox-developer', 'ap-southeast-1')).not.toThrow();
    expect(() =>
      assertArgvSafe(
        ['ec2', 'delete-vpc', ...argv.slice(2)],
        'starter-sandbox-developer',
        'ap-southeast-1',
      ),
    ).toThrow(/allowlist/);
    expect(() =>
      assertArgvSafe([...argv, '--debug'], 'starter-sandbox-developer', 'ap-southeast-1'),
    ).toThrow(/denied flag/);
    expect(() => assertArgvSafe(argv, 'starter-sandbox-developer', 'us-east-1')).toThrow(/region/);
  });

  it('refuses unlisted operations and regions other than ap-southeast-1', async () => {
    const aws = fakeAws({});
    const cli = createAwsCli({
      info,
      profile: 'starter-sandbox-developer',
      region: 'ap-southeast-1',
      parentEnv: {},
      cwd: '/',
      runner: aws.runner,
    });
    await expect(cli.call('ec2', 'terminate-instances')).rejects.toBeInstanceOf(BoundaryViolation);
    await expect(
      cli.call('secretsmanager', 'get-secret-value', ['--secret-id', 'x']),
    ).rejects.toBeInstanceOf(BoundaryViolation);
    expect(aws.calls).toHaveLength(0);
    expect(() =>
      createAwsCli({ info, profile: 'p', region: 'us-east-1', parentEnv: {}, cwd: '/' }),
    ).toThrow(BoundaryViolation);
  });

  it('builds the child environment from scratch: no credentials or profile variables pass', () => {
    const env = buildChildEnv({
      HOME: '/home/op',
      PATH: '/usr/bin',
      AWS_ACCESS_KEY_ID: 'x',
      AWS_SECRET_ACCESS_KEY: 'y',
      AWS_PROFILE: 'other',
      AWS_CONFIG_FILE: '/tmp/evil',
      LC_ALL: 'C',
    });
    expect(Object.keys(env).sort()).toEqual(
      [
        'AWS_CLI_AUTO_PROMPT',
        'AWS_CLI_ERROR_FORMAT',
        'AWS_EC2_METADATA_DISABLED',
        'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
        'AWS_MAX_ATTEMPTS',
        'AWS_PAGER',
        'AWS_RETRY_MODE',
        'HOME',
        'LC_ALL',
        'PATH',
        'PYTHONNOUSERSITE',
      ].sort(),
    );
  });

  it('refuses ambient credentials, redirects, another profile or region and CI — when SET, even empty', () => {
    expect(parentEnvProblems({ AWS_SESSION_TOKEN: 'x' }, 'p')).toHaveLength(1);
    expect(parentEnvProblems({ AWS_SESSION_TOKEN: '' }, 'p')).toHaveLength(1);
    expect(parentEnvProblems({ AWS_SESSION_TOKEN: 'x' }, 'p')[0]).not.toMatch(/SESSION_TOKEN/);
    expect(parentEnvProblems({ AWS_CONFIG_FILE: '/x' }, 'p')[0]).toMatch(/AWS_CONFIG_FILE/);
    expect(parentEnvProblems({ AWS_ENDPOINT_URL_STS: 'http://x' }, 'p')[0]).toMatch(
      /AWS_ENDPOINT_URL_STS/,
    );
    expect(parentEnvProblems({ PYTHONPATH: '/x' }, 'p')).toHaveLength(1);
    expect(parentEnvProblems({ AWS_PROFILE: 'q' }, 'p')).toHaveLength(1);
    expect(parentEnvProblems({ AWS_PROFILE: 'p' }, 'p')).toHaveLength(0);
    expect(parentEnvProblems({ AWS_REGION: 'us-east-1' }, 'p')).toHaveLength(1);
    expect(parentEnvProblems({ AWS_DEFAULT_REGION: 'ap-southeast-1' }, 'p')).toHaveLength(0);
    expect(parentEnvProblems({ CI: '' }, 'p')[0]).toMatch(/operator-run only/);
    expect(parentEnvProblems({ GITLAB_CI: 'true' }, 'p')[0]).toMatch(/operator-run only/);
  });

  it('pins the AWS CLI to the verified release before the first call (same pin as the guard)', async () => {
    const wrong = fakeAws({ 'ec2 describe-vpcs': ok({ Vpcs: [] }) }, { version: '2.31.0' });
    const cli = createAwsCli({
      info,
      profile: 'p',
      region: 'ap-southeast-1',
      parentEnv: {},
      cwd: '/',
      runner: wrong.runner,
    });
    await expect(cli.call('ec2', 'describe-vpcs')).rejects.toThrow(
      /2\.31\.0 is not the verified release 2\.35\.11/,
    );
    expect(wrong.calls).toHaveLength(0);
    const right = fakeAws({ 'ec2 describe-vpcs': ok({ Vpcs: [] }) });
    const cli2 = createAwsCli({
      info,
      profile: 'p',
      region: 'ap-southeast-1',
      parentEnv: {},
      cwd: '/',
      runner: right.runner,
    });
    await cli2.call('ec2', 'describe-vpcs');
    await cli2.call('ec2', 'describe-vpcs');
    expect(right.versionCalls).toHaveLength(1);
    expect(cli2.version()).toBe('2.35.11');
    const preflight = readFileSync(
      new URL('../../aws-preflight/src/probes.ts', import.meta.url),
      'utf8',
    );
    expect(preflight).toContain(`VERIFIED_CLI_VERSION = '${VERIFIED_AWS_CLI_VERSION}'`);
    expect(AWS_CLI_PIN_COMMAND).toContain(
      /VERIFIED_CLI_NIXPKGS_REV = '([0-9a-f]{40})'/.exec(preflight)?.[1] ?? 'missing',
    );
  });

  it('classifies CLI errors without echoing stdout and masks account ids', () => {
    const e = (stderr: string, exitCode = 254) =>
      classifyError({ exitCode, stdout: 'SECRET-STDOUT', stderr, timedOut: false });
    expect(
      e(
        'An error occurred (AccessDeniedException) when calling X: User arn:aws:iam::111122223333:user/u',
      ).kind,
    ).toBe('access-denied');
    expect(
      e(
        'An error occurred (AccessDeniedException) when calling X: arn:aws:iam::111122223333:user/u',
      ).message,
    ).not.toContain('111122223333');
    expect(e('An error occurred (ResourceNotFoundException) when calling X').kind).toBe(
      'not-found',
    );
    expect(
      e('An error occurred (ValidationError) when calling X: Stack with id y does not exist').kind,
    ).toBe('not-found');
    expect(e('An error occurred (ThrottlingException) when calling X').kind).toBe('throttled');
    expect(
      e('Error when retrieving token from sso: Token has expired and refresh failed', 255).kind,
    ).toBe('credentials');
    expect(e('weird').message).not.toContain('SECRET-STDOUT');
    expect(classifyError({ exitCode: null, stdout: '', stderr: '', timedOut: true }).kind).toBe(
      'timeout',
    );
  });

  it('detects listings the CLI did not paginate', () => {
    expect(hasContinuation({ Rules: [], NextToken: 'x' })).toBe(true);
    expect(
      hasContinuation({ DistributionList: { Items: [], IsTruncated: true, NextMarker: 'm' } }),
    ).toBe(true);
    expect(hasContinuation({ ResourceTagMappingList: [], PaginationToken: '' })).toBe(false);
    expect(hasContinuation({ Buckets: [], ContinuationToken: 'c' })).toBe(true);
    expect(hasContinuation({ BackupSummaries: [], LastEvaluatedBackupArn: 'arn:x' })).toBe(true);
    expect(
      hasContinuation({ DistributionList: { Items: [], IsTruncated: false, Marker: '' } }),
    ).toBe(false);
  });

  it('returns invalid JSON as an error without the output', async () => {
    const aws = fakeAws({ 'ec2 describe-vpcs': { stdout: undefined } });
    const runner = async (req: { args: readonly string[] }) => ({
      exitCode: 0,
      stdout: req.args[0] === '--version' ? 'aws-cli/2.35.11 Python/3.13.7' : 'not json SECRET',
      stderr: '',
      timedOut: false,
    });
    const cli = createAwsCli({
      info,
      profile: 'p',
      region: 'ap-southeast-1',
      parentEnv: {},
      cwd: '/',
      runner,
    });
    const r = await cli.call('ec2', 'describe-vpcs');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(aws.calls).toHaveLength(0);
    const cli2 = createAwsCli({
      info,
      profile: 'p',
      region: 'ap-southeast-1',
      parentEnv: {},
      cwd: '/',
      runner: fakeAws({ 'ec2 describe-vpcs': ok({ Vpcs: [] }) }).runner,
    });
    expect((await cli2.call('ec2', 'describe-vpcs')).ok).toBe(true);
    expect(cli2.records).toEqual([
      { service: 'ec2', operation: 'describe-vpcs', iamAction: 'ec2:DescribeVpcs', ok: true },
    ]);
  });

  it('resolves the AWS CLI and records its hash', () => {
    const ws = workspace();
    const r = resolveAwsCli({ explicitPath: ws.aws, parentEnv: {}, cwd: ws.dir });
    expect('error' in r).toBe(false);
    expect(
      resolveAwsCli({ explicitPath: join(ws.dir, 'missing'), parentEnv: {}, cwd: ws.dir }),
    ).toHaveProperty('error');
    expect(resolveAwsCli({ parentEnv: { PATH: 'relative/bin' }, cwd: ws.dir })).toHaveProperty(
      'error',
    );
  });
});

describe('static boundaries', () => {
  const srcFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? srcFiles(join(dir, e.name))
        : e.name.endsWith('.ts')
          ? [join(dir, e.name)]
          : [],
    );
  const root = new URL('../src/', import.meta.url).pathname;

  it('only the executor starts processes; nothing imports an AWS SDK', () => {
    for (const f of srcFiles(root)) {
      const text = readFileSync(f, 'utf8');
      if (!f.endsWith(join('aws', 'executor.ts')))
        expect(text, f).not.toMatch(/node:child_process/);
      expect(text, f).not.toMatch(/@aws-sdk\//);
    }
  });
});
