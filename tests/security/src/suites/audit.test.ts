/**
 * The API's audit trail, read from its own logs (self mode, or SECTEST_LOG_FILES).
 *
 *  - every /v1 request — created, replayed, read, listed, 400, 401, 403, 404 for a foreign job and
 *    for an unknown route — yields exactly ONE `audit` event, found by the X-Request-Id the suite
 *    sends, with the event, outcome and status of what the client saw;
 *  - events name a principal only by its 16-hex pseudonym (never the subject) and carry no token,
 *    title or content;
 *  - a client that goes away while the API is still handling its POST (the job row exists, the
 *    workflow start is held) still yields exactly ONE event, outcome `aborted`, naming the job.
 *    Control: the same held request with the client still connected yields `success`.
 *
 * "Exactly one" is decided with a sentinel: a request sent after every response arrived. One API
 * process logs in order, so once the sentinel's event is in the log a duplicate of an earlier event
 * would be there too — no fixed waits.
 */
import { once } from 'node:events';
import { connect } from 'node:net';
import { IDEMPOTENCY_KEY_HEADER } from '@starter/contracts';
import { NEGATIVE_TOKEN_CASES } from '@starter/testing/auth';
import { describe, expect, it } from 'vitest';
import { auditLines, PSEUDONYM, requestIdFor, type AuditLine } from '../audit-log.js';
import { context, type Target } from '../context.js';
import { call, describeRes, pollUntil, type CallOptions, type Res } from '../http.js';
import { findLeaks, type NamedValue } from '../leaks.js';
import { documentBody, expectAccepted, newKey, precondition } from '../support.js';
import { mintToken, principal } from '../tokens.js';

const ctx = context();
const SUITE = 'audit';
const REQUEST_ID = 'x-request-id';
const logsNote =
  ctx.logFiles.length > 0 ? '' : ' [skipped: no API log files; set SECTEST_LOG_FILES]';
const gatedNote = ctx.gated ? '' : ' [skipped: self-started harness only]';
const NO_LOGS = 'no API log files to read the audit trail from (SECTEST_LOG_FILES)';

type Who = 'owner' | 'other' | 'none';

interface Expected {
  event: string;
  outcome: string;
  status: number;
  who: Who;
  /** The job the event must name (`jobIds`), if any. */
  jobId?: string;
  /** auth.denied events carry the verifier/limiter reason; `true` = any non-empty reason. */
  reason?: string | true;
}

/** Waits for one event per id, then for a later sentinel's event (see the module comment). */
async function settledAudit(
  target: Target,
  token: string,
  requestIds: readonly string[],
): Promise<Map<string, AuditLine[]>> {
  for (const id of requestIds) {
    await pollUntil(`the audit event of ${id}`, async () =>
      auditLines(ctx.logFiles, id).length > 0 ? true : undefined,
    );
  }
  const sentinel = requestIdFor(ctx.runId, `${SUITE}-sentinel`);
  const r = await call(target, 'GET', '/v1/jobs?limit=1', {
    token,
    headers: { [REQUEST_ID]: sentinel },
  });
  expect(r.status, describeRes(r)).toBe(200);
  await pollUntil('the sentinel audit event', async () =>
    auditLines(ctx.logFiles, sentinel).length > 0 ? true : undefined,
  );
  return new Map(requestIds.map((id) => [id, auditLines(ctx.logFiles, id)]));
}

