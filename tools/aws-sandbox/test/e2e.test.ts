/**
 * End to end: the BUILT CLI (dist/bin.js, run `pnpm --filter @starter/tool-aws-sandbox build` first)
 * as a child process, with a fake `aws` executable and a fake guard-cli.js on disk. Proves the
 * real exec path: execFile without a shell, the scrubbed environment, the guard before the first
 * AWS call, and the distinct exit codes.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPERATIONS_BY_KEY } from '../src/aws/allowlist.js';
import { EXIT } from '../src/cli.js';
import { verifyReportSchema } from '../src/schemas.js';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

const FAKE_AWS = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('aws-cli/2.35.11 Python/3.13.7 Linux/6.12 source/x86_64\\n'); process.exit(0); }
fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify({ args, envNames: Object.keys(process.env).sort() }) + '\\n');
const responses = JSON.parse(fs.readFileSync(path.join(__dirname, 'responses.json'), 'utf8'));
const r = responses[args[0] + ' ' + args[1]];
if (r && r.exit) { process.stderr.write(r.stderr || ''); process.exit(r.exit); }
process.stdout.write(JSON.stringify(r ? r.stdout : {}));
`;

const FAKE_GUARD = `const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'guard-calls.log'), JSON.stringify({ args, envNames: Object.keys(process.env).sort() }) + '\\n');
const mode = fs.readFileSync(path.join(__dirname, 'guard-mode.txt'), 'utf8').trim();
const arg = (f) => args[args.indexOf(f) + 1];
if (mode !== 'ok') { process.stderr.write('ACCOUNT MISMATCH: refusing\\n'); process.exit(12); }
process.stdout.write(JSON.stringify({ time: '2026-10-20T12:00:00Z', label: arg('--label'), account: '********3333',
  principalArn: 'arn:aws:sts::********3333:assumed-role/R/s', principalType: 'AssumedRole', region: arg('--region'),
  executionProfile: arg('--execution-profile') }) + '\\n');
`;

function sandbox(responses: Record<string, unknown>, guardMode: 'ok' | 'refuse') {
  const dir = mkdtempSync(join(tmpdir(), 'starter-aws-sandbox-e2e-'));
  writeFileSync(join(dir, 'aws'), FAKE_AWS);
  chmodSync(join(dir, 'aws'), 0o755);
  writeFileSync(join(dir, 'responses.json'), JSON.stringify(responses));
  writeFileSync(join(dir, 'guard-cli.js'), FAKE_GUARD);
  writeFileSync(join(dir, 'guard-mode.txt'), guardMode);
  writeFileSync(join(dir, 'expected-account'), '111122223333\n', { mode: 0o600 });
  return dir;
}

function run(dir: string, args: string[], extraEnv: Record<string, string> = {}) {
  if (!existsSync(BIN))
    throw new Error(
      `${BIN} is missing: build the package first (pnpm --filter @starter/tool-aws-sandbox build)`,
    );
  const r = spawnSync(
    process.execPath,
    [
      BIN,
      ...args,
      '--aws-cli',
      join(dir, 'aws'),
      '--guard-cli',
      join(dir, 'guard-cli.js'),
      '--expected-account-file',
      join(dir, 'expected-account'),
    ],
    // A polluted (but not refused) parent environment: none of it may reach the AWS CLI; the
    // guard sees all of it.
    {
      cwd: dir,
      encoding: 'utf8',
      env: {
        HOME: dir,
        PATH: process.env['PATH'] ?? '',
        AWS_PAGER: 'less',
        OPERATOR_NOTE: 'not for the aws cli',
        ...extraEnv,
      },
    },
  );
  const lines = (f: string) =>
    existsSync(join(dir, f))
      ? readFileSync(join(dir, f), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as unknown)
      : [];
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    awsCalls: lines('calls.log') as { args: string[]; envNames: string[] }[],
    guardCalls: lines('guard-calls.log') as { args: string[]; envNames: string[] }[],
  };
}

const NAT = {
  'ec2 describe-nat-gateways': {
    stdout: {
      NatGateways: [
        {
          NatGatewayId: 'nat-00000000000000002',
          State: 'available',
          VpcId: 'vpc-1',
          Tags: [{ Key: 'starter:run-id', Value: 'sbx-a1b2c3' }],
        },
      ],
    },
  },
};

describe('built CLI end to end', () => {
  it('verify-clean: guard first, then only allowlisted read-only calls with a scrubbed environment; exit 0 when clean', () => {
    const dir = sandbox({}, 'ok');
    const r = run(dir, ['verify-clean', '--run-id', 'sbx-a1b2c3', '--out', 'v.json']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(EXIT.OK);
    expect(r.guardCalls[0]?.args.slice(0, 4)).toEqual([
      'check',
      '--execution-profile',
      'personal-sandbox',
      '--profile',
    ]);
    expect(r.awsCalls.length).toBeGreaterThan(40);
    // A guard check before EVERY AWS call (no caching by default), with the real environment.
    expect(r.guardCalls).toHaveLength(r.awsCalls.length);
    expect(r.guardCalls[0]?.envNames).toContain('OPERATOR_NOTE');
    for (const c of r.awsCalls) {
      expect(OPERATIONS_BY_KEY.has(`${c.args[0]} ${c.args[1]}`)).toBe(true);
      expect(c.envNames).not.toContain('OPERATOR_NOTE');
      expect(c.envNames).not.toContain('AWS_PROFILE');
    }
    const report = verifyReportSchema.parse(JSON.parse(readFileSync(join(dir, 'v.json'), 'utf8')));
    expect(report.status).toBe('clean');
    expect(report.guard.checks[0]?.executionProfile).toBe('personal-sandbox');
  });

  it('refuses a redirecting environment (AWS_CONFIG_FILE, another region) before the guard or the CLI', () => {
    const dir = sandbox({}, 'ok');
    const envs: Record<string, string>[] = [
      { AWS_CONFIG_FILE: '/tmp/evil' },
      { AWS_REGION: 'us-east-1' },
      { AWS_SESSION_TOKEN: '' },
    ];
    for (const env of envs) {
      const r = run(dir, ['verify-clean', '--run-id', 'sbx-a1b2c3', '--out', 'v.json'], env);
      expect(r.code).toBe(EXIT.REFUSED);
      expect(r.guardCalls).toHaveLength(0);
      expect(r.awsCalls).toHaveLength(0);
    }
  });

  it('writes no absolute local path into the report', () => {
    const dir = sandbox({}, 'ok');
    run(dir, ['verify-clean', '--run-id', 'sbx-a1b2c3', '--out', 'v.json']);
    const report = verifyReportSchema.parse(JSON.parse(readFileSync(join(dir, 'v.json'), 'utf8')));
    expect(report.tool.awsCli?.path).toBe('~/aws');
    expect(report.tool.awsCli?.version).toBe('2.35.11');
    expect(report.tool.guardCli.path).toBe('~/guard-cli.js');
    expect(readFileSync(join(dir, 'v.json'), 'utf8')).not.toContain(dir);
  });

  it('verify-clean: exit 1 with a remaining NAT gateway', () => {
    const dir = sandbox(NAT, 'ok');
    const r = run(dir, ['verify-clean', '--run-id', 'sbx-a1b2c3', '--out', 'v.json']);
    expect(r.code).toBe(EXIT.NOT_CLEAN);
    expect(r.stdout).toMatch(/remaining\s+AWS::EC2::NatGateway nat-00000000000000002/);
  });

  it('guard refusal: exit 3 and the AWS CLI is never started', () => {
    const dir = sandbox(NAT, 'refuse');
    for (const cmd of [
      ['verify-clean', '--run-id', 'sbx-a1b2c3', '--out', 'v.json'],
      ['inventory', '--run-id', 'sbx-a1b2c3', '--out', 'i.json'],
    ]) {
      const r = run(dir, cmd);
      expect(r.code).toBe(EXIT.REFUSED);
      expect(r.stderr).toMatch(/refused: account guard refused: exit 12/);
      expect(r.awsCalls).toHaveLength(0);
    }
    expect(
      verifyReportSchema.parse(JSON.parse(readFileSync(join(dir, 'v.json'), 'utf8'))).status,
    ).toBe('guard-refused');
  });

  it('estimate runs offline without the guard or the AWS CLI', () => {
    const dir = sandbox({}, 'refuse');
    const r = spawnSync(
      process.execPath,
      [BIN, 'estimate', '--phase', '2', '--quiet', '--out', 'e.json'],
      { cwd: dir, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } },
    );
    expect(r.status).toBe(EXIT.OK);
    expect(existsSync(join(dir, 'calls.log'))).toBe(false);
    expect(existsSync(join(dir, 'guard-calls.log'))).toBe(false);
  });
});
