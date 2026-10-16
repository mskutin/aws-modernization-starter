import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildChildEnv,
  CLI_PIN_COMMAND,
  createExecutor,
  ENV_FIXED,
  execFileRunner,
  resolveAwsCli,
  type AwsCli,
} from '../src/executor.ts';
import { BoundaryViolation, DENIED_FLAGS, flagMatches, type ProbeDef } from '../src/policy.ts';
import { PROBES, PROBES_BY_ID } from '../src/probes.ts';
import { fakeRunner, ok, ROLE, SANDBOX } from './support.ts';

/** Variables that must never reach the AWS CLI (values are fake). */
const SECRET_ENV: Record<string, string> = {
  AWS_ACCESS_KEY_ID: 'unused',
  AWS_SECRET_ACCESS_KEY: 'unused',
  AWS_SESSION_TOKEN: 'unused',
  AWS_PROFILE: 'admin',
  AWS_DEFAULT_PROFILE: 'admin',
  AWS_ROLE_ARN: 'arn:aws:iam::444455556666:role/x',
  AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/token',
  AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/creds',
  AWS_CONTAINER_AUTHORIZATION_TOKEN: 'unused',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  AWS_ENDPOINT_URL_STS: 'http://localhost:4566',
  AWS_CONFIG_FILE: '/tmp/other-config',
  AWS_SHARED_CREDENTIALS_FILE: '/tmp/other-credentials',
  AWS_DATA_PATH: '/tmp/models',
  AWS_DEFAULT_REGION: 'eu-west-1',
  AWS_REGION: 'eu-west-1',
  AWS_CA_BUNDLE: '/etc/ssl/corp-ca.pem',
  GITLAB_TOKEN: 'unused',
  NODE_OPTIONS: '--require /tmp/evil.js',
  PYTHONPATH: '/tmp/evil',
  PYTHONSTARTUP: '/tmp/evil.py',
};

const PARENT_ENV = {
  HOME: '/home/operator',
  PATH: '/usr/bin:/bin',
  LANG: 'en_SG.UTF-8',
  LC_ALL: 'en_SG.UTF-8',
  TZ: 'UTC',
  HTTPS_PROXY: 'http://proxy.example.internal:3128',
  no_proxy: '169.254.169.254',
  ...SECRET_ENV,
};

const CLI: AwsCli = {
  path: '/opt/aws/bin/aws',
  realpath: '/opt/aws/v2/dist/aws',
  sha256: 'f'.repeat(64),
  version: '2.35.11',
};

const VALUES = {
  account: SANDBOX,
  qualifier: 'starter',
  vpcId: 'vpc-00000000000000001',
  kmsKeyRef: 'alias/starter-data',
  boundaryPolicyArn: `arn:aws:iam::${SANDBOX}:policy/ExampleBoundary`,
  customerPolicyArn: `arn:aws:iam::${SANDBOX}:policy/team/ExampleCustom`,
  policyVersionId: 'v12',
  dbEngineVersion: '17.9',
  budgetName: 'sandbox-monthly',
  roleName: ROLE,
  policyName: 'AwsSSOInlinePolicy',
};

describe('child environment', () => {
  it('is built from scratch: pass-through allowlist (by name) plus fixed values', () => {
    const { env, passedThrough } = buildChildEnv(PARENT_ENV);
    expect(passedThrough).toEqual(
      ['AWS_CA_BUNDLE', 'HOME', 'HTTPS_PROXY', 'LANG', 'LC_ALL', 'PATH', 'TZ', 'no_proxy'].sort(),
    );
    expect(Object.keys(env).sort()).toEqual([...passedThrough, ...Object.keys(ENV_FIXED)].sort());
    expect(env).toMatchObject({
      AWS_PAGER: '',
      AWS_CLI_AUTO_PROMPT: 'off',
      AWS_RETRY_MODE: 'standard',
      AWS_MAX_ATTEMPTS: '3',
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_CLI_ERROR_FORMAT: 'legacy',
      // endpoint_url settings in ~/.aws/config are ignored even if one slipped through.
      AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
      PYTHONNOUSERSITE: '1',
    });
    for (const name of Object.keys(SECRET_ENV)) {
      if (name !== 'AWS_CA_BUNDLE') expect(env, name).not.toHaveProperty(name);
    }
  });

  it('reaches the runner unchanged for every call (secret variables never do)', async () => {
    const fake = fakeRunner({ 'ec2 describe-vpcs': ok({ Vpcs: [] }) });
    const executor = createExecutor({
      cli: CLI,
      profile: 'starter-sandbox-developer',
      parentEnv: PARENT_ENV,
      cwd: tmpdir(),
      timeoutMs: 1000,
      runner: fake.runner,
    });
    executor.unlockDiscovery();
    await executor.call({ probeId: 'b.ec2.vpcs', region: 'ap-southeast-1', values: {} });
    const [call] = fake.calls;
    expect(call?.envNames).not.toContain('AWS_ACCESS_KEY_ID');
    expect(call?.envNames).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(call?.envNames).not.toContain('AWS_SESSION_TOKEN');
    expect(call?.envNames).not.toContain('AWS_PROFILE');
    expect(call?.envNames).not.toContain('AWS_DATA_PATH');
    expect(call?.envNames.filter((n) => n.startsWith('AWS_ENDPOINT_URL'))).toEqual([]);
    expect(call?.envNames.filter((n) => n.startsWith('AWS_CONTAINER_'))).toEqual([]);
    expect(call?.env['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS']).toBe('true');
    expect(executor.passedThroughEnv).toContain('HOME');
    // The resolved real path is executed, not the PATH entry.
    expect(call?.file).toBe(CLI.realpath);
  });
});

