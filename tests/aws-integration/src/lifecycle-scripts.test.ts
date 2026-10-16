/**
 * Self-test of the AWS lifecycle shell scripts WITHOUT AWS.
 *
 * `pnpm` (and thus `cdk`) is replaced by a stub (PNPM=<stub>) that records its arguments, and the
 * AWS SDK used by cleanup-verify is pointed at an in-process fake CloudFormation (Query/XML) and
 * Resource Groups Tagging (JSON) endpoint via AWS_ENDPOINT_URL. Proves the control flow:
 * opt-in refusal, deploy -> test -> destroy + verify, cleanup on test failure / deploy failure /
 * SIGTERM, the DeleteStack fallback when `cdk destroy` fails, and leak reporting; and the account
 * guard: refusal without an expected account, the account/qualifier/toolkit context, a
 * guard check before every mutation (fake `sandbox-guard.sh`) and no deletion outside the account.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_GUARD } from './sandbox/fixtures/fake-guard.js';
import {
  FAKE_AWS_VERSION,
  GUARD_REFUSED_ENV,
  callerIdentity,
  installRealGuard,
} from './sandbox/fixtures/real-guard.js';

const SUITE = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(SUITE, 'scripts');

interface FakeStack {
  name: string;
  id: string;
  runId: string;
  status: string;
}

const ACCOUNT = '111122223333';
const stackArn = (name: string, account = ACCOUNT) =>
  `arn:aws:cloudformation:ap-southeast-1:${account}:stack/${name}/1`;

const fake = {
  stacks: [] as FakeStack[],
  calls: [] as string[],
  ignoreDelete: false,
  /** tag:GetResources answers AccessDenied (the sandbox Developer permission set). */
  denyTagging: false,
};

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const NS = 'http://cloudformation.amazonaws.com/doc/2010-05-15/';

function describeStacksXml(stacks: FakeStack[]): string {
  const members = stacks
    .map(
      (s) =>
        `<member><StackName>${xml(s.name)}</StackName><StackId>${xml(s.id)}</StackId>` +
        `<StackStatus>${s.status}</StackStatus><CreationTime>2026-10-13T00:00:00Z</CreationTime>` +
        `<EnableTerminationProtection>false</EnableTerminationProtection>` +
        `<Tags><member><Key>starter:run-id</Key><Value>${xml(s.runId)}</Value></member>` +
        `<member><Key>starter:ephemeral</Key><Value>true</Value></member></Tags></member>`,
    )
    .join('');
  return (
    `<DescribeStacksResponse xmlns="${NS}"><DescribeStacksResult><Stacks>${members}</Stacks>` +
    `</DescribeStacksResult><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></DescribeStacksResponse>`
  );
}

let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const target = req.headers['x-amz-target'];
      if (typeof target === 'string') {
        fake.calls.push(target.split('.').pop() ?? target);
        if (fake.denyTagging && target.endsWith('.GetResources')) {
          res.writeHead(400, { 'content-type': 'application/x-amz-json-1.1' });
          res.end(
            '{"__type":"AccessDeniedException","message":"not authorized to perform: tag:GetResources"}',
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
        res.end(target.endsWith('.GetResources') ? '{"ResourceTagMappingList":[]}' : '{}');
        return;
      }
      const params = new URLSearchParams(body);
      const action = params.get('Action') ?? '?';
      fake.calls.push(`cfn:${action}`);
      if (action === 'DescribeStacks') {
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end(describeStacksXml(fake.stacks.filter((s) => s.status !== 'DELETE_COMPLETE')));
        return;
      }
      if (action === 'DeleteStack') {
        const target = params.get('StackName');
        if (!fake.ignoreDelete) {
          for (const s of fake.stacks)
            if (s.id === target || s.name === target) s.status = 'DELETE_COMPLETE';
        }
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end(
          `<DeleteStackResponse xmlns="${NS}"><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></DeleteStackResponse>`,
        );
        return;
      }
      res.writeHead(400, { 'content-type': 'text/xml' });
      res.end(
        `<ErrorResponse><Error><Code>InvalidAction</Code><Message>${xml(action)}</Message></Error></ErrorResponse>`,
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** Stub for `pnpm`: records argv; behaviour controlled by FAKE_* env vars. */
const STUB = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$*" in
  *"exec cdk deploy"*)
    if [[ -n "\${FAKE_DEPLOY_SLEEP:-}" ]]; then sleep "$FAKE_DEPLOY_SLEEP"; fi
    if [[ "\${FAKE_DEPLOY_EXIT:-0}" != 0 ]]; then exit "$FAKE_DEPLOY_EXIT"; fi
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == --outputs-file ]]; then
        printf '{"starter-it-x":{"StateMachineArn":"arn:aws:states:ap-southeast-1:111122223333:stateMachine:x","JobsTableName":"starter-it-x-job-state"}}' > "$2"
      fi
      shift
    done
    exit 0 ;;
  *"exec cdk destroy"*) exit "\${FAKE_DESTROY_EXIT:-0}" ;;
  *"run test:aws"*) exit "\${FAKE_TEST_EXIT:-0}" ;;
  *) exit 0 ;;
