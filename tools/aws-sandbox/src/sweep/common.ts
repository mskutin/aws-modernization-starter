/**
 * Shared types and helpers of the read-only sweeps. A sweep lists one service, projects every
 * response to the few fields it needs (never keeping raw responses), decides ownership and records
 * a finding per experiment resource it sees, including the ones already gone (so that the tag
 * index can be cross-checked).
 */
import type { ReadOnlyAws } from '../aws/session.js';
import type { AwsErrorKind } from '../aws/executor.js';
import { normalizeArn, type Candidate, type MatchContext, type Ownership } from '../match.js';
import type { PriceBook } from '../model/prices.js';

export type Disposition = 'exists' | 'pending-deletion' | 'retained' | 'gone';

export interface RawFinding {
  readonly service: string;
  readonly resourceType: string;
  readonly id: string;
  readonly arn?: string | undefined;
  readonly name?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly state?: string | undefined;
  readonly disposition: Disposition;
  readonly deletionDate?: string | undefined;
  readonly note?: string | undefined;
  /** What it costs per hour while it stays (0 = usage-based or free). */
  readonly hourlyUsdIfLeft?: number | undefined;
  readonly residualLikelyUsd?: number | undefined;
  readonly residualWorstUsd?: number | undefined;
  readonly ownership: Ownership;
  /** Weak match that the baseline lists or that predates --since. */
  readonly notOwned: boolean;
}

export interface SweepError {
  readonly operation: string;
  readonly kind: AwsErrorKind;
  readonly code: string;
  readonly message: string;
}

/**
 * How far a category could be proven with the operator's role:
 *  - ok: exhaustive listing succeeded;
 *  - fallback: the exhaustive listing was denied; resources were found another way (tag index,
 *    inventory, aliases, deleted-stack resources) and read one by one — not exhaustive;
 *  - unverifiable-with-this-role: no read of the category is possible; only evidence is reported;
 *  - not-used-by-experiment: the experiment creates nothing of this kind (justification given);
 *  - error: a call failed without a fallback (the run is incomplete).
 */
export type CategoryStatus =
  'ok' | 'error' | 'fallback' | 'unverifiable-with-this-role' | 'not-used-by-experiment';

export interface SweepOutcome {
  readonly service: string;
  readonly operations: string[];
  readonly errors: SweepError[];
  readonly findings: RawFinding[];
  /** Set when the category is not simply ok / error. */
  status?: Exclude<CategoryStatus, 'ok' | 'error'>;
  /** Operations denied by the role and handled by a fallback (not errors). */
  readonly denied: string[];
  /** What the fallback found, in words (masked before writing). */
  readonly evidence: string[];
  justification?: string;
  /** Tag-index ARNs the category evidence already accounts for. */
  readonly accountedArns: string[];
}

/** What the run's own inventory recorded (masked ids, as committed). */
export interface InventoryEvidence {
  readonly file: string;
  readonly runId: string;
  readonly startedAt: string | null;
  readonly stacks: readonly { readonly name: string; readonly id: string | null }[];
  readonly kmsKeys: readonly {
    readonly stack: string;
    readonly logicalId: string;
    readonly keyId: string;
  }[];
  readonly secrets: readonly {
    readonly stack: string;
    readonly logicalId: string;
    readonly arn: string;
  }[];
  readonly logGroups: readonly {
    readonly stack: string;
    readonly logicalId: string;
    readonly name: string;
  }[];
  /** Every physical id of the run's stack resources (masked). */
  readonly physicalIds: readonly string[];
}

/** Final resource states of the run's deleted stacks (cloudformation list-stacks + list-stack-resources). */
export interface CfnEvidence {
  available: boolean;
  note: string;
  stacks: {
    name: string;
    status: string;
    deletedAt?: string | undefined;
  }[];
  resources: {
    stack: string;
    logicalId: string;
    type: string;
    physicalId?: string | undefined;
    status: string;
  }[];
}

export interface Judge {
  /** Ownership of a candidate, with the not-owned decision for weak matches. */
  judge(
    c: Candidate,
    meta: { id: string; createdAt?: string | undefined },
  ): { ownership: Ownership; notOwned: boolean } | undefined;
}

export interface SweepEnv {
  readonly aws: ReadOnlyAws;
  readonly runId: string;
  readonly region: string;
  readonly book: PriceBook;
  readonly now: Date;
  readonly match: MatchContext & { readonly experimentVpcIds: Set<string> };
  readonly judge: Judge['judge'];
  readonly inventory?: InventoryEvidence | undefined;
  cfn?: CfnEvidence | undefined;
}

export function outcome(service: string): SweepOutcome {
  return {
    service,
    operations: [],
    errors: [],
    findings: [],
    denied: [],
    evidence: [],
    accountedArns: [],
  };
}

/** One allowlisted call returning the raw result (the caller handles errors). */
export async function callRaw(
  env: SweepEnv,
  out: SweepOutcome,
  service: string,
  operation: string,
  args: readonly string[] = [],
) {
  const name = `${service} ${operation}`;
  if (!out.operations.includes(name)) out.operations.push(name);
  return env.aws.call(service, operation, args);
}

/** One allowlisted call; failures are recorded on the outcome and yield undefined. */
export async function call(
  env: SweepEnv,
  out: SweepOutcome,
  service: string,
  operation: string,
  args: readonly string[] = [],
  options: { notFoundIsEmpty?: boolean } = {},
): Promise<Record<string, unknown> | undefined> {
  const name = `${service} ${operation}`;
  if (!out.operations.includes(name)) out.operations.push(name);
  const r = await env.aws.call(service, operation, args);
  if (r.ok) return r.data;
  if (options.notFoundIsEmpty && r.error.kind === 'not-found') return {};
  out.errors.push({ operation: name, ...r.error });
  return undefined;
}

/** Records a finding when the candidate is the experiment's; returns the judgement. */
export function record(
  env: SweepEnv,
  out: SweepOutcome,
  c: Candidate,
  f: Omit<RawFinding, 'ownership' | 'notOwned' | 'arn'>,
): { ownership: Ownership; notOwned: boolean } | undefined {
  const j = env.judge(c, { id: f.id, createdAt: f.createdAt });
  if (!j) return undefined;
  out.findings.push({ ...f, arn: c.arn ? normalizeArn(c.arn) : undefined, ...j });
  return j;
}

// ── Projection helpers (responses are untrusted JSON) ────────────────────────────────────────

export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
export const items = (v: unknown, key: string): Record<string, unknown>[] =>
  arr(obj(v)[key]).map(obj);

/** ISO-8601 from an ISO string or an epoch number (seconds or milliseconds). */
export function iso(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  }
  return undefined;
}

/** `[{Key, Value}]` (or other key names) to a record. */
export function tagMap(v: unknown, k = 'Key', val = 'Value'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of arr(v).map(obj)) {
    const key = str(t[k]);
    const value = typeof t[val] === 'string' ? (t[val] as string) : undefined;
    if (key !== undefined && value !== undefined) out[key] = value;
  }
  return out;
}

export const addDays = (isoDate: string | undefined, days: number): string | undefined => {
  if (!isoDate) return undefined;
  const t = Date.parse(isoDate);
  return Number.isFinite(t) ? new Date(t + days * 86_400_000).toISOString() : undefined;
};

/** Splits a list into chunks of `size` (API batch limits). */
export function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