describe('exec boundary', () => {
  const executorWith = (runner = fakeRunner({}).runner) =>
    createExecutor({
      cli: CLI,
      profile: 'starter-sandbox-developer',
      parentEnv: PARENT_ENV,
      cwd: tmpdir(),
      timeoutMs: 1000,
      runner,
    });

  it('rejects a probe id that is not in the allowlist, without starting a process', async () => {
    const fake = fakeRunner({});
    const executor = executorWith(fake.runner);
    executor.unlockDiscovery();
    for (const probeId of [
      'secretsmanager.get-secret-value',
      'b.ec2.vpcs.extra',
      '',
      '__proto__',
    ]) {
      await expect(
        executor.call({ probeId, region: 'ap-southeast-1', values: {} }),
      ).rejects.toThrow(BoundaryViolation);
    }
    expect(fake.calls).toEqual([]);
  });

  it('refuses discovery probes until the identity gate unlocks them (latch)', async () => {
    const fake = fakeRunner({});
    const executor = executorWith(fake.runner);
    await expect(
      executor.call({ probeId: 'b.ec2.vpcs', region: 'ap-southeast-1', values: {} }),
    ).rejects.toThrow(/discovery is locked until the identity gate has passed/);
    expect(fake.calls).toEqual([]);
    // Identity probes are allowed before (the gate) and after (the re-check).
    await executor.call({ probeId: 'identity.caller', region: 'ap-southeast-1', values: {} });
    executor.unlockDiscovery();
    await executor.call({ probeId: 'b.ec2.vpcs', region: 'ap-southeast-1', values: {} });
    await executor.call({
      probeId: 'identity.caller-recheck',
      region: 'ap-southeast-1',
      values: {},
    });
    expect(fake.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual([
      'sts get-caller-identity',
      'ec2 describe-vpcs',
      'sts get-caller-identity',
    ]);
  });

  it('refuses a registry entry that is missing from the independent boundary list', async () => {
    const forged: ProbeDef = {
      ...(PROBES_BY_ID.get('b.ec2.vpcs') as ProbeDef),
      id: 'x.forged.describe-instances',
      operation: 'describe-instances',
      iamAction: 'ec2:DescribeInstances',
    };
    const registry = PROBES_BY_ID as Map<string, ProbeDef>;
    registry.set(forged.id, forged);
    try {
      const fake = fakeRunner({});
      const executor = executorWith(fake.runner);
      executor.unlockDiscovery();
      await expect(
        executor.call({ probeId: forged.id, region: 'ap-southeast-1', values: {} }),
      ).rejects.toThrow(/not in the boundary list/);
      expect(fake.calls).toEqual([]);
    } finally {
      registry.delete(forged.id);
    }
  });

  it('rejects a region the probe does not allow and invalid placeholder values', async () => {
    const fake = fakeRunner({});
    const executor = executorWith(fake.runner);
    executor.unlockDiscovery();
    await expect(
      executor.call({ probeId: 'b.ec2.vpcs', region: 'us-east-1', values: {} }),
    ).rejects.toThrow(/region us-east-1/);
    await expect(
      executor.call({ probeId: 'a.org.parents', region: 'us-east-1', values: { account: '1234' } }),
    ).rejects.toThrow(/placeholder \{account\}/);
    for (const values of [
      { account: SANDBOX, budgetName: '--debug' },
      { account: SANDBOX, budgetName: '-x' },
    ]) {
      await expect(
        executor.call({ probeId: 'd.budgets.notifications', region: 'us-east-1', values }),
      ).rejects.toThrow(BoundaryViolation);
    }
    for (const roleName of ['--no-verify', '-debug', '--endpoint=x.example']) {
      await expect(
        executor.call({ probeId: 'identity.role', region: 'ap-southeast-1', values: { roleName } }),
      ).rejects.toThrow(/placeholder \{roleName\}/);
    }
    expect(fake.calls).toEqual([]);
  });

  it('refuses an invalid profile name (could be read as an option)', () => {
    expect(() =>
      createExecutor({
        cli: CLI,
        profile: '--debug',
        parentEnv: {},
        cwd: tmpdir(),
        timeoutMs: 1,
        runner: fakeRunner({}).runner,
      }),
    ).toThrow(BoundaryViolation);
  });

  it('builds a safe argv for every allowlisted probe in every permitted region', async () => {
    const fake = fakeRunner({});
    const executor = executorWith(fake.runner);
    executor.unlockDiscovery();
    let n = 0;
    for (const def of PROBES) {
      for (const region of def.regions) {
        await executor.call({ probeId: def.id, region, values: VALUES });
        n += 1;
      }
    }
    expect(fake.calls).toHaveLength(n);
    for (const call of fake.calls) {
      const argv = call.args;
      for (const flag of DENIED_FLAGS) {
        expect(
          argv.some((t) => flagMatches(t, flag)),
          `${argv.join(' ')} has ${flag}`,
        ).toBe(false);
      }
      const once = (flag: string) => argv.filter((t) => t === flag).length;
      expect(once('--profile')).toBe(1);
      expect(once('--region')).toBe(1);
      expect(argv[argv.indexOf('--output') + 1]).toBe('json');
      expect(once('--no-cli-pager')).toBe(1);
      expect(argv[argv.indexOf('--cli-connect-timeout') + 1]).toBe('10');
      expect(argv[argv.indexOf('--cli-read-timeout') + 1]).toBe('30');
      expect(argv[0]).toMatch(/^[a-z0-9-]+$/);
      expect(argv[1]).toMatch(/^(get|list|describe)-/);
      // Every interpolated value is bound to its option with '=' and never starts with '-'.
      for (const token of argv.slice(2)) {
        if (!token.startsWith('--')) expect(token.startsWith('-'), token).toBe(false);
      }
      expect(call.file).toBe(CLI.realpath);
    }
  });
});

describe('AWS CLI resolution (local --version only)', () => {
  const bin = (mode = 0o755, dirMode = 0o700) => {
    const dir = mkdtempSync(join(tmpdir(), 'aws-preflight-bin-'));
    const file = join(dir, 'aws');
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, mode);
    chmodSync(dir, dirMode);
    return { dir, file };
  };
  const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

  it('accepts exactly 2.35.11 and records the real path and SHA-256; refuses v1 and other v2 releases', async () => {
    const { file } = bin();
    const v2 = await resolveAwsCli({
      explicitPath: file,
      parentEnv: {},
      cwd: tmpdir(),
      runner: fakeRunner({}).runner,
    });
    expect(v2).toEqual({
      path: file,
      realpath: expect.any(String),
      sha256: sha(file),
      version: '2.35.11',
    });
    const v1 = await resolveAwsCli({
      explicitPath: file,
      parentEnv: {},
      cwd: tmpdir(),
      runner: fakeRunner({}, { version: '1.33.0' }).runner,
    });
    expect(v1).toEqual({ error: expect.stringContaining('AWS CLI v2 is required') });
    const newer = await resolveAwsCli({
      explicitPath: file,
      parentEnv: {},
      cwd: tmpdir(),
      runner: fakeRunner({}, { version: '2.35.12' }).runner,
    });
    expect(newer).toEqual({ error: expect.stringContaining('not the verified release 2.35.11') });
    expect((newer as { error: string }).error).toContain(CLI_PIN_COMMAND);
    expect(CLI_PIN_COMMAND).toBe(
      'nix shell github:NixOS/nixpkgs/e8be7818e19ada32105a8af937a6a473b38167ca#awscli2',
    );
  });

  it('executes the resolved real path of a symlinked CLI', async () => {
    const { file } = bin();
    const linkDir = mkdtempSync(join(tmpdir(), 'aws-preflight-link-'));
    chmodSync(linkDir, 0o755);
    const link = join(linkDir, 'aws');
    symlinkSync(file, link);
    const fake = fakeRunner({});
    const r = await resolveAwsCli({
      parentEnv: { PATH: linkDir },
      cwd: tmpdir(),
      runner: fake.runner,
    });
    expect(r).toMatchObject({ path: link, sha256: sha(file) });
    expect((r as AwsCli).realpath).not.toBe(link);
    expect(fake.calls[0]?.file).toBe((r as AwsCli).realpath);
  });

  it.each([
    ['the file is group-writable', 0o775, 0o700, 'the AWS CLI file'],
    ['the file is world-writable', 0o757, 0o700, 'the AWS CLI file'],
    ['its directory is group-writable', 0o755, 0o770, 'the directory of the AWS CLI'],
  ])('refuses a CLI when %s, without running it', async (_, mode, dirMode, what) => {
    const { file } = bin(mode, dirMode);
    const fake = fakeRunner({});
    const r = await resolveAwsCli({
      explicitPath: file,
      parentEnv: {},
      cwd: tmpdir(),
      runner: fake.runner,
    });
    expect(r).toEqual({ error: expect.stringContaining(`${what} (`) });
    expect((r as { error: string }).error).toContain('writable by group or others');
    expect(fake.calls).toEqual([]);
  });

  it('refuses a missing CLI and never searches relative PATH entries', async () => {
    const { dir } = bin();
    const fake = fakeRunner({});
    expect(
      await resolveAwsCli({ parentEnv: { PATH: '/nonexistent' }, cwd: dir, runner: fake.runner }),
    ).toEqual({
      error: expect.stringContaining('not found on PATH'),
    });
    // `aws` exists in the cwd, but "." and "" are never searched.
    expect(
      await resolveAwsCli({
        parentEnv: { PATH: `.::${'/nonexistent'}` },
        cwd: dir,
        runner: fake.runner,
      }),
    ).toEqual({
      error: expect.stringContaining('not found on PATH'),
    });
    expect(fake.calls).toEqual([]);
    const found = await resolveAwsCli({
      parentEnv: { PATH: `/nonexistent:${dir}` },
      cwd: tmpdir(),
      runner: fake.runner,
    });
    expect(found).toMatchObject({ path: join(dir, 'aws'), version: '2.35.11' });
  });

  it('refuses an --aws-cli path that is not an executable file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aws-preflight-noexec-'));
    mkdirSync(join(dir, 'sub'));
    const r = await resolveAwsCli({
      explicitPath: join(dir, 'sub'),
      parentEnv: {},
      cwd: tmpdir(),
      runner: fakeRunner({}).runner,
    });
    expect(r).toEqual({ error: expect.stringContaining('not an executable file') });
  });
});

