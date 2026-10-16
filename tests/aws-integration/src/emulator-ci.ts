/**
 * Node side of `tests/aws-integration/emulator/ci.sh` (the MiniStack EMULATOR job). NOT AWS.
 * Every subcommand first applies the shared emulator guard (`@starter/infra/emulator-guard`) to its
 * own environment and exits 5 on a refusal, before any HTTP or SDK call.
 *
 *   preflight        --expected-version V --timeout-seconds N --run-id R --out F
 *                    health (bounded wait, exact version), STS identity = the fake account,
 *                    in-service probe: no container-engine socket reachable from MiniStack
 *   reconcile        --stack S --template T --out F       (emulator-reconcile.ts)
 *   snapshot         --stack S --out F                    Lambda alias/version/APP_VERSION
 *   verify-update    --stack S --before F --app-version V --out F
 *   stack-resources  --stack S --out F                    physical ids + stack id (before destroy)
 *   verify-destroyed --resources F --out F
 *   reset            --out F                              POST /_ministack/reset
 *   junit            --steps F --suite NAME --out F [--include F]… [--reconciliation F]…
 *                    [--results F]  (default: results.json next to --out, if present)
 *   diagnostics      --run-dir D --out F                  (includes the leak scan of D)
 *   scan-leaks       --dir D [--out F]                    AWS endpoint hosts / foreign accounts
 *   forward          --port-file F    ci-service only: 127.0.0.1:<port> → the allowlisted endpoint
 * Exit: 0 ok, 1 failed check, 2 usage, 5 guard refusal.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { CreateRoleCommand, DeleteRoleCommand, IAMClient } from '@aws-sdk/client-iam';
import {
  CreateFunctionCommand,
  DeleteFunctionCommand,
  InvokeCommand,
  LambdaClient,
  waitUntilFunctionActiveV2,
} from '@aws-sdk/client-lambda';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  EMULATOR_ACCOUNT,
  EMULATOR_REFUSAL_EXIT_CODE,
  EMULATOR_REGION,
  checkEmulatorEnvironment,
} from '@starter/infra/emulator-guard';
import {
  reconcile,
  sdkReader,
  snapshotFunctions,
  verifyDestroyed,
  verifyUpdate,
  type FunctionSnapshot,
  type StackResourceInfo,
  type Template,
} from './emulator-reconcile.js';

type Args = Record<string, string[]>;

export function parseArgs(argv: readonly string[]): { command: string; args: Args } {
  const [command = '', ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i] ?? '';
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    (args[key.slice(2)] ??= []).push(rest[i + 1] ?? '');
    i += 1;
  }
  return { command, args };
}

const one = (args: Args, name: string): string => {
  const v = args[name]?.[0];
  if (v === undefined || v === '') throw new UsageError(`--${name} is required`);
  return v;
};

class UsageError extends Error {}

const writeJson = (file: string, data: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------------------------

export interface HealthPayload {
  version?: string;
  edition?: string;
  services?: Record<string, string>;
  [k: string]: unknown;
}

/** Polls `GET <endpoint>/_ministack/health` until it answers (bounded), returns the payload. */
export async function waitForHealth(
  endpoint: string,
  timeoutSeconds: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ payload: HealthPayload; waitedMs: number; attempts: number }> {
  const started = Date.now();
  let attempts = 0;
  let last: string;
  for (;;) {
    attempts += 1;
    try {
      const res = await fetchImpl(new URL('/_ministack/health', endpoint), {
        signal: AbortSignal.timeout(3_000),
        // Never follow the emulator elsewhere.
        redirect: 'error',
      });
      if (res.ok)
        return {
          payload: (await res.json()) as HealthPayload,
          waitedMs: Date.now() - started,
          attempts,
        };
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() - started > timeoutSeconds * 1000) {
      throw new Error(`MiniStack health did not answer within ${timeoutSeconds} s (${last})`);
    }
    await sleep(Math.min(1_000 * attempts, 3_000));
  }
}