describe.each(ctx.targets)('audit trail — $name: $description', (target) => {
  it(`one event per /v1 request, whatever the outcome; pseudonymous, no document or token${logsNote}`, async (t) => {
    precondition(t, ctx, ctx.logFiles.length > 0, NO_LOGS);
    const subs = {
      owner: principal(ctx.runId, SUITE, `${target.name}-owner`),
      other: principal(ctx.runId, SUITE, `${target.name}-other`),
    };
    const [owner, other, readOnly, expired] = await Promise.all([
      mintToken(ctx.tokenEndpoint, { sub: subs.owner }),
      mintToken(ctx.tokenEndpoint, { sub: subs.other }),
      mintToken(ctx.tokenEndpoint, { sub: subs.owner, scope: 'jobs:read' }),
      mintToken(ctx.tokenEndpoint, { sub: subs.owner, options: NEGATIVE_TOKEN_CASES.expired }),
    ]);
    const title = `audit title ${ctx.runId} ${target.name}`;
    const body = documentBody(title, `audit ${target.name}`);
    const key = newKey('audit');
    const expected = new Map<string, Expected>();
    /** Sends one request with its own X-Request-Id and records what its audit event must say. */
    const send = async (
      label: string,
      want: Omit<Expected, 'status'>,
      status: number,
      method: string,
      path: string,
      opts: CallOptions = {},
    ): Promise<Res> => {
      const id = requestIdFor(ctx.runId, `${SUITE}-${label}`);
      const r = await call(target, method, path, {
        ...opts,
        headers: { ...opts.headers, [REQUEST_ID]: id },
      });
      expect(r.status, `${label}: ${describeRes(r)}`).toBe(status);
      expect(r.headers.get(REQUEST_ID), `${label}: the API keeps the caller's request id`).toBe(id);
      const jobId = want.jobId ?? (status === 202 ? expectAccepted(r).jobId : undefined);
      expected.set(id, { ...want, status, ...(jobId ? { jobId } : {}) });
      return r;
    };
    const idempotent = { [IDEMPOTENCY_KEY_HEADER]: key };

    const created = await send(
      'create',
      { event: 'job.create', outcome: 'success', who: 'owner' },
      202,
      'POST',
      '/v1/jobs',
      { token: owner, json: body, headers: idempotent },
    );
    const jobId = expectAccepted(created).jobId;
    const asOwner = { token: owner };
    await send(
      'replay',
      { event: 'job.create', outcome: 'replayed', who: 'owner', jobId },
      200,
      'POST',
      '/v1/jobs',
      { ...asOwner, json: body, headers: idempotent },
    );
    await send(
      'read',
      { event: 'job.read', outcome: 'success', who: 'owner', jobId },
      200,
      'GET',
      `/v1/jobs/${jobId}`,
      asOwner,
    );
    await send(
      'list',
      { event: 'job.list', outcome: 'success', who: 'owner', jobId },
      200,
      'GET',
      '/v1/jobs?limit=100',
      asOwner,
    );
    // Someone else asking for the job: audited with the job id they asked for.
    await send(
      'foreign',
      { event: 'job.read', outcome: 'not_found', who: 'other', jobId },
      404,
      'GET',
      `/v1/jobs/${jobId}`,
      { token: other },
    );
    await send(
      'invalid',
      { event: 'job.create', outcome: 'invalid', who: 'owner' },
      400,
      'POST',
      '/v1/jobs',
      { ...asOwner, json: { ...body, options: { topTerms: 9999 } } },
    );
    await send(
      'anonymous',
      { event: 'auth.denied', outcome: 'denied', who: 'none', reason: true },
      401,
      'GET',
      '/v1/jobs',
    );
    await send(
      'expired',
      { event: 'auth.denied', outcome: 'denied', who: 'none', reason: true },
      401,
      'GET',
      '/v1/jobs',
      { token: expired },
    );
    await send(
      'scope',
      { event: 'auth.denied', outcome: 'denied', who: 'owner', reason: 'insufficient_scope' },
      403,
      'POST',
      '/v1/jobs',
      { token: readOnly, json: documentBody(title, 'audit read-only') },
    );
    await send(
      'unrouted',
      { event: 'request.unrouted', outcome: 'not_found', who: 'owner' },
      404,
      'GET',
      '/v1/no-such-route',
      asOwner,
    );

    const events = await settledAudit(target, owner, [...expected.keys()]);
    const pseudonyms: Record<Exclude<Who, 'none'>, Set<string>> = {
      owner: new Set(),
      other: new Set(),
    };
    const canaries: NamedValue[] = [
      { label: 'owner-subject', value: subs.owner },
      { label: 'other-subject', value: subs.other },
      { label: 'title', value: title },
      ...body.content.split('\n\n').map((value, i) => ({ label: `content-${i}`, value })),
    ];
    const secrets: NamedValue[] = [owner, other, readOnly, expired].map((value, i) => ({
      label: `token-${i}`,
      value,
    }));
    for (const [id, want] of expected) {
      const lines = events.get(id) ?? [];
      expect(lines, `${id}: exactly one audit event`).toHaveLength(1);
      const [{ line, audit }] = lines as [AuditLine];
      expect(audit, id).toMatchObject({
        event: want.event,
        outcome: want.outcome,
        status: want.status,
      });
      if (want.jobId) expect(audit.jobIds, `${id}: names the job`).toContain(want.jobId);
      if (want.reason === true) expect(audit.reason, `${id}: reason`).toMatch(/\S/);
      else if (want.reason) expect(audit.reason, `${id}: reason`).toBe(want.reason);
      if (want.who === 'none') {
        expect(audit.principal, `${id}: no principal before authentication`).toBeUndefined();
      } else {
        expect(audit.principal, `${id}: pseudonymous principal`).toMatch(PSEUDONYM);
        pseudonyms[want.who].add(audit.principal ?? '');
      }
      expect(findLeaks(line, { canaries, secrets, patterns: false }), id).toEqual([]);
    }
    // One stable pseudonym per principal, different principals apart.
    expect(pseudonyms.owner.size).toBe(1);
    expect(pseudonyms.other.size).toBe(1);
    expect([...pseudonyms.owner][0]).not.toBe([...pseudonyms.other][0]);
  });
});

