/**
 * Classification of IAM policy documents read for the caller's own role (inline policies via
 * iam:GetRolePolicy, customer managed policies via iam:GetPolicyVersion). The document itself
 * never leaves the private raw directory: only derived facts (classification, statement counts,
 * the names of non-allowlisted actions, SHA-256 of the canonical document) reach the evidence.
 *
 * Rules (Deny statements only restrict and are ignored; conditions only restrict and are ignored):
 * - admin-equivalent: an Allow of every action (`*`), or of every IAM or Organizations action
 *   (`iam:*`, `organizations:*`, also as globs such as `*:*` or `i*:*`), on every resource
 *   (`Resource: "*"`, an ARN whose resource part is only wildcards, or any `NotResource`); or an
 *   Allow with `NotAction` on every resource that does not exclude both `iam:*` and
 *   `organizations:*`;
 * - write-capable: any other Allow that is not a read (a `NotAction` Allow, or an action whose name
 *   is not Get/List/Describe/View, wildcards included). Privilege-escalation paths other than the
 *   admin-equivalent patterns (for example `iam:PutRolePolicy` on some roles) are write-capable,
 *   not a hard stop;
 * - read-only-data-capable: every Allow action is a read, but some are not literal actions of the
 *   tool's allowlist (for example `s3:GetObject`, `ec2:Describe*`), or a statement uses
 *   `NotResource`;
 * - allowlisted-only: every Allow action is a literal action of the tool's allowlist, on
 *   `Resource` (no `NotAction`, no `NotResource`, no wildcard action).
 */
import { createHash } from 'node:crypto';
import { isRecord } from './types.ts';

export type DocClass =
  | 'allowlisted-only'
  | 'read-only-data-capable'
  | 'write-capable'
  | 'admin-equivalent'
  | 'unparseable';

export interface DocFacts {
  readonly classification: DocClass;
  readonly sha256: string | null;
  readonly allowStatements: number;
  readonly denyStatements: number;
  /** Allow actions outside the tool's allowlist (AWS action names only; at most 50). */
  readonly nonAllowlistedActions: readonly string[];
}

const SEVERITY: Record<DocClass, number> = {
  'allowlisted-only': 0,
  'read-only-data-capable': 1,
  unparseable: 2,
  'write-capable': 3,
  'admin-equivalent': 4,
};

export const worseClass = (a: DocClass, b: DocClass): DocClass =>
  SEVERITY[b] > SEVERITY[a] ? b : a;

const toArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** IAM returns URL-encoded JSON; the CLI usually decodes it to an object already. */
export function parsePolicyDocument(doc: unknown): Record<string, unknown> | undefined {
  if (isRecord(doc)) return doc;
  if (typeof doc !== 'string') return undefined;
  for (const candidate of [doc, safeDecode(doc)]) {
    if (candidate === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // try the next form
    }
  }
  return undefined;
}

function safeDecode(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

/** Stable JSON (sorted keys) for hashing. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const ACTION_RE = /^[a-z0-9-]+:[A-Za-z0-9*?]+$/;
const READ_VERB_RE = /^(get|list|describe|view)[a-z0-9*?]*$/i;
const ONLY_WILDCARDS_RE = /^[*?]*\*[*?]*$/;

const globRe = (glob: string) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
    'i',
  );

/** `*`, or every action of IAM or Organizations (`iam:*`, `*:*`, `i*:*`, ...). */
export function isAdminActionPattern(action: string): boolean {
  if (ONLY_WILDCARDS_RE.test(action)) return true;
  const colon = action.indexOf(':');
  if (colon < 0) return false;
  const service = action.slice(0, colon);
  if (!ONLY_WILDCARDS_RE.test(action.slice(colon + 1))) return false;
  const re = globRe(service);
  return re.test('iam') || re.test('organizations');
}

/** `*`, or an ARN pattern whose resource part (after the fifth colon) is only wildcards. */
export function isEveryResourcePattern(resource: unknown): boolean {
  if (typeof resource !== 'string') return false;
  if (ONLY_WILDCARDS_RE.test(resource)) return true;
  const parts = resource.split(':');
  return (
    parts.length >= 6 && parts[0] === 'arn' && ONLY_WILDCARDS_RE.test(parts.slice(5).join(':'))
  );
}

export function analyzePolicyDocument(doc: unknown, allowlisted: ReadonlySet<string>): DocFacts {
  const parsed = parsePolicyDocument(doc);
  const empty: DocFacts = {
    classification: 'unparseable',
    sha256: null,
    allowStatements: 0,
    denyStatements: 0,
    nonAllowlistedActions: [],
  };
  if (!parsed) return empty;
  const sha256 = createHash('sha256').update(canonical(parsed)).digest('hex');
  const allowLower = new Set([...allowlisted].map((a) => a.toLowerCase()));
  let classification: DocClass = 'allowlisted-only';
  let allowStatements = 0;
  let denyStatements = 0;
  const nonAllowlisted = new Set<string>();
  const statements = toArray(parsed['Statement']);
  if (statements.length === 0) return { ...empty, sha256 };
  for (const st of statements) {
    if (!isRecord(st)) return { ...empty, sha256 };
    if (st['Effect'] === 'Deny') {
      denyStatements += 1;
      continue;
    }
    if (st['Effect'] !== 'Allow') return { ...empty, sha256 };
    allowStatements += 1;
    const resources = toArray(st['Resource']);
    const everyResource =
      st['NotResource'] !== undefined || resources.some((r) => isEveryResourcePattern(r));
    if (st['NotResource'] !== undefined) {
      // Not verifiable as allowlisted-only (reviewer rule); the actions decide anything worse.
      classification = worseClass(classification, 'read-only-data-capable');
      nonAllowlisted.add('NotResource');
    }
    if (st['NotAction'] !== undefined) {
      const excluded = toArray(st['NotAction']).map((a) => String(a).toLowerCase());
      const covers = (svc: string) => excluded.includes('*') || excluded.includes(`${svc}:*`);
      classification = worseClass(
        classification,
        everyResource && !(covers('iam') && covers('organizations'))
          ? 'admin-equivalent'
          : 'write-capable',
      );
      nonAllowlisted.add('NotAction');
      continue;
    }
    const actions = toArray(st['Action']);
    if (actions.length === 0) return { ...empty, sha256 };
    for (const a of actions) {
      if (typeof a !== 'string') return { ...empty, sha256 };
      const lower = a.toLowerCase();
      if (isAdminActionPattern(a) && everyResource) {
        classification = worseClass(classification, 'admin-equivalent');
        nonAllowlisted.add(a);
        continue;
      }
      if (allowLower.has(lower)) continue;
      if (!ACTION_RE.test(a)) {
        classification = worseClass(classification, 'write-capable');
        nonAllowlisted.add(a === '*' ? '*' : '<non-standard action>');
        continue;
      }
      nonAllowlisted.add(a);
      const name = a.slice(a.indexOf(':') + 1);
      classification = worseClass(
        classification,
        READ_VERB_RE.test(name) ? 'read-only-data-capable' : 'write-capable',
      );
    }
  }
  return {
    classification,
    sha256,
    allowStatements,
    denyStatements,
    nonAllowlistedActions: [...nonAllowlisted].sort().slice(0, 50),
  };
}
