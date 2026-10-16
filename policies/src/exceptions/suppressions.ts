/**
 * Governed suppression register (`policies/exceptions/suppressions.yaml`).
 *
 * Every acknowledgement that infrastructure code makes — `acknowledgeRule()` for a cdk-nag
 * finding such as `AwsSolutions-IAM5[Resource::*]`, `acknowledgeAnnotation()` for a CDK construct
 * warning, `acknowledgeCfnValidate()` for a CloudFormation Validate code — must match exactly one
 * ACTIVE entry of this register. An entry names:
 *
 * - the rule (with the cdk-nag finding where the rule reports one),
 * - the construct class whose code makes the acknowledgement (`construct`),
 * - the exact resources it may cover, as construct paths relative to that construct
 *   (`resources`; `*` matches within one path segment, `**` is not allowed),
 * - the environments, a justification, an owner and a review date (`reviewBy`) after which the
 *   suppression stops applying until the owner re-reviews it,
 * - for `AwsSolutions-IAM5[Resource::*]`, the exact actions that may appear on `Resource: "*"`.
 *
 * BASE-* baseline deviations are NOT registered here: they are governed exceptions
 * (`exceptions.yaml`, EXC-NNNN) that `applyBaselinePolicies` applies by construct path.
 *
 * `status: reference` (the starter's own code; no dates, never expires, no approval digest) and
 * `status: example` (never applies; an error until adopted) work as in `exceptions.ts`.
 *
 * PROPOSED BASELINE — not an approved control set of any organization or regulator.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { RESOURCE_WILDCARD_ALLOWED_ACTIONS } from '../rules/iam.js';
import { ENVIRONMENTS, type Environment } from '../types.js';
import {
  ENTRY_STATUSES,
  daysBetween,
  exampleMessage,
  globToRegExp,
  statusFieldIssues,
  isoDate,
  todayUtc,
  type ExceptionIssue,
  type ExceptionIssueCode,
} from './exceptions.js';
import { unpinnedReferenceMessage } from './reference-pins.js';

export const SUPPRESSIONS_SCHEMA_VERSION = 1;
/** Longest allowed interval between two reviews (reviewedAt → reviewBy). */
export const MAX_SUPPRESSION_REVIEW_DAYS = 180;
/** Look-ahead for "review due soon" warnings. */
export const SUPPRESSION_WARN_WITHIN_DAYS = 30;
/** The one cdk-nag finding whose scope is narrowed further by an action allowlist. */
export const IAM5_WILDCARD_RESOURCE = 'AwsSolutions-IAM5[Resource::*]';
/** Rule name reported by the suppression audits (synth-time plugin and CLI). */
export const SUPPRESSION_GOVERNANCE_RULE_ID = 'BASE-SUP-001';

/** cdk-nag pack rule (`AwsSolutions-IAM5`, optionally with the finding `[Resource::*]`), never BASE-*. */
const NAG_RULE_ID = /^(?!BASE-)[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+(\[[^\]]+\])?$/;
const ANNOTATION_ID = /^Annotation::@aws-cdk\/[\w-]+:\w+$/;
const CFN_VALIDATE_ID = /^CloudFormation-Validate::[EWIF]\d{4}$/;
const BASELINE_RULE_ID = /^BASE-[A-Z0-9]+-\d{3}(\[[^\]]+\])?$/;

/**
 * What an acknowledgement suppresses:
 * - `rule`: a cdk-nag finding on one CloudFormation resource (exact resources only);
 * - `annotation`: a CDK construct warning, attached to the construct that raises it;
 * - `cfn-validate`: a CloudFormation Validate (cfn-lint) code on one resource.
 */
export type SuppressionKind = 'rule' | 'annotation' | 'cfn-validate';

export function suppressionKind(ruleId: string): SuppressionKind | undefined {
  if (ANNOTATION_ID.test(ruleId)) return 'annotation';
  if (CFN_VALIDATE_ID.test(ruleId)) return 'cfn-validate';
  if (NAG_RULE_ID.test(ruleId)) return 'rule';
  return undefined;
}

