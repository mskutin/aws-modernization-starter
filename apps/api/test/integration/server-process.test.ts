/**
 * Runs the built server (dist/server.js) as a real process: startup wiring,
 * authentication against a JWKS served over HTTP (TEST-ONLY issuer), a full job
 * through the local simulator, the container healthcheck script, SIGTERM graceful
 * shutdown and fail-fast configuration errors.
 * Requires `pnpm --filter @starter/api build` first.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aCreateJobRequestInput,
  bearer,
  startTestIssuer,
  type StartedTestIssuer,
} from '@starter/testing';
import { IT_AUDIENCE, jobStateTable, migratedDatabase, processorPool } from './helpers.js';

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
const SERVER = `${DIST}server.js`;
const HEALTHCHECK = `${DIST}healthcheck.js`;

async function freePort(): Promise<number> {
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

function run(
  file: string,
  env: Record<string, string>,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condition not met in time');
}

/** AUTH_* for a CI-runtime process (the caller sets APP_RUNTIME=ci) trusting the http test issuer. */
const authEnv = (issuer: StartedTestIssuer) => ({
  AUTH_ISSUER: issuer.issuer,
  AUTH_AUDIENCE: IT_AUDIENCE,
  AUTH_ALLOW_INSECURE_ISSUER: 'true',
});

