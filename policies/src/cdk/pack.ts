import { readFileSync } from 'node:fs';
import {
  type CfnResource,
  Stack,
  Validations,
  type IPolicyValidationContext,
  type PolicyValidationPluginReport,
  type PolicyViolation,
} from 'aws-cdk-lib';
import { NagMessageLevel, NagPack, NagRuleCompliance, type NagPackProps } from 'cdk-nag';
import type { IConstruct } from 'constructs';
import {
  POLICY_BASELINE_VERSION,
  RULES,
  evaluateRule,
  isBlockingSeverity,
  resolveOptions,
} from '../catalogue.js';
import type { ExceptionIssue } from '../exceptions/exceptions.js';
import type {
  CfnTemplateJson,
  Finding,
  PolicyOptions,
  PolicyRule,
  ResolvedPolicyOptions,
} from '../types.js';

export interface BaselineChecksProps extends NagPackProps, PolicyOptions {
  /** Restrict evaluation to these rule IDs (default: every rule implemented for cdk-nag). */
  rules?: readonly string[];
  /** Exception-governance problems (e.g. expired exceptions) to report as BASE-EXC-001 errors. */
  exceptionIssues?: readonly ExceptionIssue[];
  /**
   * Permissions boundary each resource must carry (BASE-IAM-004), e.g. the boundary configured for
   * its Stage. When set it replaces `permissionsBoundaryArn`; `undefined` for a resource means no
   * boundary is configured there (rule not applicable).
   */
  permissionsBoundaryFor?: (node: CfnResource) => string | undefined;
}

/** Detailed per-resource result, kept for reports and tests. */
export interface BaselinePackFinding {
  ruleId: string;
  constructPath: string;
  logicalId: string;
  severity: PolicyRule['severity'];
  findings: Finding[];
  /** True when a cdk-nag acknowledgement (governed exception) suppressed the violation. */
  acknowledged: boolean;
}

export const GOVERNANCE_RULE_ID = 'BASE-EXC-001';

type RenderableStack = Stack & { _toCloudFormation?: () => unknown };

/** Same lookup cdk-nag performs: acknowledgements on the resource or any ancestor. */
export function isAcknowledged(node: IConstruct, ruleId: string): boolean {
  for (let c: IConstruct | undefined = node; c; c = c.node.scope) {
    for (const entry of c.node.metadata) {
      if (entry.type !== Validations.ACKNOWLEDGED_RULES_METADATA_KEY || !entry.data) continue;
      const ids = Object.keys(entry.data as Record<string, string>).map((k) =>
        k.replace(/^annotation::/i, ''),
      );
      if (ids.includes(ruleId)) return true;
    }
  }
  return false;
}

/**
 * cdk-nag (v3) rule pack implementing the proposed baseline.
 *
 * Rules are evaluated against the *synthesized* CloudFormation of each stack
 * (template file when invoked by the CDK validation framework), so tags added
 * by Aspects, escape-hatch overrides and resolved tokens are all visible.
 *
 * Register through `applyBaselinePolicies()` (preferred: also applies governed
 * exceptions) or `Validations.of(app).addPlugins(new BaselineChecks(app))`.
 */
export class BaselineChecks extends NagPack {
  public readonly name = 'BaselineChecks';
  public override readonly version = POLICY_BASELINE_VERSION;
  public override readonly ruleIds: string[];
  private readonly options: ResolvedPolicyOptions;
  private readonly activeRules: readonly PolicyRule[];
  private readonly exceptionIssues: readonly ExceptionIssue[];
  private readonly boundaryFor: ((node: CfnResource) => string | undefined) | undefined;
  private templatePaths = new Map<string, string>();
  private templates = new Map<Stack, CfnTemplateJson>();
  private details: BaselinePackFinding[] = [];

  constructor(scope?: IConstruct, props: BaselineChecksProps = {}) {
    super(scope, props);
    this.packName = 'BASE';
    this.options = resolveOptions(props);
    const wanted = props.rules ? new Set(props.rules) : undefined;
    this.activeRules = RULES.filter(
      (r) => r.engines.includes('cdk-nag') && (!wanted || wanted.has(r.id)),
    );
    this.ruleIds = this.activeRules.map((r) => r.id);
    this.exceptionIssues = props.exceptionIssues ?? [];
    this.boundaryFor = props.permissionsBoundaryFor;
  }

