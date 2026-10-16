/**
 * Runs the BUILT API (`apps/api/dist/server.js`) as a real child process — the same artifact the
 * container image runs — with an explicit environment (nothing inherited but PATH, so no AWS
 * profile or real credential can leak in). stdout/stderr go to a log file under the run's
 * evidence directory, which the leakage suite and the artifact scanner read afterwards.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { repoRoot } from './paths.js';

export interface StartedApi {
  name: string;
  url: string;
  logFile: string;
  stop(): Promise<void>;
}

/**
 * The API build under test: the repository's `apps/api`, or SECTEST_API_DIR (an `apps/api`
 * directory with `dist/` and `migrations/`) for mutation runs against a modified or older build.
 */
export function apiDist(file: 'server.js' | 'migrate.js'): string {
  const apiDir = process.env['SECTEST_API_DIR'] ?? join(repoRoot(), 'apps', 'api');
  const path = join(apiDir, 'dist', file);
  if (!existsSync(path)) {
    throw new Error(
      `${path} is missing: build the API first (pnpm --filter "@starter/tests-security..." build)`,
    );
  }
  return path;
}

/** Like `apiDist`, but `undefined` when the build does not ship the file. */
export function apiDistIfPresent(file: string): string | undefined {
  const apiDir = process.env['SECTEST_API_DIR'] ?? join(repoRoot(), 'apps', 'api');
  const path = join(apiDir, 'dist', file);
  return existsSync(path) ? path : undefined;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Runs a one-off node script (e.g. migrations) to completion; rejects on a non-zero exit. */
export function runNode(
  file: string,
  args: string[],
  env: Record<string, string>,
  logFile: string,
) {
  return new Promise<void>((resolve, reject) => {
    const log = createWriteStream(logFile, { flags: 'a' });
    const child = spawn(process.execPath, [file, ...args], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('error', reject);
    child.on('exit', (code) => {
      log.end();
      if (code === 0) resolve();
      else
        reject(new Error(`${file} ${args.join(' ')} exited with ${String(code)} (see ${logFile})`));
    });
  });
}

async function waitReady(url: string, child: ChildProcess, logFile: string): Promise<void> {
  const until = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`API exited with ${String(child.exitCode)} during start-up (see ${logFile})`);
    }
    try {
      const ready = `${url}/health/ready`;
      const res = await fetch(ready, { signal: AbortSignal.timeout(2_000) }); // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf -- test harness: polls the readiness URL of the API child process it started on 127.0.0.1
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > until) throw new Error(`API at ${url} not ready within 60 s (see ${logFile})`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export async function startApi(
  name: string,
  env: Record<string, string>,
  evidenceDir: string,
): Promise<StartedApi> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const logFile = join(evidenceDir, `api-${name}.log`);
  const log = createWriteStream(logFile, { flags: 'a' });
  const child = spawn(process.execPath, [apiDist('server.js')], {
    env: { PATH: process.env.PATH ?? '', ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    await waitReady(url, child, logFile);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  return {
    name,
    url,
    logFile,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
        await exited;
        clearTimeout(timer);
      }
      await new Promise<void>((resolve) => log.end(() => resolve()));
    },
  };
}

export interface ApiRunResult {
  /** Exit code, or null when the process was still running at the deadline (then killed). */
  code: number | null;
  /** stdout and stderr, interleaved as received. */
  output: string;
}

/**
 * Runs the built API with `env` (plus PATH and a free PORT) until it exits or `deadlineMs`
 * passes; a process still running at the deadline is killed and reported with `code: null`.
 * For start-up refusal checks: a refused configuration exits before it opens a port.
 */
export async function runApiToExit(
  env: Record<string, string>,
  deadlineMs = 20_000,
): Promise<ApiRunResult> {
  const port = await freePort();
  const child = spawn(process.execPath, [apiDist('server.js')], {
    env: { PATH: process.env.PATH ?? '', ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  return new Promise<ApiRunResult>((resolve, reject) => {
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, deadlineMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: killed ? null : code, output });
    });
  });
}
