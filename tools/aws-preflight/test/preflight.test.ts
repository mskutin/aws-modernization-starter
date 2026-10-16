import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/types.ts';
import {
  fakeRunner,
  happyResponses,
  liveArgs,
  PROFILE,
  runCli,
  sandbox,
  SANDBOX,
  ssoConfig,
} from './support.ts';

/** Removes `--flag value` (or a boolean flag) from argv. */
const without = (argv: string[], flag: string) => {
  const i = argv.indexOf(flag);
  return i < 0 ? argv : [...argv.slice(0, i), ...argv.slice(i + 2)];
};
const replace = (argv: string[], flag: string, value: string) =>
  argv.map((t, i) => (argv[i - 1] === flag ? value : t));
const ATTEST = 'AccountDiscovery permission set, checked by the platform owner';
const ACCEPT = 'Developer permission set accepted by the account owner for one run, 2026-10-14';

describe('refuses to run before any AWS call (exit 2)', () => {
  it.each([
    ['--profile missing', (a: string[]) => without(a, '--profile')],
    ['--expected-account missing', (a: string[]) => without(a, '--expected-account')],
    ['--expected-role-pattern missing', (a: string[]) => without(a, '--expected-role-pattern')],
    [
      '--expected-account with 11 digits',
      (a: string[]) => replace(a, '--expected-account', '11112222333'),
    ],
    [
      '--expected-account not numeric',
      (a: string[]) => replace(a, '--expected-account', 'sandbox-acct'),
    ],
    ['--profile starting with -', (a: string[]) => replace(a, '--profile', '-debug')],
    ['--profile with a space', (a: string[]) => replace(a, '--profile', 'my profile')],
    [
      'a role pattern that matches anything',
      (a: string[]) => replace(a, '--expected-role-pattern', '*'),
    ],
    [
      'a role pattern with regex syntax',
      (a: string[]) => replace(a, '--expected-role-pattern', 'Admin.*|x'),
    ],
    ['a malformed --region', (a: string[]) => replace(a, '--region', 'ap-southeast')],
    ['an availability zone as --region', (a: string[]) => replace(a, '--region', 'eu-west-1a')],
    ['a region of the aws-cn partition', (a: string[]) => replace(a, '--region', 'cn-north-1')],
    ['a GovCloud region', (a: string[]) => replace(a, '--region', 'us-gov-west-1')],
    ['--region given twice', (a: string[]) => [...a, '--region', 'ap-southeast-1']],
    ['an invalid --vpc-id', (a: string[]) => [...a, '--vpc-id', 'vpc-123;rm']],
    [
      'an invalid --kms-key',
      (a: string[]) => [...a, '--kms-key', 'arn:aws:kms:ap-southeast-1:111122223333:key/x'],
    ],
    [
      'a boundary policy in another account',
      (a: string[]) => [...a, '--boundary-policy-arn', 'arn:aws:iam::444455556666:policy/B'],
    ],
    ['an invalid --db-engine-version', (a: string[]) => [...a, '--db-engine-version', '17']],
    ['an invalid --qualifier', (a: string[]) => [...a, '--qualifier', 'BASE-REF']],
    [
      'an attestation with an e-mail address',
      (a: string[]) => [...a, '--attest-read-only', 'approved by jane.doe@example.com'],
    ],
    [
      'an attestation with a URL-encoded e-mail address',
      (a: string[]) => [...a, '--attest-read-only', 'approved by jane.doe%40example.com ok'],
    ],
    [
      'an attestation with an account ID',
      (a: string[]) => [...a, '--attest-read-only', `AccountDiscovery in ${SANDBOX} ok`],
    ],
    [
      'an attestation with a hyphenated account ID',
      (a: string[]) => [...a, '--attest-read-only', 'AccountDiscovery in 1111-2222-3333 ok'],
    ],
    [
      'an attestation with a phone number',
      (a: string[]) => [
        ...a,
        '--attest-read-only',
        'approved by Alex Example, call +1 202 555 0143',
      ],
    ],
    [
      'an acceptance with an e-mail address',
      (a: string[]) => [...a, '--accept-write-capable', 'accepted by jane.doe@example.com'],
    ],
    ['an acceptance that is too short', (a: string[]) => [...a, '--accept-write-capable', 'ok']],
    [
      'both human statements (mutually exclusive)',
      (a: string[]) => [...a, '--attest-read-only', ATTEST, '--accept-write-capable', ACCEPT],
    ],
    ['--call-timeout out of range', (a: string[]) => [...a, '--call-timeout', '0']],
    ['an unknown option', (a: string[]) => [...a, '--endpoint-url', 'http://localhost']],
    ['an unknown command', (a: string[]) => ['deploy', ...a.slice(1)]],
  ])('%s', async (_, mutate) => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses());
    const r = await runCli(mutate(liveArgs('discover', box)), fake.runner);
    expect(r.code).toBe(EXIT.REFUSED);
    expect(fake.calls).toEqual([]);
    expect(existsSync(box.evidence)).toBe(false);
    for (const line of [...r.out, ...r.err]) {
      expect(line).not.toContain('jane.doe');
    }
  });

  it('names the problem of both statements', async () => {
    const box = sandbox();
    const r = await runCli(
      [
        ...liveArgs('identity', box),
        '--attest-read-only',
        ATTEST,
        '--accept-write-capable',
        ACCEPT,
      ],
      fakeRunner({}).runner,
    );
    expect(r.code).toBe(EXIT.REFUSED);
    expect(r.err.join('\n')).toContain('mutually exclusive');
  });

  it.each(['CI', 'GITLAB_CI'])('%s is set: no live discovery in pipelines', async (name) => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses());
    for (const command of ['identity', 'discover'] as const) {
      const r = await runCli(liveArgs(command, box), fake.runner, {
        env: { PATH: '/usr/bin', HOME: box.home, [name]: 'true' },
      });
      expect(r.code).toBe(EXIT.REFUSED);
      expect(r.err.join('\n')).toContain('never runs in a pipeline');
    }
    // Even an empty value counts as "set".
    const r = await runCli(liveArgs('discover', box), fake.runner, {
      env: { PATH: '/usr/bin', HOME: box.home, [name]: '' },
    });
    expect(r.code).toBe(EXIT.REFUSED);
    expect(fake.calls).toEqual([]);
    expect(readdirSync(box.rawDir)).toEqual([]);
  });

  it('HOME is not set (the AWS CLI configuration could not be checked)', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses());
    const r = await runCli(liveArgs('discover', box), fake.runner, { env: { PATH: '/usr/bin' } });
    expect(r.code).toBe(EXIT.REFUSED);
    expect(r.err.join('\n')).toContain('HOME must be an absolute path');
    expect(fake.calls).toEqual([]);
  });

  it.each([
    [
      '~/.aws/cli/alias',
      (home: string) => {
        mkdirSync(join(home, '.aws', 'cli'));
        writeFileSync(
          join(home, '.aws', 'cli', 'alias'),
          '[toplevel]\nwhoami = sts get-caller-identity\n',
        );
      },
      'cli/alias exists',
    ],
    [
      '~/.aws/models',
      (home: string) => mkdirSync(join(home, '.aws', 'models')),
      '~/.aws/models exists',
    ],
    [
      'a [plugins] section',
      (home: string) =>
        writeFileSync(
          join(home, '.aws', 'config'),
          ssoConfig({ after: '[plugins]\ncli_legacy_plugin_path = /tmp/p\nmyplugin = evil\n' }),
        ),
      'has a [plugins] section',
    ],
    [
      'an endpoint_url in the profile',
      (home: string) =>
        writeFileSync(
          join(home, '.aws', 'config'),
          ssoConfig({ profileExtra: 'endpoint_url = https://proxy.example.test' }),
        ),
      'sets endpoint_url',
    ],
    [
      'a credential_process in another profile',
      (home: string) =>
        writeFileSync(
          join(home, '.aws', 'config'),
          ssoConfig({ after: '[profile other]\ncredential_process = /tmp/evil\n' }),
        ),
      'sets credential_process',
    ],
    [
      'static keys for the profile in the credentials file',
      (home: string) =>
        writeFileSync(
          join(home, '.aws', 'credentials'),
          `[${PROFILE}]\naws_access_key_id = unused\n`,
        ),
      'has a [starter-sandbox-developer] section',
    ],
    [
      'an sso_account_id that is not --expected-account',
      (home: string) =>
        writeFileSync(join(home, '.aws', 'config'), ssoConfig({ account: '444455556666' })),
      'ACCOUNT MISMATCH (offline)',
    ],
    [
      'an sso_role_name the role pattern cannot match',
      (home: string) =>
        writeFileSync(
          join(home, '.aws', 'config'),
          ssoConfig({ ssoRoleName: 'AdministratorAccess' }),
        ),
      'cannot match the profile',
    ],
  ])(
    'the AWS CLI configuration has %s: refused before ANY aws process',
    async (_, setup, message) => {
      const box = sandbox();
      setup(box.home);
      const fake = fakeRunner(happyResponses());
      const r = await runCli(liveArgs('discover', box), fake.runner);
      expect(r.code).toBe(EXIT.REFUSED);
      expect(r.err.join('\n')).toContain(message);
      expect(r.err.join('\n')).toContain('Nothing was run');
      // Not even `aws --version`: plugins and aliases load in every aws process.
      expect(fake.calls).toEqual([]);
      expect(readdirSync(box.rawDir)).toEqual([]);
      expect(r.err.join('\n')).not.toContain('444455556666');
    },
  );

  it('the raw output directory is inside a git work tree', async () => {
    const box = sandbox();
    const repo = join(box.dir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const fake = fakeRunner(happyResponses());
    const argv = replace(liveArgs('discover', box), '--raw-dir', join(repo, 'raw'));
    const r = await runCli(argv, fake.runner);
    expect(r.code).toBe(EXIT.REFUSED);
    expect(r.err.join('\n')).toContain('inside the git work tree');
    expect(fake.calls).toEqual([]);
    expect(existsSync(join(repo, 'raw'))).toBe(false);
  });

  it('the raw output directory is a symlink into a git work tree', async () => {
    const box = sandbox();
    const repo = join(box.dir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'raw'), { mode: 0o700 });
    const link = join(box.dir, 'raw-link');
    symlinkSync(join(repo, 'raw'), link);
    const fake = fakeRunner(happyResponses());
    const r = await runCli(replace(liveArgs('discover', box), '--raw-dir', link), fake.runner);
    expect(r.code).toBe(EXIT.REFUSED);
    expect(r.err.join('\n')).toContain('resolves into the git work tree');
    expect(fake.calls).toEqual([]);
    expect(readdirSync(join(repo, 'raw'))).toEqual([]);
  });

  it('the raw output base is writable by others', async () => {
    const box = sandbox();
    const shared = join(box.dir, 'shared');
    mkdirSync(shared, { mode: 0o777 });
    chmodSync(shared, 0o777);
    const fake = fakeRunner(happyResponses());
    const r = await runCli(replace(liveArgs('discover', box), '--raw-dir', shared), fake.runner);
    expect(r.code).toBe(EXIT.REFUSED);
    expect(r.err.join('\n')).toContain('writable by group or others');
    expect(fake.calls).toEqual([]);
  });

  it('the AWS CLI is v1 (only `aws --version` ran)', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses(), { version: '1.33.9' });
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.REFUSED);
    expect(r.err.join('\n')).toContain('AWS CLI v2 is required');
    expect(fake.calls.map((c) => c.args)).toEqual([['--version']]);
    expect(fake.awsCalls()).toEqual([]);
  });

  it('the AWS CLI is not the verified release (only `aws --version` ran)', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses(), { version: '2.35.12' });
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.REFUSED);
    expect(r.err.join('\n')).toContain('not the verified release 2.35.11');
    expect(r.err.join('\n')).toContain('nix shell github:NixOS/nixpkgs/');
    expect(fake.awsCalls()).toEqual([]);
  });

  it('the AWS CLI directory is writable by group (nothing ran)', async () => {
    const box = sandbox();
    chmodSync(join(box.dir, 'bin'), 0o775);
    const fake = fakeRunner(happyResponses());
    const r = await runCli(liveArgs('discover', box), fake.runner);
    expect(r.code).toBe(EXIT.REFUSED);
    expect(r.err.join('\n')).toContain('writable by group or others');
    expect(fake.calls).toEqual([]);
  });

  it('the AWS CLI is missing', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses());
    const r = await runCli(
      replace(liveArgs('discover', box), '--aws-cli', join(box.dir, 'no-such-aws')),
      fake.runner,
    );
    expect(r.code).toBe(EXIT.REFUSED);
    expect(fake.calls).toEqual([]);
  });

  it('the raw directory is created privately (0700, run.json 0600) only when the run starts', async () => {
    const box = sandbox();
    const fake = fakeRunner(happyResponses());
    const r = await runCli(liveArgs('identity', box), fake.runner);
    expect(r.code).toBe(EXIT.OK);
    const runs = readdirSync(box.rawDir);
    expect(runs).toEqual(['20261014T053000Z-a1b2c3']);
    const dir = join(box.rawDir, runs[0] ?? '');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777, f).toBe(0o600);
  });

  it('plan needs no arguments, no credentials and no AWS CLI, even in CI', async () => {
    const fake = fakeRunner({});
    for (const format of ['markdown', 'json', 'iam-policy']) {
      const r = await runCli(['plan', '--format', format], fake.runner, { env: { CI: 'true' } });
      expect(r.code).toBe(EXIT.OK);
      expect(r.out.join('\n').length).toBeGreaterThan(100);
    }
    expect(fake.calls).toEqual([]);
  });
});
