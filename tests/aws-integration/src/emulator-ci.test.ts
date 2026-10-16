import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  annotatePartialPasses,
  diagnostics,
  isLoopbackHost,
  junitXml,
  main,
  parseArgs,
  partialPasses,
  preflightProblems,
  reconciliationSteps,
  scanForAwsLeaks,
  startForwarder,
  storedZip,
  waitForHealth,
  type SocketProbe,
} from './emulator-ci.js';

const cleanProbe: SocketProbe = {
  socketsFound: [],
  dockerHostSet: false,
  lambdaRuntimeApi: false,
  node: 'v24.18.1',
  endpointHost: '127.0.0.1:4566',
};
const ok = {
  expectedVersion: '1.5.26',
  expectedExecutor: 'local' as const,
  health: { version: '1.5.26' },
  account: '000000000001',
  probe: cleanProbe,
};

describe('preflight verdict', () => {
  it('accepts the pinned version, the fake account and a socket-less local executor', () => {
    expect(preflightProblems(ok)).toEqual([]);
  });
  it('refuses another MiniStack version', () => {
    expect(preflightProblems({ ...ok, health: { version: '1.5.27' } }).join()).toMatch(
      /1.5.27, expected 1.5.26/,
    );
  });
  it('refuses any other account (an endpoint that is not the emulator)', () => {
    expect(preflightProblems({ ...ok, account: '123456789012' }).join()).toMatch(
      /expected the fake 000000000001/,
    );
  });
  it('refuses a reachable engine socket or DOCKER_HOST in the socket-less mode', () => {
    expect(
      preflightProblems({
        ...ok,
        probe: { ...cleanProbe, socketsFound: ['/var/run/docker.sock'] },
      }).join(),
    ).toMatch(/container-engine socket is reachable/);
    expect(
      preflightProblems({ ...ok, probe: { ...cleanProbe, dockerHostSet: true } }).join(),
    ).toMatch(/DOCKER_HOST/);
    expect(
      preflightProblems({ ...ok, probe: { ...cleanProbe, lambdaRuntimeApi: true } }).join(),
    ).toMatch(/docker executor/);
  });
  it('refuses Lambdas inside MiniStack that would call AWS or a non-loopback endpoint', () => {
    const host = (endpointHost: string | null) =>
      preflightProblems({ ...ok, probe: { ...cleanProbe, endpointHost } }).join();
    expect(host(null)).toMatch(/AWS_ENDPOINT_URL is not set for the Lambdas/);
    expect(host('lambda.ap-southeast-1.amazonaws.com')).toMatch(/use the AWS endpoint/);
    expect(host('cdk-cli-telemetry.us-east-1.api.aws:443')).toMatch(/use the AWS endpoint/);
    expect(host('ministack:4566')).toMatch(/expected a loopback host/);
    expect(host('127.0.0.1:4566')).toBe('');
    expect(host('localhost:4566')).toBe('');
    // docker executor: a non-loopback emulator host is fine, AWS never.
    const docker = { ...ok, expectedExecutor: 'docker' as const };
    const dockerProbe = { ...cleanProbe, lambdaRuntimeApi: true };
    expect(
      preflightProblems({ ...docker, probe: { ...dockerProbe, endpointHost: 'ministack:4566' } }),
    ).toEqual([]);
    expect(
      preflightProblems({
        ...docker,
        probe: { ...dockerProbe, endpointHost: 'sts.amazonaws.com' },
      }).join(),
    ).toMatch(/AWS endpoint/);
  });
  it('recognises loopback hosts only', () => {
    for (const h of ['127.0.0.1:4566', '127.1.2.3', 'localhost', '[::1]:4566']) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of ['ministack:4566', '10.0.0.1', '127.0.0.1.nip.io', '', null, 'a b']) {
      expect(isLoopbackHost(h), String(h)).toBe(false);
    }
  });
  it('a declared docker executor must really run functions under a runtime API', () => {
    expect(preflightProblems({ ...ok, expectedExecutor: 'docker' }).join()).toMatch(
      /did not run under a Lambda runtime API/,
    );
    expect(
      preflightProblems({
        ...ok,
        expectedExecutor: 'docker',
        probe: { ...cleanProbe, lambdaRuntimeApi: true },
      }),
    ).toEqual([]);
  });
});