/** A minimal ZIP (stored, no compression) holding the given files. */
export function storedZip(files: Record<string, string>): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    local.push(header, nameBuf, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += header.length + nameBuf.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/**
 * Runs inside MiniStack (local executor: a worker process of the MiniStack container) and reports
 * what it can see — never an environment VALUE except the endpoint host.
 */
export const SOCKET_PROBE_SOURCE = `import { existsSync, readdirSync } from 'node:fs';
const sockets = ['/var/run/docker.sock', '/run/docker.sock', '/run/podman/podman.sock'];
try {
  for (const uid of readdirSync('/run/user')) sockets.push('/run/user/' + uid + '/podman/podman.sock');
} catch {}
export const handler = async () => {
  let endpointHost = null;
  try { endpointHost = new URL(process.env.AWS_ENDPOINT_URL).host; } catch {}
  return {
    socketsFound: sockets.filter((p) => existsSync(p)),
    dockerHostSet: Boolean(process.env.DOCKER_HOST),
    lambdaRuntimeApi: Boolean(process.env.AWS_LAMBDA_RUNTIME_API),
    node: process.version,
    endpointHost,
  };
};
`;

export interface SocketProbe {
  socketsFound: string[];
  dockerHostSet: boolean;
  lambdaRuntimeApi: boolean;
  node: string;
  endpointHost: string | null;
}

async function socketProbe(runId: string): Promise<SocketProbe> {
  const lambda = new LambdaClient({ region: EMULATOR_REGION });
  const iam = new IAMClient({ region: EMULATOR_REGION });
  const name = `starter-emulator-probe-${runId}`;
  try {
    const role = await iam.send(
      new CreateRoleCommand({
        RoleName: name,
        AssumeRolePolicyDocument: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 'lambda.amazonaws.com' },
              Action: 'sts:AssumeRole',
            },
          ],
        }),
      }),
    );
    await lambda.send(
      new CreateFunctionCommand({
        FunctionName: name,
        Runtime: 'nodejs24.x',
        Handler: 'index.handler',
        Role: role.Role?.Arn,
        Timeout: 10,
        Code: { ZipFile: storedZip({ 'index.mjs': SOCKET_PROBE_SOURCE }) },
      }),
    );
    await waitUntilFunctionActiveV2({ client: lambda, maxWaitTime: 30 }, { FunctionName: name });
    const out = await lambda.send(
      new InvokeCommand({ FunctionName: name, Payload: new TextEncoder().encode('{}') }),
    );
    const text = new TextDecoder().decode(out.Payload);
    if (out.FunctionError) throw new Error(`socket probe failed: ${text.slice(0, 300)}`);
    return JSON.parse(text) as SocketProbe;
  } finally {
    await lambda.send(new DeleteFunctionCommand({ FunctionName: name })).catch(() => undefined);
    await iam.send(new DeleteRoleCommand({ RoleName: name })).catch(() => undefined);
    lambda.destroy();
    iam.destroy();
  }
}

/** `host[:port]` is a loopback address (127.0.0.0/8, ::1, localhost). */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(hostname)
  );
}

const AWS_HOST = /(^|\.)(amazonaws\.com(\.cn)?|api\.aws)(:\d+)?$/i;

