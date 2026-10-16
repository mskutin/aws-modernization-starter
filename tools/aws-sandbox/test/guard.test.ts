import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GUARD_CLI,
  GuardRefused,
  GuardSession,
  guardArgv,
  parseGuardRecord,
  runGuard,
} from '../src/aws/guard.js';
import { fakeGuard, workspace } from './support.js';

const config = (ws: ReturnType<typeof workspace>) => ({
  guardCli: ws.guard,
  profile: 'starter-sandbox-developer',
  expectedAccountFile: ws.expected,
  region: 'ap-southeast-1',
});
const record = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    time: '2026-10-20T12:00:00Z',
    label: 'L',
    account: '********3333',
    principalArn: 'arn:aws:sts::********3333:assumed-role/R/s',
    principalType: 'AssumedRole',
    region: 'ap-southeast-1',
    executionProfile: 'personal-sandbox',
    ...o,
  });

describe('account guard', () => {
  it('calls guard-cli.js check with the personal-sandbox execution profile and explicit inputs', () => {
    const ws = workspace();
    expect(guardArgv({ ...config(ws), logFile: '/runs/x/guard.log' }, 'L')).toEqual([
      ws.guard,
      'check',
      '--execution-profile',
      'personal-sandbox',
      '--profile',
      'starter-sandbox-developer',
      '--expected-account-file',
      ws.expected,
      '--region',
      'ap-southeast-1',
      '--label',
      'L',
      '--log',
      '/runs/x/guard.log',
    ]);
    expect(DEFAULT_GUARD_CLI).toMatch(/tools[/\\]aws-preflight[/\\]dist[/\\]guard-cli\.js$/);
  });

  it('accepts only a matching, masked record', () => {
    const want = { label: 'L', region: 'ap-southeast-1' };
    expect(parseGuardRecord(`noise\n${record()}\n`, want)).toMatchObject({
      account: '********3333',
    });
    expect(parseGuardRecord(record({ executionProfile: 'strict' }), want)).toHaveProperty('error');
    expect(parseGuardRecord(record({ region: 'us-east-1' }), want)).toHaveProperty('error');
    expect(parseGuardRecord(record({ label: 'other' }), want)).toHaveProperty('error');
    expect(parseGuardRecord(record({ account: '111122223333' }), want)).toHaveProperty('error');
    expect(parseGuardRecord(record({ principalType: undefined }), want)).toHaveProperty('error');
    expect(parseGuardRecord('', want)).toHaveProperty('error');
    expect(parseGuardRecord('{not json', want)).toHaveProperty('error');
  });

  it('refuses when the guard exits non-zero, is missing, or the label is unsafe', async () => {
    const ws = workspace();
    const refused = await runGuard(config(ws), 'L', {
      runner: fakeGuard('refuse').runner,
      parentEnv: {},
      cwd: ws.dir,
    });
    expect(refused).toMatchObject({ ok: false, exitCode: 12 });
    const missing = await runGuard({ ...config(ws), guardCli: join(ws.dir, 'nope.js') }, 'L', {
      parentEnv: {},
      cwd: ws.dir,
    });
    expect(missing).toMatchObject({ ok: false });
    expect(!missing.ok && missing.reason).toMatch(/refusing to call AWS/);
    const unsafe = await runGuard(config(ws), 'L; rm -rf', {
      runner: fakeGuard().runner,
      parentEnv: {},
      cwd: ws.dir,
    });
    expect(unsafe).toMatchObject({ ok: false });
  });

  it('re-verifies when the last verification is older than the freshness window', async () => {
    const ws = workspace();
    const guard = fakeGuard();
    let now = 0;
    const session = new GuardSession(config(ws), {
      runner: guard.runner,
      parentEnv: {},
      cwd: ws.dir,
      clock: () => now,
      maxAgeMs: 1000,
    });
    await session.ensure('L');
    now = 999;
    await session.ensure('L');
    expect(guard.calls).toHaveLength(1);
    now = 2001;
    await session.ensure('L');
    expect(guard.calls).toHaveLength(2);
    expect(session.checks).toHaveLength(2);
  });

  it('by default verifies before every call (no caching) and gives the guard the real environment', async () => {
    const ws = workspace();
    const guard = fakeGuard();
    const seen: Record<string, string>[] = [];
    const session = new GuardSession(config(ws), {
      runner: async (req) => {
        seen.push({ ...req.env });
        return guard.runner(req);
      },
      parentEnv: { HOME: ws.dir, AWS_REGION: 'ap-southeast-1', OPERATOR_VAR: 'x' },
      cwd: ws.dir,
      clock: () => 0,
    });
    await session.ensure('L');
    await session.ensure('L');
    expect(guard.calls).toHaveLength(2);
    expect(session.maxAgeSeconds).toBe(0);
    expect(seen[0]).toMatchObject({ AWS_REGION: 'ap-southeast-1', OPERATOR_VAR: 'x' });
  });

  it('throws GuardRefused when a re-verification fails', async () => {
    const ws = workspace();
    const guard = fakeGuard('refuse-after-first');
    let now = 0;
    const session = new GuardSession(config(ws), {
      runner: guard.runner,
      parentEnv: {},
      cwd: ws.dir,
      clock: () => now,
      maxAgeMs: 10,
    });
    await session.ensure('L');
    now = 100;
    await expect(session.ensure('L')).rejects.toBeInstanceOf(GuardRefused);
  });
});
