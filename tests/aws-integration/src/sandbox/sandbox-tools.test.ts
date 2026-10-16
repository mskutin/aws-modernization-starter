/**
 * Unit tests of the Phase 2 sandbox helpers (pure logic over AWS CLI JSON; no AWS, no network).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  albSecurityGroupCheck,
  listenerCheck,
  smokeSteps,
  stepFunctionsSummary,
} from './aws-checks.js';
import { FAKE_GUARD, unguardedMutations } from './fixtures/fake-guard.js';
import {
  DENY_OUTSIDE_TRANSACTION,
  DENY_STATEMENTS,
  ECS_OVERRIDES_LIMIT,
  PROBE_MARKER,
  evaluateProbe,
  probeLines,
  probeOverrides,
  type ProbeLine,
} from './db-probe.js';
import {
  failurePathOf,
  leakScan,
  loadCanaries,
  privateJwkSecrets,
  scanTexts,
} from './leak-scan.js';
import { newEvents, parseEvents } from './log-follow.js';
import {
  findOutput,
  getPath,
  mergeOutputs,
  outputsFromDescribeStacks,
  scalarText,
} from './outputs.js';
import {
  appendRecords,
  fromPlaywrightJson,
  fromVitestJson,
  makeRecord,
  readRecords,
  summarize,
} from './results.js';
import {
  UNHEALTHY_CMD,
  cloneTaskDefinition,
  deriveUnhealthyImage,
  initialRolloutState,
  observeRollout,
  serviceEventsSince,
} from './rollback.js';
import { experimentStacks, otherRuns } from './stacks.js';
import { unverifiableLines } from './verify-report.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'starter-sbx-tools-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rec = (check: string, status: Parameters<typeof makeRecord>[0]['status']) =>
  makeRecord({ check, name: `${check}-${status}`, status, evidence: 'e' });

describe('results', () => {
  it('a run that executed nothing, or only skips, is never green', () => {
    expect(summarize([]).ok).toBe(false);
    expect(summarize([rec('a', 'skipped')]).ok).toBe(false);
  });

  it('green only when something passed and nothing failed, errored or was not run', () => {
    expect(summarize([rec('a', 'passed'), rec('a', 'skipped')]).ok).toBe(true);
    for (const bad of ['failed', 'error', 'not-run'] as const) {
      const s = summarize([rec('a', 'passed'), rec('b', bad)]);
      expect(s.ok, bad).toBe(false);
      expect(s.checks.find((c) => c.check === 'b')?.status).toBe(bad);
    }
  });

  it('a check is as bad as its worst result', () => {
    const s = summarize([rec('x', 'passed'), rec('x', 'not-run'), rec('x', 'failed')]);
    expect(s.checks).toEqual([
      expect.objectContaining({
        check: 'x',
        status: 'failed',
        counts: expect.objectContaining({ passed: 1, failed: 1, 'not-run': 1 }),
      }),
    ]);
  });

  it('round-trips JSON lines, bounds details and rejects malformed lines', async () => {
    const file = join(dir, 'r.jsonl');
    appendRecords(file, [
      makeRecord({
        check: 'c',
        name: 'n',
        status: 'failed',
        evidence: 'e',
        detail: `a\n  b ${'x'.repeat(900)}`,
      }),
    ]);
    const [r] = readRecords(file);
    expect(r?.detail).toMatch(/^a b x+…$/);
    expect(r?.detail?.length).toBe(500);
    await writeFile(file, '{"check":"c","name":"n","status":"great","evidence":"e"}\n');
    expect(() => readRecords(file)).toThrow(/malformed/);
  });

  it('Vitest JSON: passed/failed/skipped per test; a file that did not load is an error', () => {
    const records = fromVitestJson(
      {
        testResults: [
          {
            name: 'a.test.ts',
            status: 'failed',
            assertionResults: [
              { fullName: 'suite ok', status: 'passed' },
              {
                fullName: 'suite bad',
                status: 'failed',
                failureMessages: ['AssertionError: x\n at y'],
              },
              { fullName: 'suite skip [skipped: self only]', status: 'skipped' },
              { fullName: 'suite todo', status: 'todo' },
            ],
          },
          {
            name: 'b.test.ts',
            status: 'failed',
            message: 'SyntaxError: nope\nmore',
            assertionResults: [],
          },
        ],
      },
      'security',
      'sec.json',
    );
    expect(records.map((r) => [r.name, r.status])).toEqual([
      ['suite ok', 'passed'],
      ['suite bad', 'failed'],
      ['suite skip [skipped: self only]', 'skipped'],
      ['suite todo', 'skipped'],
      ['security: b.test.ts did not run', 'error'],
    ]);
    expect(records[1]?.detail).toBe('AssertionError: x');
  });

  it('Vitest JSON without tests, or not a report at all, is an error', () => {
    expect(fromVitestJson({ testResults: [] }, 'c', 'e')[0]?.status).toBe('error');
    expect(fromVitestJson('nope', 'c', 'e')[0]?.status).toBe('error');
  });

  it('Playwright JSON: expected=passed, skipped, unexpected and flaky fail, run errors are errors', () => {
    const records = fromPlaywrightJson(
      {
        suites: [
          {
            title: 'jobs.spec.ts',
            specs: [],
            suites: [
              {
                title: 'identity',
                specs: [
                  { title: 'a', tests: [{ status: 'expected', results: [{ status: 'passed' }] }] },
                  {
                    title: 'b',
                    tests: [
                      { status: 'unexpected', results: [{ error: { message: 'boom\nstack' } }] },
                    ],
                  },
                  { title: 'c', tests: [{ status: 'flaky', results: [] }] },
                  { title: 'd', tests: [{ status: 'skipped', results: [] }] },
                ],
              },
            ],
          },
        ],
        errors: [{ message: 'browserType.launch: Executable does not exist\n…' }],
      },
      'e2e',
      'e2e.json',
    );
    expect(records.map((r) => [r.name, r.status, r.detail])).toEqual([
      ['jobs.spec.ts › identity › a', 'passed', undefined],
      ['jobs.spec.ts › identity › b', 'failed', 'boom'],
      ['jobs.spec.ts › identity › c', 'failed', 'flaky (passed on retry; fails by policy)'],
      ['jobs.spec.ts › identity › d', 'skipped', undefined],
      ['e2e: run error', 'error', 'browserType.launch: Executable does not exist'],
    ]);
    expect(fromPlaywrightJson({ suites: [] }, 'e2e', 'x')[0]?.status).toBe('error');
  });
});

describe('outputs', () => {
  const described = {
    Stacks: [
      {
        StackName: 'Sandbox-Api',
        Outputs: [
          { OutputKey: 'ServiceName', OutputValue: 'starter-sbx-api' },
          { OutputKey: 'ApiAlbDnsName1A2B3C4D', OutputValue: 'alb.example' },
        ],
      },
      { StackName: 'Sandbox-Data', Outputs: [{ OutputKey: 'JobTableName', OutputValue: 't' }] },
    ],
  };

  it('describe-stacks → { stack: { key: value } }, merged', () => {
    const o = mergeOutputs(outputsFromDescribeStacks(described), {
      'Sandbox-Data': { DbEndpoint: 'db' },
    });
    expect(o['Sandbox-Data']).toEqual({ JobTableName: 't', DbEndpoint: 'db' });
  });

  it('finds exact keys and CDK-hashed construct outputs; refuses ambiguity and absence', () => {
    const o = outputsFromDescribeStacks(described);
    expect(findOutput(o, 'Sandbox-Api', 'ServiceName')).toBe('starter-sbx-api');
    expect(findOutput(o, 'Sandbox-Api', 'AlbDnsName')).toBe('alb.example');
    expect(() => findOutput(o, 'Sandbox-Api', 'Missing')).toThrow(/not found/);
    expect(() => findOutput(o, 'Sandbox-Nope', 'X')).toThrow(/no outputs/);
    const twice = { S: { AAlbDnsName: '1', BAlbDnsName: '2' } };
    expect(() => findOutput(twice, 'S', 'AlbDnsName')).toThrow(/ambiguous/);
  });

  it('paths: dots, indices, length and bracketed keys with dots', () => {
    const j = {
      tasks: [{ containers: [{ exitCode: 0 }] }],
      Labels: { 'org.opencontainers.image.revision': 'abc' },
      o: { 'awslogs-group': 'g' },
    };
    expect(getPath(j, 'tasks.0.containers.0.exitCode')).toBe(0);
    expect(getPath(j, 'tasks.length')).toBe(1);
    expect(getPath(j, 'Labels[org.opencontainers.image.revision]')).toBe('abc');
    expect(getPath(j, 'o.awslogs-group')).toBe('g');
    expect(getPath(j, 'tasks.3.x')).toBeUndefined();
    expect(scalarText(getPath(j, 'tasks.0.containers.0.exitCode'))).toBe('0');
    expect(scalarText(null)).toBeUndefined();
  });
});

describe('stacks', () => {
  const stack = (
    name: string,
    tags: Record<string, string>,
    extra: Record<string, unknown> = {},
  ) => ({
    StackName: name,
    StackStatus: 'CREATE_COMPLETE',
    Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
    ...extra,
  });
  const json = {
    Stacks: [
      stack('Sandbox-Foundation', {
        'starter:experiment': 'live-validation',
        'starter:run-id': 'sbx-aaaaaa',
      }),
      stack('Sandbox-Api', { 'starter:run-id': 'sbx-aaaaaa' }),
      stack('Sandbox-Frontend', {
        'starter:experiment': 'live-validation',
        'starter:run-id': 'sbx-bbbbbb',
      }),
      stack('Sandbox-Unrelated', { Owner: 'someone' }),
      stack(
        'Sandbox-Data',
        { 'starter:experiment': 'live-validation' },
        { EnableTerminationProtection: true },
      ),
      stack('Dev-Api', { 'starter:experiment': 'live-validation' }),
      stack(
        'Sandbox-Workflow',
        { 'starter:run-id': 'sbx-aaaaaa' },
        { StackStatus: 'DELETE_COMPLETE' },
      ),
    ],
  };

  it('finds experiment stacks by name AND tag, in teardown order', () => {
    expect(experimentStacks(json).map((s) => s.stackName)).toEqual([
      'Sandbox-Frontend',
      'Sandbox-Api',
      'Sandbox-Data',
      'Sandbox-Foundation',
    ]);
  });

  it('filters by run id (an untagged-run experiment stack is kept), reports protection', () => {
    const found = experimentStacks(json, 'sbx-aaaaaa');
    expect(found.map((s) => s.stackName)).toEqual([
      'Sandbox-Api',
      'Sandbox-Data',
      'Sandbox-Foundation',
    ]);
    expect(found.find((s) => s.stackName === 'Sandbox-Data')?.terminationProtection).toBe(true);
    expect(otherRuns(json, 'sbx-aaaaaa')).toEqual(['sbx-bbbbbb']);
    expect(otherRuns(json, 'sbx-bbbbbb')).toEqual(['sbx-aaaaaa']);
  });
});

describe('db probe', () => {
  it('fits the ECS overrides limit and is a syntactically valid ES module', async () => {
    const o = probeOverrides('api', 'sbx-abcdef-p1');
    expect(JSON.stringify(o).length).toBeLessThanOrEqual(ECS_OVERRIDES_LIMIT);
    const [c] = o.containerOverrides;
    expect(c?.name).toBe('api');
    expect(c?.command.slice(0, 2)).toEqual(['--input-type=module', '-e']);
    expect(c?.environment).toEqual([{ name: 'PROBE_RUN_ID', value: 'sbx-abcdef-p1' }]);
    // Parse (not run) the probe as a module: node --check on a file.
    const file = join(dir, 'probe.mjs');
    await writeFile(file, c?.command[2] ?? '');
    const { execFileSync } = await import('node:child_process');
    expect(() =>
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }),
    ).not.toThrow();
  });

  const line = (name: string, ok: boolean, extra: Partial<ProbeLine> = {}) =>
    JSON.stringify({ probe: PROBE_MARKER, runId: 'r1', name, ok, ...extra });
  const allGood = (): string[] => [
    line('tls-verify-full', true, { user: 'starter_app', ssl: true, tls: 'TLSv1.3' }),
    line('tls-wrong-ca', false, { code: 'SELF_SIGNED_CERT_IN_CHAIN' }),
    line('tls-wrong-hostname', false, { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
    line('tls-disabled', false, { code: '28000' }),
    line('iam-other-role', false, { code: '28P01' }),
    line('allow:count jobs', true),
    line('allow:read job ids', true),
    ...[...DENY_STATEMENTS, ...DENY_OUTSIDE_TRANSACTION].map(([n]) =>
      line(`deny:${n}`, false, { code: '42501' }),
    ),
    line('done', true),
  ];

  it('all expectations met → every verdict passes; lines of other runs and noise are ignored', () => {
    const messages = [
      'starting',
      `2026-10-15T00:00:00Z ${line('tls-verify-full', false)}`.replace('r1', 'other'),
      ...allGood(),
    ];
    const verdicts = evaluateProbe(probeLines(messages, 'r1'));
    expect(verdicts.filter((v) => !v.ok)).toEqual([]);
    expect(verdicts.length).toBe(
      5 + 2 + DENY_STATEMENTS.length + DENY_OUTSIDE_TRANSACTION.length + 1,
    );
  });

  it('a privilege that is NOT denied, a TLS bypass, a missing case and a wrong error code all fail', () => {
    const lines = allGood()
      .filter((l) => !l.includes('"iam-other-role"'))
      .map((l) => (l.includes('deny:TRUNCATE jobs') ? line('deny:TRUNCATE jobs', true) : l))
      .map((l) => (l.includes('tls-wrong-ca') ? line('tls-wrong-ca', true) : l))
      .map((l) =>
        l.includes('deny:DROP TABLE jobs')
          ? line('deny:DROP TABLE jobs', false, { code: '42P01' })
          : l,
      );
    const failed = evaluateProbe(probeLines(lines, 'r1')).filter((v) => !v.ok);
    expect(failed.map((v) => v.name)).toEqual([
      'db: a trust store without the RDS CA is rejected (TLS verification)',
      'db: the API task role cannot log in as starter_migrator',
      'db: starter_app cannot TRUNCATE jobs (42501)',
      'db: starter_app cannot DROP TABLE jobs (42501)',
    ]);
    expect(failed[1]?.detail).toMatch(/did not run/);
  });

  it('RDS feature_not_supported (0A000) counts as a denial for COPY TO PROGRAM only', () => {
    const withCode = (name: string, code: string) =>
      allGood().map((l) =>
        l.includes(`"deny:${name}"`) ? line(`deny:${name}`, false, { code }) : l,
      );
    const verdictOf = (lines: string[], name: string) =>
      evaluateProbe(probeLines(lines, 'r1')).find((v) => v.name.includes(name))?.ok;
    expect(verdictOf(withCode('COPY TO PROGRAM', '0A000'), 'COPY TO PROGRAM')).toBe(true);
    expect(verdictOf(withCode('CREATE ROLE', '0A000'), 'CREATE ROLE')).toBe(false);
    expect(verdictOf(withCode('COPY TO PROGRAM', '42P01'), 'COPY TO PROGRAM')).toBe(false);
  });

  it('a connection refused by the network is not proof that TLS is enforced', () => {
    const lines = allGood().map((l) =>
      l.includes('tls-disabled') ? line('tls-disabled', false, { code: 'ECONNREFUSED' }) : l,
    );
    expect(evaluateProbe(probeLines(lines, 'r1')).find((v) => /without TLS/.test(v.name))?.ok).toBe(
      false,
    );
  });
});

describe('leak scan', () => {
  const canaryRun = {
    canaries: {
      title: 'sbx canary title r~live~1',
      sentence: 'the silent beacon aa~bb stays.',
      token: 'cnry~aaaa~bbbb',
    },
    ownerView: { titleFound: true, contentCanariesFound: 0 },
  };

  it('loads our canary run and the security suite canaries.json; ignores short values', () => {
    expect(loadCanaries(canaryRun, 'live').map((c) => c.label)).toEqual([
      'live:title',
      'live:sentence',
      'live:token',
    ]);
    expect(
      loadCanaries(
        {
          canaries: [
            { label: 'proxy:token', value: 'cnry~1234567' },
            { label: 'x', value: 'short' },
          ],
        },
        's',
      ),
    ).toEqual([{ label: 's:proxy:token', value: 'cnry~1234567' }]);
  });

  it('counts canary, secret and JWT hits without returning the matched text', () => {
    const jwt = `eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4eHh4eCJ9.${'a'.repeat(40)}`;
    const s = scanTexts(
      'log',
      'g',
      ['clean', `has cnry~aaaa~bbbb and ${jwt}`, 'origin-secret-value!'],
      loadCanaries(canaryRun, 'live'),
      [{ label: 'origin', value: 'origin-secret-value!' }],
    );
    expect(s).toEqual({
      kind: 'log',
      name: 'g',
      events: 3,
      canaryHits: { 'live:token': 1 },
      secretHits: { origin: 1 },
      jwtHits: 1,
    });
    expect(JSON.stringify(s)).not.toContain('cnry~aaaa~bbbb');
  });

  const writeInputs = async (
    logs: Record<string, string[]>,
    histories: Record<string, unknown[]>,
  ) => {
    await mkdir(join(dir, 'logs'));
    await mkdir(join(dir, 'history'));
    let i = 0;
    const index: string[] = [];
    for (const [group, messages] of Object.entries(logs)) {
      i += 1;
      await writeFile(
        join(dir, 'logs', `g${i}.json`),
        JSON.stringify({ events: messages.map((message) => ({ message })) }),
      );
      index.push(JSON.stringify({ file: `g${i}.json`, group }));
    }
    await writeFile(join(dir, 'logs', 'index.jsonl'), `${index.join('\n')}\n`);
    for (const [name, events] of Object.entries(histories)) {
      await writeFile(join(dir, 'history', `${name}.json`), JSON.stringify({ events }));
    }
  };
  const failureHistory = [
    { type: 'ExecutionStarted', executionStartedEventDetails: { input: '{"jobId":"j2"}' } },
    {
      type: 'LambdaFunctionFailed',
      lambdaFunctionFailedEventDetails: { error: 'JobValidationError', cause: 'too few words' },
    },
    { type: 'TaskStateEntered', stateEnteredEventDetails: { name: 'RecordFailure' } },
    { type: 'ExecutionFailed' },
  ];
  const input = () => ({
    logsDir: join(dir, 'logs'),
    historyDir: join(dir, 'history'),
    canaries: loadCanaries(canaryRun, 'live'),
    secrets: [{ label: 'origin', value: 'origin-secret-value!' }],
    expectLogs: [['/ecs/api', 'j1'] as [string, string]],
    expectHistories: [['job-j1', 'j1'] as [string, string], ['job-j2', 'j2'] as [string, string]],
    failureExecutions: ['job-j2'],
    ownerView: canaryRun.ownerView,
  });

  it('clean logs and histories with every positive control → ok, failure path proven', async () => {
    await writeInputs(
      {
        '/starter/starter-sbx/ecs/api': ['{"msg":"audit","jobIds":["j1"]}'],
        '/aws/lambda/starter-sbx-validator': ['x'],
      },
      {
        'job-j1': [
          { type: 'ExecutionStarted', executionStartedEventDetails: { input: '{"jobId":"j1"}' } },
        ],
        'job-j2': failureHistory,
      },
    );
    const r = leakScan(input());
    expect(r.findings).toEqual([]);
    expect(r.controls.every((c) => c.ok)).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.failurePaths[0]).toMatchObject({
      found: true,
      validationErrorEvents: 1,
      recordFailureEntered: true,
    });
  });

  it('a canary in a history, a secret in a log or a missing positive control fail the scan', async () => {
    await writeInputs(
      { '/starter/starter-sbx/ecs/api': ['nothing about the job', 'origin-secret-value!'] },
      { 'job-j1': [{ type: 'TaskSucceeded', output: 'sbx canary title r~live~1' }] },
    );
    const r = leakScan(input());
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([
      'log /starter/starter-sbx/ecs/api: secret origin x1',
      'history job-j1: canary live:title x1',
    ]);
    const failed = r.controls.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual([
      'positive control: logs of */ecs/api* cover job j1',
      'positive control: execution history job-j1 was read and names its job',
      'positive control: execution history job-j2 was read and names its job',
      'Lambda failure path: job-j2 caught JobValidationError and entered RecordFailure',
    ]);
  });

  it('nothing scanned is never clean; the owner-view positive control must hold', () => {
    const r = leakScan({
      ...input(),
      logsDir: join(dir, 'none'),
      historyDir: join(dir, 'none'),
      ownerView: { titleFound: false, contentCanariesFound: 1 },
    });
    expect(r.ok).toBe(false);
    expect(r.findings).toContain('nothing was scanned (no logs or histories downloaded)');
    expect(r.controls[0]?.ok).toBe(false);
  });

  it('private JWK parameters become secrets to look for; failure path absent when no history', () => {
    expect(privateJwkSecrets({ kty: 'EC', d: 'x'.repeat(43), x: 'pub' }, 'k')).toEqual([
      { label: 'k.d', value: 'x'.repeat(43) },
    ]);
    expect(failurePathOf('e', undefined)).toMatchObject({ found: false, validationErrorEvents: 0 });
  });
});