describe('health wait', () => {
  it('returns the payload once MiniStack answers', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '1.5.26' }), { status: 200 }));
    const r = await waitForHealth('http://127.0.0.1:1', 10, fetchImpl);
    expect(r.payload.version).toBe('1.5.26');
    expect(r.attempts).toBe(2);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('http://127.0.0.1:1/_ministack/health');
    // A redirect from the emulator is never followed to another host .
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: 'error' });
  });
  it('gives up after the bounded wait with what it saw', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('no', { status: 503 }));
    await expect(waitForHealth('http://127.0.0.1:1', 0, fetchImpl)).rejects.toThrow(
      /within 0 s \(HTTP 503\)/,
    );
  });
});

describe('probe package', () => {
  it('is a valid stored ZIP holding the probe source', () => {
    const zip = Buffer.from(storedZip({ 'index.mjs': 'export const handler = async () => 1;' }));
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const nameLength = zip.readUInt16LE(26);
    const size = zip.readUInt32LE(18);
    expect(zip.subarray(30, 30 + nameLength).toString()).toBe('index.mjs');
    const data = zip.subarray(30 + nameLength, 30 + nameLength + size);
    expect(data.toString()).toBe('export const handler = async () => 1;');
    expect(zip.readUInt32LE(14)).toBe(crc32(data));
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  });
});

