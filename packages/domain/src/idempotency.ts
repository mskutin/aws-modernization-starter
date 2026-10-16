/**
 * Idempotency keys.
 *
 * - API level: the `Idempotency-Key` header, or — when absent — a key derived
 *   from the SHA-256 of the canonical (sorted-key) JSON of the *parsed*
 *   request, so identical submissions map to one job.
 * - Every API key is SCOPED TO THE AUTHENTICATED PRINCIPAL before it
 *   reaches DynamoDB or PostgreSQL (ADR 0211):
 *     header : `p:<sha256(iss|sub)>:h:<Idempotency-Key>`
 *     derived: `p:<sha256(iss|sub)>:derived:v1:<fingerprint>`
 *   The same header key or the same body from two principals therefore names two
 *   different jobs; a replay is only ever answered with the caller's own job.
 * - Step level: `step:<jobId>:<state>` guards duplicate Lambda deliveries.
 *
 * Scoped, derived and step keys contain ':' which the header pattern forbids,
 * so a client-chosen key can never collide with a server-generated one, and
 * legacy (unscoped) keys never equal a scoped key.
 */
import { CONTRACT_MAJOR, type CreateJobRequest } from '@starter/contracts';
import type { ProcessingStateName } from '@starter/workflow-processing';
import { sha256Hex } from './analysis.js';

/** How long API idempotency records live in DynamoDB (TTL). */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
export const DERIVED_KEY_PREFIX = `derived:v${CONTRACT_MAJOR}:`;
/** Prefix of every principal-scoped API idempotency key. */
export const PRINCIPAL_SCOPE_PREFIX = 'p:';
/** Marks a client-supplied (header) key inside a scoped key. */
export const HEADER_KEY_MARKER = 'h:';

const PRINCIPAL_KEY_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Stable, pseudonymous key of a principal: SHA-256 hex of `iss + "|" + sub`
 *. Its first 16 characters are the `principal` log field.
 */
export function principalKey(issuer: string, subject: string): string {
  if (!issuer || !subject) throw new TypeError('principalKey: issuer and subject are required');
  return sha256Hex(`${issuer}|${subject}`);
}

/** JSON with recursively sorted object keys and no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
}

/** Fingerprint of a parsed request; detects key reuse with a different body. */
export function requestFingerprint(request: CreateJobRequest): string {
  return sha256Hex(canonicalJson({ contractMajor: CONTRACT_MAJOR, request }));
}

export interface ResolvedIdempotencyKey {
  key: string;
  source: 'header' | 'derived';
  fingerprint: string;
}

/** The scope part shared by every key of one principal: `p:<principalKey>:`. */
export function principalScope(principal: string): string {
  if (!PRINCIPAL_KEY_PATTERN.test(principal)) {
    throw new TypeError('principal scope must be a principalKey() (64 lower-case hex characters)');
  }
  return `${PRINCIPAL_SCOPE_PREFIX}${principal}:`;
}

/**
 * Resolves the storage key for POST /v1/jobs. `principal` is `principalKey(iss, sub)` of the
 * authenticated caller and is required: an unscoped key would let callers collide.
 */
export function resolveIdempotencyKey(
  headerKey: string | undefined,
  request: CreateJobRequest,
  principal: string,
): ResolvedIdempotencyKey {
  const scope = principalScope(principal);
  const fingerprint = requestFingerprint(request);
  return headerKey
    ? { key: `${scope}${HEADER_KEY_MARKER}${headerKey}`, source: 'header', fingerprint }
    : { key: `${scope}${DERIVED_KEY_PREFIX}${fingerprint}`, source: 'derived', fingerprint };
}

export function stepIdempotencyKey(jobId: string, state: ProcessingStateName): string {
  return `step:${jobId}:${state}`;
}

/** Epoch seconds for the DynamoDB TTL attribute. */
export function expiresAtEpochSeconds(now: Date, ttlSeconds = IDEMPOTENCY_TTL_SECONDS): number {
  return Math.floor(now.getTime() / 1000) + ttlSeconds;
}