describe('rollback helpers', () => {
  const sha = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
  const writeBlob = async (layout: string, content: string) => {
    const digest = sha(content);
    await writeFile(join(layout, 'blobs', 'sha256', digest.slice(7)), content);
    return { digest, size: Buffer.byteLength(content) };
  };

  it('derives the unhealthy image: new config (CMD exits 1, labels), same layers, new tag', async () => {
    const layout = join(dir, 'oci');
    await mkdir(join(layout, 'blobs', 'sha256'), { recursive: true });
    const config = await writeBlob(
      layout,
      JSON.stringify({
        architecture: 'arm64',
        os: 'linux',
        config: {
          Entrypoint: ['/nodejs/bin/node'],
          Cmd: ['dist/server.js'],
          User: '65532:65532',
          Labels: { a: 'b' },
        },
        history: [],
      }),
    );
    const layer = {
      mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
      digest: sha('layer'),
      size: 5,
    };
    const manifest = await writeBlob(
      layout,
      JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...config },
        layers: [layer],
      }),
    );
    await writeFile(
      join(layout, 'index.json'),
      JSON.stringify({
        schemaVersion: 2,
        manifests: [
          {
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            ...manifest,
            annotations: { 'org.opencontainers.image.ref.name': 'healthy' },
          },
        ],
      }),
    );
    const digest = deriveUnhealthyImage(
      layout,
      'healthy',
      'unhealthy',
      new Date('2026-10-15T00:00:00Z'),
    );
    const index = JSON.parse(await readFile(join(layout, 'index.json'), 'utf8')) as {
      manifests: { digest: string; annotations: Record<string, string> }[];
    };
    expect(index.manifests.map((m) => m.annotations['org.opencontainers.image.ref.name'])).toEqual([
      'healthy',
      'unhealthy',
    ]);
    expect(index.manifests[1]?.digest).toBe(digest);
    const newManifestText = await readFile(
      join(layout, 'blobs', 'sha256', digest.slice(7)),
      'utf8',
    );
    expect(sha(newManifestText)).toBe(digest);
    const newManifest = JSON.parse(newManifestText) as {
      config: { digest: string };
      layers: unknown[];
    };
    expect(newManifest.layers).toEqual([layer]);
    const newConfig = JSON.parse(
      await readFile(join(layout, 'blobs', 'sha256', newManifest.config.digest.slice(7)), 'utf8'),
    ) as {
      config: { Cmd: string[]; Entrypoint: string[]; User: string; Labels: Record<string, string> };
    };
    expect(newConfig.config.Cmd).toEqual(UNHEALTHY_CMD);
    expect(newConfig.config.Entrypoint).toEqual(['/nodejs/bin/node']);
    expect(newConfig.config.User).toBe('65532:65532');
    expect(newConfig.config.Labels).toMatchObject({ a: 'b', 'starter.sandbox.unhealthy': 'true' });
    expect(digest).not.toBe(manifest.digest);
    expect(() => deriveUnhealthyImage(layout, 'missing', 'x')).toThrow(/not found/);
  });

  it('clones a task definition: read-only fields dropped, image replaced, aws: tags dropped, tag added', () => {
    const td = cloneTaskDefinition(
      {
        taskDefinition: {
          taskDefinitionArn: 'arn:td:1',
          revision: 1,
          status: 'ACTIVE',
          family: 'starter-sbx-api',
          requiresAttributes: [],
          compatibilities: ['FARGATE'],
          registeredAt: 'x',
          registeredBy: 'y',
          cpu: '256',
          containerDefinitions: [{ name: 'api', image: 'repo@sha256:old', environment: [] }],
        },
        tags: [
          { key: 'starter:run-id', value: 'sbx-aaaaaa' },
          { key: 'aws:cloudformation:stack-name', value: 'Sandbox-Api' },
        ],
      },
      'repo@sha256:new',
      'api',
      { 'starter:rollback-test': 'unhealthy' },
    );
    expect(td).toEqual({
      family: 'starter-sbx-api',
      cpu: '256',
      containerDefinitions: [{ name: 'api', image: 'repo@sha256:new', environment: [] }],
      tags: [
        { key: 'starter:run-id', value: 'sbx-aaaaaa' },
        { key: 'starter:rollback-test', value: 'unhealthy' },
      ],
    });
    expect(() =>
      cloneTaskDefinition({ taskDefinition: { containerDefinitions: [] } }, 'x', 'api'),
    ).toThrow(/not in the task definition/);
  });

  const snap = (
    taskDefinition: string,
    running: number,
    deployments: Record<string, unknown>[],
    events: unknown[] = [],
  ) => ({
    services: [{ taskDefinition, desiredCount: 1, runningCount: running, deployments, events }],
  });
  const at = (s: number) => new Date(Date.UTC(2026, 9, 15, 0, 0, s));

  it('observes deploying → failed → rolled back, with first-seen times', () => {
    let s = initialRolloutState('td:1', 'td:2');
    s = observeRollout(
      s,
      snap('td:1', 1, [{ status: 'PRIMARY', taskDefinition: 'td:1', rolloutState: 'COMPLETED' }]),
      at(0),
    );
    expect(s.phase).toBe('waiting');
    s = observeRollout(
      s,
      snap('td:2', 1, [
        { status: 'PRIMARY', taskDefinition: 'td:2', rolloutState: 'IN_PROGRESS', failedTasks: 1 },
        { status: 'ACTIVE', taskDefinition: 'td:1', rolloutState: 'COMPLETED' },
      ]),
      at(10),
    );
    expect(s.phase).toBe('target-deploying');
    s = observeRollout(
      s,
      snap('td:1', 1, [
        { status: 'PRIMARY', taskDefinition: 'td:1', rolloutState: 'IN_PROGRESS' },
        {
          status: 'ACTIVE',
          taskDefinition: 'td:2',
          rolloutState: 'FAILED',
          failedTasks: 3,
          rolloutStateReason: 'ECS deployment circuit breaker: tasks failed to start.',
        },
      ]),
      at(20),
    );
    expect(s.phase).toBe('target-failed');
    s = observeRollout(
      s,
      snap('td:1', 1, [{ status: 'PRIMARY', taskDefinition: 'td:1', rolloutState: 'COMPLETED' }]),
      at(30),
    );
    expect(s.phase).toBe('rolled-back');
    expect(s.seen).toEqual({
      targetDeployment: at(10).toISOString(),
      targetFailed: at(20).toISOString(),
      rollbackDeployment: at(20).toISOString(),
      rolledBack: at(30).toISOString(),
    });
    expect(s.targetFailedTasks).toBe(3);
    expect(s.targetRolloutStateReason).toMatch(/circuit breaker/);
    expect(s.snapshots).toBe(4);
  });

  it('never calls it a rollback before the target deployment was seen; a serving target is flagged', () => {
    let s = initialRolloutState('td:1', 'td:2');
    s = observeRollout(
      s,
      snap('td:1', 1, [{ status: 'PRIMARY', taskDefinition: 'td:1', rolloutState: 'COMPLETED' }]),
      at(0),
    );
    expect(s.phase).toBe('waiting');
    s = observeRollout(
      s,
      snap('td:2', 1, [{ status: 'PRIMARY', taskDefinition: 'td:2', rolloutState: 'COMPLETED' }]),
      at(5),
    );
    expect(s.phase).toBe('target-serving');
  });

  it('service events since the update, oldest first', () => {
    const events = serviceEventsSince(
      snap(
        'td:1',
        1,
        [],
        [
          { createdAt: '2026-10-15T00:00:30Z', message: 'rolling back' },
          { createdAt: '2026-10-15T00:00:20Z', message: 'deployment failed' },
          { createdAt: '2026-10-14T23:00:00Z', message: 'old' },
        ],
      ),
      at(10),
    );
    expect(events.map((e) => e.message)).toEqual(['deployment failed', 'rolling back']);
  });
});