describe('JUnit', () => {
  it('lifecycle steps become test cases; included suites are merged without host names', () => {
    const vitest =
      '<?xml version="1.0"?>\n<testsuites name="vitest"><testsuite name="a" hostname="ops-laptop.local" tests="1"><testcase name="t"/></testsuite></testsuites>';
    const xml = junitXml(
      'ministack-emulator workflows (em-abc123)',
      [
        { name: 'deploy', status: 'pass', durationMs: 1500 },
        { name: 'workflow suites', status: 'fail', durationMs: 10, message: 'exit 1 <x>' },
        { name: 'reset', status: 'skipped', message: 'not reached' },
      ],
      [vitest],
    );
    expect(xml).toContain('tests="3" failures="1" errors="0" skipped="1"');
    expect(xml).toContain('<failure message="exit 1 &lt;x&gt;">');
    expect(xml).toContain('<skipped message="not reached"/>');
    expect(xml).toContain('<testsuite name="a" tests="1"><testcase name="t"/></testsuite>');
    expect(xml).not.toContain('hostname');
    expect(xml.match(/<testsuites/g)).toHaveLength(1);
  });

  it('reconciliation: reconciled passes, unsupported and metadata-only are SKIPPED, failures fail', () => {
    const steps = reconciliationSteps({
      resources: [
        { logicalId: 'Fn', type: 'AWS::Lambda::Function', status: 'reconciled', checks: [] },
        {
          logicalId: 'Table',
          type: 'AWS::DynamoDB::Table',
          status: 'unsupported',
          checks: [
            {
              property: 'PointInTimeRecoverySpecification',
              status: 'unsupported',
              reason: 'not applied',
            },
          ],
        },
        {
          logicalId: 'Role',
          type: 'AWS::IAM::Role',
          status: 'unsupported',
          checks: [],
          unsupportedSemantics: 'iamNotEnforced: x',
        },
        {
          logicalId: 'CDKMetadata',
          type: 'AWS::CDK::Metadata',
          status: 'metadata-only',
          checks: [],
        },
        {
          logicalId: 'Machine',
          type: 'AWS::StepFunctions::StateMachine',
          status: 'failed',
          checks: [{ property: 'DefinitionString', status: 'mismatch' }],
        },
      ],
    });
    expect(steps.map((s) => s.status)).toEqual(['pass', 'skipped', 'skipped', 'skipped', 'fail']);
    expect(steps[1]!.message).toMatch(
      /emulator-unsupported: PointInTimeRecoverySpecification: not applied/,
    );
    expect(steps[2]!.message).toMatch(/iamNotEnforced/);
    expect(steps[4]!.message).toBe('mismatch: DefinitionString');
  });

  it('reconciliation: compared-not-enforced is SKIPPED (never a pass); unknown properties fail', () => {
    const steps = reconciliationSteps({
      resources: [
        {
          logicalId: 'Logs',
          type: 'AWS::Logs::LogGroup',
          status: 'compared-not-enforced',
          checks: [
            { property: 'LogGroupName', status: 'match' },
            { property: 'KmsKeyId', status: 'compared-not-enforced', reason: 'no encryption' },
          ],
        },
        {
          logicalId: 'Fn',
          type: 'AWS::Lambda::Function',
          status: 'failed',
          error: 'unknown properties: VpcConfig',
          checks: [
            { property: 'Timeout', status: 'mismatch' },
            { property: 'VpcConfig', status: 'unknown' },
          ],
        },
      ],
    });
    expect(steps[0]).toMatchObject({
      status: 'skipped',
      message: expect.stringMatching(/^compared-not-enforced .*KmsKeyId: no encryption/),
    });
    expect(steps[1]).toMatchObject({
      status: 'fail',
      message: 'mismatch: Timeout; unknown properties: VpcConfig',
    });
  });

  const vitestJunit = [
    '<testsuites name="vitest tests">',
    '  <testsuite name="src/w.aws.test.ts" tests="3">',
    '    <testcase classname="src/w.aws.test.ts" name="[ministack-emulator] w &gt; partial &apos;one&apos;" time="1">',
    '    </testcase>',
    '    <testcase classname="src/w.aws.test.ts" name="[ministack-emulator] w &gt; full" time="1"/>',
    '    <testcase classname="src/w.aws.test.ts" name="[ministack-emulator] w &gt; na [emulator-not-applicable: x]" time="0">',
    '      <skipped/>',
    '    </testcase>',
    '  </testsuite>',
    '</testsuites>',
  ].join('\n');
  const results = {
    tests: [
      {
        file: 'w.aws.test.ts',
        test: "[ministack-emulator] w > partial 'one'",
        status: 'pass',
        notApplicableAssertions: ['error name [localExecutorErrorNames]', 'cause [failStatePaths]'],
      },
      { file: 'w.aws.test.ts', test: '[ministack-emulator] w > full', status: 'pass' },
      { file: 'w.aws.test.ts', test: '[ministack-emulator] w > na', status: 'not-applicable' },
    ],
  };
  const governance = `${JSON.stringify({
    kind: 'assertion',
    file: 'w.aws.test.ts',
    test: "[ministack-emulator] w > partial 'one'",
    assertion: 'error name',
    gap: 'localExecutorErrorNames',
    baselineId: 'NA-LEN-01',
  })}\n`;

  it('partial passes stay passes but carry their n/a assertions and baseline ids', () => {
    const partial = partialPasses(results, governance);
    expect(partial).toEqual([
      {
        file: 'w.aws.test.ts',
        test: "[ministack-emulator] w > partial 'one'",
        assertions: ['error name [localExecutorErrorNames] NA-LEN-01', 'cause [failStatePaths]'],
      },
    ]);
    const out = annotatePartialPasses(vitestJunit, partial);
    const cases = out.match(/<testcase\b[^>]*\/>|<testcase\b[\s\S]*?<\/testcase>/g) ?? [];
    expect(cases).toHaveLength(3);
    expect(cases[0]).toContain(
      '<property name="emulator-not-applicable" value="error name [localExecutorErrorNames] NA-LEN-01"/>',
    );
    expect(cases[0]).toContain('<system-out>emulator: PASSED WITH 2 NOT-APPLICABLE ASSERTION(S)');
    expect(cases[0]).not.toMatch(/<skipped|<failure/);
    // A full pass and a not-applicable (skipped) test are unchanged.
    expect(cases[1]).toBe(
      '<testcase classname="src/w.aws.test.ts" name="[ministack-emulator] w &gt; full" time="1"/>',
    );
    expect(cases[2]).toContain('<skipped/>');
    expect(cases[2]).not.toContain('emulator-not-applicable"');
    expect(annotatePartialPasses(vitestJunit, [])).toBe(vitestJunit);
  });
});

