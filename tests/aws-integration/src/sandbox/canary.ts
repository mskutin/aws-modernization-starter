/**
 * Canary jobs for the live leak scans (test.sh): one valid document carrying canaries and one
 * business-invalid document (validator Lambda → JobValidationError → the workflow's failure
 * path), submitted through CloudFront with a token from the local test IdP.
 *
 * Canary design as in tests/security/src/canary.ts: every canary contains spaces or `~` (token
 * separators of the analyser) and is lower case, so it can never become a derived term; values are
 * unique per run. The positive control is the owner's own GET: it must show the title canary (the
 * scanner demonstrably finds a canary where it legitimately is) and none of the content canaries.
 * The output file holds canary values and job ids — never a token.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { FetchLike } from './http-checks.js';

export interface CanaryValues {
  title: string;
  sentence: string;
  token: string;
}

export interface CanaryRun {
  runId: string;
  submittedAt: string;
  canaryJobId: string;
  canaryStatus: string;
  failureJobId: string;
  failureStatus: string;
  failureErrorName: string | null;
  canaries: CanaryValues;
  /** Positive control: the owner's GET of the canary job. */
  ownerView: { titleFound: boolean; contentCanariesFound: number };
}

const hex = (n: number) => randomBytes(n).toString('hex');

export function canaryValues(runId: string): CanaryValues {
  const id = `${runId}~live~${hex(4)}`.toLowerCase();
  return {
    title: `sbx canary title ${id}`,
    sentence: `the silent beacon ${hex(3)}~${hex(3)} stays inside the database.`,
    token: `cnry~${hex(6)}~${hex(6)}`,
  };
}

export function canaryContent(c: CanaryValues): string {
  return [
    'Teams assess workloads and plan the migration waves carefully.',
    `${c.sentence} Reference ${c.token} is confidential.`,
    'Operations staff review dashboards before every weekly release.',
  ].join('\n\n');
}

export interface CanaryOptions {
  baseUrl: string;
  idpUrl: string;
  runId: string;
  fetchImpl?: FetchLike;
  jobDeadlineMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export async function submitCanaries(opts: CanaryOptions): Promise<CanaryRun> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const base = opts.baseUrl.replace(/\/+$/, '');
  const mint = await f(`${opts.idpUrl.replace(/\/+$/, '')}/test/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sub: `sbx-${opts.runId}-canary-${hex(3)}`,
      scope: 'jobs:read jobs:write',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const minted = (await mint.json().catch(() => undefined)) as
    { access_token?: unknown } | undefined;
  if (mint.status !== 200 || typeof minted?.access_token !== 'string') {
    throw new Error(`test IdP answered HTTP ${mint.status} to /test/token`);
  }
  const token = minted.access_token;
  const auth = { authorization: `Bearer ${token}` };

  const submit = async (title: string, content: string): Promise<string> => {
    const res = await f(`${base}/v1/jobs`, {
      method: 'POST',
      headers: {
        ...auth,
        'content-type': 'application/json',
        'idempotency-key': `sbx-${randomUUID()}`,
      },
      body: JSON.stringify({ title, content }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => undefined)) as { jobId?: unknown } | undefined;
    if (res.status !== 202 || typeof body?.jobId !== 'string') {
      throw new Error(`POST /v1/jobs answered HTTP ${res.status}`);
    }
    return body.jobId;
  };
  const get = async (jobId: string): Promise<{ status: number; text: string; body: unknown }> => {
    const res = await f(`${base}/v1/jobs/${jobId}`, {
      headers: auth,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, text, body };
  };
  const terminal = async (jobId: string): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + (opts.jobDeadlineMs ?? 120_000);
    for (;;) {
      const r = await get(jobId);
      if (
        r.status === 200 &&
        isRecord(r.body) &&
        (r.body.status === 'SUCCEEDED' || r.body.status === 'FAILED')
      ) {
        return r.body;
      }
      if (Date.now() > deadline) throw new Error(`job ${jobId} not terminal before the deadline`);
      await sleep(opts.pollIntervalMs ?? 1_000);
    }
  };

  const canaries = canaryValues(opts.runId);
  const submittedAt = new Date().toISOString();
  const canaryJobId = await submit(canaries.title, canaryContent(canaries));
  // Too few words: schema-valid, rejected by the validator Lambda (JobValidationError).
  const failureJobId = await submit(`sbx failure ${hex(4)}`, 'Too short.');
  const [canaryJob, failureJob] = [await terminal(canaryJobId), await terminal(failureJobId)];
  const own = await get(canaryJobId);
  const contentCanariesFound = [canaries.sentence, canaries.token].filter((c) =>
    own.text.includes(c),
  ).length;
  return {
    runId: opts.runId,
    submittedAt,
    canaryJobId,
    canaryStatus: String(canaryJob.status),
    failureJobId,
    failureStatus: String(failureJob.status),
    failureErrorName:
      isRecord(failureJob.error) && typeof failureJob.error.name === 'string'
        ? failureJob.error.name
        : null,
    canaries,
    ownerView: { titleFound: own.text.includes(canaries.title), contentCanariesFound },
  };
}