esac
`;

let dir: string;
let logFile: string;

beforeEach(async () => {
  fake.stacks = [];
  fake.calls = [];
  fake.ignoreDelete = false;
  fake.denyTagging = false;
  dir = await mkdtemp(join(tmpdir(), 'starter-aws-lifecycle-'));
  logFile = join(dir, 'pnpm.log');
  await writeFile(logFile, '');
  await writeFile(join(dir, 'pnpm'), STUB);
  await chmod(join(dir, 'pnpm'), 0o755);
  await writeFile(join(dir, 'sandbox-guard.sh'), FAKE_GUARD);
  // Fake AWS CLI for the read-only IAM residue check (sandbox mode): prints $FAKE_IAM_ROLES.
  await writeFile(
    join(dir, 'aws'),
    '#!/usr/bin/env bash\necho "AWSCLI $*" >> "$FAKE_LOG"\nprintf \'%s\\n\' "${FAKE_IAM_ROLES:-}"\n',
  );
  await chmod(join(dir, 'aws'), 0o755);
  // Fake finops verify-clean (sandbox mode): writes the report, exits $FAKE_FINOPS_EXIT.
  await writeFile(
    join(dir, 'finops.mjs'),
    `import { appendFileSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, 'FINOPS ' + a.join(' ') + '\\n');
const code = Number(process.env.FAKE_FINOPS_EXIT ?? 0);
// exit 5 (clean-with-unverifiable): the categories the role could not list, with evidence
const unverifiable = code === 5
  ? [{ category: 'kms-keys', status: 'unverifiable-with-this-role',
       evidence: ['kms:ListKeys denied; key arn:aws:kms:ap-southeast-1:111122223333:key/k1 proven PendingDeletion'] }]
  : [];
