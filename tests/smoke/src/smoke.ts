/**
 * Post-deploy / post-start smoke test for the Jobs API.
 *
 * Deliberately dependency-free (Node >= 24 global fetch + node:crypto) so it runs from a bare
 * `node` image against any BASE_URL: the API directly (:8080), the local nginx web tier (:4173,
 * exercising the /v1 + /health proxy routes) or a deployed CloudFront/ALB endpoint.
 *
 * Steps (fail fast, each bounded by a deadline — no fixed sleeps):
 *   1. GET /health/live  -> 200
 *   2. GET /health/ready -> 200 (polled until ready or deadline)
 *   3. GET /v1/jobs WITHOUT a token -> 401 with a Bearer challenge (authentication enforced)
 *   4. POST /v1/jobs (valid document) -> 202 + Location; poll -> SUCCEEDED; verify result shape
 *      and that result.checksumSha256 == sha256(content) computed locally
 *   5. POST /v1/jobs (schema-valid, business-invalid: too few words) -> 202; poll -> FAILED
 *      with error.name == JobValidationError
 *   6. POST /v1/jobs (schema-invalid) -> 400 application/problem+json
 *
 * Every /v1 call of steps 4-6 carries a bearer access token: SMOKE_ACCESS_TOKEN (e.g. from
 * the deploy pipeline's client of the organization IdP), else one minted by the TEST-ONLY IdP's
 * /test/token endpoint (SMOKE_TEST_IDP_URL / TEST_IDP_URL; default http://127.0.0.1:9400 for a
 * loopback BASE_URL). Tokens are never logged.
 */
import { createHash, randomUUID } from 'node:crypto';

export interface SmokeConfig {
  baseUrl: string;
  readyDeadlineMs: number;
  jobDeadlineMs: number;
  requestTimeoutMs: number;
  pollIntervalMs: number;
  /** Content that passes schema validation but violates a business rule (too few words). */
  businessInvalidContent: string;
  /** Bearer token for /v1 (takes precedence over `testIdpUrl`). */
  accessToken?: string | undefined;
  /** TEST-ONLY IdP whose POST /test/token mints a token for `subject` (local/CI). */
  testIdpUrl?: string | undefined;
  /** `sub` of the minted token (default smoke-<random>). */
  subject?: string | undefined;
  log?: (line: string) => void;
}

export interface StepResult {
  name: string;
  ok: boolean;
  durationMs: number;
  detail: string;
}

export interface SmokeResult {
  ok: boolean;
  steps: StepResult[];
}

export class SmokeFailure extends Error {
  override name = 'SmokeFailure';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[a-f0-9]{64}$/;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED']);

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new SmokeFailure(message);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface HttpResponse {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

async function http(
  cfg: SmokeConfig,
  method: 'GET' | 'POST',
  path: string,
  init: { json?: unknown; headers?: Record<string, string>; token?: string } = {},
): Promise<HttpResponse> {
  const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let body: string | undefined;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers['content-type'] = 'application/json';
  }
  const request: RequestInit = {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
  };
  let res: Response;
  try {
    res = await fetch(new URL(path, cfg.baseUrl), request); // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf -- post-deploy smoke CLI: the base URL is operator configuration (BASE_URL) and paths are test literals; it never runs inside a server
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    throw new SmokeFailure(`${method} ${path}: request failed (${reason})`);
  }
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  return { status: res.status, headers: res.headers, body: parsed, text };
}

const describeResponse = (r: HttpResponse) =>
  `HTTP ${r.status} ${r.headers.get('content-type') ?? ''} request-id=${
    r.headers.get('x-request-id') ?? '-'
  } body=${r.text.slice(0, 300)}`;

/** Poll `probe` until it returns a value or the deadline passes (bounded backoff). */
export async function pollUntil<T>(
  what: string,
  deadlineMs: number,
  intervalMs: number,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  let delay = intervalMs;
  let lastError: unknown;
  for (;;) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch (err) {
      if (!(err instanceof SmokeFailure)) throw err;
      lastError = err;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const suffix = lastError instanceof Error ? ` (last error: ${lastError.message})` : '';
      throw new SmokeFailure(`timed out after ${deadlineMs}ms waiting for ${what}${suffix}`);
    }
    await new Promise((r) => setTimeout(r, Math.min(delay, remaining)));
    delay = Math.min(delay * 2, 2_000);
  }
}