describe('aws checks', () => {
  const rules = (
    secretValues: string[],
    def: Record<string, unknown> = {
      Type: 'fixed-response',
      FixedResponseConfig: { StatusCode: '403' },
    },
  ) => ({
    Rules: [
      { IsDefault: true, Actions: [def] },
      {
        IsDefault: false,
        Actions: [{ Type: 'forward' }],
        Conditions: [
          {
            Field: 'http-header',
            HttpHeaderConfig: { HttpHeaderName: 'X-Origin-Verify', Values: secretValues },
          },
        ],
      },
    ],
  });

  it('listener: default 403 and the header condition with exactly the run secret; never prints it', () => {
    const ok = listenerCheck(rules(['s3cr3t-value']), 's3cr3t-value');
    expect(ok.every((o) => o.ok)).toBe(true);
    expect(JSON.stringify(ok)).not.toContain('s3cr3t-value');
    expect(listenerCheck(rules(['other']), 's3cr3t-value')[1]?.ok).toBe(false);
    expect(listenerCheck(rules(['s3cr3t-value'], { Type: 'forward' }), 's3cr3t-value')[0]?.ok).toBe(
      false,
    );
    expect(
      listenerCheck({ Rules: [{ IsDefault: true, Actions: [{ Type: 'forward' }] }] }, 'x').every(
        (o) => !o.ok,
      ),
    ).toBe(true);
  });

  it('ALB security group: prefix lists only', () => {
    const sg = (perm: Record<string, unknown>) => ({ SecurityGroups: [{ IpPermissions: [perm] }] });
    expect(
      albSecurityGroupCheck(sg({ PrefixListIds: [{ PrefixListId: 'pl-1' }], IpRanges: [] }))[0]?.ok,
    ).toBe(true);
    expect(
      albSecurityGroupCheck(
        sg({ PrefixListIds: [{ PrefixListId: 'pl-1' }], IpRanges: [{ CidrIp: '0.0.0.0/0' }] }),
      )[0]?.ok,
    ).toBe(false);
    expect(albSecurityGroupCheck({ SecurityGroups: [] })[0]?.ok).toBe(false);
  });

  it('smoke log → per-step results; steps never reached are not-run', () => {
    const steps = smokeSteps(
      [
        'smoke: target https://d.cloudfront.net',
        'ok   - liveness: GET /health/live -> 200 (12ms) status=ok',
        'FAIL - readiness: GET /health/ready -> 200 (60000ms) timed out',
        'smoke: FAILED (1/6 steps passed)',
      ].join('\n'),
    );
    expect(steps.map((s) => [s.name, s.status])).toEqual([
      ['smoke: liveness: GET /health/live -> 200', 'passed'],
      ['smoke: readiness: GET /health/ready -> 200', 'failed'],
      ['smoke: 4 of 6 steps did not run', 'not-run'],
    ]);
  });

  it('Step Functions: only this run, all terminal, none timed out; none at all is not a pass', () => {
    const since = new Date('2026-10-15T00:00:00Z');
    const e = (status: string, startDate: string) => ({ status, startDate });
    expect(
      stepFunctionsSummary(
        {
          executions: [
            e('SUCCEEDED', '2026-10-15T00:01:00Z'),
            e('FAILED', '2026-10-15T00:02:00Z'),
            e('RUNNING', '2026-10-14T00:00:00Z'),
          ],
        },
        since,
      )[0]?.ok,
    ).toBe(true);
    expect(
      stepFunctionsSummary({ executions: [e('RUNNING', '2026-10-15T00:01:00Z')] }, since)[0]?.ok,
    ).toBe(false);
    expect(
      stepFunctionsSummary({ executions: [e('TIMED_OUT', '2026-10-15T00:01:00Z')] }, since)[0]?.ok,
    ).toBe(false);
    expect(stepFunctionsSummary({ executions: [] }, since)[0]?.ok).toBe(false);
  });
});