writeFileSync(a[a.indexOf('--out') + 1], JSON.stringify({ remaining: [], summary: { unverifiable } }));
process.exit(code);
`,
  );
  await mkdir(join(dir, 'infra'), { recursive: true });
  await mkdir(join(dir, 'sandbox-home'), { recursive: true });
  // The fake guard pins AWS_PROFILE like the real one: give that profile fake static keys in a
  // private config file, so nothing ever reads the operator's ~/.aws.
  await writeFile(
    join(dir, 'aws-config'),
    '[profile starter-sandbox-developer]\naws_access_key_id = selftest\naws_secret_access_key = selftest\nregion = ap-southeast-1\n',
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface RunResult {
  code: number | null;
  output: string;
}

function runScript(
  script: string,
  env: Record<string, string>,
  opts: { terminateWhenLogged?: string; unset?: readonly string[] } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const childEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? dir,
      AWS_REGION: 'ap-southeast-1',
      AWS_ACCESS_KEY_ID: 'selftest',
      AWS_SECRET_ACCESS_KEY: 'selftest',
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_CONFIG_FILE: join(dir, 'aws-config'),
      AWS_SHARED_CREDENTIALS_FILE: join(dir, 'aws-credentials'),
      AWS_ENDPOINT_URL: endpoint,
      PNPM: join(dir, 'pnpm'),
      FAKE_LOG: logFile,
      AWS_INTEGRATION_REPORT_DIR: join(dir, 'reports'),
      AWS_INTEGRATION_INFRA_DIR: join(dir, 'infra'),
      AWS_INTEGRATION_VERIFY_CMD: `node --import tsx ${join(SUITE, 'src', 'cleanup-verify.ts')}`,
      AWS_INTEGRATION_CLEANUP_WAIT_SECONDS: '0',
      // Never the operator's real ~/.config/starter-aws-sandbox (its expected-account file).
      SANDBOX_HOME: join(dir, 'sandbox-home'),
      SANDBOX_GUARD_SCRIPT: join(dir, 'sandbox-guard.sh'),
      AWS_INTEGRATION_AWS_CLI: join(dir, 'aws'),
      AWS_INTEGRATION_FINOPS_CLI: join(dir, 'finops.mjs'),
      AWS_INTEGRATION_SBX_TOOL: `node --import tsx ${join(SUITE, 'src', 'sandbox', 'cli.ts')}`,
      ...env,
    };
    for (const name of opts.unset ?? []) delete childEnv[name];
    const child = spawn('bash', [join(SCRIPTS, script)], {
      cwd: SUITE,
      detached: true, // own process group, so SIGTERM reaches the whole tree like a CI cancel
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr.on('data', (c: Buffer) => (output += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));

    if (opts.terminateWhenLogged) {
      const needle = opts.terminateWhenLogged;
      const deadline = Date.now() + 20_000;
      const poll = async () => {
        const log = await readFile(logFile, 'utf8').catch(() => '');
        if (log.includes(needle)) {
          // negative pid = the child's process group; never signal our own group (pid 0)
          if (child.pid) process.kill(-child.pid, 'SIGTERM');
        } else if (Date.now() < deadline && child.exitCode === null) {
          setTimeout(() => void poll(), 50);
        }
      };
      void poll();
    }
  });
}

const pnpmLog = async () => (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean);
const cleanupStatus = async () =>
  JSON.parse(await readFile(join(dir, 'reports', 'cleanup-status.json'), 'utf8')) as {
    status: string;
    destroyExitCode: number | null;
    runId: string;
  };
/** Real AWS enabled the way CI runs it: expected account set, `ci` guard mode. */
const enabled = {
  AWS_INTEGRATION_ENABLED: 'true',
  AWS_INTEGRATION_EXPECTED_ACCOUNT: ACCOUNT,
  AWS_INTEGRATION_GUARD: 'ci',
};
/**
 * The personal-sandbox way: the account guard of tools/aws-preflight (here: the faithful fake of
 * src/sandbox/fixtures/fake-guard.ts, which also needs the expected-account file).
 */
const sandboxGuard = { ...enabled, AWS_INTEGRATION_GUARD: 'sandbox' };
const OPERATOR_ARN = `arn:aws:iam::${ACCOUNT}:role/aws-reserved/sso.amazonaws.com/ap-southeast-1/AWSReservedSSO_Developer_0123456789abcdef`;
/** The sandbox-mode inputs: expected-account and operator-role-arn files (0600). */
const writeAccountFile = async () => {
  await writeFile(join(dir, 'sandbox-home', 'expected-account'), `${ACCOUNT}\n`, { mode: 0o600 });
  await writeFile(join(dir, 'sandbox-home', 'operator-role-arn'), `${OPERATOR_ARN}\n`, {
    mode: 0o600,
  });
};
const checks = async () =>
  (await pnpmLog()).filter((l) => /^GUARD (?!sandbox_guard_init$)/.test(l));

// Every test spawns the scripts (bash, node, tsx): an explicit limit, since the 5 s default is
// too short under a loaded full gate. Still failing tests: a hang ends at 60 s.
describe('AWS lifecycle scripts (stubbed cdk, fake AWS endpoint)', { timeout: 60_000 }, () => {
  it('refuse to run (exit 3, nothing invoked) unless AWS_INTEGRATION_ENABLED=true', async () => {
    for (const s of ['deploy.sh', 'run.sh', 'cleanup.sh', 'lifecycle.sh']) {
      const r = await runScript(s, {});
      expect(r.code, `${s}: ${r.output}`).toBe(3);
    }
    expect(await pnpmLog()).toEqual([]);
  });

  it('refuse (exit 4, nothing invoked) when real AWS is enabled without an expected account', async () => {
    for (const s of ['deploy.sh', 'run.sh', 'cleanup.sh', 'lifecycle.sh']) {
      const r = await runScript(s, {
        AWS_INTEGRATION_ENABLED: 'true',
        AWS_INTEGRATION_GUARD: 'ci',
      });
      expect(r.code, `${s}: ${r.output}`).toBe(4);
      expect(r.output).toMatch(/no expected account/);
    }
    expect(await pnpmLog()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('refuse (exit 4, nothing invoked) when AWS_REGION is not the configured region (default ap-southeast-1)', async () => {
    await writeAccountFile();
    for (const env of [enabled, sandboxGuard]) {
      for (const script of ['deploy.sh', 'run.sh', 'cleanup.sh']) {
        const r = await runScript(script, { ...env, AWS_REGION: 'us-east-1' });
        expect(r.code, `${script}: ${r.output}`).toBe(4);
        expect(r.output).toMatch(/AWS_REGION must be the configured region ap-southeast-1/);
        // A configured region does not follow the ambient one, and vice versa.
        const other = await runScript(script, { ...env, AWS_INTEGRATION_REGION: 'eu-west-1' });
        expect(other.code, `${script}: ${other.output}`).toBe(4);
        expect(other.output).toMatch(/AWS_REGION must be the configured region eu-west-1/);
      }
    }
    expect(await pnpmLog()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it.each([
    ['cn-north-1', 'a region of another partition'],
    ['us-gov-west-1', 'GovCloud'],
    ['eu-west-1a', 'an availability zone'],
    ['Nowhere', 'garbage'],
  ])('refuse (exit 4, nothing invoked) a configured region %s (%s)', async (region) => {
    await writeAccountFile();
    for (const env of [enabled, sandboxGuard]) {
      const r = await runScript('deploy.sh', {
        ...env,
        AWS_INTEGRATION_REGION: region,
        AWS_REGION: region,
      });
      expect(r.code, r.output).toBe(4);
      expect(r.output).toMatch(/AWS_INTEGRATION_REGION is not an aws-partition region name/);
    }
    expect(await pnpmLog()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('another configured region reaches the CDK app as -c region', async () => {
    const r = await runScript('lifecycle.sh', {
      ...enabled,
      AWS_INTEGRATION_REGION: 'eu-west-1',
      AWS_REGION: 'eu-west-1',
    });
    expect(r.code, r.output).toBe(0);
    const log = await pnpmLog();
    for (const sub of ['deploy', 'destroy']) {
      const line = log.find((l) => l.includes(`exec cdk ${sub}`)) ?? '';
      expect(line).toMatch(/--context region=eu-west-1/);
    }
  });

  it('refuse (exit 4) when the env and the expected-account file disagree, or the id is malformed', async () => {
    await writeFile(join(dir, 'sandbox-home', 'expected-account'), '999988887777\n');
    const mismatch = await runScript('lifecycle.sh', enabled);
    expect(mismatch.code, mismatch.output).toBe(4);
    expect(mismatch.output).toContain('********7777');
    expect(mismatch.output, 'account ids are masked in logs').not.toContain('999988887777');
    const malformed = await runScript('deploy.sh', {
      ...enabled,
      AWS_INTEGRATION_EXPECTED_ACCOUNT: '12345',
      SANDBOX_HOME: join(dir, 'nowhere'),
    });
    expect(malformed.code, malformed.output).toBe(4);
    expect(await pnpmLog()).toEqual([]);
  });

  it('the expected-account file alone is enough (SANDBOX_HOME/expected-account)', async () => {
    await writeFile(join(dir, 'sandbox-home', 'expected-account'), `${ACCOUNT}\n`);
    const { AWS_INTEGRATION_EXPECTED_ACCOUNT: _unset, ...fromFile } = enabled;
    const r = await runScript('lifecycle.sh', fromFile);
    expect(r.code, r.output).toBe(0);
    const deploy = (await pnpmLog()).find((l) => l.includes('exec cdk deploy')) ?? '';
    expect(deploy).toContain(`--context account=${ACCOUNT}`);
  });

  it('sandbox guard: initialised per script, checked right before every mutation', async () => {
    await writeAccountFile();
    const r = await runScript('lifecycle.sh', sandboxGuard);
    expect(r.code, r.output).toBe(0);
    const log = await pnpmLog();
    const mutations = log
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /exec cdk (deploy|destroy)|run test:aws/.test(line));
    expect(mutations).toHaveLength(3);
    expect(mutations[0]?.line).toContain('exec cdk deploy');
    expect(mutations[1]?.line).toContain('run test:aws');
    expect(mutations[2]?.line).toContain('exec cdk destroy');
    for (const { line, i } of mutations) {
      expect(log[i - 1], `guarded command right before: ${line}`).toMatch(/^GUARD-BEGIN /);
      expect(log[i - 2], `guard check right before: ${line}`).toMatch(/^GUARD /);
    }
    expect(log.filter((l) => l.startsWith('GUARD-INIT'))).toHaveLength(3); // deploy, run, cleanup
    for (const { line } of mutations.filter((m) => m.line.includes('exec cdk'))) {
      expect(line).toContain(`--context operatorPrincipalArn=${OPERATOR_ARN}`);
    }
    expect(
      log.some((l) =>
        /^FINOPS verify-clean --run-id it-[0-9a-f]{6} --out \S+verify-clean\.json --strict --region ap-southeast-1 --guard-log /.test(
          l,
        ),
      ),
    ).toBe(true);
    expect(log.find((l) => l.startsWith('GUARD-INIT'))).toMatch(/log=\S+guard\.log/);
  });

  it('sandbox guard refuses the deploy: nothing deployed, tests never run, cleanup still guarded', async () => {
    await writeAccountFile();
    const r = await runScript('lifecycle.sh', { ...sandboxGuard, FAKE_GUARD_REFUSE: 'cdk deploy' });
    expect(r.code, r.output).not.toBe(0);
    const log = await pnpmLog();
    expect(log.some((l) => l.includes('exec cdk deploy'))).toBe(false);
    expect(log.some((l) => l.includes('run test:aws'))).toBe(false);
    const destroyAt = log.findIndex((l) => l.includes('exec cdk destroy'));
    expect(destroyAt).toBeGreaterThan(0);
    expect(log[destroyAt - 1]).toMatch(/^GUARD-BEGIN cdk destroy/);
  });

  it('sandbox mode needs the expected-account file the guard reads (exit 4 with the env var only)', async () => {
    const r = await runScript('deploy.sh', sandboxGuard);
    expect(r.code, r.output).toBe(4);
    expect(r.output).toMatch(/expected-account, which is missing/);
    expect(await pnpmLog()).toEqual([]);
  });

  it('a missing guard script is a refusal (exit 4), not a silent unguarded run', async () => {
    const r = await runScript('deploy.sh', {
      ...sandboxGuard,
      SANDBOX_GUARD_SCRIPT: join(dir, 'no-such-guard.sh'),
    });
    expect(r.code, r.output).toBe(4);
    expect(await pnpmLog()).toEqual([]);
  });

  it('lifecycle: deploy -> tests -> destroy -> verified clean; context passed correctly', async () => {
    const r = await runScript('lifecycle.sh', enabled);
    expect(r.code, r.output).toBe(0);
    const log = await pnpmLog();
    const deploy = log.find((l) => l.includes('exec cdk deploy')) ?? '';
    const destroy = log.find((l) => l.includes('exec cdk destroy')) ?? '';
    expect(deploy).toMatch(/--app node dist\/bin\/integration\.js/);
    expect(deploy).toMatch(/--context runId=it-[0-9a-f]{6} --context region=ap-southeast-1/);
    expect(deploy).toMatch(/--context expiresAt=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(deploy).toMatch(/--outputs-file \S+outputs\.json/);
    // The stack environment is pinned to the expected account and the starter bootstrap.
    expect(deploy).toContain(`--context account=${ACCOUNT}`);
    expect(deploy).toContain('--context qualifier=starter');
    expect(deploy).toContain('--toolkit-stack-name starter-cdk-toolkit');
    expect(destroy).toMatch(/--context runId=it-[0-9a-f]{6}/);
    expect(destroy).toContain(`--context account=${ACCOUNT}`);
    expect(destroy).toContain('--context qualifier=starter');
    expect(destroy).toContain('--toolkit-stack-name starter-cdk-toolkit');
    expect(destroy, 'destroy must not pass a (possibly past) expiresAt').not.toMatch(/expiresAt/);
    expect(log.some((l) => l.includes('run test:aws'))).toBe(true);
    const status = await cleanupStatus();
    expect(status).toMatchObject({ status: 'clean', destroyExitCode: 0 });
    expect(deploy).toContain(`runId=${status.runId}`);
    const testStatus = JSON.parse(
      await readFile(join(dir, 'reports', 'test-status.json'), 'utf8'),
    ) as { exitCode: number };
    expect(testStatus.exitCode).toBe(0);
  });

  it('failing tests: exit code is the test result and cleanup still runs', async () => {
    const r = await runScript('lifecycle.sh', { ...enabled, FAKE_TEST_EXIT: '1' });
    expect(r.code, r.output).toBe(1);
    expect((await pnpmLog()).some((l) => l.includes('exec cdk destroy'))).toBe(true);
    expect((await cleanupStatus()).status).toBe('clean');
  });

  it('failed deploy: partial stack destroyed, tests never run, deploy exit code propagated', async () => {
    const r = await runScript('lifecycle.sh', { ...enabled, FAKE_DEPLOY_EXIT: '2' });
    expect(r.code, r.output).toBe(2);
    const log = await pnpmLog();
    expect(log.some((l) => l.includes('run test:aws'))).toBe(false);
    expect(log.some((l) => l.includes('exec cdk destroy'))).toBe(true);
    expect((await cleanupStatus()).status).toBe('clean');
  });

  it('SIGTERM during deploy (CI cancel): cleanup runs and exit is 143', async () => {
    const r = await runScript(
      'lifecycle.sh',
      { ...enabled, FAKE_DEPLOY_SLEEP: '30' },
      { terminateWhenLogged: 'exec cdk deploy' },
    );
    expect(r.code, r.output).toBe(143);
    expect((await pnpmLog()).some((l) => l.includes('exec cdk destroy'))).toBe(true);
    expect((await cleanupStatus()).status).toBe('clean');
  });

  it('cdk destroy fails: falls back to DeleteStack by starter:run-id tag, then verifies clean', async () => {
    const runId = 'it-selftest-e';
    fake.stacks = [
      {
        name: `starter-it-${runId}`,
        id: stackArn(`starter-it-${runId}`),
        runId,
        status: 'CREATE_COMPLETE',
      },
      {
        name: 'starter-it-other-run',
        id: stackArn('starter-it-other-run'),
        runId: 'other-run',
        status: 'CREATE_COMPLETE',
      },
    ];
    const r = await runScript('lifecycle.sh', {
      ...enabled,
      AWS_INTEGRATION_RUN_ID: runId,
      FAKE_DESTROY_EXIT: '1',
    });
    expect(r.code, r.output).toBe(0);
    expect(fake.calls.filter((c) => c === 'cfn:DeleteStack')).toHaveLength(1);
    expect(fake.stacks.find((s) => s.runId === 'other-run')?.status).toBe('CREATE_COMPLETE');
    expect(await cleanupStatus()).toMatchObject({ status: 'clean', destroyExitCode: 1, runId });
  });

  it('stack that cannot be deleted: reported as leaked and the run fails even if tests passed', async () => {
    const runId = 'it-selftest-leak';
    fake.ignoreDelete = true;
    fake.stacks = [
      {
        name: `starter-it-${runId}`,
        id: `arn:aws:cloudformation:ap-southeast-1:111122223333:stack/starter-it-${runId}/1`,
        runId,
        status: 'DELETE_FAILED',
      },
    ];
    const r = await runScript('lifecycle.sh', {
      ...enabled,
      AWS_INTEGRATION_RUN_ID: runId,
      FAKE_DESTROY_EXIT: '1',
    });
    expect(r.code, r.output).toBe(1);
    expect((await cleanupStatus()).status).toBe('leaked');
  });

  it('DeleteStack fallback refuses a stack outside the expected account (error, nothing deleted)', async () => {
    const runId = 'it-selftest-acct';
    fake.stacks = [
      {
        name: `starter-it-${runId}`,
        id: stackArn(`starter-it-${runId}`, '999988887777'),
        runId,
        status: 'CREATE_COMPLETE',
      },
    ];
    const r = await runScript('cleanup.sh', {
      ...enabled,
      AWS_INTEGRATION_RUN_ID: runId,
      FAKE_DESTROY_EXIT: '1',
    });
    expect(r.code, r.output).toBe(2);
    expect(fake.calls.filter((c) => c === 'cfn:DeleteStack')).toHaveLength(0);
    expect(fake.stacks[0]?.status).toBe('CREATE_COMPLETE');
    expect((await cleanupStatus()).status).toBe('error');
    expect(r.output).not.toContain('999988887777');
  });

  it('sandbox guard wraps the DeleteStack fallback (a mutation), not the read-only verification', async () => {
    const runId = 'it-selftest-g';
    fake.stacks = [
      {
        name: `starter-it-${runId}`,
        id: stackArn(`starter-it-${runId}`),
        runId,
        status: 'CREATE_COMPLETE',
      },
    ];
    await writeAccountFile();
    const failed = await runScript('cleanup.sh', {
      ...sandboxGuard,
      AWS_INTEGRATION_RUN_ID: runId,
      FAKE_DESTROY_EXIT: '1',
    });
    expect(failed.code, failed.output).toBe(0);
    expect(await checks()).toEqual([
      `GUARD cdk destroy mini-stack ${runId}`,
      `GUARD DeleteStack fallback for run ${runId}`,
    ]);
    await writeFile(logFile, '');
    const ok = await runScript('cleanup.sh', { ...sandboxGuard, AWS_INTEGRATION_RUN_ID: runId });
    expect(ok.code, ok.output).toBe(0);
    expect(await checks()).toEqual([`GUARD cdk destroy mini-stack ${runId}`]);
  });

  it('sandbox mode: an IAM role of the run left behind (KeyProbeRole) fails the cleanup', async () => {
    await writeAccountFile();
    const runId = 'it-selftest-iam';
    const clean = await runScript('cleanup.sh', { ...sandboxGuard, AWS_INTEGRATION_RUN_ID: runId });
    expect(clean.code, clean.output).toBe(0);
    const iam = JSON.parse(
      await readFile(join(dir, 'reports', 'iam-residual.json'), 'utf8'),
    ) as unknown;
    expect(iam).toEqual({ runId, checked: true, remainingRoles: [] });
    expect((await pnpmLog()).find((l) => l.startsWith('AWSCLI'))).toMatch(
      /^AWSCLI iam list-roles --profile starter-sandbox-developer --region ap-southeast-1 .*'starter-it-it-selftest-iam-'/,
    );
    const left = await runScript('cleanup.sh', {
      ...sandboxGuard,
      AWS_INTEGRATION_RUN_ID: runId,
      FAKE_IAM_ROLES: `starter-it-${runId}-KeyProbeRole1A2B3C-XYZ`,
    });
    expect(left.code, left.output).toBe(1);
    expect(
      JSON.parse(await readFile(join(dir, 'reports', 'iam-residual.json'), 'utf8')),
    ).toMatchObject({
      checked: true,
      remainingRoles: [`starter-it-${runId}-KeyProbeRole1A2B3C-XYZ`],
    });
  });

  it('ci mode does not call the AWS CLI for IAM and records the check as not done', async () => {
    const r = await runScript('cleanup.sh', {
      ...enabled,
      AWS_INTEGRATION_RUN_ID: 'it-selftest-ci',
    });
    expect(r.code, r.output).toBe(0);
    expect((await pnpmLog()).some((l) => l.startsWith('AWSCLI'))).toBe(false);
    expect(
      JSON.parse(await readFile(join(dir, 'reports', 'iam-residual.json'), 'utf8')),
    ).toMatchObject({
      checked: false,
    });
  });

  it('sandbox mode refuses (exit 4, nothing invoked) without a private operator-role-arn file', async () => {
    await writeAccountFile();
    await rm(join(dir, 'sandbox-home', 'operator-role-arn'));
    const missing = await runScript('deploy.sh', sandboxGuard);
    expect(missing.code, missing.output).toBe(4);
    expect(missing.output).toMatch(/operator-role-arn .*missing/);
    await writeFile(join(dir, 'sandbox-home', 'operator-role-arn'), `${OPERATOR_ARN}\n`, {
      mode: 0o644,
    });
    await chmod(join(dir, 'sandbox-home', 'operator-role-arn'), 0o644);
    const open = await runScript('deploy.sh', sandboxGuard);
    expect(open.code, open.output).toBe(4);
    expect(open.output).toMatch(/mode 644/);
    await writeFile(
      join(dir, 'sandbox-home', 'operator-role-arn'),
      'arn:aws:iam::999988887777:role/other\n',
      { mode: 0o600 },
    );
    await chmod(join(dir, 'sandbox-home', 'operator-role-arn'), 0o600);
    const foreign = await runScript('deploy.sh', sandboxGuard);
    expect(foreign.code, foreign.output).toBe(4);
    expect(foreign.output).not.toContain('999988887777');
    expect(await pnpmLog()).toEqual([]);
  });

  it('ci mode passes AWS_INTEGRATION_OPERATOR_PRINCIPAL_ARN when set', async () => {
    const r = await runScript('lifecycle.sh', {
      ...enabled,
      AWS_INTEGRATION_OPERATOR_PRINCIPAL_ARN: OPERATOR_ARN,
    });
    expect(r.code, r.output).toBe(0);
    for (const l of (await pnpmLog()).filter((x) => x.includes('exec cdk'))) {
      expect(l).toContain(`--context operatorPrincipalArn=${OPERATOR_ARN}`);
    }
  });

  it('tag:GetResources denied: ci mode reports NOT verified (exit 3); sandbox mode settles it with the finops sweep', async () => {
    fake.denyTagging = true;
    const ci = await runScript('cleanup.sh', {
      ...enabled,
      AWS_INTEGRATION_RUN_ID: 'it-selftest-tag',
    });
    expect(ci.code, ci.output).toBe(3);
    expect(((await cleanupStatus()) as { status: string }).status).toBe('stacks-clean');
    await writeAccountFile();
    const clean = await runScript('cleanup.sh', {
      ...sandboxGuard,
      AWS_INTEGRATION_RUN_ID: 'it-selftest-tag',
    });
    expect(clean.code, clean.output).toBe(0);
    const leaked = await runScript('cleanup.sh', {
      ...sandboxGuard,
      AWS_INTEGRATION_RUN_ID: 'it-selftest-tag',
      FAKE_FINOPS_EXIT: '1',
    });
    expect(leaked.code, leaked.output).toBe(1);
    const unverifiable = await runScript('cleanup.sh', {
      ...sandboxGuard,
      AWS_INTEGRATION_RUN_ID: 'it-selftest-tag',
      FAKE_FINOPS_EXIT: '4',
    });
    expect(unverifiable.code, unverifiable.output).toBe(3);
  });

  it('sandbox mode, finops exit 5 (clean-with-unverifiable): its own exit code, categories and evidence printed', async () => {
    await writeAccountFile();
    const r = await runScript('lifecycle.sh', { ...sandboxGuard, FAKE_FINOPS_EXIT: '5' });
    expect(r.code, r.output).toBe(5);
    expect(r.output).toContain('UNVERIFIABLE kms-keys (unverifiable-with-this-role)');
    expect(r.output).toMatch(
      /evidence: kms:ListKeys denied; key arn:aws:kms:ap-southeast-1:\*{8}3333:key\/k1/,
    );
    expect(r.output).not.toContain(ACCOUNT);
  });

  it('sandbox mode under the REAL account guard: every guarded shape passes; its STS check right before each mutation', async () => {
    await writeAccountFile();
    // The real helper and guard CLI sources; HOME is private and its fake `aws` comes first on PATH,
    // so the guard never sees the operator's ~/.aws or AWS CLI.
    const home = join(dir, 'home');
    const guardScript = await installRealGuard(dir, home);
    const bin = join(dir, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, 'aws'),
      [
        '#!/bin/sh',
        `echo "AWSCLI $*" >> ${JSON.stringify(logFile)}`,
        'case "$1" in',
        `  --version) echo '${FAKE_AWS_VERSION}' ;;`,
        `  sts) echo '${JSON.stringify(callerIdentity(ACCOUNT))}' ;;`,
        '  *) printf \'%s\\n\' "${FAKE_IAM_ROLES:-}" ;;',
        'esac',
        '',
      ].join('\n'),
    );
    await chmod(join(bin, 'aws'), 0o755);
    // The SDK path of cleanup-verify needs AWS_ENDPOINT_URL, which the real guard refuses: a fake
    // verifier (a node script file, like the real one) records its arguments and reports clean.
    await writeFile(
      join(dir, 'fake-verify.mjs'),
      `import { appendFileSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, 'VERIFY ' + a.join(' ') + '\\n');