/** Resolves the bearer token for /v1 calls (never logged). */
export async function obtainToken(cfg: SmokeConfig): Promise<string> {
  if (cfg.accessToken) return cfg.accessToken;
  if (!cfg.testIdpUrl) {
    throw new SmokeFailure(
      'no access token: set SMOKE_ACCESS_TOKEN, or SMOKE_TEST_IDP_URL for a local/CI test IdP',
    );
  }
  let res: Response;
  try {
    res = await fetch(new URL('/test/token', cfg.testIdpUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: cfg.subject ?? `smoke-${randomUUID().slice(0, 8)}` }),
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    throw new SmokeFailure(`test IdP ${cfg.testIdpUrl}: request failed (${reason})`);
  }
  const body = (await res.json().catch(() => undefined)) as { access_token?: unknown } | undefined;
  if (res.status !== 200 || typeof body?.access_token !== 'string') {
    throw new SmokeFailure(`test IdP ${cfg.testIdpUrl}/test/token answered HTTP ${res.status}`);
  }
  return body.access_token;
}

async function submit(cfg: SmokeConfig, token: string, payload: unknown): Promise<string> {
  const r = await http(cfg, 'POST', '/v1/jobs', {
    json: payload,
    token,
    headers: { 'idempotency-key': `smoke-${randomUUID()}` },
  });
  assert(r.status === 202, `POST /v1/jobs: expected 202, got ${describeResponse(r)}`);
  assert(isRecord(r.body), 'POST /v1/jobs: body is not a JSON object');
  const jobId = r.body.jobId;
  assert(typeof jobId === 'string' && UUID_RE.test(jobId), `POST /v1/jobs: bad jobId ${jobId}`);
  const location = r.headers.get('location') ?? '';
  assert(location.endsWith(`/v1/jobs/${jobId}`), `POST /v1/jobs: bad Location "${location}"`);
  return jobId;
}

async function waitTerminal(
  cfg: SmokeConfig,
  token: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  const seen: string[] = [];
  return pollUntil(
    `job ${jobId} to reach a terminal status`,
    cfg.jobDeadlineMs,
    cfg.pollIntervalMs,
    async () => {
      const r = await http(cfg, 'GET', `/v1/jobs/${jobId}`, { token });
      assert(r.status === 200, `GET /v1/jobs/${jobId}: ${describeResponse(r)}`);
      assert(isRecord(r.body), `GET /v1/jobs/${jobId}: body is not an object`);
      const status = String(r.body.status);
      if (seen.at(-1) !== status) seen.push(status);
      cfg.log?.(`    job ${jobId.slice(0, 8)} status ${seen.join(' -> ')}`);
      return TERMINAL.has(status) ? r.body : undefined;
    },
  );
}

function verifyResult(job: Record<string, unknown>, content: string): string {
  assert(
    job.status === 'SUCCEEDED',
    `expected SUCCEEDED, got ${String(job.status)} error=${JSON.stringify(job.error)}`,
  );
  assert(job.error === null, `SUCCEEDED job has error ${JSON.stringify(job.error)}`);
  const result = job.result;
  assert(isRecord(result), 'SUCCEEDED job has no result object');
  for (const k of [
    'wordCount',
    'uniqueWordCount',
    'sentenceCount',
    'paragraphCount',
    'characterCount',
    'readingTimeSeconds',
  ]) {
    assert(
      Number.isInteger(result[k]) && Number(result[k]) >= 0,
      `result.${k} is not a non-negative integer`,
    );
  }
  assert(Number(result.wordCount) > 0, 'result.wordCount is 0 for a non-empty document');
  assert(typeof result.algorithmVersion === 'string', 'result.algorithmVersion missing');
  const ld = Number(result.lexicalDiversity);
  assert(ld >= 0 && ld <= 1, `result.lexicalDiversity out of range: ${ld}`);
  assert(Array.isArray(result.topTerms) && result.topTerms.length > 0, 'result.topTerms empty');
  for (const t of result.topTerms as unknown[]) {
    assert(isRecord(t) && typeof t.term === 'string' && Number(t.count) >= 1, 'bad topTerms entry');
  }
  const expected = createHash('sha256').update(content, 'utf8').digest('hex');
  assert(
    typeof result.checksumSha256 === 'string' && HEX64_RE.test(result.checksumSha256),
    'result.checksumSha256 malformed',
  );
  assert(
    result.checksumSha256 === expected,
    `result.checksumSha256 ${String(result.checksumSha256)} != sha256(content) ${expected}`,
  );
  return `wordCount=${String(result.wordCount)} topTerms=${(result.topTerms as unknown[]).length}`;
}

