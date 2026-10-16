/**
 * Audit trail of the `/v1` API (ADR 0005 item 4, ADR 0211): exactly ONE
 * structured event per `/v1` request, so 401/403/429/404/5xx outcomes are covered as well as
 * successes. It is written by the `onResponse` hook, or — when the client disconnects before
 * the response finished — with outcome `aborted` once the handler has settled.
 * Fastify reports such a disconnect through neither `onResponse` (no `finish`) nor
 * `onRequestAbort` (that one only fires while the body is still being received), so the
 * response's `close` event is watched instead (`openAudit`).
 *
 *   { "msg": "audit", "requestId": "...",
 *     "audit": { "event": "job.read", "outcome": "not_found", "status": 404,
 *                "principal": "3f2a…" (16 hex), "jobIds": ["…"], "requestId": "..." } }
 *
 * Events: `job.create`, `job.read`, `job.list`, `auth.denied` (401, 403, 429 and the 503 of an
 * IdP outage — `reason` carries the verifier/limiter reason code) and `request.unrouted` (an
 * authenticated request to an unknown /v1 route or method).
 *
 * Never logged: titles, document content, tokens, raw claims or the subject. The principal is
 * the pseudonym sha256(iss|sub)[0..16] — LINKABLE, not anonymous: anyone holding a candidate
 * subject can recompute it (low-entropy subjects such as e-mail addresses are dictionary-
 * reversible). Workflow transitions correlate to the user through jobId → owner in PostgreSQL.
 * Retention = the API log group's CloudWatch retention (observability.logRetentionDays).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export type AuditEvent =
  'job.create' | 'job.read' | 'job.list' | 'auth.denied' | 'request.unrouted';

export type AuditOutcome =
  | 'success'
  | 'replayed'
  | 'denied'
  | 'not_found'
  | 'invalid'
  | 'unavailable'
  | 'error'
  /** The client went away before the response finished; `status` is what the API decided. */
  | 'aborted';

/** Collected while a `/v1` request is handled; emitted once by `emitAudit`. */
export interface AuditContext {
  /** Set when authentication, rate limiting or scope checks rejected the request. */
  denied?: { reason: string };
  /** Job ids the request created, read or listed (UUIDs only, never caller-supplied junk). */
  jobIds?: string[];
  /** Number of jobs returned by a list. */
  count?: number;
  replayed?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** `/v1` audit context (null outside `/v1`). */
    audit: AuditContext | null;
  }
}

const JOBS_ROUTE = '/v1/jobs';
const JOB_ROUTE = '/v1/jobs/:jobId';

function classify(request: FastifyRequest, context: AuditContext): AuditEvent {
  if (context.denied) return 'auth.denied';
  const route = request.routeOptions.url;
  if (route === JOBS_ROUTE && request.method === 'POST') return 'job.create';
  if (route === JOB_ROUTE) return 'job.read';
  if (route === JOBS_ROUTE) return 'job.list';
  return 'request.unrouted';
}

function outcomeOf(status: number, context: AuditContext): AuditOutcome {
  if (context.denied) return status === 503 ? 'unavailable' : 'denied';
  if (status >= 500) return 'error';
  if (status === 404) return 'not_found';
  if (status >= 400) return 'invalid';
  return context.replayed ? 'replayed' : 'success';
}

/** Adds details to the audit event of this request (route handlers). */
export function recordAudit(request: FastifyRequest, detail: Omit<AuditContext, 'denied'>): void {
  if (request.audit) Object.assign(request.audit, detail);
}

/** Emission state of one request's audit event. */
interface Emission {
  /** The handler has settled and the reply is being sent (`onSend` ran). */
  replying: boolean;
  /** The response closed before it finished: the client disconnected. */
  aborted: boolean;
  emitted: boolean;
}
const emissions = new WeakMap<FastifyRequest, Emission>();

/**
 * Opens the audit context of a `/v1` request (first `onRequest` step) and watches for a client
 * disconnect: `close` without a preceding `finish`. The event is then emitted as soon as the
 * handler has settled — immediately if the reply is already being sent, else from `onSend`
 * (`auditReplySending`) — so it carries the job ids the request recorded.
 */
export function openAudit(request: FastifyRequest, reply: FastifyReply): AuditContext {
  const context: AuditContext = {};
  request.audit = context;
  const emission: Emission = { replying: false, aborted: false, emitted: false };
  emissions.set(request, emission);
  let finished = false;
  reply.raw.once('finish', () => {
    finished = true; // the response was handed over: `onResponse` emits
  });
  reply.raw.once('close', () => {
    if (finished) return;
    emission.aborted = true;
    if (emission.replying) emitAudit(request, reply);
  });
  return context;
}

/** `onSend` step: the handler has settled; emit now if the client is already gone. */
export function auditReplySending(request: FastifyRequest, reply: FastifyReply): void {
  const emission = emissions.get(request);
  if (!emission) return;
  emission.replying = true;
  if (emission.aborted) emitAudit(request, reply);
}

/** Writes the request's audit event; later calls for the same request are no-ops. */
export function emitAudit(request: FastifyRequest, reply: FastifyReply): void {
  const emission = emissions.get(request);
  if (emission?.emitted) return;
  if (emission) emission.emitted = true;
  const context = request.audit ?? {};
  const event = classify(request, context);
  request.log.info(
    {
      audit: {
        event,
        outcome: emission?.aborted ? 'aborted' : outcomeOf(reply.statusCode, context),
        status: reply.statusCode,
        ...(request.principal ? { principal: request.principal.id } : {}),
        ...(context.jobIds ? { jobIds: context.jobIds } : {}),
        ...(context.count !== undefined ? { count: context.count } : {}),
        ...(context.denied ? { reason: context.denied.reason } : {}),
        requestId: request.id,
      },
    },
    'audit',
  );
}
