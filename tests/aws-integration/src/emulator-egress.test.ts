/**
 * The emulator-mode `cdk` calls must reach nothing but the emulator.
 *
 * CDK CLI 2.1144 phones home on its own: telemetry (a detached sender POSTing to
 * `TELEMETRY_ENDPOINT` or https://cdk-cli-telemetry.us-east-1.api.aws/metrics), notices
 * (https://cli.cdk.dev-tools.aws.dev/notices.json) and an npm version check
 * (https://registry.npmjs.org), each through an optional proxy. `cdk bootstrap` from an empty
 * directory had none of infra/cdk.json's switches, so the telemetry went out.
 *
 * Method (the reviewer's, automated, no internet): the emulator endpoint is a CLOSED loopback port,
 * a loopback TCP sink stands in for the telemetry host (TELEMETRY_ENDPOINT), and every Node process
 * is preloaded with emulator/egress-audit.mjs, which records — and blocks — every connection and
 * DNS query outside its allowlist. The first test reproduces the leak with the pre-fix command (the
 * sink receives a TLS ClientHello); the second runs the fixed commands of _emulator.sh, with the
 * same redirect forced in after the guard and a hostile ~/.cdk.json, and requires zero violations.
 * Needs the workspace build (guard CLI, integration app) and the infra package's `cdk`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const EMULATOR_DIR = fileURLToPath(new URL('../emulator/', import.meta.url));
const REPO_ROOT = path.resolve(EMULATOR_DIR, '../../..');
const CDK_BIN = path.join(REPO_ROOT, 'infra', 'node_modules', '.bin', 'cdk');
const HOOK = path.join(EMULATOR_DIR, 'egress-audit.mjs');
const REPORT = path.join(EMULATOR_DIR, 'egress-report.mjs');
const TELEMETRY_SENDER = 'sender-bundle.js';

interface Sink {
  port: number;
  connections: { firstByte: number | undefined }[];
  /** Resolves on the first connection, or with `undefined` after `ms` (bounded wait). */
  firstConnection: (ms: number) => Promise<{ firstByte: number | undefined } | undefined>;
  close: () => Promise<void>;
}

/** A loopback TCP sink that records each connection and its first byte (0x16 = TLS ClientHello). */
async function startSink(): Promise<Sink> {
  const connections: { firstByte: number | undefined }[] = [];
  const waiters: ((c: { firstByte: number | undefined }) => void)[] = [];
  const open = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    const entry = { firstByte: undefined as number | undefined };
    socket.once('data', (chunk: Buffer) => {
      entry.firstByte = chunk[0];
      connections.push(entry);
      for (const w of waiters.splice(0)) w(entry);
      socket.destroy();
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    connections,
    firstConnection: (ms) =>
      connections[0]
        ? Promise.resolve(connections[0])
        : new Promise((resolve) => {
            const timer = setTimeout(() => resolve(undefined), ms);
            waiters.push((c) => {
              clearTimeout(timer);
              resolve(c);
            });
          }),
    close: () =>
      new Promise((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A loopback port nothing listens on: the "emulator" refuses every connection, quickly. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Runs a bash script asynchronously (the sink lives in this process's event loop). */
function bash(
  script: string,
  env: Record<string, string>,
): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    child.on('close', (status) => resolve({ status, output }));
  });
}

interface AuditRecord {
  kind: string;
  target?: string;
  proc?: string;
  script?: string[];
  allowed: boolean;
}
const readLog = (file: string): AuditRecord[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as AuditRecord)
    : [];

let work: string;
let sink: Sink;
let emulatorPort: number;
const EMULATOR_ENV = (port: number): Record<string, string> => ({
  AWS_CONFIG_FILE: '/dev/null',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_ACCESS_KEY_ID: '000000000001',
  AWS_SECRET_ACCESS_KEY: 'ministack-local-only',
  AWS_REGION: 'ap-southeast-1',
  AWS_DEFAULT_REGION: 'ap-southeast-1',
  AWS_ENDPOINT_URL: `http://127.0.0.1:${port}`,
});

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'starter-emu-egress-'));
  sink = await startSink();
  emulatorPort = await closedPort();
});
afterAll(async () => {
  await sink.close();
  rmSync(work, { recursive: true, force: true });
});

const baseEnv = (home: string): Record<string, string> => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: home,
  TMPDIR: work,
});

