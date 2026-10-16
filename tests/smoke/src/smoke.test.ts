/**
 * Self-tests for the smoke runner: an in-process fake API (node:http on an ephemeral port)
 * proves the runner PASSES against a correct API and FAILS (non-zero) for each regression class.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { runSmoke, toJUnit, configFromEnv, type SmokeConfig } from './smoke.js';

interface FakeBehaviour {
  readyStatus?: number;
  /** terminal status for "valid" jobs */
  validOutcome?: 'SUCCEEDED' | 'FAILED' | 'STUCK';
  corruptChecksum?: boolean;
  schemaInvalidStatus?: number;
  /** polls before a job becomes terminal */
  pollsToTerminal?: number;
  /** false = the fake answers /v1 without a token (an API that lost its authentication) */
  requireAuth?: boolean;
}

const GOOD_TOKEN = 'good-token';

interface FakeJob {
  jobId: string;
  content: string;
  polls: number;
  invalid: boolean;
}

function startFake(b: FakeBehaviour): Promise<{ server: Server; url: string }> {
  const jobs = new Map<string, FakeJob>();
  const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'x-request-id': randomUUID() });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = '';
      req.on('data', (c: Buffer) => (s += c.toString()));
      req.on('end', () => resolve(s));
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/test/token' && req.method === 'POST') {
      return send(res, 200, { access_token: GOOD_TOKEN, token_type: 'Bearer' });
    }
    if (
      url.pathname.startsWith('/v1/') &&
      (b.requireAuth ?? true) &&
      req.headers.authorization !== `Bearer ${GOOD_TOKEN}`
    ) {
      res.writeHead(401, {
        'content-type': 'application/problem+json',
        'www-authenticate': 'Bearer realm="starter-api"',
      });
      return res.end(
        JSON.stringify({
          type: 'urn:starter:problem:unauthorized',
          title: 'Unauthorized',
          status: 401,
        }),
      );
    }
    if (url.pathname === '/health/live') return send(res, 200, { status: 'ok', draining: false });
    if (url.pathname === '/health/ready') {
      const st = b.readyStatus ?? 200;
      return send(res, st, { status: st === 200 ? 'ok' : 'unavailable', draining: false });
    }
    if (url.pathname === '/v1/jobs' && req.method === 'POST') {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as { title?: unknown; content?: unknown };
      if (typeof body.title !== 'string' || body.title === '' || typeof body.content !== 'string') {
        const st = b.schemaInvalidStatus ?? 400;
        return send(
          res,
          st,
          { type: 'urn:starter:problem:validation-error', title: 'Invalid request', status: st },
          'application/problem+json',
        );
      }
      const jobId = randomUUID();
      jobs.set(jobId, {
        jobId,
        content: body.content,
        polls: 0,
        invalid: body.content.split(/\s+/).length < 5,
      });
      res.setHeader('location', `/v1/jobs/${jobId}`);
      return send(res, 202, { jobId, status: 'PENDING' });
    }
    const m = /^\/v1\/jobs\/([0-9a-f-]+)$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const job = jobs.get(m[1] ?? '');
      if (!job) return send(res, 404, { status: 404 }, 'application/problem+json');
      job.polls += 1;
      const done = job.polls >= (b.pollsToTerminal ?? 2);
      const outcome = job.invalid ? 'FAILED' : (b.validOutcome ?? 'SUCCEEDED');
      if (!done || outcome === 'STUCK')
        return send(res, 200, { jobId: job.jobId, status: 'PROCESSING' });
      if (outcome === 'FAILED') {
        return send(res, 200, {
          jobId: job.jobId,
          status: 'FAILED',
          result: null,
          error: { name: 'JobValidationError', message: 'content must contain at least 5 words' },
        });
      }
      const sha = createHash('sha256').update(job.content).digest('hex');
      return send(res, 200, {
        jobId: job.jobId,
        status: 'SUCCEEDED',
        error: null,
        result: {
          algorithmVersion: '1.0.0',
          wordCount: 30,
          uniqueWordCount: 25,
          sentenceCount: 5,
          paragraphCount: 2,
          characterCount: 200,
          averageWordLength: 5,
          averageSentenceLength: 6,
          lexicalDiversity: 0.8,
          readingTimeSeconds: 9,
          topTerms: [{ term: 'smoke', count: 2 }],
          checksumSha256: b.corruptChecksum ? 'f'.repeat(64) : sha,
        },
      });
    }
    send(res, 404, { status: 404 }, 'application/problem+json');
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    }),
  );
}

let current: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (current ? current.close(() => r()) : r()));
  current = undefined;
});

async function smokeAgainst(b: FakeBehaviour, overrides: Partial<SmokeConfig> = {}) {
  const { server, url } = await startFake(b);
  current = server;
  return runSmoke({
    baseUrl: url,
    readyDeadlineMs: 500,
    jobDeadlineMs: 500,
    requestTimeoutMs: 2_000,
    pollIntervalMs: 10,
    businessInvalidContent: 'Too short.',
    accessToken: GOOD_TOKEN,
    ...overrides,
  });
}

