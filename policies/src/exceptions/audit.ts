/**
 * Suppression audit over synthesized templates (`cdk_nag.rules_to_suppress` metadata).
 *
 * Every suppression recorded in a template must cite an ACTIVE register entry for the same rule:
 * `[EXC-NNNN]` (governed exception, `exceptions.yaml`) or `[SUP-NNNN]` (suppression register,
 * `suppressions.yaml`), and the suppressed resource must be inside that entry's scope:
 *
 * - BASE-* rules: governed exceptions only; the CDK path matches the exception's resource glob (or
 *   the logical ID equals it) and the stage environment is listed.
 * - Other cdk-nag rules (AwsSolutions-*): an exception or a register entry; register entries must
 *   cover the resource exactly, list the environment, and for `AwsSolutions-IAM5[Resource::*]`
 *   every action allowed on `Resource: "*"` must be in the entry's `allowedActions`.
 * - CDK annotation acknowledgements (`@aws-cdk/...`): register entries.
 * - CloudFormation Validate codes: audited when they cite an entry; uncited ones are
 *   aws-cdk-lib's own acknowledgements (e.g. `F3002` on flow logs) and are only inventoried.
 *
 * The same rules are enforced at synth time on the construct tree (`SuppressionAuditPlugin`);
 * this template audit is the engine-independent second line run by CI (`check-exceptions`).
 */
import { identityStatements } from '../rules/iam.js';
import { asArray, isRecord } from '../rules/util.js';
import { isBaselineEnvironment, type CfnResourceJson } from '../types.js';
import { globToRegExp, type ExceptionIssue, type PolicyException } from './exceptions.js';
import {
  IAM5_WILDCARD_RESOURCE,
  cdkPathInScope,
  citedRegisterId,
  environmentOfCdkPath,
  isBaselineRuleId,
  suppressionKind,
  type SuppressionEntry,
} from './suppressions.js';

export type AuditScope = 'baseline' | 'all';

export interface AuditTemplate {
  file: string;
  template: { Resources?: Record<string, Partial<CfnResourceJson>> };
}

export interface SuppressionInventoryItem {
  file: string;
  logicalId: string;
  cdkPath: string | undefined;
  ruleId: string;
  /** EXC-/SUP- id cited by the reason, if any. */
  citation: string | undefined;
  /** How the suppression is governed (`framework` = uncited aws-cdk-lib CloudFormation Validate ack). */
  governedBy: 'exception' | 'register' | 'framework' | 'ungoverned';
}

export interface SuppressionAuditOptions {
  /** `baseline`: only BASE-* suppressions (legacy); `all` (default): every suppression. */
  scope?: AuditScope;
  /** Active governed exceptions (exceptions.yaml). */
  exceptions: readonly PolicyException[];
  /** Active register entries (suppressions.yaml). */
  suppressions?: readonly SuppressionEntry[];
}

export interface SuppressionAuditResult {
  issues: ExceptionIssue[];
  inventory: SuppressionInventoryItem[];
}

/** Template id → register id: cdk-nag strips the `Annotation::` prefix when it writes metadata. */
export function normalizeSuppressedId(id: string): string {
  const bare = id.replace(/^annotation::/i, '');
  return bare.startsWith('@aws-cdk/') ? `Annotation::${bare}` : bare;
}

/** Actions an identity policy resource allows on `Resource: "*"` (`NotAction` counts as `*`). */
export function wildcardResourceActions(resource: Partial<CfnResourceJson>): string[] {
  if (typeof resource.Type !== 'string') return [];
  const out = new Set<string>();
  for (const { statement } of identityStatements(resource as CfnResourceJson)) {
    if (statement['Effect'] !== 'Allow') continue;
    if (!asArray(statement['Resource']).includes('*')) continue;
    if (statement['NotAction'] !== undefined) out.add('*');
    for (const action of asArray(statement['Action'])) {
      out.add(typeof action === 'string' ? action : JSON.stringify(action));
    }
  }
  return [...out];
}

/** Checks a resource against the scope of the register entry it cites (shared with the tree audit). */
export function registerScopeIssues(
  entry: SuppressionEntry,
  where: string,
  scope: { cdkPathInScope: boolean; environment: string | undefined },
  resource: Partial<CfnResourceJson> | undefined,
): ExceptionIssue[] {
  const issues: ExceptionIssue[] = [];
  const err = (code: ExceptionIssue['code'], message: string) =>
    issues.push({ level: 'error', code, exceptionId: entry.id, message: `${where}: ${message}` });
  if (!scope.cdkPathInScope) {
    err(
      'SCOPE_MISMATCH',
      `${entry.ruleId} cites ${entry.id}, whose scope (${entry.construct}: ${entry.resources.join(', ')}) does not cover this resource`,
    );
  }
  if (
    scope.environment !== undefined
      ? !(entry.environments as readonly string[]).includes(scope.environment)
      : !entry.environments.some(isBaselineEnvironment)
  ) {
    // Outside a known stage only entries listing a governed environment apply (never sandbox-only ones).
    err(
      'ENVIRONMENT_MISMATCH',
      `${entry.id} is limited to ${entry.environments.join('/')}, not ${scope.environment ?? 'a resource outside a Dev/Staging/Prod/Sandbox stage'}`,
    );
  }
  if (entry.ruleId === IAM5_WILDCARD_RESOURCE && resource) {
    const allowed = new Set(entry.allowedActions ?? []);
    for (const action of wildcardResourceActions(resource)) {
      if (!allowed.has(action)) {
        err(
          'ACTION_NOT_ALLOWED',
          `${action} on Resource "*" is not in ${entry.id} allowedActions (${[...allowed].join(', ')})`,
        );
      }
    }
  }
  return issues;
}

