/**
 * Governed policy exceptions (`policies/exceptions/exceptions.yaml`).
 *
 * An exception is the ONLY sanctioned way to waive a finding. It is versioned
 * in git, carries a justification, an owner, a ticket and an expiry date, and
 * is applied as a targeted cdk-nag acknowledgement (synth time) and as a
 * targeted Guard finding waiver (CI). Malformed or expired exceptions fail.
 *
 * `status` marks entries that carry no dates and no approver (the schema rejects them there):
 * - `reference`: a deviation of the starter's OWN reference code. It is part of the code: it
 *   applies wherever the code needs it, never expires and needs no approval digest; changing it is
 *   a code change reviewed in an MR. Never scoped to the sandbox.
 * - `example`: a shipped example (the sandbox register under `examples/`). It never applies; a
 *   loaded example is an error until a project adopts it (removes `status`, sets dates).
 * Entries without `status` are the project's own deviations: dated, expiring, approvable.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ruleById } from '../catalogue.js';
import { ENVIRONMENTS, type Environment } from '../types.js';
import { unpinnedReferenceMessage } from './reference-pins.js';

export const EXCEPTIONS_SCHEMA_VERSION = 1;
/** Longest allowed validity window (createdAt → expiresAt). */
export const MAX_EXCEPTION_VALIDITY_DAYS = 180;
/** Default look-ahead for "expiring soon" warnings. */
export const DEFAULT_WARN_WITHIN_DAYS = 14;

/** `BASE-XXX-000`, `AwsSolutions-XXX`, optionally with a cdk-nag finding suffix `[...]`. */
export const EXCEPTION_RULE_ID_PATTERN =
  /^(BASE-[A-Z0-9]+-\d{3}|AwsSolutions-[A-Za-z0-9]+)(\[[^\]]+\])?$/;

/** `YYYY-MM-DD` calendar date (shared by the exceptions file and the suppression register). */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'is not a valid calendar date');

/** Undated entry kinds (see the module comment). */
export const ENTRY_STATUSES = ['reference', 'example'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];
/** Minimum justification of a reference-design entry (it never expires). */
export const MIN_REFERENCE_JUSTIFICATION = 40;

/**
 * Cross-field rules shared by both registers: an undated entry (`reference`/`example`) carries no
 * dates and no approver, a reference entry is never scoped to the sandbox and explains itself in at
 * least 40 characters, and every other entry carries all of `dateFields`.
 */
export function statusFieldIssues(
  entry: Record<string, unknown>,
  dateFields: readonly string[],
): { path: string[]; message: string }[] {
  const status = entry['status'];
  if (status === undefined) {
    return dateFields
      .filter((f) => entry[f] === undefined)
      .map((f) => ({ path: [f], message: 'is required (only reference/example entries omit it)' }));
  }
  const issues = [...dateFields, 'approver']
    .filter((f) => entry[f] !== undefined)
    .map((f) => ({
      path: [f],
      message: `a ${String(status)} entry carries no ${f}${status === 'example' ? ': the adopting project sets it when it adopts the entry' : ''}`,
    }));
  if (status === 'reference') {
    if ((entry['environments'] as unknown[] | undefined)?.includes('sandbox')) {
      issues.push({
        path: ['environments'],
        message: 'a reference entry is never scoped to the sandbox',
      });
    }
    const resource = entry['resource'];
    if (typeof resource === 'string' && !isNarrowReferenceResource(resource)) {
      issues.push({
        path: ['resource'],
        message:
          'a reference entry names exact resources: no "**", and no wildcard after the first (stage) segment',
      });
    }
    const justification = entry['justification'];
    if (
      typeof justification === 'string' &&
      justification.trim().length < MIN_REFERENCE_JUSTIFICATION
    ) {
      issues.push({
        path: ['justification'],
        message: `a reference entry never expires: explain it in >= ${MIN_REFERENCE_JUSTIFICATION} chars`,
      });
    }
  }
  return issues;
}

/**
 * Scope of a reference exception (stricter than project entries, which accept any glob): a CDK path
 * of at least two segments, no `**`, and wildcards only in the first segment (the stage), e.g.
 * `*\/Migrations/DatabaseBootstrap/TaskDefinition/Resource`; or an exact logical ID.
 */
export function isNarrowReferenceResource(resource: string): boolean {
  const segments = resource.split('/');
  if (segments.includes('**') || resource.includes('**')) return false;
  if (segments.length === 1) return !/[*?]/.test(resource);
  return segments.slice(1).every((s) => s !== '' && !/[*?]/.test(s));
}

