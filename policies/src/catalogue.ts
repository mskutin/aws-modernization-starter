import { cloudFrontRules } from './rules/cloudfront.js';
import { dynamoDbRules } from './rules/dynamodb.js';
import { ecsRules } from './rules/ecs.js';
import { governanceRules } from './rules/governance.js';
import { RESOURCE_WILDCARD_ALLOWED_ACTIONS, iamRules } from './rules/iam.js';
import {
  DEFAULT_ALLOWED_RUNTIMES,
  DEFAULT_MAX_TIMEOUT_SECONDS,
  lambdaRules,
} from './rules/lambda.js';
import { loggingRules } from './rules/logging.js';
import { rdsRules } from './rules/rds.js';
import { s3Rules } from './rules/s3.js';
import { environmentOf } from './rules/util.js';
import type {
  CfnResourceJson,
  CfnTemplateJson,
  Engine,
  Environment,
  Evaluation,
  PolicyOptions,
  PolicyRule,
  ResolvedPolicyOptions,
  Severity,
} from './types.js';

export const POLICY_BASELINE_VERSION = '0.1.0';

export const DISCLAIMER =
  'Proposed baseline for the AWS modernization starter. NOT an approved control set of any organization or regulator; ' +
  'each project must review, adapt and formally approve these rules before relying on them.';

export const RULES: readonly PolicyRule[] = [
  ...s3Rules,
  ...cloudFrontRules,
  ...ecsRules,
  ...iamRules,
  ...lambdaRules,
  ...rdsRules,
  ...dynamoDbRules,
  ...loggingRules,
  ...governanceRules,
];

const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r]));

export const ruleById = (id: string): PolicyRule | undefined => RULES_BY_ID.get(id);

/** Severities that fail CI (and are reported as cdk-nag errors). `low` is advisory. */
export const isBlockingSeverity = (s: Severity): boolean => s !== 'low';

export function resolveOptions(options: PolicyOptions = {}): ResolvedPolicyOptions {
  return {
    environment: options.environment,
    permissionsBoundaryArn: options.permissionsBoundaryArn,
    lambda: {
      allowedRuntimes: options.lambda?.allowedRuntimes ?? DEFAULT_ALLOWED_RUNTIMES,
      maxTimeoutSeconds: options.lambda?.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
    },
    resourceWildcardActions: new Set([
      ...Object.keys(RESOURCE_WILDCARD_ALLOWED_ACTIONS),
      ...(options.extraResourceWildcardActions ?? []),
    ]),
  };
}

/** Evaluates one rule against one resource, applying type and environment scoping. */
export function evaluateRule(
  rule: PolicyRule,
  logicalId: string,
  resource: CfnResourceJson,
  template: CfnTemplateJson,
  options: ResolvedPolicyOptions,
): Evaluation {
  if (!rule.resourceTypes.includes(resource.Type)) return 'not-applicable';
  const environment: Environment | undefined = environmentOf(resource, options.environment);
  if (rule.environments && (!environment || !rule.environments.includes(environment))) {
    return 'not-applicable';
  }
  return rule.evaluate({ logicalId, resource, template, environment, options });
}

export interface TemplateFinding {
  ruleId: string;
  severity: Severity;
  logicalId: string;
  resourceType: string;
  /** `aws:cdk:path` metadata, when the template was synthesized by the CDK. */
  cdkPath: string | undefined;
  environment: Environment | undefined;
  path: string;
  message: string;
}

export const cdkPathOf = (resource: CfnResourceJson): string | undefined => {
  const p = resource.Metadata?.['aws:cdk:path'];
  return typeof p === 'string' ? p : undefined;
};

/**
 * Evaluates the TypeScript rule implementations directly against a template.
 * Used for parity tests with Guard and for offline analysis; the cdk-nag pack
 * uses the same functions at synth time.
 */
export function evaluateTemplate(
  template: CfnTemplateJson,
  options: PolicyOptions = {},
  engine?: Engine,
): TemplateFinding[] {
  const resolved = resolveOptions(options);
  const out: TemplateFinding[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    for (const rule of RULES) {
      if (engine && !rule.engines.includes(engine)) continue;
      const result = evaluateRule(rule, logicalId, resource, template, resolved);
      if (result === 'not-applicable') continue;
      for (const f of result) {
        out.push({
          ruleId: rule.id,
          severity: rule.severity,
          logicalId,
          resourceType: resource.Type,
          cdkPath: cdkPathOf(resource),
          environment: environmentOf(resource, resolved.environment),
          path: f.path,
          message: f.message,
        });
      }
    }
  }
  return out;
}