export const isBaselineRuleId = (ruleId: string): boolean => BASELINE_RULE_ID.test(ruleId);

const relativeConstructPath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith('/') && !p.endsWith('/') && !p.includes('//'),
    'must be a construct path relative to `construct`, without leading or trailing "/"',
  )
  .refine((p) => !p.split('/').includes('**'), '"**" is not allowed: name the resources')
  .refine(
    (p) => !/[*?]/.test(p.split('/')[0] ?? ''),
    'the first segment must be a literal construct id (no wildcard)',
  );

const suppressionFields = z
  .object({
    id: z.string().regex(/^SUP-\d{4}$/, 'must look like SUP-0001'),
    status: z.enum(ENTRY_STATUSES).optional(),
    ruleId: z
      .string()
      .refine(
        (s) => !isBaselineRuleId(s),
        'BASE-* findings are waived only by governed exceptions (exceptions.yaml)',
      )
      .refine(
        (s) => isBaselineRuleId(s) || suppressionKind(s) !== undefined,
        'must be a cdk-nag rule id (e.g. AwsSolutions-IAM5[Resource::*]), ' +
          'Annotation::@aws-cdk/<module>:<id> or CloudFormation-Validate::<code>',
      ),
    construct: z
      .string()
      .regex(/^[A-Z][A-Za-z0-9]*$/, 'class name of the construct whose code acknowledges'),
    resources: z.array(relativeConstructPath).min(1),
    environments: z.array(z.enum(ENVIRONMENTS)).min(1),
    allowedActions: z
      .array(z.string().regex(/^[a-z0-9-]+:[A-Za-z0-9]+$/, 'exact IAM action (no wildcards)'))
      .min(1)
      .optional(),
    justification: z
      .string()
      .trim()
      .min(40, 'must explain why the finding is acceptable (>= 40 chars)'),
    compensatingControls: z.array(z.string().trim().min(3)).optional(),
    owner: z.string().trim().min(3),
    approver: z.string().trim().min(3).optional(),
    ticket: z.string().trim().min(1).optional(),
    createdAt: isoDate.optional(),
    reviewedAt: isoDate.optional(),
    reviewBy: isoDate.optional(),
  })
  .strict();

type SuppressionFields = z.infer<typeof suppressionFields>;
type SuppressionCommon = Omit<
  SuppressionFields,
  'status' | 'createdAt' | 'reviewedAt' | 'reviewBy' | 'approver'
>;
/** A project's own register entry: dated and reviewed. */
export type DatedSuppressionEntry = SuppressionCommon & {
  status?: undefined;
  createdAt: string;
  reviewedAt: string;
  reviewBy: string;
  approver?: string;
};
/** A reference-design entry or a shipped example: no dates, no approver. */
export type UndatedSuppressionEntry = SuppressionCommon & {
  status: (typeof ENTRY_STATUSES)[number];
  createdAt?: undefined;
  reviewedAt?: undefined;
  reviewBy?: undefined;
  approver?: undefined;
};
export type SuppressionEntry = DatedSuppressionEntry | UndatedSuppressionEntry;

export const suppressionEntrySchema = suppressionFields
  .superRefine((entry, ctx) => {
    for (const issue of statusFieldIssues(entry, ['createdAt', 'reviewedAt', 'reviewBy'])) {
      ctx.addIssue({ code: 'custom', ...issue });
    }
  })
  .transform((entry) => entry as SuppressionEntry);

export const suppressionsFileSchema = z
  .object({
    schemaVersion: z.literal(SUPPRESSIONS_SCHEMA_VERSION),
    suppressions: z.array(suppressionEntrySchema).default([]),
  })
  .strict();

export interface SuppressionRegister {
  ok: boolean;
  /** Schema-valid entries (including inactive ones). */
  suppressions: SuppressionEntry[];
  /** Entries that may be applied today (valid, review not overdue; reference entries always). */
  active: SuppressionEntry[];
  issues: ExceptionIssue[];
  /** Source file, when loaded from disk. */
  file?: string;
}