describe('verify-clean report (finops exit 5)', () => {
  it('prints every unverifiable category with all its evidence, account ids masked', () => {
    const lines = unverifiableLines({
      status: 'clean-with-unverifiable',
      summary: {
        unverifiable: [
          {
            category: 'kms-keys',
            status: 'unverifiable-with-this-role',
            evidence: [
              'kms:ListKeys denied',
              'key arn:aws:kms:ap-southeast-1:111122223333:key/k1 PendingDeletion',
            ],
          },
          {
            category: 'secretsmanager-secrets',
            status: 'unverifiable-with-this-role',
            evidence: [],
          },
        ],
      },
    });
    expect(lines).toEqual([
      'UNVERIFIABLE kms-keys (unverifiable-with-this-role)',
      '  evidence: kms:ListKeys denied',
      '  evidence: key arn:aws:kms:ap-southeast-1:********3333:key/k1 PendingDeletion',
      'UNVERIFIABLE secretsmanager-secrets (unverifiable-with-this-role)',
      '  evidence: none recorded',
    ]);
  });

  it('a report without the list, or malformed entries, yields nothing (the caller then says NOT verified)', () => {
    expect(unverifiableLines({ status: 'clean' })).toEqual([]);
    expect(unverifiableLines(null)).toEqual([]);
    expect(unverifiableLines({ summary: { unverifiable: [{ evidence: ['x'] }, 7] } })).toEqual([]);
    const [line] = unverifiableLines({
      summary: { unverifiable: [{ category: `a\nb${'c'.repeat(400)}` }] },
    });
    expect(line).not.toContain('\n');
    expect(line?.length).toBeLessThanOrEqual(340);
  });
});

