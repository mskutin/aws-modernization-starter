/**
 * Shared types for the proposed policy baseline.
 *
 * DISCLAIMER: every rule in this package is a *proposed baseline* for this
 * reference implementation. None of them is an approved control of any organization or
 * regulator. Each project must review and approve the rule set before relying
 * on it.
 */

/** The governed environments: the only allowed values of the `Environment` tag (BASE-TAG-002). */
export const BASELINE_ENVIRONMENTS = ['dev', 'staging', 'prod'] as const;
export type BaselineEnvironment = (typeof BASELINE_ENVIRONMENTS)[number];

/**
 * Every environment a governed exception or suppression-register entry may be scoped to: the
 * governed environments plus `sandbox`, the opt-in, non-governed live-validation stage (an
 * ordinary, dedicated AWS account). `sandbox` exists only so that its deviations are governed per
 * environment; it is never an allowed `Environment` tag value (the sandbox stage waives
 * BASE-TAG-002 by a governed exception), and an entry scoped to it alone never applies outside a
 * `Sandbox` stage.
 */
export const ENVIRONMENTS = [...BASELINE_ENVIRONMENTS, 'sandbox'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const isBaselineEnvironment = (v: unknown): v is BaselineEnvironment =>
  typeof v === 'string' && (BASELINE_ENVIRONMENTS as readonly string[]).includes(v);

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Engines that implement a rule. */
export type Engine = 'cdk-nag' | 'guard';

/** Minimal structural view of a CloudFormation resource as it appears in a template. */
export interface CfnResourceJson {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Metadata?: Record<string, unknown>;
  Condition?: string;
  DependsOn?: string | string[];
}

export interface CfnTemplateJson {
  Resources?: Record<string, CfnResourceJson>;
  [key: string]: unknown;
}

/** A single reason a resource is non-compliant. `path` is slash-separated, e.g. `Properties/Tags`. */
export interface Finding {
  path: string;
  message: string;
}

/** `not-applicable`, or the list of findings (an empty list means compliant). */
export type Evaluation = 'not-applicable' | Finding[];

export interface LambdaPolicyOptions {
  /** Allowed `Runtime` values for zip-packaged functions. */
  allowedRuntimes: readonly string[];
  /** Upper bound for `Timeout` (seconds). */
  maxTimeoutSeconds: number;
}

export interface PolicyOptions {
  /**
   * Fallback environment used when a resource has no valid `Environment` tag.
   * The tag wins when both are present (Guard can only see the tag).
   */
  environment?: Environment;
  /**
   * When set, every IAM role must carry this permissions boundary (BASE-IAM-004).
   * Use `'*'` to require *a* boundary without pinning its ARN.
   */
  permissionsBoundaryArn?: string;
  lambda?: Partial<LambdaPolicyOptions>;
  /** Additional IAM actions allowed on `Resource: "*"` (BASE-IAM-002). Document each one. */
  extraResourceWildcardActions?: readonly string[];
}

export interface ResolvedPolicyOptions {
  environment: Environment | undefined;
  permissionsBoundaryArn: string | undefined;
  lambda: LambdaPolicyOptions;
  resourceWildcardActions: ReadonlySet<string>;
}

export interface RuleContext {
  logicalId: string;
  resource: CfnResourceJson;
  /** Whole template, for cross-resource checks (e.g. bucket policy → bucket). */
  template: CfnTemplateJson;
  /** Effective environment for this resource (tag first, then option). */
  environment: Environment | undefined;
  options: ResolvedPolicyOptions;
}

export interface PolicyRule {
  /** Stable rule ID, e.g. `BASE-S3-001`. */
  id: string;
  title: string;
  description: string;
  rationale: string;
  severity: Severity;
  engines: readonly Engine[];
  /** Resource types the rule inspects. */
  resourceTypes: readonly string[];
  /** When set, the rule only applies to resources in these environments. */
  environments?: readonly Environment[];
  remediation: string;
  /** Optional notes: approximations, engine differences, related AwsSolutions rules. */
  notes?: string;
  evaluate(ctx: RuleContext): Evaluation;
}

/** Guard rule names cannot contain `-`; `BASE-S3-001` ⇄ `BASE_S3_001`. */
export const guardRuleName = (ruleId: string): string => ruleId.replaceAll('-', '_');
export const ruleIdFromGuardName = (name: string): string => name.replaceAll('_', '-');