describe('smoke runner', () => {
  it('passes all six steps against a correct API', async () => {
    const lines: string[] = [];
    const r = await smokeAgainst({}, { log: (l) => lines.push(l) });
    expect(r.steps.map((s) => [s.name, s.ok, s.detail])).toHaveLength(6);
    expect(r.ok).toBe(true);
    expect(lines.join('\n')).not.toContain(GOOD_TOKEN);
  });

  it('fails when the API answers /v1 without a token (authentication lost)', async () => {
    const r = await smokeAgainst({ requireAuth: false });
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)?.name).toMatch(/authentication enforced/);
    expect(r.steps.at(-1)?.detail).toMatch(/expected 401/);
  });

  it('obtains a token from a test IdP when no token is configured', async () => {
    const { server, url } = await startFake({});
    current = server;
    const r = await runSmoke({
      baseUrl: url,
      readyDeadlineMs: 500,
      jobDeadlineMs: 500,
      requestTimeoutMs: 2_000,
      pollIntervalMs: 10,
      businessInvalidContent: 'Too short.',
      testIdpUrl: url,
    });
    expect(r.ok).toBe(true);
  });

  it('fails with a clear message when no token source is configured', async () => {
    const r = await smokeAgainst({}, { accessToken: undefined, testIdpUrl: undefined });
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)?.detail).toMatch(/SMOKE_ACCESS_TOKEN/);
  });

  it('fails (and stops) when readiness never becomes 200 within the deadline', async () => {
    const r = await smokeAgainst({ readyStatus: 503 });
    expect(r.ok).toBe(false);
    expect(r.steps).toHaveLength(2);
    expect(r.steps[1]?.detail).toMatch(/timed out after 500ms waiting for readiness/);
  });

  it('fails when a valid job ends FAILED', async () => {
    const r = await smokeAgainst({ validOutcome: 'FAILED' });
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)?.detail).toMatch(/expected SUCCEEDED, got FAILED/);
  });

  it('fails when a job never reaches a terminal status (deadline, not a hang)', async () => {
    const t0 = Date.now();
    const r = await smokeAgainst({ validOutcome: 'STUCK' });
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)?.detail).toMatch(/timed out after 500ms waiting for job/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('fails when the result checksum does not match the submitted content', async () => {
    const r = await smokeAgainst({ corruptChecksum: true });
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)?.detail).toMatch(/checksumSha256 .* != sha256\(content\)/);
  });

  it('fails when a schema-invalid request is not rejected with 400', async () => {
    const r = await smokeAgainst({ schemaInvalidStatus: 422 });
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)?.name).toMatch(/schema-invalid/);
  });

  it('fails fast with a clear message when the API is unreachable', async () => {
    const r = await runSmoke({
      baseUrl: 'http://127.0.0.1:9',
      readyDeadlineMs: 100,
      jobDeadlineMs: 100,
      requestTimeoutMs: 500,
      pollIntervalMs: 10,
      businessInvalidContent: 'x',
    });
    expect(r.ok).toBe(false);
    expect(r.steps[0]?.detail).toMatch(/request failed/);
  });
});

describe('toJUnit / configFromEnv', () => {
  it('reports failures and not-run steps as skipped', () => {
    const xml = toJUnit({
      ok: false,
      steps: [
        { name: 'a', ok: true, durationMs: 5, detail: '' },
        { name: 'b <x>', ok: false, durationMs: 7, detail: 'boom & bust' },
      ],
    });
    expect(xml).toContain('tests="6" failures="1" skipped="4"');
    expect(xml).toContain('name="b &lt;x&gt;"');
    expect(xml).toContain('message="boom &amp; bust"');
  });

  it('assumes a test IdP only for a loopback target', () => {
    expect(configFromEnv({}).testIdpUrl).toBe('http://127.0.0.1:9400');
    expect(configFromEnv({ BASE_URL: 'https://jobs.example.com' }).testIdpUrl).toBeUndefined();
    expect(
      configFromEnv({ BASE_URL: 'https://jobs.example.com', SMOKE_ACCESS_TOKEN: 't' }).accessToken,
    ).toBe('t');
    expect(configFromEnv({ TEST_IDP_URL: 'http://idp:9400' }).testIdpUrl).toBe('http://idp:9400');
  });

  it('validates configuration', () => {
    expect(configFromEnv({}).baseUrl).toBe('http://127.0.0.1:8080');
    expect(configFromEnv({ BASE_URL: 'http://web:4173' }).baseUrl).toBe('http://web:4173');
    expect(() => configFromEnv({ BASE_URL: 'not a url' })).toThrow(/BASE_URL/);
    expect(() => configFromEnv({ SMOKE_JOB_DEADLINE_MS: '-5' })).toThrow(/positive/);
  });
});