describe('log follow', () => {
  it('parses events and returns only unseen ones in time order, tracking the high-water mark', () => {
    const state = { seen: new Set<string>(), high: 0 };
    const first = newEvents(
      state,
      parseEvents(
        JSON.stringify({
          events: [
            { eventId: 'b', timestamp: 20, message: 'two' },
            { eventId: 'a', timestamp: 10, message: 'one' },
          ],
        }),
      ),
    );
    expect(first.map((e) => e.message)).toEqual(['one', 'two']);
    const again = newEvents(
      state,
      parseEvents(
        JSON.stringify({
          events: [
            { eventId: 'a', timestamp: 10, message: 'one' },
            { eventId: 'c', timestamp: 15, message: 'late' },
          ],
        }),
      ),
    );
    expect(again.map((e) => e.message)).toEqual(['late']);
    expect(state.high).toBe(20);
  });
});

describe(
  'fake guard (fixture) enforces the command rules of the real guard',
  { timeout: 60_000 },
  () => {
    const run = async (script: string, env: Record<string, string> = {}) => {
      const guard = join(dir, 'guard.sh');
      await writeFile(guard, FAKE_GUARD);
      await writeFile(join(dir, 'expected-account'), '111122223333\n');
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync(
        'bash',
        ['-c', `set -euo pipefail; source ${JSON.stringify(guard)}; ${script}`],
        {
          env: {
            PATH: process.env.PATH ?? '',
            HOME: dir,
            FAKE_LOG: join(dir, 'log'),
            SANDBOX_PROFILE: 'starter-sandbox-developer',
            SANDBOX_GUARD_LOG: join(dir, 'guard.log'),
            SANDBOX_EXPECTED_ACCOUNT_FILE: join(dir, 'expected-account'),
            ...env,
          },
          encoding: 'utf8',
        },
      );
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };

    it('runs an executable and returns its exit code; guard output stays off stdout', async () => {
      const ok = await run(
        'sandbox_guard_init; out="$(guarded "label" -- printf hello)"; echo "[$out]"',
      );
      expect(ok.code, ok.out).toBe(0);
      expect(ok.out).toContain('[hello]');
      const failing = await run('sandbox_guard_init; guarded "label" -- false');
      expect(failing.code).toBe(1);
    });

    it.each([
      ['a shell function', 'f() { :; }; guarded "l" -- f', /shell functions/],
      ['a shell wrapper', 'guarded "l" -- bash -c true', /bash is refused/],
      ['env as wrapper', 'guarded "l" -- env true', /env is refused/],
      // (timeout/nix are refused the same way; nice/nohup exist on every test host)
      ['nice as a wrapper', 'guarded "l" -- nice true', /nice is refused/],
      ['nohup', 'guarded "l" -- nohup true', /nohup is refused/],
      ['node with inline code', 'guarded "l" -- node -e 1', /inline code/],
      ['node --eval', 'guarded "l" -- node --no-warnings --eval 1', /inline code/],
      ['another profile', 'guarded "l" -- printf x --profile other', /another --profile/],
      ['an abbreviated profile', 'guarded "l" -- printf x --prof other', /another --profile/],
      ['an abbreviated region', 'guarded "l" -- printf x --reg=us-east-1', /another --region/],
      ['an abbreviated endpoint', 'guarded "l" -- printf x --endp http://x', /--endpoint-url/],
      ['an endpoint override', 'guarded "l" -- printf x --endpoint-url http://x', /--endpoint-url/],
      ['an account id in the label', 'guarded "deploy 111122223333" -- true', /account id/],
      ['no --', 'guarded "l" true', /usage/],
    ])('refuses %s', async (_name, script, message) => {
      const r = await run(`sandbox_guard_init; ${script}; echo RAN`);
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toMatch(message);
      expect(r.out).not.toContain('RAN');
    });

    it('accepts what the scripts run: a script file for node, the pinned --profile/--region', async () => {
      await writeFile(join(dir, 'ok.mjs'), 'process.exit(0)\n');
      const r = await run(
        `sandbox_guard_init; guarded "l" -- node --no-warnings ${JSON.stringify(join(dir, 'ok.mjs'))} --region ap-southeast-1; guarded "l" -- true --profile starter-sandbox-developer --region=ap-southeast-1 --progress events; echo RAN`,
      );
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('RAN');
    });

    it('refuses to initialise without a profile or a guard log', async () => {
      expect((await run('sandbox_guard_init', { SANDBOX_PROFILE: '' })).code).toBe(11);
      expect((await run('sandbox_guard_init', { SANDBOX_PROFILE: 'default' })).code).toBe(11);
      expect((await run('sandbox_guard_init', { SANDBOX_GUARD_LOG: '' })).code).toBe(2);
    });

    it('brackets guarded commands in the call log (what unguardedMutations relies on)', async () => {
      await run('sandbox_guard_init; guarded "l" -- true');
      const lines = (await readFile(join(dir, 'log'), 'utf8')).trim().split('\n');
      expect(lines.slice(-3)).toEqual(['GUARD l', 'GUARD-BEGIN l', 'GUARD-END l']);
      expect(
        unguardedMutations(['CALL aws --profile p --region r ecs run-task --cluster c']),
      ).toHaveLength(1);
      expect(unguardedMutations(['GUARD-BEGIN x', 'CALL aws ecs run-task', 'GUARD-END x'])).toEqual(
        [],
      );
      expect(
        unguardedMutations(['CALL aws ecs describe-tasks', 'CALL skopeo copy docker://a oci:/x:y']),
      ).toEqual([]);
    });
  },
);

