/**
 * scripts/sandbox-guard.sh end to end: the real helper (copied next to a dist/guard-cli.js that
 * runs the real src/guard-cli.ts), a fake `aws` on PATH that records every call and answers from a
 * scenario, and a fake child command that records its arguments and the AWS_* variables it saw.
 * Runs /bin/bash (3.2 on macOS) under `set -euo pipefail` unless a test says otherwise.
 */
import { execFile } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeHome, OTHER, PROFILE, ROLE, SANDBOX, SESSION, ssoExpired } from './support.ts';

const HELPER = fileURLToPath(new URL('../scripts/sandbox-guard.sh', import.meta.url));
const REGION_HELPER = fileURLToPath(new URL('../scripts/region.sh', import.meta.url));
const GUARD_SRC = fileURLToPath(new URL('../src/guard-cli.ts', import.meta.url));
/** /bin/bash by default (3.2 on macOS); SANDBOX_GUARD_TEST_BASH runs the suite with another bash. */
const BASH = process.env['SANDBOX_GUARD_TEST_BASH'] ?? '/bin/bash';

const CALLER = {
  stdout: {
    UserId: `AROAFAKEROLEID00000001:${SESSION}`,
    Account: SANDBOX,
    Arn: `arn:aws:sts::${SANDBOX}:assumed-role/${ROLE}/${SESSION}`,
  },
};
const MISMATCH = {
  stdout: { Account: OTHER, Arn: `arn:aws:sts::${OTHER}:assumed-role/${ROLE}/${SESSION}` },
};

type Scenario = Record<string, unknown>;

interface World {
  readonly dir: string;
  readonly tool: string;
  readonly bin: string;
  readonly home: string;
  readonly log: string;
  readonly accountFile: string;
  readonly marker: string;
  readonly calls: () => string[];
  readonly logLines: () => Record<string, unknown>[];
}

function world(scenario: Scenario = { 'sts get-caller-identity': [CALLER] }): World {
  const dir = mkdtempSync(join(tmpdir(), 'aws-guard-sh-'));
  // The tool tree: the real helper and a dist/guard-cli.js that runs the real sources.
  const tool = join(dir, 'tool');
  mkdirSync(join(tool, 'scripts'), { recursive: true });
  mkdirSync(join(tool, 'dist'));
  copyFileSync(HELPER, join(tool, 'scripts', 'sandbox-guard.sh'));
  copyFileSync(REGION_HELPER, join(tool, 'scripts', 'region.sh'));
  writeFileSync(
    join(tool, 'dist', 'guard-cli.js'),
    `import { main } from ${JSON.stringify(GUARD_SRC)};\nprocess.exitCode = await main(process.argv.slice(2));\n`,
  );
  const bin = join(dir, 'bin');
  mkdirSync(bin, { mode: 0o755 });
  chmodSync(bin, 0o755);
  // Fake AWS CLI: records argv, answers the n-th call of an operation with scenario[op][n] (the
  // last entry repeats).
  const callsFile = join(dir, 'calls.log');
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  writeFileSync(
    join(bin, 'aws'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, args.slice(0, 2).join(' ') + '\\n');
if (args[0] === '--version') { process.stdout.write('aws-cli/2.35.11 Python/3.14.7 Darwin/25 source/arm64\\n'); process.exit(0); }
const op = args[0] + ' ' + args[1];
const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'scenario.json'))}, 'utf8'));
const list = scenario[op] || [{ stdout: {} }];
const n = fs.readFileSync(${JSON.stringify(callsFile)}, 'utf8').split('\\n').filter((l) => l === op).length;
const r = list[Math.min(n, list.length) - 1];
if (r.stderr) process.stderr.write(r.stderr);
if (r.stdout !== undefined) process.stdout.write(JSON.stringify(r.stdout));
process.exit(r.exit === undefined ? 0 : r.exit);
`,
  );
  chmodSync(join(bin, 'aws'), 0o755);
  // Fake mutating command: prints what it received, leaves a marker, exits with $CHILD_EXIT.
  const marker = join(dir, 'child-ran');
  writeFileSync(
    join(bin, 'child'),
    `#!/bin/sh