/** The preflight verdict (pure; unit-tested). */
export function preflightProblems(input: {
  expectedVersion: string;
  expectedExecutor: 'local' | 'docker';
  health: HealthPayload;
  account: string | undefined;
  probe: SocketProbe;
}): string[] {
  const problems: string[] = [];
  if (input.health.version !== input.expectedVersion) {
    problems.push(
      `MiniStack reports version ${String(input.health.version)}, expected ${input.expectedVersion}`,
    );
  }
  if (input.account !== EMULATOR_ACCOUNT) {
    problems.push(
      `STS GetCallerIdentity returned account ${String(input.account)}, expected the fake ${EMULATOR_ACCOUNT}`,
    );
  }
  // The endpoint the handlers inside MiniStack use: never AWS; loopback for the local executor
  // (its workers share MiniStack's network namespace).
  const host = input.probe.endpointHost;
  if (!host) {
    problems.push(
      'AWS_ENDPOINT_URL is not set for the Lambdas inside MiniStack: their SDK clients would call the real AWS endpoints',
    );
  } else if (AWS_HOST.test(host)) {
    problems.push(`the Lambdas inside MiniStack use the AWS endpoint ${host}`);
  } else if (input.expectedExecutor === 'local' && !isLoopbackHost(host)) {
    problems.push(
      `the Lambdas inside MiniStack use endpoint host ${host}, expected a loopback host (local executor)`,
    );
  }
  if (input.expectedExecutor === 'local') {
    if (input.probe.socketsFound.length > 0 || input.probe.dockerHostSet) {
      problems.push(
        `a container-engine socket is reachable from MiniStack (${input.probe.socketsFound.join(', ') || 'DOCKER_HOST'}): the emulator must run socket-less`,
      );
    }
    if (input.probe.lambdaRuntimeApi) {
      problems.push(
        'the probe ran under a Lambda runtime API (docker executor), not the socket-less local executor',
      );
    }
  } else if (!input.probe.lambdaRuntimeApi) {
    problems.push('docker executor declared, but the probe did not run under a Lambda runtime API');
  }
  return problems;
}