const exceptionFields = z
  .object({
    id: z.string().regex(/^EXC-\d{4}$/, 'must look like EXC-0001'),
    status: z.enum(ENTRY_STATUSES).optional(),
    ruleId: z
      .string()
      .regex(EXCEPTION_RULE_ID_PATTERN, 'must be a BASE-* or AwsSolutions-* rule ID'),
    resource: z
      .string()
      .min(1)
      .describe('Glob on the CDK construct path (aws:cdk:path) or exact logical ID'),
    environments: z.array(z.enum(ENVIRONMENTS)).min(1),
    justification: z.string().trim().min(20, 'must explain the risk acceptance (>= 20 chars)'),
    owner: z.string().trim().min(3),
    approver: z.string().trim().min(3).optional(),
    ticket: z.string().trim().min(1),
    createdAt: isoDate.optional(),
    expiresAt: isoDate.optional(),
  })
  .strict();

type ExceptionFields = z.infer<typeof exceptionFields>;
type ExceptionCommon = Omit<ExceptionFields, 'status' | 'createdAt' | 'expiresAt' | 'approver'>;
/** A project's own exception: dated, expiring, approver where the rule requires one. */
export type DatedPolicyException = ExceptionCommon & {
  status?: undefined;
  createdAt: string;
  expiresAt: string;
  approver?: string;
};
/** A reference-design entry or a shipped example: no dates, no approver. */
export type UndatedPolicyException = ExceptionCommon & {
  status: EntryStatus;
  createdAt?: undefined;
  expiresAt?: undefined;
  approver?: undefined;
};
export type PolicyException = DatedPolicyException | UndatedPolicyException;

export const policyExceptionSchema = exceptionFields
  .superRefine((entry, ctx) => {
    for (const issue of statusFieldIssues(entry, ['createdAt', 'expiresAt'])) {
      ctx.addIssue({ code: 'custom', ...issue });
    }
  })
  .transform((entry) => entry as PolicyException);

export const exceptionsFileSchema = z
  .object({
    schemaVersion: z.literal(EXCEPTIONS_SCHEMA_VERSION),
    exceptions: z.array(policyExceptionSchema).default([]),
  })
  .strict();

export type ExceptionIssueCode =
  | 'MALFORMED'
  | 'DUPLICATE_ID'
  | 'UNKNOWN_RULE'
  | 'INVALID_WINDOW'
  | 'APPROVER_REQUIRED'
  | 'EXPIRED'
  | 'EXPIRING_SOON'
  | 'UNGOVERNED_SUPPRESSION'
  // Suppression register (suppressions.yaml) and suppression audits:
  | 'DUPLICATE_SCOPE'
  | 'ACTIONS_REQUIRED'
  | 'ACTION_NOT_IN_BASELINE'
  | 'SCOPE_MISMATCH'
  | 'ENVIRONMENT_MISMATCH'
  | 'ACTION_NOT_ALLOWED'
  | 'UNUSED_SUPPRESSION'
  // Approvals recorded outside the repository (approvals.ts):
  | 'UNAPPROVED_ENTRY'
  // A shipped example (`status: example`) loaded without being adopted:
  | 'EXAMPLE_NOT_ADOPTED'
  // A `status: reference` entry that is not pinned with exactly this content (reference-pins.ts):
  | 'UNPINNED_REFERENCE_ENTRY';

export interface ExceptionIssue {
  level: 'error' | 'warning';
  code: ExceptionIssueCode;
  exceptionId?: string;
  message: string;
}

export interface ExceptionsCheckResult {
  ok: boolean;
  /** Schema-valid exceptions (including expired ones). */
  exceptions: PolicyException[];
  /** Exceptions that may be applied today (valid and not expired; reference entries always). */
  active: PolicyException[];
  issues: ExceptionIssue[];
}

export interface CheckExceptionsOptions {
  /** Evaluation date `YYYY-MM-DD` (UTC). Defaults to today. */
  today?: string;
  warnWithinDays?: number;
}