describe('leak scan', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('finds AWS endpoint URLs and foreign account ids; ignores the fake account, namespaces and bundles', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'starter-emu-scan-'));
    writeFileSync(
      path.join(dir, 'clean.json'),
      JSON.stringify({
        arn: 'arn:aws:lambda:ap-southeast-1:000000000001:function:f',
        principal: 'lambda.amazonaws.com',
        xmlns: 'https://sts.amazonaws.com/doc/2011-06-15/',
        endpoint: 'http://127.0.0.1:4566',
      }),
    );
    mkdirSync(path.join(dir, 'cdk.out', 'asset.abc'), { recursive: true });
    writeFileSync(
      path.join(dir, 'cdk.out', 'asset.abc', 'index.mjs'),
      '"https://sts.amazonaws.com"',
    );
    writeFileSync(path.join(dir, 'bin.zip'), Buffer.from([0x50, 0x4b, 0, 1]));
    expect(scanForAwsLeaks(dir)).toMatchObject({
      ok: true,
      findings: [],
      filesScanned: 1,
      filesSkipped: 2,
    });

    writeFileSync(
      path.join(dir, 'service.log'),
      [
        'POST https://dynamodb.ap-southeast-1.amazonaws.com/ 200',
        'role arn:aws:iam::123456789012:role/x',
        '{"Account": "210987654321"}',
        'telemetry https://cdk-cli-telemetry.us-east-1.api.aws/metrics',
      ].join('\n'),
    );
    const scan = scanForAwsLeaks(dir);
    expect(scan.ok).toBe(false);
    expect(scan.findings.map((f) => `${f.file}:${f.line} ${f.kind} ${f.match}`)).toEqual([
      'service.log:1 aws-endpoint https://dynamodb.ap-southeast-1.amazonaws.com/',
      'service.log:2 foreign-account <12-digit account id, redacted>',
      'service.log:3 foreign-account <12-digit account id, redacted>',
      'service.log:4 aws-endpoint https://cdk-cli-telemetry.us-east-1.api.aws/metrics',
    ]);
    expect(JSON.stringify(scan)).not.toMatch(/123456789012|210987654321/);
  });

  it('scan-leaks exits 1 on a finding, 0 when clean; diagnostics record the scan', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'starter-emu-scan-'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      writeFileSync(path.join(dir, 'a.json'), '{"x":"arn:aws:s3:::bucket"}');
      expect(await main(['scan-leaks', '--dir', dir], {})).toBe(0);
      expect(diagnostics(dir, {})).toMatchObject({ leakScan: { ok: true, filesScanned: 1 } });
      writeFileSync(path.join(dir, 'b.json'), '{"u":"https://s3.amazonaws.com/x"}');
      expect(
        await main(['scan-leaks', '--dir', dir, '--out', path.join(dir, 'out', 'scan.json')], {}),
      ).toBe(1);
      expect(JSON.parse(readFileSync(path.join(dir, 'out', 'scan.json'), 'utf8'))).toMatchObject({
        ok: false,
        findings: [{ file: 'b.json', kind: 'aws-endpoint' }],
      });
      expect(await main(['scan-leaks'], {})).toBe(2);
    } finally {
      err.mockRestore();
    }
  });
});