async function preflight(args: Args, endpoint: string): Promise<number> {
  const out = one(args, 'out');
  const expectedVersion = one(args, 'expected-version');
  const timeoutSeconds = Number(args['timeout-seconds']?.[0] ?? '90');
  const runId = one(args, 'run-id');
  const expectedExecutor = args['expected-executor']?.[0] === 'docker' ? 'docker' : 'local';
  const t0 = Date.now();
  const record: Record<string, unknown> = {
    target: 'ministack-emulator',
    endpoint,
    expectedVersion,
  };
  try {
    const health = await waitForHealth(endpoint, timeoutSeconds);
    Object.assign(record, {
      health: health.payload,
      healthWaitMs: health.waitedMs,
      healthAttempts: health.attempts,
    });
    const sts = new STSClient({ region: EMULATOR_REGION });
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    sts.destroy();
    record.identity = { account: identity.Account };
    const t1 = Date.now();
    const probe = await socketProbe(runId);
    Object.assign(record, { socketProbe: probe, socketProbeMs: Date.now() - t1 });
    const problems = preflightProblems({
      expectedVersion,
      expectedExecutor,
      health: health.payload,
      account: identity.Account,
      probe,
    });
    Object.assign(record, { problems, ok: problems.length === 0, durationMs: Date.now() - t0 });
    writeJson(out, record);
    for (const p of problems) console.error(`[emulator-ci] preflight: ${p}`);
    return problems.length === 0 ? 0 : 1;
  } catch (error) {
    Object.assign(record, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - t0,
    });
    writeJson(out, record);
    console.error(`[emulator-ci] preflight failed: ${String(record.error)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------------------------
// Loopback forwarder (ci-service mode)
// ---------------------------------------------------------------------------------------------

/**
 * A TCP forwarder on 127.0.0.1 (ephemeral port) to `target`. Why: against a host-name endpoint
 * (`http://ministack:4566`) the AWS SDK addresses S3 buckets virtual-hosted style
 * (`<bucket>.ministack`), which no service alias resolves, and the CDK CLI offers no path-style
 * switch. Against a loopback IP the SDK uses path-style, exactly as in local runs. ci.sh starts it
 * only after the guard accepted the job environment, and its target is that guard-validated,
 * allowlisted endpoint — never anything else.
 */
export async function startForwarder(target: URL): Promise<net.Server> {
  const port = Number(target.port || 80);
  const server = net.createServer((client) => {
    const upstream = net.connect(port, target.hostname);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.pipe(upstream);
    upstream.pipe(client);
    for (const socket of [client, upstream]) {
      socket.on('error', close);
      socket.on('close', close);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

// ---------------------------------------------------------------------------------------------
// JUnit
// ---------------------------------------------------------------------------------------------

export interface StepRecord {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  durationMs?: number;
  message?: string;
}

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Reconciliation as JUnit test cases: reconciled → pass; compared-not-enforced, unsupported and
 * metadata-only → SKIPPED (never a pass: no semantic verification), with the reasons; failed →
 * failure naming the mismatched and unknown properties.
 */
export function reconciliationSteps(report: {
  resources: {
    logicalId: string;
    type: string;
    status: string;
    error?: string;
    checks: { property: string; status: string; reason?: string }[];
    unsupportedSemantics?: string;
  }[];
}): StepRecord[] {
  return report.resources.map((r) => {
    const name = `reconcile ${r.type} ${r.logicalId}`;
    const of = (status: string) =>
      r.checks.filter((c) => c.status === status).map((c) => `${c.property}: ${c.reason ?? ''}`);
    if (r.status === 'reconciled') return { name, status: 'pass' };
    if (r.status === 'failed') {
      const mismatched = r.checks.filter((c) => c.status === 'mismatch').map((c) => c.property);
      const message = [
        ...(mismatched.length > 0 ? [`mismatch: ${mismatched.join(', ')}`] : []),
        ...(r.error ? [r.error] : []),
      ].join('; ');
      return { name, status: 'fail', message: message || 'failed' };
    }
    if (r.status === 'metadata-only') {
      return {
        name,
        status: 'skipped',
        message: 'metadata-only: no service object (on AWS either)',
      };
    }
    if (r.status === 'compared-not-enforced') {
      return {
        name,
        status: 'skipped',
        message: `compared-not-enforced (values equal, no effect on the emulator): ${of('compared-not-enforced').join(' | ')}`,
      };
    }
    const reasons = [
      ...(r.unsupportedSemantics ? [r.unsupportedSemantics] : []),
      ...of('unsupported'),
      ...of('compared-not-enforced').map((x) => `compared-not-enforced ${x}`),
    ];
    return { name, status: 'skipped', message: `emulator-unsupported: ${reasons.join(' | ')}` };
  });
}

/** A test of results.json that passed with not-applicable assertions. */
export interface PartialPass {
  file: string;
  test: string;
  /** `what [gap]` (results.json) plus ` NA-…` when the governance record names the entry. */
  assertions: string[];
}

/** The partial passes of a results.json, with baseline ids from not-applicable.jsonl (if given). */
export function partialPasses(results: unknown, governanceJsonl = ''): PartialPass[] {
  const ids = new Map<string, string>();
  for (const line of governanceJsonl.split('\n')) {
    if (line.trim() === '') continue;
    const x = JSON.parse(line) as {
      kind?: string;
      file?: string;
      test?: string;
      assertion?: string;
      baselineId?: string;
    };
    if (x.kind === 'assertion' && x.baselineId) {
      ids.set(`${x.file}|${x.test}|${x.assertion}`, x.baselineId);
    }
  }
  const tests =
    (
      results as {
        tests?: {
          file?: string;
          test?: string;
          status?: string;
          notApplicableAssertions?: string[];
        }[];
      }
    ).tests ?? [];
  return tests
    .filter((t) => t.status === 'pass' && (t.notApplicableAssertions?.length ?? 0) > 0)
    .map((t) => ({
      file: String(t.file),
      test: String(t.test),
      assertions: (t.notApplicableAssertions ?? []).map((a) => {
        const what = a.replace(/ \[[^\]]*\]$/, '');
        const id = ids.get(`${t.file}|${t.test}|${what}`);
        return id ? `${a} ${id}` : a;
      }),
    }));
}

const unxml = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * Marks the partial passes in a (vitest) JUnit document: the testcase stays a pass, but carries
 * a `<properties>` entry per not-applicable assertion (`emulator-not-applicable`) and a
 * `<system-out>` line naming them, so the GitLab test report does not show it as a plain pass.
 */
export function annotatePartialPasses(doc: string, partial: readonly PartialPass[]): string {
  if (partial.length === 0) return doc;
  return doc.replace(
    /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g,
    (whole, attrs: string, _end: string, body: string | undefined) => {
      const attr = (n: string) => unxml(new RegExp(`\\b${n}="([^"]*)"`).exec(attrs)?.[1] ?? '');
      const p = partial.find(
        (x) => x.test === attr('name') && path.basename(attr('classname')) === x.file,
      );
      if (!p || (body ?? '').includes('<failure') || (body ?? '').includes('<skipped')) {
        return whole;
      }
      const props = p.assertions
        .map((a) => `<property name="emulator-not-applicable" value="${xml(a)}"/>`)
        .join('');
      const out = `emulator: PASSED WITH ${p.assertions.length} NOT-APPLICABLE ASSERTION(S), not a full pass: ${p.assertions.join(' | ')}`;
      return `<testcase${attrs}><properties>${props}</properties><system-out>${xml(out)}</system-out>${(body ?? '').trim()}</testcase>`;
    },
  );
}

/** A JUnit document: the lifecycle steps as one suite, plus the suites of included JUnit files. */
export function junitXml(
  suite: string,
  steps: readonly StepRecord[],
  included: readonly string[] = [],
): string {
  const failures = steps.filter((s) => s.status === 'fail').length;
  const skipped = steps.filter((s) => s.status === 'skipped').length;
  const time = steps.reduce((n, s) => n + (s.durationMs ?? 0), 0) / 1000;
  const cases = steps
    .map((s) => {
      const open = `    <testcase classname="${xml(suite)}" name="${xml(s.name)}" time="${((s.durationMs ?? 0) / 1000).toFixed(3)}"`;
      if (s.status === 'pass') return `${open}/>`;
      const body =
        s.status === 'fail'
          ? `<failure message="${xml(s.message ?? 'failed')}">${xml(s.message ?? '')}</failure>`
          : `<skipped message="${xml(s.message ?? 'skipped')}"/>`;
      return `${open}>\n      ${body}\n    </testcase>`;
    })
    .join('\n');
  const inner = included
    .map((doc) => {
      // No workstation or runner host names in a published report.
      const body = doc.replace(/<\?xml[^>]*\?>\s*/, '').replace(/\s+hostname="[^"]*"/g, '');
      const m = /<testsuites[^>]*>([\s\S]*)<\/testsuites>/.exec(body);
      return (m?.[1] ?? body).trim();
    })
    .filter((s) => s !== '');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${xml(suite)}">`,
    `  <testsuite name="${xml(suite)}" tests="${steps.length}" failures="${failures}" errors="0" skipped="${skipped}" time="${time.toFixed(3)}">`,
    cases,
    '  </testsuite>',
    ...inner,
    '</testsuites>',
    '',
  ].join('\n');
}

export function readSteps(file: string): StepRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as StepRecord);
}

// ---------------------------------------------------------------------------------------------
// Leak scan of a run directory (and of a service log placed in it)
// ---------------------------------------------------------------------------------------------

export interface LeakFinding {
  file: string;
  line: number;
  kind: 'aws-endpoint' | 'foreign-account';
  match: string;
}

export interface LeakScan {
  dir: string;
  filesScanned: number;
  /** Skipped: bundled third-party code (`asset.*`), binary or larger than the limit. */
  filesSkipped: number;
  findings: LeakFinding[];
  ok: boolean;
}

/** An AWS-operated endpoint URL (XML namespace URIs `…amazonaws.com/doc/…` are not calls). */
const AWS_ENDPOINT_URL_RE =
  /\bhttps?:\/\/(?:[a-z0-9-]+\.)*(?:amazonaws\.com(?:\.cn)?|api\.aws)\b(?!\/doc\/)[^\s"'<>)]*/gi;
/** A 12-digit account id in an ARN or an account/owner field. */
const ACCOUNT_RE =
  /\barn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:(\d{12}):|"(?:account|accountId|Account|AccountId|OwnerId|ownerId)"\s*:\s*"(\d{12})"/g;

/**
 * Scans every text file under `dir` for AWS endpoint URLs and account ids other than the fake
 * emulator account. Skips `asset.*` directories (bundled SDK code with static AWS URLs), binary
 * files and files over `maxBytes`. A MiniStack service log written into `dir` is scanned too.
 */
export function scanForAwsLeaks(
  dir: string,
  allowedAccounts: readonly string[] = [EMULATOR_ACCOUNT],
  maxBytes = 20 * 1024 * 1024,
): LeakScan {
  const findings: LeakFinding[] = [];
  let filesScanned = 0;
  let filesSkipped = 0;
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('asset.')) filesSkipped += 1;
        else walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (statSync(full).size > maxBytes) {
        filesSkipped += 1;
        continue;
      }
      const buffer = readFileSync(full);
      if (buffer.includes(0)) {
        filesSkipped += 1;
        continue;
      }
      filesScanned += 1;
      const rel = path.relative(dir, full);
      buffer
        .toString('utf8')
        .split('\n')
        .forEach((text, i) => {
          for (const m of text.matchAll(AWS_ENDPOINT_URL_RE)) {
            findings.push({ file: rel, line: i + 1, kind: 'aws-endpoint', match: m[0] });
          }
          for (const m of text.matchAll(ACCOUNT_RE)) {
            const account = m[1] ?? m[2] ?? '';
            if (!allowedAccounts.includes(account)) {
              // Never echo an account id into logs or artifacts: the location is enough to act on.
              findings.push({
                file: rel,
                line: i + 1,
                kind: 'foreign-account',
                match: '<12-digit account id, redacted>',
              });
            }
          }
        });
    }
  };
  walk(dir);
  return { dir, filesScanned, filesSkipped, findings, ok: findings.length === 0 };
}