export async function runSmoke(cfg: SmokeConfig): Promise<SmokeResult> {
  const steps: StepResult[] = [];
  const log = cfg.log ?? (() => {});
  const nonce = randomUUID();
  const content =
    `Smoke test document ${nonce}. The quick brown fox jumps over the lazy dog. ` +
    'Modernization keeps services observable, secure and resilient. ' +
    'Every request is validated, persisted and processed by the workflow.\n\n' +
    'A second paragraph confirms paragraph counting works as expected.';

  let token = '';
  const step = async (name: string, fn: () => Promise<string>): Promise<boolean> => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, durationMs: Date.now() - t0, detail });
      log(`ok   - ${name} (${Date.now() - t0}ms) ${detail}`);
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      steps.push({ name, ok: false, durationMs: Date.now() - t0, detail });
      log(`FAIL - ${name} (${Date.now() - t0}ms) ${detail}`);
      return false;
    }
  };

  const all = [
    () =>
      step('liveness: GET /health/live -> 200', async () => {
        const r = await http(cfg, 'GET', '/health/live');
        assert(r.status === 200, describeResponse(r));
        return `status=${isRecord(r.body) ? String(r.body.status) : '?'}`;
      }),
    () =>
      step('readiness: GET /health/ready -> 200', async () => {
        const body = await pollUntil(
          'readiness 200',
          cfg.readyDeadlineMs,
          cfg.pollIntervalMs,
          async () => {
            const r = await http(cfg, 'GET', '/health/ready');
            return r.status === 200 ? r.body : undefined;
          },
        );
        return `checks=${JSON.stringify(isRecord(body) ? body.checks : undefined)}`;
      }),
    () =>
      step('authentication enforced: GET /v1/jobs without a token -> 401', async () => {
        const r = await http(cfg, 'GET', '/v1/jobs');
        assert(r.status === 401, `expected 401, got ${describeResponse(r)}`);
        const challenge = r.headers.get('www-authenticate') ?? '';
        assert(/^Bearer\b/i.test(challenge), `missing Bearer challenge, got "${challenge}"`);
        token = await obtainToken(cfg);
        return `challenge=${challenge}`;
      }),
    () =>
      step('valid job: POST /v1/jobs -> 202 -> SUCCEEDED with results', async () => {
        const jobId = await submit(cfg, token, {
          title: `smoke ${nonce}`,
          content,
          options: { topTerms: 5 },
        });
        const job = await waitTerminal(cfg, token, jobId);
        return `jobId=${jobId} ${verifyResult(job, content)}`;
      }),
    () =>
      step(
        'business-rule failure: POST /v1/jobs -> 202 -> FAILED (JobValidationError)',
        async () => {
          const jobId = await submit(cfg, token, {
            // the nonce in the title keeps the body unique (the API dedupes identical bodies)
            title: `smoke invalid ${nonce}`,
            content: cfg.businessInvalidContent,
          });
          const job = await waitTerminal(cfg, token, jobId);
          assert(job.status === 'FAILED', `expected FAILED, got ${String(job.status)}`);
          assert(job.result === null, 'FAILED job must not carry a result');
          assert(isRecord(job.error), 'FAILED job has no error object');
          assert(
            job.error.name === 'JobValidationError',
            `expected error.name JobValidationError, got ${String(job.error.name)}`,
          );
          assert(
            typeof job.error.message === 'string' && job.error.message.length > 0,
            'empty error.message',
          );
          return `jobId=${jobId} error="${job.error.message}"`;
        },
      ),
    () =>
      step('schema-invalid request: POST /v1/jobs -> 400 problem+json', async () => {
        const r = await http(cfg, 'POST', '/v1/jobs', { json: { title: '', content: 42 }, token });
        assert(r.status === 400, `expected 400, got ${describeResponse(r)}`);
        const ct = r.headers.get('content-type') ?? '';
        assert(ct.startsWith('application/problem+json'), `content-type "${ct}"`);
        assert(isRecord(r.body) && r.body.status === 400, 'problem.status != 400');
        assert(
          typeof r.body.type === 'string' && typeof r.body.title === 'string',
          'problem type/title missing',
        );
        return `type=${r.body.type}`;
      }),
  ];

  for (const run of all) {
    if (!(await run())) break; // fail fast: later steps depend on earlier ones
  }
  const ok = steps.length === all.length && steps.every((s) => s.ok);
  return { ok, steps };
}

