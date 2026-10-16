/**
 * The mutation guard (`guard-cli.js check`), in process with a fake AWS CLI:
 * one STS call per invocation through the exec boundary, and a distinct exit code for every
 * refusal. Refusals before the STS call start no process at all.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProblem, main } from '../src/guard-cli.ts';
import { GUARD_EXIT } from '../src/guard.ts';
import type { ProcessRunner } from '../src/executor.ts';
import { maskPrincipalArn } from '../src/sandbox.ts';
import {
  awsError,
  fakeRunner,
  ok,
  OTHER,
  PROFILE,
  ROLE,
  ROLE_PATTERN,
  sandbox,
  SANDBOX,
  SESSION,
  ssoConfig,
  ssoExpired,
  type FakeResponse,
  type Responder,
  type Sandbox,
} from './support.ts';

const DIGEST = 'f'.repeat(64);
const LABEL = 'cdk deploy Sandbox-Foundation';
const CALLER = ok({
  UserId: `AROAFAKEROLEID00000001:${SESSION}`,
  Account: SANDBOX,
  Arn: `arn:aws:sts::${SANDBOX}:assumed-role/${ROLE}/${SESSION}`,
});

interface Setup {
  readonly box: Sandbox;
  readonly accountFile: string;
  readonly log: string;
}

function setup(options: { config?: string; account?: string } = {}): Setup {
  const box = sandbox(options.config === undefined ? {} : { config: options.config });
  const accountFile = join(box.dir, 'expected-account');
  writeFileSync(accountFile, `${options.account ?? SANDBOX}\n`, { mode: 0o600 });
  return { box, accountFile, log: join(box.dir, 'guard.jsonl') };
}

const argsOf = (s: Setup, extra: string[] = [], omit: string[] = []) => {
  const pairs: [string, string][] = [
    ['--execution-profile', 'personal-sandbox'],
    ['--profile', PROFILE],
    ['--expected-account-file', s.accountFile],
    ['--region', 'ap-southeast-1'],
    ['--label', LABEL],
    ['--log', s.log],
    ['--aws-cli', s.box.awsCli],
  ];
  return ['check', ...pairs.filter(([k]) => !omit.includes(k)).flat(), ...extra];
};

async function guard(
  s: Setup,
  argv: string[],
  responses: Record<string, Responder> = { 'sts get-caller-identity': CALLER },
  options: { env?: Record<string, string>; runner?: ProcessRunner; version?: string } = {},
) {
  const fake = fakeRunner(responses, options.version ? { version: options.version } : {});
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    env: { HOME: s.box.home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...options.env },
    cwd: s.box.dir,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    runner: options.runner ?? fake.runner,
    now: () => new Date('2026-10-15T04:05:06.000Z'),
    toolSourceSha256: DIGEST,
    buildProblem: undefined,
  });
  return { code, out, err: err.join('\n'), fake };
}

const logLines = (s: Setup) =>
  existsSync(s.log)
    ? readFileSync(s.log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

describe('guard check: verified', () => {
  it('one STS call through the exec boundary, one masked JSON line on stdout and in the log', async () => {
    const s = setup();
    const r = await guard(s, argsOf(s, ['--expected-role-pattern', ROLE_PATTERN]));
    expect(r.err).toBe('');
    expect(r.code).toBe(GUARD_EXIT.VERIFIED);
    // `aws --version` (local) + exactly one AWS call.
    expect(r.fake.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual([
      '--version',
      'sts get-caller-identity',
    ]);
    const sts = r.fake.awsCalls()[0];
    expect(sts?.args).toEqual([
      'sts',
      'get-caller-identity',
      '--profile',
      PROFILE,
      '--region',
      'ap-southeast-1',
      '--output',
      'json',
      '--no-cli-pager',
      '--cli-connect-timeout',
      '10',
      '--cli-read-timeout',
      '30',
    ]);
    expect(sts?.file).toBe(realpathSync(s.box.awsCli));
    expect(sts?.envNames.filter((n) => /PROFILE|KEY|TOKEN/.test(n))).toEqual([]);
    expect(r.out).toHaveLength(1);
    const line = JSON.parse(r.out[0] ?? '{}');
    expect(line).toEqual({
      time: '2026-10-15T04:05:06.000Z',
      result: 'verified',
      label: LABEL,
      account: '********3333',
      principalArn: `arn:aws:sts::********3333:assumed-role/${ROLE}/<session>`,
      principalType: 'assumed-role',
      region: 'ap-southeast-1',
      profile: PROFILE,
      executionProfile: 'personal-sandbox',
      toolSourceSha256: DIGEST,
    });
    expect(r.out[0]).not.toContain(SANDBOX);
    expect(r.out[0]).not.toContain(SESSION);
    expect(logLines(s)).toEqual([line]);
    expect(statSync(s.log).mode & 0o777).toBe(0o600);
    // A second invocation appends (and calls STS again: one call per invocation).
    const again = await guard(s, argsOf(s));
    expect(again.code).toBe(0);
    expect(again.fake.awsCalls()).toHaveLength(1);
    expect(logLines(s)).toHaveLength(2);
  });

  it('logs to $SANDBOX_GUARD_LOG when --log is not given; accepts the pinned AWS_* values', async () => {
    const s = setup();
    const r = await guard(s, argsOf(s, [], ['--log']), undefined, {
      env: {
        SANDBOX_GUARD_LOG: s.log,
        AWS_PROFILE: PROFILE,
        AWS_REGION: 'ap-southeast-1',
        AWS_DEFAULT_REGION: 'ap-southeast-1',
      },
    });
    expect(r.code).toBe(0);
    expect(logLines(s)).toHaveLength(1);
    // The pinned variables are checked, not passed: the child environment is built from scratch.
    expect(r.fake.awsCalls()[0]?.envNames).not.toContain('AWS_PROFILE');
    expect(r.fake.awsCalls()[0]?.envNames).not.toContain('AWS_REGION');
  });

  it('without a log, stdout only', async () => {
    const s = setup();
    const r = await guard(s, argsOf(s, [], ['--log']));
    expect(r.code).toBe(0);
    expect(existsSync(s.log)).toBe(false);
    expect(r.out).toHaveLength(1);
  });
});

describe('guard check: refusals (distinct exit codes)', () => {
  /** A refusal before the STS call: no process at all, nothing on stdout. */
  const before = async (
    s: Setup,
    argv: string[],
    code: number,
    message: string,
    env: Record<string, string> = {},
  ) => {
    const r = await guard(s, argv, undefined, { env });
    expect(r.code, r.err).toBe(code);
    expect(r.err).toContain(message);
    expect(r.fake.calls).toEqual([]);
    expect(r.out).toEqual([]);
    return r;
  };

  it('the strict profile (default or explicit) never authorizes a mutation: exit 2', async () => {
    const s = setup();
    await before(s, argsOf(s, [], ['--execution-profile']), 2, 'never authorizes a mutation');
    await before(
      s,
      argsOf(s, ['--execution-profile', 'strict'], ['--execution-profile']),
      2,
      'never authorizes a mutation',
    );
    await before(
      s,
      argsOf(s, ['--execution-profile', 'starter'], ['--execution-profile']),
      2,
      'must be strict or personal-sandbox',
    );
  });

  it('CI or GITLAB_CI: exit 2', async () => {
    const s = setup();
    await before(s, argsOf(s), 2, 'CI or GITLAB_CI is set', { GITLAB_CI: 'true' });
  });

  it('missing, blank or default profile: exit 11 (no default-profile fallback)', async () => {
    const s = setup();
    await before(s, argsOf(s, [], ['--profile']), 11, '--profile is required');
    await before(s, argsOf(s, ['--profile', '  '], ['--profile']), 11, '--profile is required');
    await before(s, argsOf(s, ['--profile', 'default'], ['--profile']), 11, '--profile default');
    // Even with AWS_PROFILE set, the profile must be selected explicitly.
    await before(s, argsOf(s, [], ['--profile']), 11, '--profile is required', {
      AWS_PROFILE: PROFILE,
    });
  });

  it('a profile not defined in ~/.aws/config: exit 11 before any process', async () => {
    const s = setup();
    await before(s, argsOf(s, ['--profile', 'other-profile'], ['--profile']), 11, 'not defined');
  });

  it('region: not allowed, missing, or a different AWS_REGION / AWS_DEFAULT_REGION: exit 10', async () => {
    const s = setup();
    await before(s, argsOf(s, ['--region', 'cn-north-1'], ['--region']), 10, 'aws-cn partition');
    await before(s, argsOf(s, ['--region', 'Nowhere'], ['--region']), 10, 'not an AWS region');
    await before(s, argsOf(s, [], ['--region']), 10, '--region is required');
    await before(s, argsOf(s), 10, 'AWS_REGION is set to a different region', {
      AWS_REGION: 'us-east-1',
    });
    await before(s, argsOf(s), 10, 'AWS_DEFAULT_REGION', { AWS_DEFAULT_REGION: 'eu-west-1' });
  });

  it.each([
    [{ AWS_ACCESS_KEY_ID: 'value-never-printed-1' }, 'static credentials'],
    [{ AWS_SECRET_ACCESS_KEY: 'value-never-printed-2' }, 'the AWS secret access key variable'],
    [{ AWS_SESSION_TOKEN: 'value-never-printed-3' }, 'the AWS session token variable'],
    [{ AWS_DEFAULT_PROFILE: PROFILE }, 'AWS_DEFAULT_PROFILE'],
    [{ AWS_PROFILE: 'admin' }, 'AWS_PROFILE is set to a different profile'],
    [{ AWS_CONFIG_FILE: '/tmp/other' }, 'AWS_CONFIG_FILE'],
    [{ AWS_SHARED_CREDENTIALS_FILE: '/tmp/other' }, 'AWS_SHARED_CREDENTIALS_FILE'],
    [{ AWS_ENDPOINT_URL: 'http://127.0.0.1:4566' }, 'AWS_ENDPOINT_URL'],
    [{ AWS_ENDPOINT_URL_STS: 'http://127.0.0.1:4566' }, 'AWS_ENDPOINT_URL_STS'],
    [{ AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/t' }, 'AWS_WEB_IDENTITY_TOKEN_FILE'],
    [{ AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/x' }, 'AWS_CONTAINER'],
    [{ AWS_DATA_PATH: '/tmp/models' }, 'AWS_DATA_PATH'],
  ])('environment conflict %o: exit 12, values never printed', async (env, message) => {
    const s = setup();
    const r = await before(s, argsOf(s), 12, message, env);
    for (const value of Object.values(env)) {
      if (value !== PROFILE) expect(r.err).not.toContain(value);
    }
  });

  it('the expected-account file: required, private, 12 digits, never echoed: exit 2', async () => {
    const s = setup();
    await before(s, argsOf(s, [], ['--expected-account-file']), 2, 'is required');
    chmodSync(s.accountFile, 0o644);
    await before(s, argsOf(s), 2, 'must be private');
    const bad = setup({ account: '1234567890ab' });
    const r = await before(bad, argsOf(bad), 2, 'exactly one 12-digit account ID');
    expect(r.err).not.toContain('1234567890ab');
    const linked = setup();
    const link = join(linked.box.dir, 'account-link');
    symlinkSync(linked.accountFile, link);
    await before(
      linked,
      argsOf(linked, ['--expected-account-file', link], ['--expected-account-file']),
      2,
      'symbolic link',
    );
  });

  it('label: required, one line, no account IDs or e-mail addresses: exit 2', async () => {
    const s = setup();
    for (const [label, message] of [
      ['', '--label is required'],
      ['deploy\nrm', 'one line'],
      [`deploy to ${SANDBOX}`, 'twelve-digit-number'],
      ['deploy by jane.doe@example.com', 'email-address'],
    ] as const) {
      const r = await before(s, argsOf(s, ['--label', label], ['--label']), 2, message);
      expect(r.err).not.toContain(SANDBOX);
      expect(r.err).not.toContain('jane.doe');
    }
    expect(existsSync(s.log)).toBe(false);
  });

  it('a stale dist/ build: exit 17 before any process', async () => {
    const s = setup();
    const fake = fakeRunner({});
    const err: string[] = [];
    const code = await main(argsOf(s), {
      env: { HOME: s.box.home, PATH: '/usr/bin:/bin' },
      cwd: s.box.dir,
      stdout: () => undefined,
      stderr: (l) => err.push(l),
      runner: fake.runner,
      toolSourceSha256: DIGEST,
      buildProblem: 'dist/ was built from other sources than the current src/ (stale build)',
    });
    expect(code).toBe(GUARD_EXIT.STALE_BUILD);
    expect(fake.calls).toEqual([]);
    expect(logLines(s)[0]).toMatchObject({ result: 'refused', reason: 'stale-build' });
  });

  it('~/.aws configuration that could redirect the call: exit 15 before any process', async () => {
    const s = setup({ config: ssoConfig({ profileExtra: 'credential_process = /tmp/x' }) });
    await before(s, argsOf(s), 15, 'credential_process');
    const alias = setup();
    mkdirSync(join(alias.box.home, '.aws', 'cli'));
    writeFileSync(join(alias.box.home, '.aws', 'cli', 'alias'), '[toplevel]\nwhoami = sts\n');
    await before(alias, argsOf(alias), 15, 'cli/alias exists');
  });

  it("the profile's sso_account_id is another account (offline): exit 3 before any process", async () => {
    const s = setup({ config: ssoConfig({ account: OTHER }) });
    const r = await before(s, argsOf(s), 3, 'ACCOUNT MISMATCH (offline)');
    expect(r.err).not.toContain(OTHER);
  });

  it('the AWS CLI is not the pinned release: exit 14 with the pin command; nothing sent to AWS', async () => {
    const s = setup();
    const r = await guard(s, argsOf(s), undefined, { version: '2.31.0' });
    expect(r.code).toBe(GUARD_EXIT.AWS_CLI);
    expect(r.err).toContain('is not the verified release 2.35.11');
    expect(r.err).toContain('nix shell github:NixOS/nixpkgs/');
    expect(r.fake.awsCalls()).toEqual([]);
    const missing = await guard(
      s,
      argsOf(s, ['--aws-cli', join(s.box.dir, 'nope')], ['--aws-cli']),
    );
    expect(missing.code).toBe(GUARD_EXIT.AWS_CLI);
  });

  it('STS account mismatch: exit 3, masked, logged as refused, nothing on stdout', async () => {
    const s = setup();
    const r = await guard(s, argsOf(s), {
      'sts get-caller-identity': ok({
        Account: OTHER,
        Arn: `arn:aws:sts::${OTHER}:assumed-role/${ROLE}/${SESSION}`,
      }),
    });
    expect(r.code).toBe(GUARD_EXIT.ACCOUNT_MISMATCH);
    expect(r.out).toEqual([]);
    expect(r.err).toContain('ACCOUNT MISMATCH');
    expect(r.err).toContain('********6666');
    expect(r.err).not.toContain(OTHER);
    const text = readFileSync(s.log, 'utf8');
    expect(text).not.toContain(OTHER);
    expect(text).not.toContain(SANDBOX);
    expect(text).not.toContain(SESSION);
    expect(logLines(s)).toEqual([
      {
        time: '2026-10-15T04:05:06.000Z',
        result: 'refused',
        reason: 'account-mismatch',
        exitCode: 3,
        label: LABEL,
        region: 'ap-southeast-1',
        profile: PROFILE,
        executionProfile: 'personal-sandbox',
        account: '********6666',
        principalArn: `arn:aws:sts::********6666:assumed-role/${ROLE}/<session>`,
        principalType: 'assumed-role',
        expectedAccount: '********3333',
        toolSourceSha256: DIGEST,
      },
    ]);
  });

  it('root, an IAM user or a role outside --expected-role-pattern: exit 4', async () => {
    for (const [arn, extra] of [
      [`arn:aws:iam::${SANDBOX}:root`, []],
      [`arn:aws:iam::${SANDBOX}:user/deployer`, []],
      [`arn:aws:sts::${SANDBOX}:federated-user/deployer`, []],
      [
        `arn:aws:sts::${SANDBOX}:assumed-role/AWSReservedSSO_AccountDiscoveryAdmin_0123456789abcdef/${SESSION}`,
        ['--expected-role-pattern', 'AWSReservedSSO_AccountDiscovery_*'],
      ],
    ] as const) {
      const s = setup();
      const r = await guard(s, argsOf(s, [...extra]), {
        'sts get-caller-identity': ok({ Account: SANDBOX, Arn: arn }),
      });
      expect(r.code, arn).toBe(GUARD_EXIT.PRINCIPAL_REJECTED);
      expect(r.out).toEqual([]);
      expect(readFileSync(s.log, 'utf8')).not.toContain('deployer');
    }
  });

  it('expired SSO session: exit 6 with the login hint (never retried)', async () => {
    const s = setup();
    const r = await guard(s, argsOf(s), { 'sts get-caller-identity': ssoExpired });
    expect(r.code).toBe(GUARD_EXIT.CREDENTIALS);
    expect(r.err).toContain(`aws sso login --profile ${PROFILE}`);
    expect(r.fake.awsCalls()).toHaveLength(1);
    expect(logLines(s)[0]).toMatchObject({ reason: 'credentials', exitCode: 6 });
  });

  it.each([
    ['throttled', awsError('ThrottlingException')],
    ['access denied', awsError('AccessDenied')],
    [
      'no network',
      { stderr: '\nCould not connect to the endpoint URL: "https://sts"\n', exit: 255 },
    ],
    ['timeout', { timedOut: true }],
    ['unexpected output', ok({ Account: 'not-an-account' })],
  ] as [string, FakeResponse][])('STS failure (%s): exit 13, one attempt', async (_, response) => {
    const s = setup();
    const r = await guard(s, argsOf(s), { 'sts get-caller-identity': response });
    expect(r.code).toBe(GUARD_EXIT.STS_FAILURE);
    expect(r.fake.awsCalls()).toHaveLength(1);
    expect(r.out).toEqual([]);
  });

  it('the log: a symbolic link, a shared file or a missing directory: exit 16 before any process', async () => {
    const s = setup();
    const target = join(s.box.dir, 'elsewhere.jsonl');
    writeFileSync(target, '', { mode: 0o600 });
    symlinkSync(target, s.log);
    await before(s, argsOf(s), 16, 'symbolic link');
    const shared = setup();
    writeFileSync(shared.log, '', { mode: 0o644 });
    chmodSync(shared.log, 0o644);
    await before(shared, argsOf(shared), 16, 'must be private');
    const nodir = setup();
    await before(
      nodir,
      argsOf(nodir, ['--log', join(nodir.box.dir, 'missing', 'g.jsonl')], ['--log']),
      16,
      'its directory must exist',
    );
  });

  it('a label that contains the session name fails the leak scan of the line: exit 1', async () => {
    const s = setup();
    const r = await guard(s, argsOf(s, ['--label', 'deploy by jdoe-sso-user'], ['--label']), {
      'sts get-caller-identity': ok({
        Account: SANDBOX,
        Arn: `arn:aws:sts::${SANDBOX}:assumed-role/${ROLE}/jdoe-sso-user`,
      }),
    });
    expect(r.code).toBe(GUARD_EXIT.ERROR);
    expect(r.out).toEqual([]);
    expect(r.err).toContain('leak scanner');
  });

  it('usage errors: unknown option, no command', async () => {
    const s = setup();
    const r = await guard(s, [...argsOf(s), '--endpoint-url', 'http://x']);
    expect(r.code).toBe(2);
    expect((await guard(s, [])).code).toBe(2);
    expect((await guard(s, ['--help'])).code).toBe(0);
  });
});

describe('guard check: no identity to fall back to (exit 15 before any process)', () => {
  const STATIC = 'aws_access_key_id = placeholder-not-a-key\naws_secret_access_key = placeholder\n';
  const fallback = async (
    s: Setup,
    message: string,
    deps: { cwd?: string; repoRoot?: string } = {},
  ) => {
    const fake = fakeRunner({ 'sts get-caller-identity': CALLER });
    const err: string[] = [];
    const out: string[] = [];
    const code = await main(argsOf(s), {
      env: { HOME: s.box.home, PATH: '/usr/bin:/bin' },
      cwd: deps.cwd ?? s.box.dir,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      runner: fake.runner,
      toolSourceSha256: DIGEST,
      buildProblem: undefined,
      ...(deps.repoRoot ? { repoRoot: deps.repoRoot } : {}),
    });
    return { code, err: err.join('\n'), out, calls: fake.calls, message };
  };
  const refusedWith = async (
    s: Setup,
    message: string,
    deps: { cwd?: string; repoRoot?: string } = {},
  ) => {
    const r = await fallback(s, message, deps);
    expect(r.code, r.err).toBe(GUARD_EXIT.AWS_CONFIG);
    expect(r.err).toContain(message);
    expect(r.calls).toEqual([]);
    expect(r.out).toEqual([]);
    expect(r.err).not.toContain('placeholder');
    expect(r.err).not.toContain(OTHER);
    expect(logLines(s)[0]).toMatchObject({ result: 'refused', reason: 'aws-config', exitCode: 15 });
  };

  it('a [default] section in ~/.aws/config, even of another account', async () => {
    await refusedWith(
      setup({
        config: ssoConfig({
          after: `[default]\nsso_session = starter-sandbox\nsso_account_id = ${OTHER}\nsso_role_name = Admin\n`,
        }),
      }),
      'has a [default] section',
    );
    await refusedWith(
      setup({ config: ssoConfig({ after: '[profile default]\nregion = ap-southeast-1\n' }) }),
      'has a [profile default] section',
    );
  });

  it('~/.aws/credentials with any section or key; an empty or comment-only file is fine', async () => {
    for (const [text, message] of [
      [`[default]\n${STATIC}`, 'has 1 section(s)'],
      [`[some-other-profile]\n${STATIC}`, 'has 1 section(s)'],
      // Keys without a section are already refused by the configuration check (also exit 15).
      [STATIC, '~/.aws/credentials cannot be parsed safely'],
    ] as const) {
      const s = setup();
      writeFileSync(join(s.box.home, '.aws', 'credentials'), text, { mode: 0o600 });
      await refusedWith(s, message);
    }
    const empty = setup();
    writeFileSync(join(empty.box.home, '.aws', 'credentials'), '# no keys here\n', {
      mode: 0o600,
    });
    expect((await fallback(empty, '')).code).toBe(GUARD_EXIT.VERIFIED);
  });

  it('a "profile" key in ~/.cdk.json, cdk.json of the working directory or infra/cdk.json', async () => {
    const home = setup();
    writeFileSync(join(home.box.home, '.cdk.json'), JSON.stringify({ profile: 'admin' }));
    await refusedWith(home, '~/.cdk.json sets "profile"');

    const cwd = setup();
    const app = join(cwd.box.dir, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'cdk.json'), JSON.stringify({ app: 'node x.js', profile: 'admin' }));
    await refusedWith(cwd, 'cdk.json in the working directory sets "profile"', { cwd: app });

    const repo = setup();
    const root = join(repo.box.dir, 'repo');
    mkdirSync(join(root, 'infra'), { recursive: true });
    writeFileSync(join(root, 'infra', 'cdk.json'), JSON.stringify({ profile: 'admin' }));
    await refusedWith(repo, 'infra/cdk.json sets "profile"', { repoRoot: root });

    const broken = setup();
    writeFileSync(join(broken.box.home, '.cdk.json'), '{ not json');
    await refusedWith(broken, '~/.cdk.json cannot be parsed');

    const fine = setup();
    writeFileSync(join(fine.box.home, '.cdk.json'), JSON.stringify({ requireApproval: 'never' }));
    writeFileSync(join(fine.box.dir, 'cdk.json'), JSON.stringify({ app: 'node x.js' }));
    expect((await fallback(fine, '')).code).toBe(GUARD_EXIT.VERIFIED);
  });
});

describe('guard helpers', () => {
  it('maskPrincipalArn: account masked, session and user names never echoed', () => {
    expect(maskPrincipalArn(`arn:aws:sts::${SANDBOX}:assumed-role/${ROLE}/${SESSION}`)).toBe(
      `arn:aws:sts::********3333:assumed-role/${ROLE}/<session>`,
    );
    expect(maskPrincipalArn(`arn:aws:iam::${SANDBOX}:user/jane`)).toBe(
      'arn:aws:iam::********3333:user/<user>',
    );
    expect(maskPrincipalArn(`arn:aws:iam::${SANDBOX}:root`)).toBe('arn:aws:iam::********3333:root');
    expect(maskPrincipalArn('not an arn')).toBe('<unrecognized-principal>');
  });

  it('buildProblem: only from dist/; missing, stale or matching build-info', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aws-guard-dist-'));
    const dist = join(dir, 'dist');
    mkdirSync(dist);
    const here = join(dist, 'guard-cli.js');
    expect(buildProblem(join(dir, 'src', 'guard-cli.ts'), DIGEST)).toBeUndefined();
    expect(buildProblem(here, DIGEST)).toContain('build-info.json is missing');
    writeFileSync(join(dist, 'build-info.json'), JSON.stringify({ sourceSha256: 'a'.repeat(64) }));
    expect(buildProblem(here, DIGEST)).toContain('stale build');
    writeFileSync(join(dist, 'build-info.json'), JSON.stringify({ sourceSha256: DIGEST }));
    expect(buildProblem(here, DIGEST)).toBeUndefined();
  });
});
