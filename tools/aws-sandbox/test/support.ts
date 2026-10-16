/**
 * Test support: an in-process fake AWS CLI and a fake account guard (injected ProcessRunners),
 * recorded-response builders and a temporary workspace. All identifiers are fake: account
 * 111122223333 (sandbox) and 444455556666 (another account), low-entropy resource ids.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../src/aws/executor.js';
import { main, type Deps } from '../src/cli.js';
import { maskString } from '../src/mask.js';

export const ACCOUNT = '111122223333';
export const OTHER_ACCOUNT = '444455556666';
export const REGION = 'ap-southeast-1';
export const RUN_ID = 'sbx-a1b2c3';
export const NOW = new Date('2026-10-20T12:00:00.000Z');

export interface FakeResponse {
  readonly stdout?: unknown;
  readonly stderr?: string;
  readonly exit?: number;
  readonly timedOut?: boolean;
}
export type Responder = FakeResponse | ((args: readonly string[]) => FakeResponse);

export const ok = (stdout: unknown): FakeResponse => ({ stdout });
export const awsError = (code: string, message = 'details'): FakeResponse => ({
  stderr: `\nAn error occurred (${code}) when calling the Operation operation: ${message}\n`,
  exit: 254,
});

export interface FakeAwsCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** In-process fake `aws`: responses by `service operation`; unknown operations return `{}`. */
export function fakeAws(
  responses: Readonly<Record<string, Responder>>,
  options: { version?: string } = {},
) {
  const calls: FakeAwsCall[] = [];
  const versionCalls: FakeAwsCall[] = [];
  const runner: ProcessRunner = async (req: ProcessRequest): Promise<ProcessResult> => {
    if (req.args[0] === '--version') {
      versionCalls.push({ file: req.file, args: [...req.args], env: { ...req.env } });
      return {
        exitCode: 0,
        stdout: `aws-cli/${options.version ?? '2.35.11'} Python/3.13.7 Darwin/25.0.0 source/arm64\n`,
        stderr: '',
        timedOut: false,
      };
    }
    calls.push({ file: req.file, args: [...req.args], env: { ...req.env } });
    const key = `${req.args[0]} ${req.args[1]}`;
    const responder = responses[key] ?? ok({});
    const r = typeof responder === 'function' ? responder(req.args) : responder;
    if (r.timedOut) return { exitCode: null, stdout: '', stderr: '', timedOut: true };
    return {
      exitCode: r.exit ?? 0,
      stdout: r.stdout === undefined ? '' : JSON.stringify(r.stdout),
      stderr: r.stderr ?? '',
      timedOut: false,
    };
  };
  const ops = () => calls.map((c) => `${c.args[0]} ${c.args[1]}`);
  return { runner, calls, versionCalls, ops };
}

export type GuardMode = 'ok' | 'refuse' | 'wrong-region' | 'unmasked' | 'refuse-after-first';

/** In-process fake guard: echoes a guard record for the requested label, or refuses. */
export function fakeGuard(mode: GuardMode = 'ok') {
  const calls: (readonly string[])[] = [];
  const runner: ProcessRunner = async (req) => {
    calls.push([...req.args]);
    const arg = (flag: string) => req.args[req.args.indexOf(flag) + 1];
    if (mode === 'refuse' || (mode === 'refuse-after-first' && calls.length > 1)) {
      return {
        exitCode: 12,
        stdout: '',
        stderr: `ACCOUNT MISMATCH: expected ********3333, got ********${OTHER_ACCOUNT.slice(-4)}\n`,
        timedOut: false,
      };
    }
    const record = {
      time: NOW.toISOString(),
      label: arg('--label'),
      account: mode === 'unmasked' ? ACCOUNT : '********3333',
      principalArn: `arn:aws:sts::********3333:assumed-role/AWSReservedSSO_Developer_0123456789abcdef/operator`,
      principalType: 'AssumedRole',
      region: mode === 'wrong-region' ? 'us-east-1' : arg('--region'),
      executionProfile: arg('--execution-profile'),
    };
    return { exitCode: 0, stdout: `${JSON.stringify(record)}\n`, stderr: '', timedOut: false };
  };
  return { runner, calls };
}

/** A temp directory with a placeholder `aws` executable and `guard-cli.js` (never executed). */
export function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'starter-aws-sandbox-'));
  const aws = join(dir, 'aws');
  writeFileSync(aws, '#!/bin/sh\nexit 99\n');
  chmodSync(aws, 0o755);
  const guard = join(dir, 'guard-cli.js');
  writeFileSync(guard, '// placeholder; tests inject the guard runner\n');
  const expected = join(dir, 'expected-account');
  writeFileSync(expected, `${ACCOUNT}\n`, { mode: 0o600 });
  return { dir, aws, guard, expected };
}