export interface CheckSuppressionsOptions {
  /** Evaluation date `YYYY-MM-DD` (UTC). Defaults to today. */
  today?: string;
  warnWithinDays?: number;
}

/** Validates parsed register data (schema + governance rules). */
export function checkSuppressions(
  raw: unknown,
  options: CheckSuppressionsOptions = {},
): SuppressionRegister {
  const today = options.today ?? todayUtc();
  const warnWithin = options.warnWithinDays ?? SUPPRESSION_WARN_WITHIN_DAYS;
  const parsed = suppressionsFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      suppressions: [],
      active: [],
      issues: parsed.error.issues.map((i) => ({
        level: 'error',
        code: 'MALFORMED',
        message: `suppressions.yaml ${i.path.length ? i.path.join('.') : '<root>'}: ${i.message}`,
      })),
    };
  }
  const issues: ExceptionIssue[] = [];
  const seen = new Set<string>();
  const scopes = new Map<string, string>();
  const active: SuppressionEntry[] = [];
  const rawList = (raw as { suppressions?: unknown[] }).suppressions ?? [];
  for (const [index, entry] of parsed.data.suppressions.entries()) {
    let valid = true;
    const err = (code: ExceptionIssueCode, message: string) => {
      issues.push({
        level: 'error',
        code,
        exceptionId: entry.id,
        message: `${entry.id}: ${message}`,
      });
      valid = false;
    };
    if (seen.has(entry.id)) err('DUPLICATE_ID', 'duplicate suppression id');
    seen.add(entry.id);
    // One entry per rule, construct, resource AND environment: a scope may have one entry for the
    // governed environments and a separate one for the non-governed sandbox, never two for one
    // environment.
    for (const resource of entry.resources) {
      const clashes = new Set<string>();
      for (const environment of entry.environments) {
        const key = `${entry.ruleId}|${entry.construct}|${resource}|${environment}`;
        const other = scopes.get(key);
        if (other && other !== entry.id) clashes.add(other);
        scopes.set(key, entry.id);
      }
      if (clashes.size > 0) {
        err(
          'DUPLICATE_SCOPE',
          `${entry.ruleId} on ${entry.construct}/${resource} is also in ${[...clashes].join(', ')}`,
        );
      }
    }
    if (entry.ruleId === IAM5_WILDCARD_RESOURCE) {
      if (!entry.allowedActions) {
        err(
          'ACTIONS_REQUIRED',
          `${IAM5_WILDCARD_RESOURCE} needs allowedActions (exact actions on "*")`,
        );
      }
      for (const action of entry.allowedActions ?? []) {
        if (!(action in RESOURCE_WILDCARD_ALLOWED_ACTIONS)) {
          err(
            'ACTION_NOT_IN_BASELINE',
            `${action} is not in the BASE-IAM-002 allowlist of actions without resource-level permissions`,
          );
        }
      }
    } else if (entry.allowedActions) {
      err('ACTIONS_REQUIRED', `allowedActions only applies to ${IAM5_WILDCARD_RESOURCE}`);
    }
    if (entry.status !== undefined) {
      // reference: part of the starter's code (no expiry, no approval; reviewed as code in an MR).
      // example: never applies until a project adopts it.
      const unpinned =
        entry.status === 'reference'
          ? unpinnedReferenceMessage(entry.id, rawList[index], false)
          : undefined;
      if (entry.status === 'example') {
        err('EXAMPLE_NOT_ADOPTED', exampleMessage(entry.ruleId, entry.environments));
      } else if (unpinned) {
        err('UNPINNED_REFERENCE_ENTRY', unpinned);
      } else if (valid) {
        active.push(entry);
      }
      continue;
    }
    if (daysBetween(today, entry.createdAt) > 0) {
      err('INVALID_WINDOW', `createdAt ${entry.createdAt} is in the future`);
    }
    if (daysBetween(today, entry.reviewedAt) > 0) {
      err('INVALID_WINDOW', `reviewedAt ${entry.reviewedAt} is in the future`);
    }
    if (daysBetween(entry.createdAt, entry.reviewedAt) < 0) {
      err(
        'INVALID_WINDOW',
        `reviewedAt ${entry.reviewedAt} is before createdAt ${entry.createdAt}`,
      );
    }
    const interval = daysBetween(entry.reviewedAt, entry.reviewBy);
    if (interval < 0) {
      err('INVALID_WINDOW', `reviewBy ${entry.reviewBy} is before reviewedAt ${entry.reviewedAt}`);
    } else if (interval > MAX_SUPPRESSION_REVIEW_DAYS) {
      err(
        'INVALID_WINDOW',
        `review interval ${interval} days exceeds the maximum of ${MAX_SUPPRESSION_REVIEW_DAYS}`,
      );
    }
    const remaining = daysBetween(today, entry.reviewBy);
    if (remaining < 0) {
      err(
        'EXPIRED',
        `review overdue since ${entry.reviewBy} (owner ${entry.owner}): the suppression no longer applies`,
      );
    } else if (remaining <= warnWithin) {
      issues.push({
        level: 'warning',
        code: 'EXPIRING_SOON',
        exceptionId: entry.id,
        message: `${entry.id}: review due in ${remaining} day(s) on ${entry.reviewBy} (owner ${entry.owner})`,
      });
    }
    if (valid) active.push(entry);
  }
  return {
    ok: !issues.some((i) => i.level === 'error'),
    suppressions: parsed.data.suppressions,
    active,
    issues,
  };
}