touch ${JSON.stringify(marker)}
echo "AWS_PROFILE=\${AWS_PROFILE-<unset>} AWS_REGION=\${AWS_REGION-<unset>} AWS_DEFAULT_REGION=\${AWS_DEFAULT_REGION-<unset>}"
for a in "$@"; do echo "arg:$a"; done
exit "\${CHILD_EXIT:-0}"
`,
  );
  chmodSync(join(bin, 'child'), 0o755);
  const home = makeHome(dir);
  const accountFile = join(dir, 'expected-account');
  writeFileSync(accountFile, `${SANDBOX}\n`, { mode: 0o600 });
  const run = join(dir, 'run');
  mkdirSync(run, { mode: 0o700 });
  const log = join(run, 'guard.log');
  return {
    dir,
    tool,
    bin,
    home,
    log,
    accountFile,
    marker,
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean)
        : [],
    logLines: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [],
  };
}

function bash(
  w: World,
  body: string,
  options: { env?: Record<string, string>; strict?: boolean; interactive?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = join(w.dir, `script-${Math.random().toString(16).slice(2)}.sh`);
  writeFileSync(
    script,
    [
      options.strict === false ? '' : 'set -euo pipefail',
      `source ${JSON.stringify(join(w.tool, 'scripts', 'sandbox-guard.sh'))}`,
      body,
      '',
    ].join('\n'),
  );
  const env: Record<string, string> = {
    PATH: `${w.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: w.home,
    LANG: 'C.UTF-8',
    SANDBOX_PROFILE: PROFILE,
    SANDBOX_EXPECTED_ACCOUNT_FILE: w.accountFile,
    SANDBOX_GUARD_LOG: w.log,
    ...options.env,
  };
  for (const [k, v] of Object.entries(env)) if (v === '<unset>') delete env[k];
  return new Promise((done) => {
    execFile(
      BASH,
      options.interactive ? ['-i', script] : [script],
      { env, cwd: w.dir, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? -1 : 0;
        done({ code, stdout, stderr });
      },
    );
  });
}

const stsCalls = (w: World) => w.calls().filter((c) => c === 'sts get-caller-identity').length;