  /** Findings from the most recent validation run (including acknowledged ones). */
  public get lastFindings(): readonly BaselinePackFinding[] {
    return this.details;
  }

  public override validate(context: IPolicyValidationContext): PolicyValidationPluginReport {
    this.templatePaths = new Map(
      context.stackTemplates.map((s) => [s.stackConstructPath, s.templatePath]),
    );
    try {
      return super.validate(context);
    } finally {
      this.templatePaths = new Map();
    }
  }

  public override validateScope(scope: IConstruct): PolicyValidationPluginReport {
    this.templates = new Map();
    this.details = [];
    const base = super.validateScope(scope);
    const violations: PolicyViolation[] = base.violations.map((v) => ({
      ...v,
      violatingResources: v.violatingResources.map((r) => {
        const detail = this.details.find(
          (d) => d.ruleId === v.ruleName && d.constructPath === r.constructPath,
        );
        return detail ? { ...r, locations: [...new Set(detail.findings.map((f) => f.path))] } : r;
      }),
    }));
    for (const issue of this.exceptionIssues.filter((i) => i.level === 'error')) {
      violations.push({
        ruleName: GOVERNANCE_RULE_ID,
        description: `Policy exception governance: ${issue.message}`,
        severity: 'error',
        violatingResources: [
          {
            constructPath: scope.node.path || '/',
            locations: ['policies/exceptions/exceptions.yaml'],
          },
        ],
      });
    }
    return { success: violations.every((v) => v.severity !== 'error'), violations };
  }

  protected checkResource(node: CfnResource): void {
    const stack = Stack.of(node);
    const template = this.templateFor(stack);
    const logicalId = stack.resolve(node.logicalId) as string;
    const resource = template.Resources?.[logicalId];
    if (!resource) return;
    const options = this.boundaryFor
      ? { ...this.options, permissionsBoundaryArn: this.boundaryFor(node) }
      : this.options;
    for (const rule of this.activeRules) {
      if (!rule.resourceTypes.includes(resource.Type)) continue;
      const evaluation = evaluateRule(rule, logicalId, resource, template, options);
      const nonCompliant = evaluation !== 'not-applicable' && evaluation.length > 0;
      this.applyRule({
        ruleSuffixOverride: rule.id.slice('BASE-'.length),
        info: `Not met: ${rule.title} [${rule.severity}].`,
        explanation: `${rule.rationale} Remediation: ${rule.remediation} [Proposed baseline - not an approved control of any organization or regulator.]`,
        level: isBlockingSeverity(rule.severity) ? NagMessageLevel.ERROR : NagMessageLevel.WARN,
        node,
        rule: () =>
          evaluation === 'not-applicable'
            ? NagRuleCompliance.NOT_APPLICABLE
            : nonCompliant
              ? NagRuleCompliance.NON_COMPLIANT
              : NagRuleCompliance.COMPLIANT,
      });
      if (nonCompliant) {
        this.details.push({
          ruleId: rule.id,
          constructPath: node.node.path,
          logicalId,
          severity: rule.severity,
          findings: evaluation,
          acknowledged: isAcknowledged(node, rule.id),
        });
      }
    }
  }

  private templateFor(stack: Stack): CfnTemplateJson {
    let t = this.templates.get(stack);
    if (!t) {
      t = this.loadTemplate(stack);
      this.templates.set(stack, t);
    }
    return t;
  }

  private loadTemplate(stack: Stack): CfnTemplateJson {
    const file = this.templatePaths.get(stack.node.path);
    if (file) return JSON.parse(readFileSync(file, 'utf8')) as CfnTemplateJson;
    // Direct `validateScope()` use (tests, tooling): render in memory. Call after
    // `app.synth()` so Aspects (tags, permissions boundaries) have been applied.
    const render = (stack as RenderableStack)._toCloudFormation;
    if (typeof render !== 'function') {
      throw new Error('BaselineChecks: cannot render stack template for ' + stack.node.path);
    }
    return stack.resolve(render.call(stack)) as CfnTemplateJson;
  }
}