describe.skipIf(!existsSync(CDK_BIN))('emulator egress', () => {
  it('reproduces the leak: the pre-fix bootstrap from an empty directory sends CLI telemetry', async () => {
    const dir = path.join(work, 'prefix');
    const home = path.join(dir, 'home');
    const boot = path.join(dir, 'boot');
    mkdirSync(home, { recursive: true });
    mkdirSync(boot, { recursive: true });
    const log = path.join(dir, 'egress.jsonl');
    const before = sink.connections.length;
    // The exact pre-fix call of _emulator.sh (8192c1c) with the pre-fix environment. The audit lets
    // the sink through so the sink sees what would have left; the default host stays blocked.
    const r = await bash(
      `cd ${JSON.stringify(boot)} && ${JSON.stringify(CDK_BIN)} bootstrap aws://000000000001/ap-southeast-1 ` +
        '--qualifier starter --toolkit-stack-name starter-cdk-toolkit --no-notices',
      {
        ...baseEnv(home),
        ...EMULATOR_ENV(emulatorPort),
        TELEMETRY_ENDPOINT: `https://127.0.0.1:${sink.port}/metrics`,
        STARTER_EMULATOR_EGRESS_LOG: log,
        STARTER_EMULATOR_EGRESS_ALLOW: `127.0.0.1:${emulatorPort},127.0.0.1:${sink.port}`,
        NODE_OPTIONS: `--import=${HOOK}`,
      },
    );
    expect(r.status, r.output).not.toBe(0); // the closed endpoint: the bootstrap itself fails
    const hello = await sink.firstConnection(20_000);
    expect(hello, 'the telemetry sender never connected').toBeDefined();
    expect(sink.connections.length).toBeGreaterThan(before);
    expect(hello?.firstByte).toBe(0x16); // TLS ClientHello, as in the review
    const records = readLog(log);
    expect(records).toContainEqual(
      expect.objectContaining({ kind: 'spawn', script: [TELEMETRY_SENDER], allowed: false }),
    );
    // The audit's verdict for this run is a failure.
    const verdict = spawnSync(
      process.execPath,
      [REPORT, '--log', log, '--out', path.join(dir, 'egress.json')],
      {
        encoding: 'utf8',
      },
    );
    expect(verdict.status).toBe(1);
    expect(verdict.stderr).toMatch(/VIOLATION detached-spawn node sender-bundle\.js/);
  }, 120_000);

  it('the emulator-mode cdk calls (bootstrap, synth, deploy, destroy) reach nothing but the emulator', async () => {
    const dir = path.join(work, 'fixed');
    const home = path.join(dir, 'home');
    mkdirSync(home, { recursive: true });
    // A hostile user config: a proxy, telemetry on, notices on. cdk_run must never read it.
    writeFileSync(
      path.join(home, '.cdk.json'),
      JSON.stringify({
        proxy: `http://127.0.0.1:${sink.port}`,
        notices: true,
        context: { 'cli-telemetry': true },
      }),
    );
    const log = path.join(dir, 'egress.jsonl');
    const before = sink.connections.length;
    const script = `
      set -uo pipefail
      source ${JSON.stringify(path.join(EMULATOR_DIR, '_emulator.sh'))}
      EMULATOR_PORT=${emulatorPort}; EMULATOR_ENDPOINT=http://127.0.0.1:${emulatorPort}
      guard incoming
      emulator_cli_isolation
      emulator_env
      guard effective
      cdk_home_prepare
      egress_audit_start ${JSON.stringify(log)} "$(endpoint_host_port "$AWS_ENDPOINT_URL")"
      emulator_bootstrap ${JSON.stringify(dir)} || echo "bootstrap failed (expected: closed endpoint)"
      emulator_synth em-e9e55e ${JSON.stringify(path.join(dir, 'cdk.out'))} || echo "synth failed"
      emulator_deploy ${JSON.stringify(path.join(dir, 'cdk.out'))} || echo "deploy failed (expected)"
      emulator_destroy ${JSON.stringify(path.join(dir, 'cdk.out'))} || echo "destroy failed (expected)"
      # An override that slipped past the guard: the bootstrap's per-command switches still hold.
      ( export TELEMETRY_ENDPOINT=https://127.0.0.1:${sink.port}/metrics
        unset CDK_DISABLE_CLI_TELEMETRY
        emulator_bootstrap ${JSON.stringify(dir)} ) || echo "bootstrap (override) failed (expected)"
      rm -rf "$CDK_ISOLATED_HOME"
      node "$EGRESS_REPORT" --log ${JSON.stringify(log)} --out ${JSON.stringify(path.join(dir, 'egress.json'))} --require cdk
    `;
    const r = await bash(script, {
      ...baseEnv(home),
      // The incoming environment of a developer machine: a proxy (removed by the isolation).
      HTTPS_PROXY: `http://127.0.0.1:${sink.port}`,
      npm_config_https_proxy: `http://127.0.0.1:${sink.port}`,
    });
    const report = JSON.parse(readFileSync(path.join(dir, 'egress.json'), 'utf8')) as {
      ok: boolean;
      allowed: Record<string, number>;
      violations: unknown[];
      processes: string[];
      spawned: string[];
    };
    expect(report.violations, r.output).toEqual([]);
    expect(report.ok).toBe(true);
    expect(r.status, r.output).toBe(0);
    // The CLI ran (audited) and talked to the emulator endpoint, and to nothing else; the app was
    // synthesized under the audit too.
    expect(report.processes).toContain('cdk');
    expect(report.processes).toContain('integration.js');
    expect(Object.keys(report.allowed)).toEqual([`127.0.0.1:${emulatorPort}`]);
    expect(report.spawned.join('\n')).not.toContain(TELEMETRY_SENDER);
    // Nothing was attempted toward the telemetry host or the proxy, and the sink saw nothing.
    for (const rec of readLog(log)) {
      expect(rec.target ?? '').not.toMatch(/cdk-cli-telemetry|dev-tools\.aws\.dev|npmjs/);
      expect(rec.target ?? '').not.toBe(`127.0.0.1:${sink.port}`);
    }
    expect(sink.connections.length).toBe(before);
  }, 180_000);

  it('the guard refuses a telemetry endpoint and a re-enabled CLI telemetry before any cdk call', () => {
    for (const env of [
      { TELEMETRY_ENDPOINT: 'https://127.0.0.1:1/metrics' },
      { CDK_DISABLE_CLI_TELEMETRY: 'false' },
    ]) {
      const r = spawnSync(
        'bash',
        [
          '-c',
          `source ${JSON.stringify(path.join(EMULATOR_DIR, '_emulator.sh'))}; guard incoming; echo PASSED`,
        ],
        { env: { ...baseEnv(work), ...env }, encoding: 'utf8' },
      );
      expect(r.status).toBe(5);
      expect(r.stdout).not.toContain('PASSED');
    }
  });

  it('emulator_cli_isolation removes every proxy variable and sets the CLI switches', () => {
    const r = spawnSync(
      'bash',
      [
        '-c',
        `source ${JSON.stringify(path.join(EMULATOR_DIR, '_emulator.sh'))}; emulator_cli_isolation; env`,
      ],
      {
        env: {
          ...baseEnv(work),
          HTTPS_PROXY: 'http://p:1',
          http_proxy: 'http://p:1',
          ALL_PROXY: 'socks5://p:1',
          npm_config_proxy: 'http://p:1',
          NPM_CONFIG_HTTPS_PROXY: 'http://p:1',
          NO_PROXY: '127.0.0.1',
        },
        encoding: 'utf8',
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const names = r.stdout.split('\n').map((l) => l.split('=')[0] ?? '');
    expect(names.filter((n) => /^(?:npm_config_)?(?:https?_|all_)?proxy$/i.test(n))).toEqual([]);
    expect(names).toContain('NO_PROXY');
    expect(r.stdout).toMatch(/^CDK_DISABLE_CLI_TELEMETRY=true$/m);
    expect(r.stdout).toMatch(/^CDK_DISABLE_VERSION_CHECK=true$/m);
    expect(r.stdout).toMatch(/^CDK_DOCKER=.*no-container-engine\.sh$/m);
  });
});

describe('egress audit hook (emulator/egress-audit.mjs)', () => {
  // Asynchronous: the allowed server lives in this process's event loop.
  const runUnderHook = (
    code: string,
    allow: string,
    log: string,
  ): Promise<{ status: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        env: {
          PATH: process.env.PATH ?? '',
          STARTER_EMULATOR_EGRESS_LOG: log,
          STARTER_EMULATOR_EGRESS_ALLOW: allow,
          NODE_OPTIONS: `--import=${HOOK}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.on('close', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });

  it('allows the emulator endpoint, blocks and records everything else (TCP, TLS, DNS, workers, detached children)', async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      s.end('HTTP/1.1 204 No Content\r\n\r\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    const log = path.join(work, 'hook.jsonl');
    try {
      const code = `
        import dns from 'node:dns';
        import { spawn } from 'node:child_process';
        import { Worker } from 'node:worker_threads';
        const out = [];
        const res = await fetch('http://127.0.0.1:${port}/').then((r) => r.status, (e) => e.cause?.code);
        out.push('allowed=' + res);
        out.push('telemetry=' + await fetch('https://cdk-cli-telemetry.us-east-1.api.aws/metrics').then(() => 'SENT', (e) => e.cause?.code ?? e.code));
        out.push('otherport=' + await fetch('http://127.0.0.1:${port + 1}/').then(() => 'SENT', (e) => e.cause?.code ?? e.code));
        out.push('dns=' + await dns.promises.lookup('registry.npmjs.org').then(() => 'RESOLVED', (e) => e.code));
        const child = spawn(process.execPath, ['-e', '0'], { detached: true, stdio: 'ignore' });
        await new Promise((r) => child.on('exit', r));
        const w = new Worker('0', { eval: true });
        await new Promise((r) => w.on('exit', r));
        console.log(out.join(' '));
      `;
      const r = await runUnderHook(code, `127.0.0.1:${port}`, log);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe(
        'allowed=204 telemetry=EGRESSBLOCKED otherport=EGRESSBLOCKED dns=EGRESSBLOCKED',
      );
      const verdict = spawnSync(
        process.execPath,
        [REPORT, '--log', log, '--out', path.join(work, 'hook.json')],
        { encoding: 'utf8' },
      );
      expect(verdict.status).toBe(1);
      const report = JSON.parse(readFileSync(path.join(work, 'hook.json'), 'utf8')) as {
        allowed: Record<string, number>;
        violations: { kind: string; target: string }[];
      };
      expect(report.allowed).toEqual({ [`127.0.0.1:${port}`]: 1 });
      expect(report.violations.map((v) => `${v.kind} ${v.target}`).sort()).toEqual(
        [
          'connect cdk-cli-telemetry.us-east-1.api.aws:443',
          `connect 127.0.0.1:${port + 1}`,
          'dns.lookup registry.npmjs.org',
          `detached-spawn ${path.basename(process.execPath)}`,
          'worker <eval>',
        ].sort(),
      );
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  it('ci-service topology: the forwarder may listen on 127.0.0.1, other DNS is still blocked', async () => {
    // In CI the allowlist names only the service alias; the forwarder's own listen() resolves the
    // loopback IP literal through dns.lookup, which sends no query and must not count as egress.
    const log = path.join(work, 'forwarder.jsonl');
    const code = `
      import dns from 'node:dns';
      import net from 'node:net';
      const server = net.createServer();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const listening = server.address().port > 0;
      server.close();
      const literal = await dns.promises.lookup('127.0.0.1').then(() => 'ok', (e) => e.code);
      const name = await dns.promises.lookup('registry.npmjs.org').then(() => 'RESOLVED', (e) => e.code);
      const resolve4 = await dns.promises.resolve4('127.0.0.1').then(() => 'QUERIED', (e) => e.code);
      console.log([listening, literal, name, resolve4].join(' '));
    `;
    const r = await runUnderHook(code, 'ministack:4566', log);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('true ok EGRESSBLOCKED EGRESSBLOCKED');
    const records = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; target?: string; allowed: boolean })
      .filter((x) => !x.allowed)
      .map((x) => `${x.kind} ${x.target}`);
    expect(records.sort()).toEqual(
      ['dns.lookup registry.npmjs.org', 'dns.resolve4 127.0.0.1'].sort(),
    );
  }, 60_000);

  it('clean-env children (sync and async) stay audited; a custom lookup and lookupService are blocked; non-Node children are recorded', async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      s.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    const log = path.join(work, 'n4.jsonl');
    // Each child drops the audit from its environment (env: {PATH}) and dials a non-allowed port.
    const child = `fetch('http://127.0.0.1:${port + 7}/').then(() => console.log('SENT'), (e) => console.log(e.cause?.code ?? e.code))`;
    const code = `
      import dns from 'node:dns';
      import net from 'node:net';
      import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
      const env = { PATH: process.env.PATH };
      const child = ${JSON.stringify(child)};
      const out = [];
      out.push('spawnSync=' + spawnSync(process.execPath, ['-e', child], { env, encoding: 'utf8' }).stdout.trim());
      out.push('execFileSync=' + execFileSync(process.execPath, ['-e', child], { env, encoding: 'utf8' }).trim());
      out.push('execSync=' + execSync(process.execPath + ' -e ' + JSON.stringify(child), { env, encoding: 'utf8' }).trim());
      const async = spawn(process.execPath, ['-e', child], { env });
      let text = '';
      async.stdout.on('data', (d) => (text += d));
      await new Promise((r) => async.on('close', r));
      out.push('spawn=' + text.trim());
      execFileSync('sh', ['-c', 'exit 0']);
      out.push('lookup=' + await new Promise((res) => {
        const s = net.connect({ host: 'allowedalias', port: ${port}, lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)) });
        s.on('connect', () => { s.destroy(); res('connected'); });
        s.on('error', (e) => res(e.code));
      }));
      out.push('lookupService=' + await new Promise((res) => dns.lookupService('127.0.0.1', 22, (e) => res(e ? e.code : 'answered'))));
      console.log(out.join(' '));
    `;
    try {
      const r = await runUnderHook(code, `127.0.0.1:${port},allowedalias:${port}`, log);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe(
        'spawnSync=EGRESSBLOCKED execFileSync=EGRESSBLOCKED execSync=EGRESSBLOCKED spawn=EGRESSBLOCKED lookup=EGRESSBLOCKED lookupService=EGRESSBLOCKED',
      );
      const verdict = spawnSync(
        process.execPath,
        [REPORT, '--log', log, '--out', path.join(work, 'n4.json')],
        { encoding: 'utf8' },
      );
      expect(verdict.status).toBe(1);
      const report = JSON.parse(readFileSync(path.join(work, 'n4.json'), 'utf8')) as {
        violations: { kind: string; target: string; proc?: string }[];
        uncovered: string[];
        reinjected: number;
      };
      expect(report.violations.map((v) => `${v.kind} ${v.target}`).sort()).toEqual(
        [
          ...Array<string>(4).fill(`connect 127.0.0.1:${port + 7}`),
          `connect-custom-lookup allowedalias:${port}`,
          'dns.lookupService 127.0.0.1:22',
        ].sort(),
      );
      // The four blocked connections above came from the children: they were audited because the
      // audit put itself back into their environment.
      expect(report.reinjected).toBeGreaterThanOrEqual(4);
      // A non-Node child is recorded as not intercepted.
      expect(report.uncovered).toContain('sh -c exit');
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  it('is a no-op where ci.sh did not configure it', () => {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write("ran")'], {
      env: { PATH: process.env.PATH ?? '', NODE_OPTIONS: `--import=${HOOK}` },
      encoding: 'utf8',
    });
    expect(r.stdout).toBe('ran');
  });
});

describe('egress report (emulator/egress-report.mjs)', () => {
  const report = (lines: string[], extra: string[] = []) => {
    const log = path.join(work, `r-${Math.random().toString(16).slice(2)}.jsonl`);
    writeFileSync(log, lines.join('\n'));
    const out = `${log}.json`;
    const r = spawnSync(process.execPath, [REPORT, '--log', log, '--out', out, ...extra], {
      encoding: 'utf8',
    });
    return { status: r.status, json: existsSync(out) ? readFileSync(out, 'utf8') : '' };
  };
  const load = (proc: string) => JSON.stringify({ kind: 'load', proc, allowed: true });
  const conn = (target: string, allowed: boolean) =>
    JSON.stringify({ kind: 'connect', target, proc: 'cdk', allowed });

  it('passes only allowed traffic from audited processes', () => {
    expect(report([load('cdk'), conn('127.0.0.1:45660', true)], ['--require', 'cdk']).status).toBe(
      0,
    );
  });

  it('fails on a blocked connection, a malformed record, or a required process that was never audited', () => {
    expect(report([load('cdk'), conn('evil:443', false)]).status).toBe(1);
    expect(report([load('cdk'), '{not json']).status).toBe(1);
    const missing = report([conn('127.0.0.1:45660', true)], ['--require', 'cdk']);
    expect(missing.status).toBe(1);
    expect(missing.json).toMatch(/"not-audited"/);
  });

  it('fails closed without a log (exit 2: nothing proven)', () => {
    const r = spawnSync(
      process.execPath,
      [REPORT, '--log', path.join(work, 'absent.jsonl'), '--out', path.join(work, 'x.json')],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(2);
  });
});
