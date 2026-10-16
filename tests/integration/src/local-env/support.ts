/**
 * Hermetic harness for the local-environment shell scripts (scripts/podman, scripts/git-hooks,
 * local/compose/bin). Each test runs a script with a PATH that holds ONLY:
 *   - stub tools written by the test (podman, systemctl, ssh, uname, id, ...), and
 *   - a "toolbox" of symlinks to the few real system tools the scripts need (bash, curl, sed, ...).
 * No real podman, systemctl, ssh or sudo can ever be reached, whatever the developer machine has
 * installed, and nothing talks to the network: the "Podman API" is a tiny Node HTTP server on a
 * unix socket in the test's temp dir.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** Absolute path of a real system tool, or undefined. Looks in the system dirs, then PATH. */
export function findTool(name: string): string | undefined {
  const dirs = [...SYSTEM_DIRS, ...(process.env.PATH ?? '').split(path.delimiter)];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Real tools the scripts under test use (besides the stubbed ones). */
const TOOLBOX = [
  'bash',
  'sh',
  'env',
  'cat',
  'chmod',
  'cp',
  'cut',
  'date',
  'dirname',
  'grep',
  'install',
  'mkdir',
  'mktemp',
  'mv',
  'nohup',
  'pgrep',
  'ps',
  'rm',
  'sed',
  'sleep',
  'tail',
  'tr',
] as const;

/** Optional real tools: tests that need them skip with an explicit reason when absent. */
export const CURL = findTool('curl');
export const OPENSSL = findTool('openssl');
export const GIT = findTool('git');

export interface Sandbox {
  dir: string;
  /** Stub tools; first on PATH. */
  stubs: string;
  /** Symlinks to real system tools; second (and last) on PATH. */
  toolbox: string;
  /** Every stub call is appended here as "<tool> <args>". */
  calls: string;
  /** PIDs of background fake API servers (killed by cleanup()). */
  pids: string;
  /** Node script that serves a fake Podman libpod info endpoint on a unix socket. */
  fakeApi: string;
  path: string;
  readCalls(): string;
  cleanup(): void;
}

/**
 * A temp dir with a short path: unix socket paths are limited to ~104 bytes (macOS), and the
 * default macOS tmpdir is long.
 */
function shortTempDir(prefix: string): string {
  const base = tmpdir().length <= 50 ? tmpdir() : '/tmp';
  return mkdtempSync(path.join(base, prefix));
}

const FAKE_API = `
import { appendFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
const url = process.argv.slice(2).find((a) => a.startsWith('unix://'));
if (!url) { console.error('fake-api: no unix:// argument'); process.exit(2); }
const sock = url.slice('unix://'.length);
const rootless = process.env.FAKE_ROOTLESS !== 'false';
rmSync(sock, { force: true });
const server = createServer((req, res) => {
  if ((req.url ?? '').startsWith('/v4.0.0/libpod/info')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ host: { security: { rootless } } }));
  } else {
    res.statusCode = 404;
    res.end();
  }
});
server.listen(sock, () => {
  if (process.env.FAKE_PIDS) appendFileSync(process.env.FAKE_PIDS, process.pid + '\\n');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

export function createSandbox(prefix = 'starter-le-'): Sandbox {
  const dir = shortTempDir(prefix);
  const stubs = path.join(dir, 'stubs');
  const toolbox = path.join(dir, 'toolbox');
  mkdirSync(stubs);
  mkdirSync(toolbox);
  for (const name of TOOLBOX) {
    const real = findTool(name);
    if (!real) throw new Error(`system tool '${name}' not found; the local-env tests need it`);
    symlinkSync(real, path.join(toolbox, name));
  }
  for (const [name, real] of [
    ['node', process.execPath],
    ['curl', CURL],
    ['openssl', OPENSSL],
    ['git', GIT],
  ] as const) {
    if (real) symlinkSync(real, path.join(toolbox, name));
  }
  const fakeApi = path.join(dir, 'fake-api.mjs');
  writeFileSync(fakeApi, FAKE_API);
  const calls = path.join(dir, 'calls.log');
  const pids = path.join(dir, 'pids.log');
  return {
    dir,
    stubs,
    toolbox,
    calls,
    pids,
    fakeApi,
    path: `${stubs}:${toolbox}`,
    readCalls: () => (existsSync(calls) ? readFileSync(calls, 'utf8') : ''),
    cleanup: () => {
      killRecorded(pids);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** SIGTERM every PID listed in `file` (one per line); missing or dead processes are ignored. */
export function killRecorded(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const pid = Number(line.trim());
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

/** Writes an executable /bin/sh stub that records its call, then runs `body`. */
export function stub(sb: Sandbox, name: string, body: string): void {
  const file = path.join(sb.stubs, name);
  writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "$CALLS"\n${body}\n`);
  chmodSync(file, 0o755);
}

export type RunResult = SpawnSyncReturns<string>;

export function run(
  sb: Sandbox,
  command: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
  opts: { cwd?: string; timeoutMs?: number } = {},
): RunResult {
  const fullEnv: Record<string, string> = {
    PATH: sb.path,
    HOME: sb.dir,
    CALLS: sb.calls,
    FAKE_API: sb.fakeApi,
    FAKE_PIDS: sb.pids,
    LC_ALL: 'C',
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete fullEnv[k];
    else fullEnv[k] = v;
  }
  const r = spawnSync(command, args, {
    cwd: opts.cwd ?? sb.dir,
    env: fullEnv,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 30_000,
  });
  if (r.error) throw r.error;
  return r;
}

/** Starts a fake Podman API on `sock` in the background and returns once it answers. */
export function startFakeApi(sb: Sandbox, sock: string, rootless: boolean): void {
  const r = run(
    sb,
    'sh',
    [
      '-c',
      // Background server; then poll (bounded) until the socket exists.
      `nohup node "$FAKE_API" "unix://$1" >/dev/null 2>&1 &
       i=0; while [ ! -S "$1" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; [ -S "$1" ]`,
      'sh',
      sock,
    ],
    { FAKE_ROOTLESS: String(rootless) },
  );
  if (r.status !== 0) throw new Error(`fake API did not start on ${sock}: ${r.stderr}`);
}
