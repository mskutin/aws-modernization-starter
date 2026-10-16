/**
 * End to end: the real CLI (node src/cli.ts) as a child process, with a fake `aws` executable on a
 * temporary PATH that records argv and environment variable NAMES and answers from a scenario
 * file, and a temporary HOME with the native IAM Identity Center profile. No network, no AWS.
 * Every run writes its evidence and raw output into its own temp directory.
 */
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROBES } from '../src/probes.ts';
import { EXIT } from '../src/types.ts';
import {
  GENERATED_POLICY_DOCUMENT,
  makeHome,
  OTHER,
  PROFILE,
  ROLE,
  ROLE_PATTERN,
  SANDBOX,
  SESSION,
  SSO_ROLE_PATH,
} from './support.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const ALLOWED_ENV = new Set([
  'HOME',
  'PATH',
  'LANG',
  'TZ',
  'LC_ALL',
  'AWS_PAGER',
  'AWS_CLI_AUTO_PROMPT',
  'AWS_RETRY_MODE',
  'AWS_MAX_ATTEMPTS',
  'AWS_EC2_METADATA_DISABLED',
  'AWS_CLI_ERROR_FORMAT',
  'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
  'PYTHONNOUSERSITE',
]);
const SECRET_ENV = {
  AWS_ACCESS_KEY_ID: 'unused',
  AWS_SECRET_ACCESS_KEY: 'unused',
  AWS_SESSION_TOKEN: 'unused',
  AWS_PROFILE: 'admin',
  AWS_DEFAULT_PROFILE: 'admin',
  AWS_ROLE_ARN: `arn:aws:iam::${OTHER}:role/admin`,
  AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/web-identity',
  AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/v2/credentials',
  AWS_ENDPOINT_URL: 'http://127.0.0.1:4566',
  AWS_ENDPOINT_URL_STS: 'http://127.0.0.1:4566',
  AWS_CONFIG_FILE: '/tmp/other-config',
  NODE_OPTIONS: '--no-warnings',
  GITLAB_TOKEN: 'unused',
};

interface Logged {
  args: string[];
  envNames: string[];
  pid: number;
}

function fakeAws(scenario: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'aws-preflight-e2e-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { mode: 0o755 });
  chmodSync(bin, 0o755);
  const home = makeHome(dir);
  const log = join(dir, 'calls.jsonl');
  const scenarioFile = join(dir, 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, envNames: Object.keys(process.env).sort(), pid: process.pid }) + '\\n');