describe('sandbox-guard.sh: verified path', () => {
  it(
    'init pins the variables; guarded runs the executable with them, arguments verbatim (no eval)',
    { timeout: 60_000 },
    async () => {
      const w = world();
      const r = await bash(
        w,
        [
          'sandbox_guard_init',
          `guarded "cdk deploy Sandbox-Foundation" -- child 'a b' '$(touch ${w.dir}/pwned)' ';' '*' '--'`,
          'echo "after: AWS_PROFILE=$AWS_PROFILE"',
        ].join('\n'),
      );
      expect(r.stderr).not.toContain('REFUSED');
      expect(r.code).toBe(0);
      // stdout holds the child's output only: the guard's JSON lines go to stderr.
      expect(r.stdout).toBe(
        [
          `AWS_PROFILE=${PROFILE} AWS_REGION=ap-southeast-1 AWS_DEFAULT_REGION=ap-southeast-1`,
          'arg:a b',
          `arg:$(touch ${w.dir}/pwned)`,
          'arg:;',
          'arg:*',
          'arg:--',
          `after: AWS_PROFILE=${PROFILE}`,
          '',
        ].join('\n'),
      );
      expect(existsSync(join(w.dir, 'pwned'))).toBe(false);
      // One STS call per check: init + the guarded command.
      expect(stsCalls(w)).toBe(2);
      const lines = w.logLines();
      expect(lines.map((l) => [l['result'], l['label']])).toEqual([
        ['verified', 'sandbox_guard_init'],
        ['verified', 'cdk deploy Sandbox-Foundation'],
      ]);
      expect(lines[1]).toMatchObject({
        account: '********3333',
        principalArn: `arn:aws:sts::********3333:assumed-role/${ROLE}/<session>`,
        principalType: 'assumed-role',
        region: 'ap-southeast-1',
        profile: PROFILE,
        executionProfile: 'personal-sandbox',
      });
      expect(r.stderr).toContain('"result":"verified"');
      expect(`${r.stdout}${r.stderr}${readFileSync(w.log, 'utf8')}`).not.toContain(SANDBOX);
      expect(`${r.stdout}${r.stderr}`).not.toContain(SESSION);
    },
  );

  it('guarded returns the command exit code unchanged; under set -e the script stops with it', async () => {
    const w = world();
    const lenient = await bash(
      w,
      'sandbox_guard_init\nguarded "x" -- child\necho "rc=$?"\nguarded "y" -- child && echo "never"\necho "rc=$?"',
      { strict: false, env: { CHILD_EXIT: '42' } },
    );
    expect(lenient.code).toBe(0);
    expect(lenient.stdout).toContain('rc=42');
    expect(lenient.stdout).not.toContain('never');
    const strict = await bash(w, 'sandbox_guard_init\nguarded "x" -- child\necho "after"', {
      env: { CHILD_EXIT: '7' },
    });
    expect(strict.code).toBe(7);
    expect(strict.stdout).not.toContain('after');
  });

  it('the child gets the pinned variables even after the script un-exports them', async () => {
    const w = world();
    const r = await bash(
      w,
      [
        'sandbox_guard_init',
        'export -n AWS_PROFILE AWS_REGION AWS_DEFAULT_REGION',
        'guarded "x" -- child',
      ].join('\n'),
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      `AWS_PROFILE=${PROFILE} AWS_REGION=ap-southeast-1 AWS_DEFAULT_REGION=ap-southeast-1`,
    );
  });

  it('accepts AWS_PROFILE / AWS_REGION already equal to the selection; init is idempotent', async () => {
    const w = world();
    const r = await bash(w, 'sandbox_guard_init\nsandbox_guard_init\nguarded "x" -- child', {
      env: { AWS_PROFILE: PROFILE, AWS_REGION: 'ap-southeast-1' },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(stsCalls(w)).toBe(3);
  });
});

describe('sandbox-guard.sh: refusals stop the script before the command runs', () => {
  const refused = async (
    w: World,
    body: string,
    code: number,
    message: string,
    env: Record<string, string> = {},
  ) => {
    const r = await bash(w, `${body}\necho "after"`, { env });
    expect(r.code, r.stderr).toBe(code);
    expect(r.stderr).toContain(message);
    expect(r.stdout).not.toContain('after');
    expect(existsSync(w.marker)).toBe(false);
    return r;
  };

  it('account mismatch at a later check: exit 3, the command never runs, logged as refused', async () => {
    const w = world({ 'sts get-caller-identity': [CALLER, MISMATCH] });
    await refused(w, 'sandbox_guard_init\nguarded "cdk deploy" -- child', 3, 'ACCOUNT MISMATCH');
    expect(stsCalls(w)).toBe(2);
    expect(w.logLines().map((l) => [l['result'], l['reason'] ?? null])).toEqual([
      ['verified', null],
      ['refused', 'account-mismatch'],
    ]);
    expect(readFileSync(w.log, 'utf8')).not.toContain(OTHER);
  });

  it('expired SSO session: exit 6; STS failure: exit 13', async () => {
    const expired = world({ 'sts get-caller-identity': [ssoExpired] });
    await refused(expired, 'sandbox_guard_init', 6, 'aws sso login --profile');
    const failing = world({
      'sts get-caller-identity': [
        { stderr: '\nCould not connect to the endpoint URL: "https://sts"\n', exit: 255 },
      ],
    });
    await refused(failing, 'sandbox_guard_init', 13, 'sts get-caller-identity failed');
  });

  it.each([
    [{ AWS_ACCESS_KEY_ID: 'value-not-printed' }, 12, 'static credentials'],
    [{ AWS_SESSION_TOKEN: 'value-not-printed' }, 12, 'static credentials'],
    [{ AWS_DEFAULT_PROFILE: PROFILE }, 12, 'AWS_DEFAULT_PROFILE'],
    [{ AWS_PROFILE: 'admin' }, 12, 'AWS_PROFILE is set to a different profile'],
    [{ AWS_ENDPOINT_URL_STS: 'http://127.0.0.1:4566' }, 12, 'AWS_ENDPOINT_URL_STS'],
    [{ AWS_CONFIG_FILE: '/tmp/other' }, 12, 'AWS_CONFIG_FILE'],
    [{ AWS_REGION: 'eu-west-1' }, 10, 'AWS_REGION is set to a different region'],
    [{ SANDBOX_REGION: 'cn-north-1' }, 10, 'the region must be an aws-partition region name'],
    [{ SANDBOX_REGION: 'us-gov-west-1' }, 10, 'the region must be an aws-partition region name'],
    [{ SANDBOX_REGION: 'Nowhere' }, 10, 'the region must be an aws-partition region name'],
    [
      { SANDBOX_REGION: 'eu-west-1', AWS_REGION: 'ap-southeast-1' },
      10,
      'AWS_REGION is set to a different region than eu-west-1',
    ],
    [{ SANDBOX_PROFILE: '<unset>' }, 11, 'select the sandbox profile explicitly'],
    [{ SANDBOX_PROFILE: '   ' }, 11, 'select the sandbox profile explicitly'],
    [{ SANDBOX_PROFILE: 'default' }, 11, 'the default profile is never used'],
    [{ SANDBOX_GUARD_LOG: '<unset>' }, 2, 'SANDBOX_GUARD_LOG'],
  ])('init with %o: exit %i, no AWS process', async (env, code, message) => {
    const w = world();
    const r = await refused(w, 'sandbox_guard_init', code, message, env);
    expect(w.calls()).toEqual([]);
    expect(r.stderr).not.toContain('value-not-printed');
  });

  it('without region.sh next to it, init refuses (exit 17) before any AWS process', async () => {
    const w = world();
    rmSync(join(w.tool, 'scripts', 'region.sh'));
    await refused(w, 'sandbox_guard_init', 17, 'region.sh (next to sandbox-guard.sh) is missing');
    expect(w.calls()).toEqual([]);
  });

  it('another configured region is pinned and checked like the default', async () => {
    const w = world();
    const r = await bash(w, 'sandbox_guard_init\nguarded "l" -- child', {
      env: { SANDBOX_REGION: 'eu-west-1' },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('AWS_REGION=eu-west-1 AWS_DEFAULT_REGION=eu-west-1');
    expect(w.logLines().map((l) => l['region'])).toEqual(['eu-west-1', 'eu-west-1']);
  });

  it('a profile not in ~/.aws/config is refused by the TS check (exit 11), still before any AWS process', async () => {
    const w = world();
    await refused(w, 'sandbox_guard_init', 11, 'not defined', { SANDBOX_PROFILE: 'other-profile' });
    expect(w.calls()).toEqual([]);
  });

  it('drift after init (AWS_PROFILE changed, static keys exported, region changed): refused', async () => {
    for (const [change, code, message] of [
      ['export AWS_PROFILE=admin', 12, 'AWS_PROFILE is set to a different profile'],
      ['unset AWS_PROFILE', 12, 'no longer holds the pinned profile'],
      ['export AWS_ACCESS_KEY_ID=x', 12, 'static credentials'],
      ['export AWS_REGION=us-east-1', 10, 'AWS_REGION is set to a different region'],
    ] as const) {
      const w = world();
      await refused(w, `sandbox_guard_init\n${change}\nguarded "x" -- child`, code, message);
      expect(stsCalls(w)).toBe(1);
    }
  });

  it('guarded refuses shell functions, builtins, a missing command and a bad call (exit 2, no STS)', async () => {
    for (const [body, message] of [
      ['my_fn() { child; }\nguarded "x" -- my_fn', 'is not an executable on PATH'],
      ['guarded "x" -- eval child', 'is not an executable on PATH'],
      ['guarded "x" -- ./nope', 'is not an executable file'],
      ['guarded "x" child', 'usage: guarded'],
      ['guarded "x" -- -child', 'must not start with -'],
    ] as const) {
      const w = world();
      await refused(w, `sandbox_guard_init\n${body}`, 2, message);
      expect(stsCalls(w)).toBe(1);
    }
  });

  it('guarded refuses a command that overrides the pinned selection or is a shell/wrapper (no STS)', async () => {
    for (const [cmd, code, message] of [
      ['child --profile admin s3 ls', 12, 'selects another profile (--profile)'],
      ['child --profile=admin', 12, 'selects another profile (--profile)'],
      ['child --region us-east-1', 10, 'selects another region (--region)'],
      ['child --region=us-east-1', 10, 'selects another region (--region)'],
      ['child --endpoint-url http://127.0.0.1:4566', 12, 'overrides the endpoint'],
      ['env AWS_PROFILE=admin child', 2, 'env is refused'],
      ['child AWS_PROFILE=admin', 12, 'assigns an AWS_* variable'],
      ["bash -c 'child'", 2, 'bash is refused'],
      ["/bin/sh -c 'child'", 2, 'sh is refused'],
    ] as const) {
      const w = world();
      await refused(w, `sandbox_guard_init\nguarded "x" -- ${cmd}`, code, message);
      expect(stsCalls(w)).toBe(1);
    }
    // The pinned values themselves are fine.
    const w = world();
    const r = await bash(
      w,
      `sandbox_guard_init\nguarded "x" -- child --profile ${PROFILE} --region=ap-southeast-1`,
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`arg:${PROFILE}`);
  });

  it('abbreviated --profile / --region / --endpoint-url (AWS CLI argparse prefixes) are refused', async () => {
    for (const [cmd, code, message] of [
      ['child --prof admin s3 ls', 12, 'selects another profile (--prof)'],
      ['child --pro=admin', 12, 'selects another profile (--pro)'],
      ['child --profil admin', 12, 'selects another profile (--profil)'],
      ['child --reg us-east-1', 10, 'selects another region (--reg)'],
      ['child --regio=us-east-1', 10, 'selects another region (--regio)'],
      ['child --endp http://127.0.0.1:4566', 12, 'overrides the endpoint (--endp)'],
      ['child --end=http://127.0.0.1:4566', 12, 'overrides the endpoint (--end)'],
      ['child --endpoint http://127.0.0.1:4566', 12, 'overrides the endpoint (--endpoint)'],
    ] as const) {
      const w = world();
      await refused(w, `sandbox_guard_init\nguarded "x" -- ${cmd}`, code, message);
      expect(stsCalls(w)).toBe(1);
    }
    // Pinned values, two-character prefixes and unrelated options that share letters stay allowed.
    const w = world();
    const r = await bash(
      w,
      `sandbox_guard_init\nguarded "x" -- child --prof ${PROFILE} --reg=ap-southeast-1 --pr x --registry-id y --end-time z --propagate-tags`,
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('arg:--propagate-tags');
  });

  it('wrappers and inline interpreter code are refused, also through a renamed symlink', async () => {
    for (const [cmd, message] of [
      ['timeout 5 child', 'timeout is refused'],
      ['nohup child', 'nohup is refused'],
      ['nice child', 'nice is refused'],
      ['stdbuf -o0 child', 'stdbuf is refused'],
      ['setsid child', 'setsid is refused'],
      ['myenv AWS_REGION=us-east-1 child', 'myenv is refused'],
      ["python3 -c 'import os'", 'python3 with inline code is refused'],
      ["python3 -Ic 'import os'", 'python3 with inline code is refused'],
      ["node -e 'process.exit(0)'", 'node with inline code is refused'],
      ['node -pe 1', 'node with inline code is refused'],
      ["perl -e 'exit 0'", 'perl with inline code is refused'],
    ] as const) {
      const w = world();
      // Stand-ins on PATH, so the refusal comes from the name, not from a missing program.
      for (const name of ['timeout', 'nohup', 'nice', 'stdbuf', 'setsid', 'python3', 'perl']) {
        copyFileSync(join(w.bin, 'child'), join(w.bin, name));
        chmodSync(join(w.bin, name), 0o755);
      }
      symlinkSync('/usr/bin/env', join(w.bin, 'myenv'));
      await refused(w, `sandbox_guard_init\nguarded "x" -- ${cmd}`, 2, message);
      expect(stsCalls(w)).toBe(1);
    }
    // A script file run by an interpreter stays allowed.
    const w = world();
    writeFileSync(join(w.dir, 'tool.js'), 'console.log("script ran", process.env.AWS_PROFILE);\n');
    const r = await bash(w, `sandbox_guard_init\nguarded "x" -- node ${join(w.dir, 'tool.js')}`);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(`script ran ${PROFILE}\n`);
  });

  it('init refuses a default profile, ~/.aws/credentials or a CDK "profile" setting (exit 15)', async () => {
    const cases: [string, (w: World) => void][] = [
      [
        'has a [default] section',
        (w) =>
          writeFileSync(
            join(w.home, '.aws', 'config'),
            `${readFileSync(join(w.home, '.aws', 'config'), 'utf8')}\n[default]\nregion = ap-southeast-1\n`,
          ),
      ],
      [
        '~/.aws/credentials has 1 section(s)',
        (w) =>
          writeFileSync(
            join(w.home, '.aws', 'credentials'),
            '[default]\naws_access_key_id = placeholder-not-a-key\n',
          ),
      ],
      [
        '~/.cdk.json sets "profile"',
        (w) => writeFileSync(join(w.home, '.cdk.json'), JSON.stringify({ profile: 'admin' })),
      ],
      [
        'cdk.json in the working directory sets "profile"',
        (w) => writeFileSync(join(w.dir, 'cdk.json'), JSON.stringify({ profile: 'admin' })),
      ],
    ];
    for (const [message, prepare] of cases) {
      const w = world();
      prepare(w);
      const r = await refused(w, 'sandbox_guard_init', 15, message);
      expect(w.calls()).toEqual([]);
      expect(r.stderr).not.toContain('placeholder');
    }
  });

  it('sandbox_guard before init, re-init with another selection, a missing build: refused', async () => {
    const w = world();
    await refused(w, 'sandbox_guard "x"', 2, 'call sandbox_guard_init first');
    await refused(
      w,
      'sandbox_guard_init\nsandbox_guard_init --profile other-profile',
      2,
      'already initialized with a different selection',
    );
    const unbuilt = world();
    await refused(
      unbuilt,
      `rm ${JSON.stringify(join(unbuilt.tool, 'dist', 'guard-cli.js'))}\nsandbox_guard_init`,
      17,
      'dist/guard-cli.js is missing',
    );
  });

  it('without set -e a refusal still exits the script: shell check, TS check, init', async () => {
    const cases: [Scenario | undefined, string, Record<string, string>, number, string][] = [
      [
        undefined,
        'sandbox_guard_init\nmy_fn() { child; }\nguarded "x" -- my_fn',
        {},
        2,
        'not an executable',
      ],
      [
        { 'sts get-caller-identity': [CALLER, MISMATCH] },
        'sandbox_guard_init\nguarded "x" -- child',
        {},
        3,
        'ACCOUNT MISMATCH',
      ],
      [undefined, 'sandbox_guard_init', { AWS_ACCESS_KEY_ID: 'x' }, 12, 'static credentials'],
      [undefined, 'sandbox_guard "x"', {}, 2, 'call sandbox_guard_init first'],
    ];
    for (const [scenario, body, env, code, message] of cases) {
      const w = world(scenario);
      const r = await bash(w, `${body}\necho "after rc=$?"`, { strict: false, env });
      expect(r.code, r.stderr).toBe(code);
      expect(r.stderr).toContain(message);
      expect(r.stdout).not.toContain('after');
      expect(existsSync(w.marker)).toBe(false);
    }
  });

  it('executing the helper instead of sourcing it is refused', async () => {
    const w = world();
    const r = await new Promise<{ code: number; stderr: string }>((done) => {
      execFile(BASH, [join(w.tool, 'scripts', 'sandbox-guard.sh')], (error, _out, stderr) =>
        done({ code: error && typeof error.code === 'number' ? error.code : 0, stderr }),
      );
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('must be sourced');
  });

  it('in an interactive shell a refusal returns its code instead of closing the shell', async () => {
    const w = world();
    const r = await bash(w, 'sandbox_guard_init\necho "still here rc=$?"', {
      strict: false,
      interactive: true,
      env: { AWS_ACCESS_KEY_ID: 'x' },
    });
    expect(r.stdout).toContain('still here rc=12');
  });
});