describe(
  'static audit of the lifecycle scripts (operator permission set)',
  { timeout: 60_000 },
  () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const repo = fileURLToPath(new URL('../../../../', import.meta.url));
    const scripts = [
      ...readdirSync(join(root, 'sandbox'))
        .filter((f) => f.endsWith('.sh'))
        .map((f) => join(root, 'sandbox', f)),
      ...readdirSync(join(root, 'scripts'))
        .filter((f) => f.endsWith('.sh'))
        .map((f) => join(root, 'scripts', f)),
    ];
    const permissions = JSON.parse(
      readFileSync(new URL('./fixtures/permission-set.json', import.meta.url), 'utf8'),
    ) as Record<string, string | string[]>;
    const permitted = (service: string, op: string) => {
      const p = permissions[service];
      return p === '*' || (Array.isArray(p) && p.includes(op));
    };
    /** Logical lines (continuations joined, comments dropped) with their file. */
    const logical = scripts.flatMap((file) => {
      const out: { file: string; line: string }[] = [];
      let acc = '';
      for (const raw of readFileSync(file, 'utf8').split('\n')) {
        if (/^\s*#/.test(raw)) continue;
        acc += `${raw.replace(/\\$/, '')} `;
        if (!raw.endsWith('\\')) {
          out.push({ file: file.slice(root.length), line: acc.trim() });
          acc = '';
        }
      }
      return out;
    });

    it('every cdk deploy/destroy/bootstrap runs through the guard (mut / guard_exec)', () => {
      const cdk = logical.filter((l) =>
        /exec cdk "?\$?\{?sub|exec cdk (deploy|destroy|bootstrap)/.test(l.line),
      );
      expect(cdk.length).toBeGreaterThanOrEqual(3);
      expect(cdk.filter((l) => !/\b(mut|guard_exec) "/.test(l.line))).toEqual([]);
    });

    it('the AWS CLI is only invoked through awsr / aws_mut (sandbox) or the read-only IAM check (Phase 1)', () => {
      const raw = logical.filter(
        (l) => /\$\{AWS_(CMD|CLI_CMD)\[@\]\}/.test(l.line) && !/^read -r -a/.test(l.line),
      );
      for (const l of raw) {
        expect(
          /^(awsr\(\) \{|mut "\$label" "\$\{AWS_CMD\[@\]\}"|roles="\$\("\$\{AWS_CLI_CMD\[@\]\}" iam list-roles)/.test(
            l.line,
          ),
          `${l.file}: ${l.line}`,
        ).toBe(true);
      }
    });

    it('read-only calls (awsr) are reads, and every call is within the operator permission set', () => {
      const reads = [
        ...logical
          .map((l) => l.line)
          .join('\n')
          .matchAll(/\bawsr ([a-z0-9-]+) ([a-z0-9-]+)/g),
      ];
      expect(reads.length).toBeGreaterThan(30);
      for (const [, service, op] of reads) {
        expect(
          /^(describe|list|get|wait|filter|head)/.test(op as string),
          `awsr ${service} ${op}`,
        ).toBe(true);
        expect(
          permitted(service as string, op as string),
          `awsr ${service} ${op} not permitted`,
        ).toBe(true);
      }
      const writes = [
        ...logical
          .map((l) => l.line)
          .join('\n')
          .matchAll(/\baws_mut "[^"]*" ([a-z0-9-]+) ([a-z0-9-]+)/g),
      ];
      expect(writes.length).toBeGreaterThan(10);
      for (const [, service, op] of writes) {
        expect(
          permitted(service as string, op as string),
          `aws_mut ${service} ${op} not permitted`,
        ).toBe(true);
      }
      // run_task builds its argv in an array: ecs run-task (permitted: ecs:*)
      expect(logical.some((l) => l.line.includes('local args=(ecs run-task'))).toBe(true);
    });

    it('every image push (skopeo copy to <repository>:<tag>) runs through the guard', () => {
      // (a copy FROM <repository>@<digest> into a local OCI layout is a read)
      const pushes = logical.filter(
        (l) =>
          /SKOPEO_CMD\[@\]\}" copy/.test(l.line) &&
          /"docker:\/\/\$\{(repo_uri|REPO_URI)\}:/.test(l.line),
      );
      expect(pushes.length).toBeGreaterThanOrEqual(2);
      expect(pushes.filter((l) => !/\bmut "/.test(l.line))).toEqual([]);
    });

    it('every guarded command is a pinned tool array whose default is no wrapper (time limits stay outside the guard)', () => {
      // The real guard refuses shells, wrappers (timeout, nohup, env, nix, …) and inline code
      // (exit 2); sandbox-real-guard.test.ts runs it, this covers the paths a fake world does not
      // reach. A call site is `mut|guard_exec "<label>" <command> …`.
      const sites = logical.flatMap((l) =>
        [...l.line.matchAll(/\b(?:mut|guard_exec) ".*?"\s+(\S+)/g)].map((m) => ({
          where: `${l.file}: ${l.line.slice(0, 120)}`,
          command: m[1] as string,
        })),
      );
      expect(sites.length).toBeGreaterThanOrEqual(8);
      for (const s of sites) {
        expect(s.command, s.where).toMatch(/^"\$\{(PNPM|AWS|SKOPEO|VERIFY)_CMD\[@\]\}"$/);
      }
      const defaults = Object.fromEntries(
        logical.flatMap((l) => {
          const m = /^read -r -a (PNPM|AWS|SKOPEO|VERIFY)_CMD <<<"\$\{[A-Z_]+:-(.*)\}"$/.exec(
            l.line,
          );
          return m ? [[m[1] as string, m[2] as string]] : [];
        }),
      );
      expect(defaults).toEqual({
        PNPM: 'pnpm',
        AWS: 'aws',
        SKOPEO: 'skopeo',
        VERIFY: 'node ${SUITE_DIR}/dist/cleanup-verify.js',
      });
    });

    it('the vendored CDK CLI sends CAPABILITY_AUTO_EXPAND on every deploy (hosted-rotation transform)', () => {
      const cli = createRequire(join(repo, 'infra', 'package.json')).resolve(
        'aws-cdk/package.json',
      );
      const pkg = JSON.parse(readFileSync(cli, 'utf8')) as { version: string };
      const bundle = readFileSync(join(cli, '..', 'lib', 'index.js'), 'utf8');
      expect(pkg.version).toBe('2.1144.0');
      // the options shared by CreateStack, UpdateStack and CreateChangeSet
      expect(bundle).toMatch(
        /shared between CreateStack, UpdateStack and CreateChangeSet[\s\S]{0,400}Capabilities: \["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"\]/,
      );
    });

    it('Playwright records no traces, screenshots or videos in AWS mode', () => {
      const config = join(repo, 'tests', 'e2e', 'playwright.config.ts');
      const read = (env: Record<string, string>) =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              '--import',
              'tsx',
              '--input-type=module',
              '-e',
              `const c = (await import(${JSON.stringify(config)})).default; process.stdout.write(JSON.stringify(c.use));`,
            ],
            {
              cwd: join(repo, 'tests', 'e2e'),
              env: { PATH: process.env.PATH ?? '', ...env },
              encoding: 'utf8',
            },
          ),
        ) as { trace: string; screenshot: string; video: string };
      expect(
        read({ E2E_AUTH_MODE: 'aws-test-issuer', E2E_ISSUER: 'https://issuer.example.net' }),
      ).toMatchObject({
        trace: 'off',
        screenshot: 'off',
        video: 'off',
      });
      expect(read({})).toMatchObject({ trace: 'retain-on-failure', screenshot: 'only-on-failure' });
    }, 60_000);
  },
);