describe('audit trail — client disconnect', () => {
  /**
   * POST /v1/jobs on the gated API while its fake Step Functions holds StartExecution: resolves
   * once the API is waiting for the workflow start (the job row exists), with the held job id.
   */
  async function heldSubmission(controlUrl: string, submit: () => void): Promise<string> {
    submit();
    const held = await pollUntil(
      'the API to wait for StartExecution (job row written)',
      async () => {
        const calls = (await call(controlUrl, 'GET', '/__held')).json as { input: string }[];
        return calls.length > 0 ? calls : undefined;
      },
    );
    expect(held, 'exactly the one submission is held').toHaveLength(1);
    const input = JSON.parse(held[0]?.input ?? '{}') as { jobId?: unknown };
    expect(typeof input.jobId).toBe('string');
    return String(input.jobId);
  }

  it(`a client that leaves before the response → ONE event, outcome aborted, naming the job${gatedNote}`, async (t) => {
    precondition(
      t,
      ctx,
      ctx.gated !== undefined,
      'needs the self-started harness (an API whose workflow start can be held)',
    );
    precondition(t, ctx, ctx.logFiles.length > 0, NO_LOGS);
    const gated = ctx.gated;
    const token = await mintToken(ctx.tokenEndpoint, {
      sub: principal(ctx.runId, SUITE, 'leaver'),
    });
    const id = requestIdFor(ctx.runId, `${SUITE}-aborted`);
    const { hostname, port } = new URL(gated.target.baseUrl);
    const payload = JSON.stringify(documentBody(`audit aborted ${ctx.runId}`, 'aborted'));
    const socket = connect({ host: hostname, port: Number(port), allowHalfOpen: true });
    const received: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    await once(socket, 'connect', { signal: AbortSignal.timeout(10_000) });

    expect((await call(gated.controlUrl, 'POST', '/__hold')).status).toBe(200);
    let jobId: string;
    try {
      jobId = await heldSubmission(gated.controlUrl, () =>
        socket.write(
          [
            'POST /v1/jobs HTTP/1.1',
            `Host: ${hostname}:${port}`,
            `Authorization: Bearer ${token}`,
            'Content-Type: application/json',
            `Content-Length: ${Buffer.byteLength(payload)}`,
            `${IDEMPOTENCY_KEY_HEADER}: ${newKey('audit-aborted')}`,
            `${REQUEST_ID}: ${id}`,
            '',
            payload,
          ].join('\r\n'),
        ),
      );
      // The client goes away (FIN). The API answers the half-close by closing its side; once that
      // FIN arrives the API has seen the disconnect, while its handler is still held.
      const serverClosed = once(socket, 'end', { signal: AbortSignal.timeout(10_000) });
      socket.end();
      await serverClosed;
      expect(Buffer.concat(received).length, 'no response before the disconnect').toBe(0);
    } finally {
      expect((await call(gated.controlUrl, 'POST', '/__release')).status).toBe(200);
      socket.destroy();
    }

    const events = await settledAudit(gated.target, token, [id]);
    const lines = events.get(id) ?? [];
    expect(lines, 'exactly one audit event').toHaveLength(1);
    expect(lines[0]?.audit).toMatchObject({
      event: 'job.create',
      outcome: 'aborted',
      status: 202,
      jobIds: [jobId],
      principal: expect.stringMatching(PSEUDONYM),
    });
  });

  it(`control: the same held request with the client still connected → 202, ONE success event${gatedNote}`, async (t) => {
    precondition(
      t,
      ctx,
      ctx.gated !== undefined,
      'needs the self-started harness (an API whose workflow start can be held)',
    );
    precondition(t, ctx, ctx.logFiles.length > 0, NO_LOGS);
    const gated = ctx.gated;
    const token = await mintToken(ctx.tokenEndpoint, {
      sub: principal(ctx.runId, SUITE, 'stayer'),
    });
    const id = requestIdFor(ctx.runId, `${SUITE}-held-success`);
    expect((await call(gated.controlUrl, 'POST', '/__hold')).status).toBe(200);
    let response: Promise<Res> | undefined;
    let jobId: string;
    try {
      jobId = await heldSubmission(gated.controlUrl, () => {
        response = call(gated.target, 'POST', '/v1/jobs', {
          token,
          json: documentBody(`audit held ${ctx.runId}`, 'held'),
          headers: { [IDEMPOTENCY_KEY_HEADER]: newKey('audit-held'), [REQUEST_ID]: id },
        });
      });
    } finally {
      expect((await call(gated.controlUrl, 'POST', '/__release')).status).toBe(200);
    }
    const r = await (response ?? Promise.reject(new Error('the request was not sent')));
    expect(expectAccepted(r).jobId).toBe(jobId);
    expect(r.status, describeRes(r)).toBe(202);

    const lines = (await settledAudit(gated.target, token, [id])).get(id) ?? [];
    expect(lines, 'exactly one audit event').toHaveLength(1);
    expect(lines[0]?.audit).toMatchObject({
      event: 'job.create',
      outcome: 'success',
      status: 202,
      jobIds: [jobId],
    });
  });
});