writeFileSync(a[a.indexOf('--out') + 1], JSON.stringify({ runId: a[a.indexOf('--run-id') + 1], status: 'clean' }));
`,
    );
    const r = await runScript(
      'lifecycle.sh',
      {
        ...sandboxGuard,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: home,
        SANDBOX_GUARD_SCRIPT: guardScript,
        AWS_INTEGRATION_AWS_CLI: join(bin, 'aws'),
        AWS_INTEGRATION_VERIFY_CMD: `node ${join(dir, 'fake-verify.mjs')}`,
        FAKE_DESTROY_EXIT: '1', // exercises the guarded DeleteStack fallback too
      },
      { unset: GUARD_REFUSED_ENV },
    );
    expect(r.code, r.output).toBe(0);
    expect(r.output).not.toMatch(/sandbox-guard: (REFUSED|STOP)/);
    const log = await pnpmLog();
    const mutations = log.flatMap((l, i) =>
      /exec cdk (deploy|destroy)|run test:aws|^VERIFY .*--delete-remaining/.test(l) ? [i] : [],
    );
    expect(mutations.map((i) => (log[i] ?? '').split(' --')[0])).toEqual([
      'exec cdk deploy',
      '--filter @starter/tests-aws-integration run test:aws',
      'exec cdk destroy',
      expect.stringMatching(/^VERIFY/),
    ]);
    for (const i of mutations) {
      expect(log[i - 1], `guard STS call right before: ${log[i]}`).toMatch(
        /^AWSCLI sts get-caller-identity --profile starter-sandbox-developer --region ap-southeast-1 /,
      );
    }
    const records = (await readFile(join(dir, 'reports', 'guard.log'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records.length).toBeGreaterThanOrEqual(mutations.length + 3); // + one init per script
    for (const rec of records) {
      expect(rec['result']).toBe('verified');
      expect(rec['account']).toBe('********3333');
    }
    expect(r.output).not.toContain(ACCOUNT);
  });
});