// ---------------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------------

const optionalJson = (file: string): Record<string, unknown> | undefined =>
  existsSync(file) ? readJson<Record<string, unknown>>(file) : undefined;

/** diagnostics.json of a run directory (version, image, executor, health, durations, counts). */
export function diagnostics(runDir: string, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const preflightRecord = optionalJson(path.join(runDir, 'preflight.json'));
  const steps = readSteps(path.join(runDir, 'steps.jsonl'));
  const reconciliation = optionalJson(path.join(runDir, 'reconciliation.json'));
  const results = optionalJson(path.join(runDir, 'report', 'results.json'));
  const probe = preflightRecord?.socketProbe as SocketProbe | undefined;
  const scan = scanForAwsLeaks(runDir);
  return {
    target: 'ministack-emulator',
    note: 'EMULATOR — not AWS; nothing here is AWS evidence',
    runId: path.basename(runDir),
    suite: env.STARTER_EMULATOR_SUITE,
    mode: env.STARTER_EMULATOR_JOB_MODE || env.STARTER_EMULATOR_MODE || 'loopback',
    ...(env.STARTER_EMULATOR_SERVICE_ENDPOINT
      ? {
          transport: {
            serviceEndpoint: env.STARTER_EMULATOR_SERVICE_ENDPOINT,
            via: 'loopback TCP forwarder (path-style S3 for the CDK asset upload)',
          },
        }
      : {}),
    ministack: {
      expectedVersion: env.STARTER_MINISTACK_EXPECTED_VERSION,
      reportedVersion: (preflightRecord?.health as HealthPayload | undefined)?.version,
      image: env.STARTER_MINISTACK_IMAGE ?? env.MINISTACK_IMAGE,
      edition: (preflightRecord?.health as HealthPayload | undefined)?.edition,
    },
    lambdaExecutor: probe
      ? probe.lambdaRuntimeApi
        ? 'docker'
        : 'local'
      : env.MINISTACK_LAMBDA_EXECUTOR,
    socketMounted: probe ? probe.socketsFound.length > 0 || probe.dockerHostSet : null,
    socketEvidence: probe
      ? {
          method:
            'probe Lambda executed by MiniStack (local executor = a worker process inside the MiniStack container) checked the engine socket paths and DOCKER_HOST',
          socketsFound: probe.socketsFound,
          dockerHostSet: probe.dockerHostSet,
          lambdaRuntimeApi: probe.lambdaRuntimeApi,
          workerNode: probe.node,
          endpointHostSeenByLambdas: probe.endpointHost,
        }
      : null,
    identityAccount: (preflightRecord?.identity as { account?: string } | undefined)?.account,
    leakScan: {
      scope:
        'run directory (asset.* bundles, binaries skipped); the CI service log is in the job trace and NOT scanned',
      filesScanned: scan.filesScanned,
      filesSkipped: scan.filesSkipped,
      findings: scan.findings,
      ok: scan.ok,
    },
    health: preflightRecord?.health,
    ciPipelineIid: env.CI_PIPELINE_IID,
    ciJobId: env.CI_JOB_ID,
    durationsMs: Object.fromEntries(steps.map((s) => [s.name, s.durationMs ?? null])),
    totalDurationMs: steps.reduce((n, s) => n + (s.durationMs ?? 0), 0),
    steps: steps.map((s) => ({ name: s.name, status: s.status })),
    counts: {
      steps: {
        pass: steps.filter((s) => s.status === 'pass').length,
        fail: steps.filter((s) => s.status === 'fail').length,
        skipped: steps.filter((s) => s.status === 'skipped').length,
      },
      ...(reconciliation
        ? {
            reconciliation: reconciliation.counts,
            templateResources: reconciliation.templateResources,
          }
        : {}),
      ...(results ? { tests: results.counts } : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let parsed: { command: string; args: Args };
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(`[emulator-ci] ${String(error)}`);
    return 2;
  }
  const { command, args } = parsed;
  // Offline subcommands (no emulator call) need no guard.
  if (command === 'junit') {
    try {
      const out = one(args, 'out');
      const resultsFile = args.results?.[0] ?? path.join(path.dirname(out), 'results.json');
      const partial = existsSync(resultsFile)
        ? partialPasses(
            readJson(resultsFile),
            existsSync(path.join(path.dirname(resultsFile), 'not-applicable.jsonl'))
              ? readFileSync(path.join(path.dirname(resultsFile), 'not-applicable.jsonl'), 'utf8')
              : '',
          )
        : [];
      const included = (args.include ?? [])
        .filter((f) => existsSync(f))
        .map((f) => annotatePartialPasses(readFileSync(f, 'utf8'), partial));
      const suite = one(args, 'suite');
      for (const f of (args.reconciliation ?? []).filter((x) => existsSync(x))) {
        const label = `${suite} ${path.basename(f, '.json')}`;
        included.push(junitXml(label, reconciliationSteps(readJson(f))));
      }
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, junitXml(suite, readSteps(one(args, 'steps')), included));
      return 0;
    } catch (error) {
      console.error(`[emulator-ci] ${String(error)}`);
      return error instanceof UsageError ? 2 : 1;
    }
  }
  if (command === 'diagnostics') {
    writeJson(one(args, 'out'), diagnostics(one(args, 'run-dir'), env));
    return 0;
  }
  if (command === 'scan-leaks') {
    try {
      const scan = scanForAwsLeaks(one(args, 'dir'));
      if (args.out?.[0]) writeJson(args.out[0], scan);
      for (const f of scan.findings) {
        console.error(`[emulator-ci] leak scan: ${f.file}:${f.line}: ${f.kind} ${f.match}`);
      }
      console.error(
        `[emulator-ci] leak scan: ${scan.filesScanned} files, ${scan.findings.length} finding(s)`,
      );
      return scan.ok ? 0 : 1;
    } catch (error) {
      console.error(`[emulator-ci] ${String(error)}`);
      return error instanceof UsageError ? 2 : 1;
    }
  }

  const guard = checkEmulatorEnvironment(env, 'effective');
  if (!guard.ok) {
    for (const r of guard.refusals) console.error(`[emulator-guard] refusing: ${r}`);
    return EMULATOR_REFUSAL_EXIT_CODE;
  }
  if (command === 'forward') {
    if (guard.mode !== 'ci-service') {
      console.error('[emulator-ci] forward: only in STARTER_EMULATOR_MODE=ci-service');
      return 2;
    }
    const server = await startForwarder(new URL(guard.endpoint));
    const address = server.address() as net.AddressInfo;
    writeFileSync(one(args, 'port-file'), `${address.port}\n`);
    console.error(`[emulator-ci] forwarding 127.0.0.1:${address.port} -> ${guard.endpoint}`);
    await new Promise<void>((resolve) => {
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.once(signal, () => server.close(() => resolve()));
      }
    });
    return 0;
  }
  const reader = sdkReader(EMULATOR_REGION);
  try {
    switch (command) {
      case 'preflight':
        return await preflight(args, guard.endpoint);
      case 'reconcile': {
        const report = await reconcile({
          reader,
          template: readJson<Template>(one(args, 'template')),
          stackName: one(args, 'stack'),
          region: EMULATOR_REGION,
          account: EMULATOR_ACCOUNT,
        });
        writeJson(one(args, 'out'), report);
        console.error(
          `[emulator-ci] reconciliation: ${report.templateResources} template resources: ${JSON.stringify(report.counts)}, properties ${JSON.stringify(report.propertyCounts)}, no-op placeholders ${report.noopPlaceholders.length}`,
        );
        for (const r of report.resources.filter((x) => x.status === 'failed')) {
          const bad = r.checks
            .filter((c) => c.status === 'mismatch' || c.status === 'unknown')
            .map((c) => `${c.property} (${c.status})`);
          console.error(
            `[emulator-ci]   FAILED ${r.logicalId} (${r.type}): ${r.error ?? bad.join(', ')}`,
          );
        }
        return report.ok ? 0 : 1;
      }
      case 'snapshot':
        writeJson(one(args, 'out'), await snapshotFunctions(reader, one(args, 'stack')));
        return 0;
      case 'verify-update': {
        const before = readJson<FunctionSnapshot[]>(one(args, 'before'));
        const after = await snapshotFunctions(reader, one(args, 'stack'));
        const result = verifyUpdate(before, after, one(args, 'app-version'));
        writeJson(one(args, 'out'), result);
        for (const f of result.functions.filter((x) => !x.ok)) {
          console.error(`[emulator-ci] update: ${f.functionName}: ${f.problems.join('; ')}`);
        }
        return result.ok ? 0 : 1;
      }
      case 'stack-resources': {
        const stackName = one(args, 'stack');
        const stack = await reader.stack(stackName);
        writeJson(one(args, 'out'), {
          stackName,
          stackId: stack?.stackId,
          resources: await reader.stackResources(stackName),
        });
        return 0;
      }
      case 'verify-destroyed': {
        const recorded = readJson<{
          stackName: string;
          stackId?: string;
          resources: StackResourceInfo[];
        }>(one(args, 'resources'));
        const report = await verifyDestroyed({ reader, ...recorded });
        writeJson(one(args, 'out'), report);
        if (!report.ok) {
          console.error(
            `[emulator-ci] destroy: stack ${report.stackStatus}, remaining ${JSON.stringify(report.remaining)}`,
          );
        }
        return report.ok ? 0 : 1;
      }
      case 'reset': {
        const res = await fetch(new URL('/_ministack/reset', guard.endpoint), {
          method: 'POST',
          signal: AbortSignal.timeout(30_000),
          redirect: 'error',
        });
        writeJson(one(args, 'out'), {
          status: res.status,
          ok: res.ok,
          at: new Date().toISOString(),
        });
        return res.ok ? 0 : 1;
      }
      default:
        console.error(`[emulator-ci] unknown command ${command}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`[emulator-ci] ${error.message}`);
      return 2;
    }
    console.error(
      `[emulator-ci] ${command} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  } finally {
    reader.destroy();
  }
}

if (process.argv[1] && path.basename(process.argv[1]).startsWith('emulator-ci')) {
  process.exitCode = await main(process.argv.slice(2));
}