export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Validates parsed exceptions data (schema + governance rules). */
export function checkExceptions(
  raw: unknown,
  options: CheckExceptionsOptions = {},
): ExceptionsCheckResult {
  const today = options.today ?? todayUtc();
  const warnWithin = options.warnWithinDays ?? DEFAULT_WARN_WITHIN_DAYS;
  const parsed = exceptionsFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      exceptions: [],
      active: [],
      issues: parsed.error.issues.map((i) => ({
        level: 'error',
        code: 'MALFORMED',
        message: `${i.path.length ? i.path.join('.') : '<root>'}: ${i.message}`,
      })),
    };
  }
  const issues: ExceptionIssue[] = [];
  const seen = new Set<string>();
  const active: PolicyException[] = [];
  const rawList = (raw as { exceptions?: unknown[] }).exceptions ?? [];
  for (const [index, exc] of parsed.data.exceptions.entries()) {
    const err = (code: ExceptionIssueCode, message: string) =>
      issues.push({ level: 'error', code, exceptionId: exc.id, message: `${exc.id}: ${message}` });
    let valid = true;
    if (seen.has(exc.id)) {
      err('DUPLICATE_ID', 'duplicate exception id');
      valid = false;
    }
    seen.add(exc.id);
    const baseRuleId = exc.ruleId.replace(/\[.*\]$/, '');
    const rule = baseRuleId.startsWith('BASE-') ? ruleById(baseRuleId) : undefined;
    if (baseRuleId.startsWith('BASE-') && !rule) {
      err('UNKNOWN_RULE', `rule ${baseRuleId} is not in the catalogue`);
      valid = false;
    }
    if (exc.status !== undefined) {
      // reference: part of the starter's code (no expiry, no approval; reviewed as code in an MR).
      // example: never applies until a project adopts it.
      const unpinned =
        exc.status === 'reference'
          ? unpinnedReferenceMessage(exc.id, rawList[index], rule?.severity === 'critical')
          : undefined;
      if (exc.status === 'example') {
        err('EXAMPLE_NOT_ADOPTED', exampleMessage(exc.ruleId, exc.environments));
      } else if (unpinned) {
        err('UNPINNED_REFERENCE_ENTRY', unpinned);
      } else if (valid) {
        active.push(exc);
      }
      continue;
    }
    const window = daysBetween(exc.createdAt, exc.expiresAt);
    if (window < 0) {
      err('INVALID_WINDOW', `expiresAt ${exc.expiresAt} is before createdAt ${exc.createdAt}`);
      valid = false;
    } else if (window > MAX_EXCEPTION_VALIDITY_DAYS) {
      err(
        'INVALID_WINDOW',
        `validity window ${window} days exceeds the maximum of ${MAX_EXCEPTION_VALIDITY_DAYS}`,
      );
      valid = false;
    }
    if (daysBetween(today, exc.createdAt) > 0) {
      err('INVALID_WINDOW', `createdAt ${exc.createdAt} is in the future`);
      valid = false;
    }
    if (rule?.severity === 'critical' && !exc.approver) {
      err('APPROVER_REQUIRED', `${rule.id} is critical; an approver is mandatory`);
      valid = false;
    }
    const remaining = daysBetween(today, exc.expiresAt);
    if (remaining < 0) {
      err('EXPIRED', `expired on ${exc.expiresAt} (ticket ${exc.ticket}, owner ${exc.owner})`);
      valid = false;
    } else if (remaining <= warnWithin) {
      issues.push({
        level: 'warning',
        code: 'EXPIRING_SOON',
        exceptionId: exc.id,
        message: `${exc.id}: expires in ${remaining} day(s) on ${exc.expiresAt}`,
      });
    }
    if (valid) active.push(exc);
  }
  return {
    ok: !issues.some((i) => i.level === 'error'),
    exceptions: parsed.data.exceptions,
    active,
    issues,
  };
}

/** Why a loaded example entry fails (shared with the suppression register). */
export const exampleMessage = (ruleId: string, environments: readonly string[]): string =>
  `shipped example for ${ruleId} (${environments.join('/')}) is not adopted and never applies: ` +
  'review it, remove `status` and set your dates (docs/policy-as-code.md, "Adding a project exception")';

/** Reads and validates an exceptions YAML file. A YAML syntax error is reported as MALFORMED. */
export function loadExceptionsFile(
  file: string,
  options: CheckExceptionsOptions = {},
): ExceptionsCheckResult {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      exceptions: [],
      active: [],
      issues: [
        {
          level: 'error',
          code: 'MALFORMED',
          message: `${file}: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
    };
  }
  return checkExceptions(raw, options);
}

/** Converts a glob (`*` within a path segment, `**` across segments, `?`) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

export interface ExceptionTarget {
  ruleId: string;
  environment: Environment | undefined;
  cdkPath: string | undefined;
  logicalId: string | undefined;
}

/** First active exception covering the target, if any. Requires a known environment. */
export function findException(
  active: readonly PolicyException[],
  target: ExceptionTarget,
): PolicyException | undefined {
  if (!target.environment) return undefined;
  return active.find((exc) => {
    if (exc.ruleId !== target.ruleId) return false;
    if (!exc.environments.includes(target.environment as Environment)) return false;
    const re = globToRegExp(exc.resource);
    return (
      (target.cdkPath !== undefined && re.test(target.cdkPath)) ||
      (target.logicalId !== undefined && exc.resource === target.logicalId)
    );
  });
}

/** Human-readable acknowledgement reason recorded with each applied exception. */
export const exceptionReason = (exc: PolicyException): string =>
  `[${exc.id}] ${exc.justification} (owner: ${exc.owner}; ticket: ${exc.ticket}; ` +
  (exc.status === undefined
    ? `expires: ${exc.expiresAt}${exc.approver ? `; approver: ${exc.approver}` : ''})`
    : 'reference design: no expiry, changed only in a reviewed MR)');