describe('CLI', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('parses repeated options', () => {
    expect(parseArgs(['junit', '--include', 'a', '--include', 'b', '--out', 'c'])).toEqual({
      command: 'junit',
      args: { include: ['a', 'b'], out: ['c'] },
    });
    expect(() => parseArgs(['x', 'stray'])).toThrow(/unexpected argument/);
  });

  it('refuses (exit 5) every emulator-calling command outside a guarded environment', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const command of ['preflight', 'reconcile', 'snapshot', 'reset', 'verify-destroyed']) {
        expect(await main([command, '--out', '/nonexistent/x.json'], { AWS_PROFILE: 'p' })).toBe(5);
      }
      expect(err.mock.calls.flat().join('\n')).toMatch(/refusing: AWS_PROFILE is set/);
    } finally {
      err.mockRestore();
    }
  });

  it('writes JUnit and diagnostics offline (no guard needed: nothing is called)', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'starter-emu-ci-'));
    writeFileSync(
      path.join(dir, 'steps.jsonl'),
      `${JSON.stringify({ name: 'guard', status: 'fail', durationMs: 5, message: 'exit 5' })}\n`,
    );
    writeFileSync(
      path.join(dir, 'preflight.json'),
      JSON.stringify({
        health: { version: '1.5.26', edition: 'light' },
        identity: { account: '000000000001' },
        socketProbe: cleanProbe,
      }),
    );
    expect(
      await main(
        [
          'junit',
          '--steps',
          path.join(dir, 'steps.jsonl'),
          '--suite',
          's',
          '--out',
          path.join(dir, 'report', 'junit.xml'),
        ],
        {},
      ),
    ).toBe(0);
    expect(readFileSync(path.join(dir, 'report', 'junit.xml'), 'utf8')).toContain(
      '<failure message="exit 5">',
    );
    expect(
      await main(['diagnostics', '--run-dir', dir, '--out', path.join(dir, 'diagnostics.json')], {
        STARTER_MINISTACK_IMAGE: 'img@sha256:x',
        STARTER_EMULATOR_SUITE: 'cdk',
      }),
    ).toBe(0);
    const d = JSON.parse(readFileSync(path.join(dir, 'diagnostics.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(d).toMatchObject({
      target: 'ministack-emulator',
      suite: 'cdk',
      mode: 'loopback',
      ministack: { reportedVersion: '1.5.26', image: 'img@sha256:x', edition: 'light' },
      lambdaExecutor: 'local',
      socketMounted: false,
      identityAccount: '000000000001',
      counts: { steps: { pass: 0, fail: 1, skipped: 0 } },
    });
    expect(d.socketEvidence).toMatchObject({ socketsFound: [], dockerHostSet: false });
  });

  it('junit marks the partial passes of the included vitest suite from results.json next to --out', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'starter-emu-ci-'));
    mkdirSync(path.join(dir, 'report'));
    writeFileSync(path.join(dir, 'steps.jsonl'), '');
    writeFileSync(
      path.join(dir, 'report', 'vitest-junit.xml'),
      '<testsuites><testsuite name="s"><testcase classname="src/w.aws.test.ts" name="t"></testcase></testsuite></testsuites>',
    );
    writeFileSync(
      path.join(dir, 'report', 'results.json'),
      JSON.stringify({
        tests: [
          { file: 'w.aws.test.ts', test: 't', status: 'pass', notApplicableAssertions: ['a [g]'] },
        ],
      }),
    );
    const args = ['--steps', path.join(dir, 'steps.jsonl'), '--suite', 's'];
    const include = ['--include', path.join(dir, 'report', 'vitest-junit.xml')];
    expect(
      await main(
        ['junit', ...args, ...include, '--out', path.join(dir, 'report', 'junit.xml')],
        {},
      ),
    ).toBe(0);
    expect(readFileSync(path.join(dir, 'report', 'junit.xml'), 'utf8')).toContain(
      '<property name="emulator-not-applicable" value="a [g]"/>',
    );
  });

  it('diagnostics without a preflight do not claim socket-less', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'starter-emu-ci-'));
    expect(diagnostics(dir, {})).toMatchObject({ socketMounted: null, socketEvidence: null });
  });
});

describe('loopback forwarder (ci-service mode)', () => {
  it('pipes 127.0.0.1:<ephemeral> to the target (path-style S3 for the CDK asset upload)', async () => {
    const upstream = createServer((req, res) => res.end(`${req.method} ${req.url}`));
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const target = new URL(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
    const forwarder = await startForwarder(target);
    try {
      const address = forwarder.address() as AddressInfo;
      expect(address.address).toBe('127.0.0.1');
      const res = await fetch(`http://127.0.0.1:${address.port}/cdk-assets-bucket/key`, {
        method: 'PUT',
      });
      expect(await res.text()).toBe('PUT /cdk-assets-bucket/key');
    } finally {
      forwarder.close();
      upstream.close();
    }
  });

  it('is refused outside ci-service mode, and outside a guarded environment', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const loopback = {
        AWS_ENDPOINT_URL: 'http://127.0.0.1:45660',
        AWS_ACCESS_KEY_ID: '000000000001',
        AWS_SECRET_ACCESS_KEY: 'ministack-local-only',
        AWS_CONFIG_FILE: '/dev/null',
        AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
        AWS_EC2_METADATA_DISABLED: 'true',
        CDK_DISABLE_CLI_TELEMETRY: 'true',
        CDK_DISABLE_VERSION_CHECK: 'true',
      };
      expect(await main(['forward', '--port-file', '/nonexistent/p'], loopback)).toBe(2);
      expect(
        await main(['forward', '--port-file', '/nonexistent/p'], {
          ...loopback,
          STARTER_EMULATOR_MODE: 'ci-service',
          GITLAB_CI: 'true',
          STARTER_EMULATOR_ALLOWED_ENDPOINT: 'http://ministack:4566',
          AWS_ENDPOINT_URL: 'http://evil:4566',
        }),
      ).toBe(5);
    } finally {
      err.mockRestore();
    }
  });
});