export async function runCli(
  argv: readonly string[],
  options: {
    aws?: ReturnType<typeof fakeAws>;
    guard?: ReturnType<typeof fakeGuard>;
    env?: NodeJS.ProcessEnv;
    cwd: string;
  },
) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: Deps = {
    env: options.env ?? { HOME: options.cwd, PATH: '/usr/bin:/bin' },
    cwd: options.cwd,
    now: () => NOW,
    ...(options.aws ? { awsRunner: options.aws.runner } : {}),
    ...(options.guard ? { guardRunner: options.guard.runner } : {}),
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  };
  const code = await main(argv, deps);
  return { code, out: out.join(''), err: err.join('\n') };
}

/** AWS options pointing at the workspace placeholders. */
export const awsArgs = (ws: ReturnType<typeof workspace>) => [
  '--aws-cli',
  ws.aws,
  '--guard-cli',
  ws.guard,
  '--expected-account-file',
  ws.expected,
];

// ── Recorded-response builders ───────────────────────────────────────────────────────────────

export const runTags = (runId = RUN_ID) => [
  { Key: 'starter:run-id', Value: runId },
  { Key: 'starter:experiment', Value: 'live-validation' },
  { Key: 'Project', Value: 'aws-modernization-starter' },
];
export const arn = (service: string, resource: string, account = ACCOUNT) =>
  `arn:aws:${service}:${REGION}:${account}:${resource}`;

/** A minimal cloud assembly with one nested assembly (as `cdk synth` writes it). */
export function assembly(stacks: Record<string, Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), 'starter-synth-'));
  const nested = join(root, 'assembly-Sandbox');
  mkdirSync(nested);
  const artifacts: Record<string, unknown> = {};
  for (const [name, resources] of Object.entries(stacks)) {
    const file = `${name.replace(/[^A-Za-z0-9]/g, '')}.template.json`;
    writeFileSync(join(nested, file), JSON.stringify({ Resources: resources }));
    artifacts[name] = {
      type: 'aws:cloudformation:stack',
      properties: { templateFile: file, stackName: name },
    };
  }
  writeFileSync(join(nested, 'manifest.json'), JSON.stringify({ artifacts }));
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({ artifacts: { 'assembly-Sandbox': { type: 'cdk:cloud-assembly' } } }),
  );
  return root;
}

/** A schema-valid inventory of RUN_ID (masked ids, as the inventory command writes them). */
export function inventoryFixture(
  stacks: {
    name: string;
    resources: { logicalId: string; type: string; physicalId: string }[];
  }[],
  options: { runId?: string; startedAt?: string } = {},
) {
  const masked = maskString;
  const runId = options.runId ?? RUN_ID;
  return {
    kind: 'starter-aws-sandbox/inventory',
    schemaVersion: 1,
    generatedAt: '2026-10-20T09:00:00.000Z',
    runId,
    phase: 2,
    region: REGION,
    account: '********3333',
    executionProfile: 'personal-sandbox',
    readOnly: true,
    status: 'ok',
    statusReason: 'fixture',
    stacks: stacks.map((s) => ({
      name: s.name,
      id: masked(stackArn(s.name)),
      status: 'CREATE_COMPLETE',
      createdAt: options.startedAt ?? '2026-10-20T08:00:00.000Z',
      lastUpdatedAt: null,
      terminationProtection: false,
      tags: { 'starter:run-id': runId },
      resources: s.resources.map((r) => ({
        logicalId: r.logicalId,
        type: r.type,
        physicalId: masked(r.physicalId),
        status: 'CREATE_COMPLETE',
        createdAt: null,
        lastUpdatedAt: null,
        hourlyUsd: 0,
      })),
      hourlyUsd: 0,
    })),
    bootstrap: null,
    experimentResources: { kmsKeys: [], secrets: [], logGroups: [] },
    otherRunStacks: [],
    cost: {
      disclaimer: 'estimate',
      estimateBasis: 'contract',
      priceBasis: 'fixture',
      resourcesUsdPerHour: 0,
      otherUsdPerHour: 0,
      totalUsdPerHour: 0,
      oneTimeUsd: 0,
      partialHourRoundingUsd: 0,
      accountLevelUsd: 0,
      startedAt: options.startedAt ?? '2026-10-20T08:00:00.000Z',
      elapsedHours: 1,
      estimatedSpendSoFarUsd: 0,
    },
    runtime: {
      stopUsd: 13,
      spentUsd: 0,
      marginPercent: 25,
      taxRatePercent: 9,
      maxRuntimeHours: 14,
      timeBoxHours: 8,
      effectiveMaxRuntimeHours: 8,
      bindingLimit: 'time-box',
      teardownStartBy: null,
      allDeletedBy: null,
      expiresAtTag: null,
      basis: 'fixture',
    },
    teardown: { owner: 'operator', command: 'down.sh', verifyCommand: 'verify.sh', notes: [] },
    guard: { checks: [], refusal: null, maxAgeSeconds: 0 },
    tool: { awsCli: null, guardCli: { path: '/g', sha256: null }, awsCalls: [] },
    errors: [],
    notes: [],
  };
}

/** The real (unmasked) stack id the fixtures use for a stack name. */
export const stackArn = (name: string) =>
  arn('cloudformation', `stack/${name}/00000000-0000-4000-8000-000000000001`);