describe('execFile runner (real child processes, no AWS)', () => {
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('kills the child with SIGKILL when the wall-clock timeout fires', async () => {
    const r = await execFileRunner({
      file: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      env: {},
      cwd: tmpdir(),
      timeoutMs: 300,
      maxBuffer: 1024,
    });
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe('SIGKILL');
    expect(r.pid).toBeTypeOf('number');
    expect(isAlive(r.pid ?? -1)).toBe(false);
  });

  it('closes stdin (a prompt reads EOF instead of hanging) and passes only the given env', async () => {
    const script =
      "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({stdin:d,env:Object.keys(process.env).sort()}))})";
    const r = await execFileRunner({
      file: process.execPath,
      args: ['-e', script],
      env: { ONLY_THIS: '1' },
      cwd: tmpdir(),
      timeoutMs: 10_000,
      maxBuffer: 1024 * 1024,
    });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { stdin: string; env: string[] };
    expect(parsed.stdin).toBe('');
    expect(parsed.env).toContain('ONLY_THIS');
    expect(parsed.env).not.toContain('HOME');
  });

  it('reports a process that cannot be started', async () => {
    const r = await execFileRunner({
      file: join(tmpdir(), 'definitely-not-here-aws'),
      args: ['--version'],
      env: {},
      cwd: tmpdir(),
      timeoutMs: 5000,
      maxBuffer: 1024,
    });
    expect(r.spawnError).toBe('ENOENT');
  });

  it('refuses oversized output', async () => {
    const r = await execFileRunner({
      file: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(4096))"],
      env: {},
      cwd: tmpdir(),
      timeoutMs: 10_000,
      maxBuffer: 1024,
    });
    expect(r.outputTooLarge).toBe(true);
  });
});