describe('dist/server.js process', () => {
  let db: Awaited<ReturnType<typeof migratedDatabase>>;
  let table: Awaited<ReturnType<typeof jobStateTable>>;
  let issuer: StartedTestIssuer;
  let processor: Awaited<ReturnType<typeof processorPool>>;
  let child: ChildProcess;
  let port: number;
  let token: string;
  const logs: Record<string, unknown>[] = [];

  beforeAll(async () => {
    if (!existsSync(SERVER)) throw new Error('dist/server.js missing — run the build first');
    [db, table, issuer] = await Promise.all([
      migratedDatabase(),
      jobStateTable(),
      startTestIssuer({ audience: IT_AUDIENCE }),
    ]);
    token = await issuer.mint({ sub: 'process-user' });
    processor = await processorPool(db);
    port = await freePort();
    child = spawn(process.execPath, [SERVER], {
      env: {
        PATH: process.env.PATH ?? '',
        PORT: String(port),
        NODE_ENV: 'test',
        // CI/local runtime: password auth and plain TCP to the test PostgreSQL are allowed.
        APP_RUNTIME: 'ci',
        LOG_LEVEL: 'info',
        DB_HOST: db.endpoint.host,
        DB_PORT: String(db.endpoint.port),
        DB_NAME: db.endpoint.database,
        DB_USER: db.endpoint.user,
        DB_PASSWORD: db.endpoint.password,
        DB_SSL: 'disable',
        JOBS_TABLE_NAME: table.tableName,
        DYNAMODB_ENDPOINT: table.endpoint,
        AWS_REGION: 'ap-southeast-1',
        WORKFLOW_MODE: 'local',
        // Workflow: the simulator loads documents as the processor identity (starter_processor).
        PROCESSOR_DB_USER: processor.user,
        PROCESSOR_DB_PASSWORD: processor.password,
        SHUTDOWN_TIMEOUT_MS: '5000',
        ...authEnv(issuer),
      },
    });
    let buffer = '';
    child.stdout?.on('data', (d: Buffer) => {
      buffer += d.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts.filter(Boolean))
        logs.push(JSON.parse(line) as Record<string, unknown>);
    });
    await waitFor(
      async () => (await fetch(`http://127.0.0.1:${port}/health/ready`)).status === 200,
      20_000,
    );
  });

  afterAll(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await processor?.drop();
    await Promise.all([db?.drop(), table?.drop(), issuer?.close()]);
  });

  it('rejects anonymous and forged requests (401) and loads the issuer keys over HTTP', async () => {
    const anonymous = await fetch(`http://127.0.0.1:${port}/v1/jobs`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe('Bearer realm="starter-api"');
    const forged = await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
      headers: { authorization: bearer(await issuer.mintWith({ hs256WithPublicKey: true })) },
    });
    expect(forged.status).toBe(401);
    expect(issuer.stats.jwksRequests).toBeGreaterThanOrEqual(1);
  });

  it('serves a full job through the local simulator', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: bearer(token) },
      body: JSON.stringify(aCreateJobRequestInput()),
    });
    expect(response.status).toBe(202);
    const { jobId } = (await response.json()) as { jobId: string };
    let status = '';
    await waitFor(async () => {
      const job = (await (
        await fetch(`http://127.0.0.1:${port}/v1/jobs/${jobId}`, {
          headers: { authorization: bearer(token) },
        })
      ).json()) as {
        status: string;
      };
      status = job.status;
      return status === 'SUCCEEDED' || status === 'FAILED';
    }, 15_000);
    expect(status).toBe('SUCCEEDED');
    expect(
      logs.some((l) => String(l.msg).includes('LOCAL SIMULATION — not AWS Step Functions')),
    ).toBe(true);
    // Structured logs carry service/version/env and never the document content.
    expect(logs[0]).toMatchObject({ service: 'api', env: 'test', version: 'unknown' });
    expect(JSON.stringify(logs)).not.toContain('Cloud migration is a journey');
    expect(JSON.stringify(logs)).not.toContain(db.endpoint.password);
    // Tokens and raw subjects never reach the logs; the pseudonymous principal does.
    expect(JSON.stringify(logs)).not.toContain(token);
    expect(JSON.stringify(logs)).not.toContain('process-user');
    expect(logs.find((l) => l.msg === 'job accepted; workflow started')?.principal).toMatch(
      /^[a-f0-9]{16}$/,
    );
    expect(logs.find((l) => l.msg === 'issuer signing keys loaded')).toBeDefined();
    expect(JSON.stringify(logs)).not.toContain(processor.password);
  });

  it('passes the container healthcheck script while running', async () => {
    expect((await run(HEALTHCHECK, { PORT: String(port) })).code).toBe(0);
  });

  it('shuts down gracefully on SIGTERM within SHUTDOWN_TIMEOUT_MS', async () => {
    const exited = new Promise<number | null>((resolve) =>
      child.once('exit', (code) => resolve(code)),
    );
    const started = Date.now();
    child.kill('SIGTERM');
    const code = await exited;
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    const messages = logs.map((l) => l.msg);
    expect(messages).toContain('shutdown: draining (readiness 503)');
    expect(messages).toContain('shutdown complete');
    expect((await run(HEALTHCHECK, { PORT: String(port) })).code).toBe(1);
  });

  it('fails fast with a clear message on invalid configuration', async () => {
    const result = await run(SERVER, { PORT: String(port), WORKFLOW_MODE: 'stepfunctions' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid API configuration');
    expect(result.stderr).toContain('DB_HOST: is required');
    expect(result.stderr).toContain('AUTH_ISSUER: is required');
    expect(result.stderr).toContain('AUTH_AUDIENCE: is required');
    expect(result.stderr).not.toContain('undefined');
  });

  it('refuses the local insecure-issuer switch on AWS (APP_RUNTIME=aws, also when unset)', async () => {
    for (const runtime of ['aws', undefined]) {
      const result = await run(SERVER, {
        PORT: String(port),
        // NODE_ENV does not matter: local compose and CI run NODE_ENV=production too.
        NODE_ENV: 'development',
        ...(runtime ? { APP_RUNTIME: runtime } : {}),
        DB_HOST: '127.0.0.1',
        DB_NAME: 'unused',
        DB_USER: 'unused',
        DB_PASSWORD: 'unused',
        JOBS_TABLE_NAME: 'unused-table',
        AWS_REGION: 'ap-southeast-1',
        WORKFLOW_MODE: 'local',
        AUTH_ISSUER: 'http://127.0.0.1:9',
        AUTH_AUDIENCE: IT_AUDIENCE,
        AUTH_ALLOW_INSECURE_ISSUER: 'true',
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'AUTH_ALLOW_INSECURE_ISSUER: is only allowed when APP_RUNTIME is local or ci',
      );
      expect(result.stderr).toContain('AUTH_ISSUER: must be an https URL');
    }
  });

  // Probe: an upper-case scheme, runtime unset, no insecure switch at all.
  it('refuses an HTTP:// issuer on AWS, so no discovery is ever fetched over http', async () => {
    const result = await run(SERVER, {
      PORT: String(port),
      DB_HOST: '127.0.0.1',
      DB_NAME: 'unused',
      DB_USER: 'unused',
      DB_PASSWORD: 'unused',
      JOBS_TABLE_NAME: 'unused-table',
      AWS_REGION: 'ap-southeast-1',
      WORKFLOW_MODE: 'local',
      AUTH_ISSUER: 'HTTP://127.0.0.1:9',
      AUTH_AUDIENCE: IT_AUDIENCE,
      AUTH_ALLOWED_CLIENT_IDS: 'starter-web',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('AUTH_ISSUER: must be an https URL');
  });
});

describe('dist/server.js stop during start-up', () => {
  it('exits 0 promptly on SIGTERM while still starting (dependencies unreachable)', async () => {
    // Nothing listens on these ports: the local-table bootstrap keeps retrying (~15 s),
    // which is exactly the window in which a container stop used to be ignored (PID 1).
    const [apiPort, deadPort] = await Promise.all([freePort(), freePort()]);
    const child = spawn(process.execPath, [SERVER], {
      env: {
        PATH: process.env.PATH ?? '',
        PORT: String(apiPort),
        NODE_ENV: 'test',
        APP_RUNTIME: 'ci',
        LOG_LEVEL: 'info',
        DB_HOST: '127.0.0.1',
        DB_PORT: String(deadPort),
        DB_NAME: 'unused',
        DB_USER: 'unused',
        DB_PASSWORD: 'unused',
        DB_SSL: 'disable',
        JOBS_TABLE_NAME: 'unused',
        DYNAMODB_ENDPOINT: `http://127.0.0.1:${deadPort}`,
        AWS_REGION: 'ap-southeast-1',
        AWS_ACCESS_KEY_ID: 'local',
        AWS_SECRET_ACCESS_KEY: 'local',
        WORKFLOW_MODE: 'local',
        PROCESSOR_DB_PASSWORD: 'unused',
        SHUTDOWN_TIMEOUT_MS: '5000',
        // Unreachable issuer: the API must still start (keys are fetched lazily, never awaited).
        AUTH_ISSUER: `http://127.0.0.1:${deadPort}`,
        AUTH_AUDIENCE: IT_AUDIENCE,
        AUTH_ALLOW_INSECURE_ISSUER: 'true',
      },
    });
    const messages: string[] = [];
    let buffer = '';
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts.filter(Boolean)) {
        messages.push(String((JSON.parse(line) as { msg?: unknown }).msg));
      }
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    try {
      // 'starting API' is logged after the handlers are installed and before the first await.
      await waitFor(async () => messages.includes('starting API'), 10_000);
      const started = Date.now();
      child.kill('SIGTERM');
      const result = await exited;
      expect(result).toEqual({ code: 0, signal: null });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(messages).toContain('shutdown requested during start-up; aborting start-up');
      expect(messages).toContain('start-up aborted; exiting');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