/** Checks a resource against the governed exception it cites (shared with the tree audit). */
export function exceptionScopeIssues(
  exc: PolicyException,
  where: string,
  target: { cdkPath: string | undefined; logicalId: string; environment: string | undefined },
): ExceptionIssue[] {
  const issues: ExceptionIssue[] = [];
  const inScope =
    (target.cdkPath !== undefined && globToRegExp(exc.resource).test(target.cdkPath)) ||
    exc.resource === target.logicalId;
  if (!inScope) {
    issues.push({
      level: 'error',
      code: 'SCOPE_MISMATCH',
      exceptionId: exc.id,
      message: `${where}: ${exc.ruleId} cites ${exc.id}, whose resource "${exc.resource}" does not cover this resource`,
    });
  }
  if (
    target.environment === undefined ||
    !(exc.environments as readonly string[]).includes(target.environment)
  ) {
    issues.push({
      level: 'error',
      code: 'ENVIRONMENT_MISMATCH',
      exceptionId: exc.id,
      message: `${where}: ${exc.id} is limited to ${exc.environments.join('/')}, not ${target.environment ?? 'an unknown environment'}`,
    });
  }
  return issues;
}

/**
 * Audits `cdk_nag.rules_to_suppress` metadata in synthesized templates and returns the issues
 * plus an inventory of every suppression found.
 */
export function auditSuppressions(
  templates: readonly AuditTemplate[],
  options: SuppressionAuditOptions,
): SuppressionAuditResult {
  const scope = options.scope ?? 'all';
  const suppressions = options.suppressions ?? [];
  const issues: ExceptionIssue[] = [];
  const inventory: SuppressionInventoryItem[] = [];
  for (const { file, template } of templates) {
    for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
      const meta = resource.Metadata?.['cdk_nag'];
      if (!isRecord(meta)) continue;
      const cdkPathValue = resource.Metadata?.['aws:cdk:path'];
      const cdkPath = typeof cdkPathValue === 'string' ? cdkPathValue : undefined;
      const environment = cdkPath ? environmentOfCdkPath(cdkPath) : undefined;
      for (const s of asArray(meta['rules_to_suppress'])) {
        if (!isRecord(s) || typeof s['id'] !== 'string') continue;
        const ruleId = normalizeSuppressedId(s['id']);
        const citation = citedRegisterId(s['reason']);
        const where = `${file} ${logicalId}${cdkPath ? ` (${cdkPath})` : ''}`;
        const item: SuppressionInventoryItem = {
          file,
          logicalId,
          cdkPath,
          ruleId,
          citation,
          governedBy: 'ungoverned',
        };
        inventory.push(item);
        const baseline = isBaselineRuleId(ruleId);
        const kind = suppressionKind(ruleId);
        if (!baseline && scope === 'baseline') continue;
        if (kind === 'cfn-validate' && citation === undefined) {
          item.governedBy = 'framework';
          continue;
        }
        const ungoverned = (detail: string) =>
          issues.push({
            level: 'error',
            code: 'UNGOVERNED_SUPPRESSION',
            message: `${where}: suppression of ${ruleId} ${detail}`,
          });
        if (citation?.startsWith('EXC-') && (baseline || kind === 'rule')) {
          const exc = options.exceptions.find((e) => e.id === citation && e.ruleId === ruleId);
          if (!exc) {
            ungoverned(`is not backed by an active exception (cites ${citation})`);
            continue;
          }
          item.governedBy = 'exception';
          issues.push(...exceptionScopeIssues(exc, where, { cdkPath, logicalId, environment }));
          continue;
        }
        if (citation?.startsWith('SUP-') && !baseline && kind !== undefined) {
          const entry = suppressions.find((e) => e.id === citation && e.ruleId === ruleId);
          if (!entry) {
            ungoverned(`is not backed by an active register entry (cites ${citation})`);
            continue;
          }
          item.governedBy = 'register';
          issues.push(
            ...registerScopeIssues(
              entry,
              where,
              {
                cdkPathInScope: cdkPath !== undefined && cdkPathInScope(entry, cdkPath),
                environment,
              },
              resource,
            ),
          );
          continue;
        }
        ungoverned(
          baseline
            ? `is not backed by an active exception${citation ? ` (cites ${citation})` : ''}`
            : `is not backed by an active register entry or exception${citation ? ` (cites ${citation})` : ''}`,
        );
      }
    }
  }
  return { issues, inventory };
}

/**
 * Backwards-compatible wrapper: issues only. Default scope is now `all` (every suppression must
 * be governed); pass `'baseline'` to audit BASE-* suppressions only.
 */
export function auditTemplateSuppressions(
  templates: readonly AuditTemplate[],
  active: readonly PolicyException[],
  scope: AuditScope = 'all',
  suppressions: readonly SuppressionEntry[] = [],
): ExceptionIssue[] {
  return auditSuppressions(templates, { scope, exceptions: active, suppressions }).issues;
}

/** Register entries that no template suppression cites (warnings: CI synthesizes a subset). */
export function unusedSuppressions(
  inventory: readonly SuppressionInventoryItem[],
  suppressions: readonly SuppressionEntry[],
): ExceptionIssue[] {
  const cited = new Set(inventory.map((i) => i.citation));
  return suppressions
    .filter((s) => !cited.has(s.id))
    .map((s) => ({
      level: 'warning' as const,
      code: 'UNUSED_SUPPRESSION' as const,
      exceptionId: s.id,
      message: `${s.id}: ${s.ruleId} (${s.construct}) is not used by any audited template (variant not synthesized, or stale)`,
    }));
}