export function configFromEnv(env: NodeJS.ProcessEnv): SmokeConfig {
  const num = (name: string, def: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
    return n;
  };
  const baseUrl = env.BASE_URL ?? env.API_BASE_URL ?? 'http://127.0.0.1:8080';
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new Error(`BASE_URL is not a valid URL: ${baseUrl}`);
  }
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  return {
    baseUrl,
    readyDeadlineMs: num('SMOKE_READY_DEADLINE_MS', 60_000),
    jobDeadlineMs: num('SMOKE_JOB_DEADLINE_MS', 60_000),
    requestTimeoutMs: num('SMOKE_REQUEST_TIMEOUT_MS', 10_000),
    pollIntervalMs: num('SMOKE_POLL_INTERVAL_MS', 250),
    businessInvalidContent: env.SMOKE_BUSINESS_INVALID_CONTENT ?? 'Too short.',
    accessToken: env.SMOKE_ACCESS_TOKEN || undefined,
    // A test IdP is only ever assumed for a loopback target (local compose, CI job container).
    testIdpUrl:
      env.SMOKE_TEST_IDP_URL ||
      env.TEST_IDP_URL ||
      (loopback ? 'http://127.0.0.1:9400' : undefined),
    subject: env.SMOKE_SUBJECT || undefined,
  };
}

const xmlEscape = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c,
  );

/** Minimal JUnit XML so CI can show smoke results next to the other suites. */
export function toJUnit(result: SmokeResult, suiteName = 'smoke', expectedSteps = 6): string {
  const failures = result.steps.filter((s) => !s.ok).length;
  const skipped = Math.max(0, expectedSteps - result.steps.length);
  const total = result.steps.length + skipped;
  const time = (result.steps.reduce((a, s) => a + s.durationMs, 0) / 1000).toFixed(3);
  const cases = result.steps
    .map((s) => {
      const head = `    <testcase classname="${suiteName}" name="${xmlEscape(s.name)}" time="${(s.durationMs / 1000).toFixed(3)}"`;
      return s.ok
        ? `${head} />`
        : `${head}>\n      <failure message="${xmlEscape(s.detail.slice(0, 500))}" />\n    </testcase>`;
    })
    .concat(
      Array.from(
        { length: skipped },
        (_, i) =>
          `    <testcase classname="${suiteName}" name="not run #${i + 1}"><skipped message="not run: an earlier smoke step failed" /></testcase>`,
      ),
    )
    .join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${suiteName}" tests="${total}" failures="${failures}" skipped="${skipped}" time="${time}">\n` +
    `  <testsuite name="${suiteName}" tests="${total}" failures="${failures}" skipped="${skipped}" time="${time}">\n${cases}\n  </testsuite>\n</testsuites>\n`
  );
}
