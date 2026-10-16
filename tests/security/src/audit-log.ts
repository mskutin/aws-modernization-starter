/**
 * The API's audit trail, read from its JSON log lines: one line per `/v1`
 * request with `msg: "audit"` and an `audit` object (event, outcome, status, principal pseudonym,
 * job ids, count, reason, request id). The suites send their own X-Request-Id, so they find exactly
 * the events of their requests even while other suites use the same API process.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface AuditEvent {
  event: string;
  outcome: string;
  status: number;
  requestId: string;
  principal?: string;
  jobIds?: string[];
  count?: number;
  reason?: string;
}

export interface AuditLine {
  /** The raw log line (for leak checks on everything the event carries). */
  line: string;
  audit: AuditEvent;
}

/** The API's pseudonym of a principal: sha256(iss|sub), first 16 hex digits. */
export const PSEUDONYM = /^[0-9a-f]{16}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function asAuditEvent(value: unknown): AuditEvent | undefined {
  if (!isRecord(value)) return undefined;
  const { event, outcome, status, requestId } = value;
  if (typeof event !== 'string' || typeof outcome !== 'string') return undefined;
  if (typeof status !== 'number' || typeof requestId !== 'string') return undefined;
  return value as unknown as AuditEvent;
}

/** The audit lines for `requestId` in a JSON-lines log text; other lines are ignored. */
export function auditLinesIn(text: string, requestId: string): AuditLine[] {
  const out: AuditLine[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes(requestId)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed['msg'] !== 'audit') continue;
    const audit = asAuditEvent(parsed['audit']);
    if (audit?.requestId === requestId) out.push({ line, audit });
  }
  return out;
}

export const auditLines = (files: readonly string[], requestId: string): AuditLine[] =>
  files.flatMap((file) => auditLinesIn(readFileSync(file, 'utf8'), requestId));

/** A request id the API keeps as its own ([A-Za-z0-9._:-]{1,128}), unique per call. */
export const requestIdFor = (runId: string, label: string): string =>
  `sectest-${runId}-${label}-${randomUUID().slice(0, 8)}`;