if (args[0] === '--version') {
  process.stdout.write('aws-cli/2.35.11 Python/3.14.7 Linux/6.12 source/x86_64\\n');
  process.exit(0);
}
const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioFile)}, 'utf8'));
const r = scenario[args[0] + ' ' + args[1]] || { stdout: {} };
if (r.hang) {
  fs.writeFileSync(r.pidFile, String(process.pid));
  setInterval(() => {}, 1000);
  return;
}
if (r.stderr) process.stderr.write(r.stderr);
if (r.stdout !== undefined) process.stdout.write(JSON.stringify(r.stdout));
process.exit(r.exit === undefined ? 0 : r.exit);
`;
  const aws = join(bin, 'aws');
  writeFileSync(aws, script);
  chmodSync(aws, 0o755);
  const calls = (): Logged[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as Logged)
      : [];
  return {
    dir,
    bin,
    home,
    calls,
    evidence: join(dir, 'out', 'evidence.json'),
    rawDir: join(dir, 'raw'),
  };
}

function runProcess(
  f: ReturnType<typeof fakeAws>,
  argv: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [CLI, ...argv],
      { env, cwd: f.dir, timeout: 110_000 },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? -1 : 0;
        done({ code, stdout, stderr });
      },
    );
  });
}

function runCliProcess(
  f: ReturnType<typeof fakeAws>,
  extra: string[] = [],
  options: { defaultRawDir?: boolean } = {},
) {
  const argv = [
    'discover',
    '--profile',
    PROFILE,
    '--expected-account',
    SANDBOX,
    '--expected-role-pattern',
    ROLE_PATTERN,
    '--region',
    'ap-southeast-1',
    '--evidence-out',
    f.evidence,
    ...(options.defaultRawDir ? [] : ['--raw-dir', f.rawDir]),
    ...extra,
  ];
  // The CLI's own environment is built explicitly (CI/GITLAB_CI from the test runner never leak in).
  return runProcess(f, argv, {
    PATH: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: f.home,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    ...SECRET_ENV,
  });
}

const gateScenario = {
  'sts get-caller-identity': {
    stdout: {
      UserId: `AROAFAKEROLEID00000001:${SESSION}`,
      Account: SANDBOX,
      Arn: `arn:aws:sts::${SANDBOX}:assumed-role/${ROLE}/${SESSION}`,
    },
  },
  'iam list-attached-role-policies': { stdout: { AttachedPolicies: [] } },
  'iam list-role-policies': { stdout: { PolicyNames: ['AwsSSOInlinePolicy'] } },
  'iam get-role-policy': {
    stdout: {
      RoleName: ROLE,
      PolicyName: 'AwsSSOInlinePolicy',
      PolicyDocument: GENERATED_POLICY_DOCUMENT,
    },
  },
  'iam get-role': {
    stdout: {
      Role: { Path: SSO_ROLE_PATH, RoleName: ROLE, Arn: `arn:aws:iam::${SANDBOX}:role/${ROLE}` },
    },
  },
  'organizations describe-organization': {
    stdout: { Organization: { Id: 'o-exampleorgid1', MasterAccountId: '999988887777' } },
  },
  'organizations list-parents': {
    stderr:
      '\naws: [ERROR]: An error occurred (AccessDeniedException) when calling the ListParents operation: denied\n',
    exit: 254,
  },
};

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('CLI end to end with a fake aws on PATH', () => {
  it(
    'discovers through allowlisted, well-formed calls with a scrubbed environment',
    { timeout: 120_000 },
    async () => {
      const f = fakeAws(gateScenario);
      const r = await runCliProcess(f, [], { defaultRawDir: true });
      expect(r.stderr).not.toMatch(/ERROR|REFUSED/);
      expect(r.code).toBe(EXIT.OK);
      const calls = f.calls();
      expect(calls[0]?.args).toEqual(['--version']);
      const allowed = new Set(PROBES.map((p) => `${p.service} ${p.operation}`));
      for (const c of calls.slice(1)) {
        const a = c.args;
        expect(allowed.has(`${a[0]} ${a[1]}`), a.join(' ')).toBe(true);
        for (const forbidden of [
          '--debug',
          '--endpoint-url',
          '--no-verify-ssl',
          '--with-decryption',
        ]) {
          expect(
            a.some((t) => t === forbidden || t.startsWith(`${forbidden}=`)),
            `${a.join(' ')}`,
          ).toBe(false);
        }
        const at = (flag: string) => a[a.indexOf(flag) + 1];
        expect(at('--profile')).toBe(PROFILE);
        expect(['ap-southeast-1', 'us-east-1']).toContain(at('--region'));
        expect(at('--output')).toBe('json');
        expect(a).toContain('--no-cli-pager');
        expect(at('--cli-connect-timeout')).toBe('10');
        expect(at('--cli-read-timeout')).toBe('30');
        // Environment names only from the allowlist; secrets never reach the AWS CLI.
        for (const name of c.envNames) {
          // macOS: the child Node process sets __CF_USER_TEXT_ENCODING in its own environment at
          // startup (`env -i env` prints nothing); it is not passed by the tool.
          if (process.platform === 'darwin' && name === '__CF_USER_TEXT_ENCODING') continue;
          expect(ALLOWED_ENV.has(name), name).toBe(true);
        }
        for (const name of Object.keys(SECRET_ENV)) expect(c.envNames).not.toContain(name);
      }
      // Strictly sequential: one process at a time, in allowlist order, ending with the re-check.
      expect(calls.at(-1)?.args.slice(0, 2)).toEqual(['sts', 'get-caller-identity']);
      // Evidence: written, sanitized, leak-free, with the gate summary and provenance.
      const text = readFileSync(f.evidence, 'utf8');
      expect(text).not.toContain(SESSION);
      const evidence = JSON.parse(text) as {
        complete: boolean;
        gate: Record<string, string>;
        tool: { sourceSha256: string; gitDirty: unknown };
        awsCli: { sha256: string; realpath: string; version: string };
        childEnvironment: { passedThroughNames: string[] };
      };
      expect(evidence.complete).toBe(true);
      expect(evidence.gate).toMatchObject({
        organization: 'member',
        readOnlyAssessment: 'verified-read-only',
        principalRecheck: 'same-principal',
      });
      expect(evidence.tool.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect([true, false, 'unknown']).toContain(evidence.tool.gitDirty);
      expect(evidence.awsCli.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(evidence.awsCli.version).toBe('2.35.11');
      expect(evidence.childEnvironment.passedThroughNames).toEqual(['HOME', 'LANG', 'PATH', 'TZ']);
      // Raw output under the default ~/.local/state location, private.
      const base = join(f.home, '.local', 'state', 'starter-aws-preflight');
      const [runId] = readdirSync(base);
      const rawDir = join(base, runId ?? '');
      expect(statSync(rawDir).mode & 0o777).toBe(0o700);
      expect(readdirSync(rawDir).length).toBe(calls.length); // run.json + one file per AWS call
      expect(r.stdout).not.toContain(SESSION);
      expect(r.stdout).not.toContain(SANDBOX);
      expect(r.stdout).toContain('aws sso logout');
    },
  );

  it(
    'kills a call that exceeds --call-timeout, records it and continues',
    { timeout: 120_000 },
    async () => {
      const pidFile = join(tmpdir(), `aws-preflight-hang-${process.pid}-${Date.now()}`);
      const f = fakeAws({ ...gateScenario, 'ec2 describe-vpcs': { hang: true, pidFile } });
      const r = await runCliProcess(f, ['--call-timeout', '2']);
      expect(r.code).toBe(EXIT.OK);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(pid).toBeGreaterThan(0);
      expect(isAlive(pid)).toBe(false);
      const evidence = JSON.parse(readFileSync(f.evidence, 'utf8')) as {
        probes: { probe: string; status: string }[];
      };
      expect(evidence.probes.find((p) => p.probe === 'b.ec2.vpcs')?.status).toBe('timeout');
      expect(evidence.probes.some((p) => p.probe === 'b.ec2.subnets')).toBe(true);
    },
  );

  it(
    'stops on an account mismatch after exactly one AWS call, without evidence',
    { timeout: 60_000 },
    async () => {
      const f = fakeAws({
        ...gateScenario,
        'sts get-caller-identity': {
          stdout: { Account: OTHER, Arn: `arn:aws:sts::${OTHER}:assumed-role/${ROLE}/${SESSION}` },
        },
      });
      const r = await runCliProcess(f);
      expect(r.code).toBe(EXIT.ACCOUNT_MISMATCH);
      expect(f.calls().map((c) => c.args.slice(0, 2).join(' '))).toEqual([
        '--version',
        'sts get-caller-identity',
      ]);
      expect(existsSync(f.evidence)).toBe(false);
      expect(r.stderr).toContain('ACCOUNT MISMATCH');
      expect(r.stderr).not.toContain(OTHER);
    },
  );

  it('refuses an ~/.aws/cli/alias file before any aws process', { timeout: 60_000 }, async () => {
    const f = fakeAws(gateScenario);
    mkdirSync(join(f.home, '.aws', 'cli'));
    writeFileSync(
      join(f.home, '.aws', 'cli', 'alias'),
      '[command ec2]\ndescribe-vpcs = !touch /tmp/should-never-exist\n',
    );
    const r = await runCliProcess(f);
    expect(r.code).toBe(EXIT.REFUSED);
    expect(r.stderr).toContain('cli/alias exists');
    expect(f.calls()).toEqual([]);
    expect(existsSync(f.evidence)).toBe(false);
    expect(existsSync(f.rawDir) ? readdirSync(f.rawDir) : []).toEqual([]);
  });

  it(
    'never loads a Prettier configuration found near --evidence-out',
    { timeout: 120_000 },
    async () => {
      const f = fakeAws(gateScenario);
      const marker = join(f.dir, 'prettier-config-was-executed');
      mkdirSync(join(f.dir, 'out'));
      const payload = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); module.exports = { useTabs: true, printWidth: 20 };\n`;
      writeFileSync(join(f.dir, '.prettierrc.js'), payload);
      writeFileSync(join(f.dir, '.prettierrc.cjs'), payload);
      writeFileSync(
        join(f.dir, 'out', 'prettier.config.mjs'),
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x'); export default { useTabs: true };\n`,
      );
      writeFileSync(join(f.dir, 'out', '.editorconfig'), 'root = true\n[*]\nindent_style = tab\n');
      const r = await runCliProcess(f);
      expect(r.code).toBe(EXIT.OK);
      expect(existsSync(marker)).toBe(false);
      const text = readFileSync(f.evidence, 'utf8');
      expect(text).not.toContain('\t');
      expect(text.split('\n')[1]).toMatch(/^ {2}"schemaVersion": 4,$/);
    },
  );

  it(
    'refuses in CI before anything else (no aws process, nothing written)',
    { timeout: 60_000 },
    async () => {
      const f = fakeAws(gateScenario);
      const r = await runProcess(
        f,
        [
          'discover',
          '--profile',
          PROFILE,
          '--expected-account',
          SANDBOX,
          '--expected-role-pattern',
          ROLE_PATTERN,
          // A temp evidence path and raw dir, so a regressed refusal cannot write into
          // the repository.
          '--evidence-out',
          f.evidence,
          '--raw-dir',
          f.rawDir,
        ],
        { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.home, GITLAB_CI: 'true' },
      );
      expect(r.code).toBe(EXIT.REFUSED);
      expect(r.stderr).toContain('never runs in a pipeline');
      expect(f.calls()).toEqual([]);
      expect(existsSync(f.evidence)).toBe(false);
      expect(existsSync(f.rawDir)).toBe(false);
    },
  );
});
