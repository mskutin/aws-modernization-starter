/**
 * @starter/policies — proposed policy-as-code baseline for the AWS modernization starter.
 *
 * NOT an approved control set of any organization or regulator. Review and approve per project.
 */
export * from './types.js';
export {
  DISCLAIMER,
  POLICY_BASELINE_VERSION,
  RULES,
  evaluateRule,
  evaluateTemplate,
  isBlockingSeverity,
  resolveOptions,
  ruleById,
  type TemplateFinding,
} from './catalogue.js';
export * from './exceptions/exceptions.js';
export * from './exceptions/suppressions.js';
export * from './exceptions/audit.js';
export * from './exceptions/approvals.js';
export { REFERENCE_ENTRY_DIGESTS, unpinnedReferenceMessage } from './exceptions/reference-pins.js';
export {
  BaselineChecks,
  GOVERNANCE_RULE_ID,
  isAcknowledged,
  type BaselineChecksProps,
  type BaselinePackFinding,
} from './cdk/pack.js';
export {
  DEFAULT_EXCEPTIONS_FILE,
  DEFAULT_SUPPRESSIONS_FILE,
  SANDBOX_EXAMPLE_EXCEPTIONS_FILE,
  SANDBOX_EXAMPLE_SUPPRESSIONS_FILE,
  acknowledgeExceptions,
  applyBaselinePolicies,
  stageEnvironment,
  type AppliedException,
  type AppliedBaselinePolicies,
  type ApplyBaselinePoliciesOptions,
} from './cdk/apply.js';
export {
  SuppressionAuditPlugin,
  UngovernedSuppressionError,
  acknowledgementsIn,
  auditConstructTree,
  findOwner,
  relativePath,
  resolveSuppression,
  type RecordedAcknowledgement,
  type SuppressionAuditPluginProps,
  type SuppressionResolution,
  type TreeAuditIssue,
  type TreeAuditOptions,
} from './cdk/suppressions.js';
export { REQUIRED_TAG_KEYS, TAGGED_RESOURCE_TYPES } from './rules/governance.js';
export { RESOURCE_WILDCARD_ALLOWED_ACTIONS } from './rules/iam.js';
export { DEFAULT_ALLOWED_RUNTIMES, DEFAULT_MAX_TIMEOUT_SECONDS } from './rules/lambda.js';
export {
  PINNED_GUARD_VERSION,
  findTemplates,
  runGuardTests,
  runGuardValidate,
  summarize,
  type GuardFinding,
  type GuardValidateResult,
} from './guard/runner.js';
export { toJUnit, toMarkdown, toSarif, writeGuardReports } from './guard/reports.js';