/** Reads and validates a register file. A YAML syntax error is reported as MALFORMED. */
export function loadSuppressionsFile(
  file: string,
  options: CheckSuppressionsOptions = {},
): SuppressionRegister {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      suppressions: [],
      active: [],
      issues: [
        {
          level: 'error',
          code: 'MALFORMED',
          message: `${file}: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
      file,
    };
  }
  return { ...checkSuppressions(raw, options), file };
}

/** Acknowledgement reason recorded for an applied suppression (cited by the audits). */
export const suppressionReason = (entry: SuppressionEntry): string =>
  `[${entry.id}] ${entry.justification} (owner: ${entry.owner}; ` +
  (entry.status === undefined
    ? `review by: ${entry.reviewBy}${entry.approver ? `; approver: ${entry.approver}` : ''})`
    : 'reference design: no review date, changed only in a reviewed MR)');

/** `EXC-0001` / `SUP-0001` cited at the start of an acknowledgement reason. */
export function citedRegisterId(reason: unknown): string | undefined {
  return typeof reason === 'string' ? /^\[((?:EXC|SUP)-\d{4})\]/.exec(reason)?.[1] : undefined;
}

/** True when a path relative to the entry's construct is one of its resources. */
export function matchesRelativeResource(entry: SuppressionEntry, relativePath: string): boolean {
  return entry.resources.some((r) => globToRegExp(r).test(relativePath));
}

/**
 * Template-level scope check (no class information in templates): the CDK path ends with one of
 * the entry's resources (segment-aligned). Annotation entries also cover the CloudFormation
 * resources below the annotated construct, because cdk-nag copies the acknowledgement there.
 */
export function cdkPathInScope(entry: SuppressionEntry, cdkPath: string): boolean {
  const segments = cdkPath.split('/');
  const subtree = suppressionKind(entry.ruleId) === 'annotation';
  return entry.resources.some((resource) => {
    const pattern = resource.split('/').map((p) => globToRegExp(p));
    const starts = subtree
      ? Array.from({ length: segments.length - pattern.length + 1 }, (_, i) => i)
      : [segments.length - pattern.length];
    return starts.some(
      (start) => start >= 1 && pattern.every((re, i) => re.test(segments[start + i] ?? '')),
    );
  });
}

/** Environment of a CDK path whose first segment is a Dev/Staging/Prod/Sandbox stage, if any. */
export function environmentOfCdkPath(cdkPath: string): Environment | undefined {
  const first = cdkPath.split('/')[0]?.toLowerCase() ?? '';
  return (ENVIRONMENTS as readonly string[]).includes(first) ? (first as Environment) : undefined;
}
