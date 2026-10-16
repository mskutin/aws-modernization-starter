/**
 * CDK side of the suppression register (`policies/exceptions/suppressions.yaml`):
 *
 * - `resolveSuppression()` maps one in-code acknowledgement (construct + rule id) to the single
 *   active register entry that governs it and to the EXACT nodes it may be attached to (the
 *   CloudFormation resources named by the entry, or the annotated construct). Infra's
 *   `acknowledgeRule()` uses it, so an ungoverned, expired or over-broad acknowledgement throws
 *   while the construct is being built.
 * - `SuppressionAuditPlugin` is a CDK validation plugin that audits EVERY acknowledgement in the
 *   construct tree at synth time — including ones made by calling `Validations.acknowledge()`
 *   directly — and reports violations with severity `fatal`, which CDK does not allow to be
 *   acknowledged away.
 */
import { readFileSync } from 'node:fs';
import {
  CfnResource,
  Stack,
  Stage,
  Validations,
  type IPolicyValidationContext,
  type IPolicyValidationPlugin,
  type PolicyValidationPluginReport,
  type PolicyViolation,
} from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import { POLICY_BASELINE_VERSION } from '../catalogue.js';
import {
  exceptionScopeIssues,
  normalizeSuppressedId,
  registerScopeIssues,
} from '../exceptions/audit.js';
import type { ExceptionIssue, PolicyException } from '../exceptions/exceptions.js';
import {
  SUPPRESSION_GOVERNANCE_RULE_ID,
  citedRegisterId,
  isBaselineRuleId,
  matchesRelativeResource,
  suppressionKind,
  type SuppressionEntry,
  type SuppressionKind,
  type SuppressionRegister,
} from '../exceptions/suppressions.js';
import { isBaselineEnvironment, type CfnResourceJson, type CfnTemplateJson } from '../types.js';
import { stageEnvironment } from './apply.js';

export const REGISTER_FILE_HINT = 'policies/exceptions/suppressions.yaml';
/** Appended to resolution errors in a `Sandbox` stage: its entries ship only as an example. */
const sandboxNote = (environment: string | undefined): string =>
  environment === 'sandbox'
    ? ` The live-validation sandbox ships its entries only as an EXAMPLE register (policies/exceptions/examples/sandbox/): review them and adopt the ones you accept into ${REGISTER_FILE_HINT} before synthesizing the sandbox (docs/policy-as-code.md).`
    : '';

export class UngovernedSuppressionError extends Error {
  public override readonly name = 'UngovernedSuppressionError';
}

export interface SuppressionResolution {
  entry: SuppressionEntry;
  /** Instance of `entry.construct` that owns the acknowledged construct. */
  owner: IConstruct;
  /** Nodes to acknowledge on: CfnResources (rules, CloudFormation Validate) or the annotated construct. */
  targets: IConstruct[];
}

const JSII_RTTI = Symbol.for('jsii.rtti');

interface ClassInfo {
  name: string;
  /** jsii type name when this class is the one carrying runtime type info (`aws-cdk-lib.Stack`). */
  fqn: string | undefined;
}

/** Classes along the prototype chain, nearest first. */
function classChain(node: IConstruct): ClassInfo[] {
  const chain: ClassInfo[] = [];
  for (
    let proto: unknown = Object.getPrototypeOf(node);
    proto;
    proto = Object.getPrototypeOf(proto)
  ) {
    const ctor = (proto as { constructor?: unknown }).constructor;
    if (typeof ctor !== 'function' || ctor === Object) continue;
    const rtti = Object.prototype.hasOwnProperty.call(ctor, JSII_RTTI)
      ? (ctor as unknown as Record<symbol, { fqn?: unknown } | undefined>)[JSII_RTTI]
      : undefined;
    chain.push({ name: ctor.name, fqn: typeof rtti?.fqn === 'string' ? rtti.fqn : undefined });
  }
  return chain;
}

/**
 * Class names a register entry's `construct` may use: the JavaScript class names plus the jsii
 * type names of library classes (aws-cdk-lib renames decorated classes, e.g. `Topic` → `Topic2`).
 */
function classNames(node: IConstruct): string[] {
  const names = new Set<string>();
  for (const c of classChain(node)) {
    names.add(c.name);
    if (c.fqn) names.add(c.fqn.split('.').pop() ?? c.fqn);
  }
  return [...names];
}

/**
 * True for instances of jsii library classes (aws-cdk-lib, constructs, cdk-nag): every class
 * before the first one carrying jsii type info is a renamed copy of it (`Topic2` for `Topic`).
 */
function isLibraryConstruct(node: IConstruct): boolean {
  const chain = classChain(node);
  const typed = chain.findIndex((c) => c.fqn !== undefined);
  if (typed < 0) return false;
  const simple = chain[typed]?.fqn?.split('.').pop() ?? '';
  return chain.slice(0, typed + 1).every((c) => c.name.replace(/\d+$/, '') === simple);
}

function* selfAndAncestors(node: IConstruct): Generator<IConstruct> {
  for (let c: IConstruct | undefined = node; c; c = c.node.scope) yield c;
}

/** Nearest ancestor-or-self that is an instance of class `className`. */
export function findOwner(node: IConstruct, className: string): IConstruct | undefined {
  for (const c of selfAndAncestors(node)) {
    if (classNames(c).includes(className)) return c;
  }
  return undefined;
}

export function relativePath(owner: IConstruct, node: IConstruct): string {
  if (owner.node.path === '') return node.node.path;
  return node.node.path === owner.node.path ? '' : node.node.path.slice(owner.node.path.length + 1);
}

/** Nodes under `target` (inclusive) that the entry may cover. */
function scopeNodes(
  target: IConstruct,
  owner: IConstruct,
  entry: SuppressionEntry,
  kind: SuppressionKind,
): IConstruct[] {
  return target.node
    .findAll()
    .filter(
      (n) =>
        (kind === 'annotation' || CfnResource.isCfnResource(n)) &&
        matchesRelativeResource(entry, relativePath(owner, n)),
    );
}

/** Nearest project (non-library) construct that is not a Stack or Stage: the likely owner class. */
function suggestedOwner(target: IConstruct): IConstruct | undefined {
  for (const c of selfAndAncestors(target)) {
    if (Stack.isStack(c) || Stage.isStage(c)) return undefined;
    if (!isLibraryConstruct(c)) return c;
  }
  return undefined;
}

function ungovernedMessage(
  target: IConstruct,
  ruleId: string,
  kind: SuppressionKind,
  candidates: readonly SuppressionEntry[],
): string {
  const owner = suggestedOwner(target);
  const ownerClass = owner
    ? (classChain(owner)[0]?.name ?? '<ConstructClass>')
    : '<ConstructClass>';
  const resources = owner
    ? target.node
        .findAll()
        .filter((n) => kind === 'annotation' || CfnResource.isCfnResource(n))
        .map((n) => relativePath(owner, n))
        .filter((p) => p !== '')
    : [];
  const env = stageEnvironment(target);
  const lines = [
    `Ungoverned acknowledgement: ${ruleId} on ${target.node.path}.`,
    `Every acknowledgement needs an active entry in ${REGISTER_FILE_HINT} (docs/policy-as-code.md, "Suppression register").`,
  ];
  for (const c of candidates) {
    lines.push(
      `  ${c.id} (${c.construct}: ${c.resources.join(', ')}) exists for ${ruleId} but does not cover this construct.`,
    );
  }
  lines.push(
    ...(sandboxNote(env) ? [sandboxNote(env).trim()] : []),
    'Suggested entry (keep only the resources that carry the finding):',
    '  - id: SUP-NNNN',
    `    ruleId: ${ruleId}`,
    `    construct: ${ownerClass}`,
    '    resources:',
    ...(resources.length > 0 ? resources : ['<relative/path/Resource>']).map((r) => `      - ${r}`),
    `    environments: [${env ?? 'dev, staging, prod'}]`,
    ...(ruleId === 'AwsSolutions-IAM5[Resource::*]'
      ? ['    allowedActions: [<exact actions>]']
      : []),
    '    justification: <why the finding is acceptable and what mitigates it>',
    '    owner: <accountable role>',
    '    createdAt: <today>',
    '    reviewedAt: <today>',
    '    reviewBy: <at most 180 days later>',
  );
  return lines.join('\n');
}

/**
 * Resolves the register entry that governs acknowledging `ruleId` on `target`, and the exact
 * nodes to acknowledge on. Throws `UngovernedSuppressionError` when no entry (or more than one)
 * covers it, the entry is inactive (review overdue, invalid) or the stage environment is not listed.
 */
export function resolveSuppression(
  target: IConstruct,
  ruleId: string,
  register: SuppressionRegister,
): SuppressionResolution {
  if (isBaselineRuleId(ruleId)) {
    throw new UngovernedSuppressionError(
      `${ruleId} on ${target.node.path}: BASE-* findings are waived only by governed exceptions in policies/exceptions/exceptions.yaml (applied by applyBaselinePolicies), never in code.`,
    );
  }
  const kind = suppressionKind(ruleId);
  if (!kind) {
    throw new UngovernedSuppressionError(
      `"${ruleId}" on ${target.node.path} is not an acknowledgeable id (cdk-nag rule, Annotation::@aws-cdk/<module>:<id> or CloudFormation-Validate::<code>).`,
    );
  }
  const malformed = register.issues.filter((i) => i.code === 'MALFORMED');
  if (malformed.length > 0) {
    throw new UngovernedSuppressionError(
      `Suppression register ${register.file ?? REGISTER_FILE_HINT} is malformed:\n` +
        malformed.map((i) => `  - ${i.message}`).join('\n'),
    );
  }
  const candidates = register.suppressions.filter((s) => s.ruleId === ruleId);
  const matches: SuppressionResolution[] = [];
  for (const entry of candidates) {
    const owner = findOwner(target, entry.construct);
    if (!owner) continue;
    const targets = scopeNodes(target, owner, entry, kind);
    if (targets.length > 0) matches.push({ entry, owner, targets });
  }
  if (matches.length === 0) {
    throw new UngovernedSuppressionError(ungovernedMessage(target, ruleId, kind, candidates));
  }
  // A scope may have one entry per environment (the governed-environment entry and its
  // non-governed sandbox twin): the stage's environment selects it. Outside a known stage only
  // entries listing a governed environment apply, so a sandbox-only deviation never reaches the
  // mini-stack or other stacks.
  const environment = stageEnvironment(target);
  const applicable = matches.filter((m) =>
    environment !== undefined
      ? m.entry.environments.includes(environment)
      : m.entry.environments.some(isBaselineEnvironment),
  );
  const [match, ...others] = applicable.length > 0 ? applicable : matches;
  if (!match) {
    throw new UngovernedSuppressionError(ungovernedMessage(target, ruleId, kind, candidates));
  }
  if (others.length > 0) {
    throw new UngovernedSuppressionError(
      `${ruleId} on ${target.node.path} matches several register entries (${matches.map((m) => m.entry.id).join(', ')}); narrow their resources so exactly one applies.`,
    );
  }
  if (!register.active.includes(match.entry)) {
    const why = register.issues
      .filter((i) => i.exceptionId === match.entry.id && i.level === 'error')
      .map((i) => i.message);
    throw new UngovernedSuppressionError(
      `${ruleId} on ${target.node.path}: register entry ${match.entry.id} is not active` +
        (why.length > 0 ? `:\n  - ${why.join('\n  - ')}` : '.') +
        sandboxNote(environment),
    );
  }
  if (
    environment !== undefined
      ? !match.entry.environments.includes(environment)
      : !match.entry.environments.some(isBaselineEnvironment)
  ) {
    throw new UngovernedSuppressionError(
      `${ruleId} on ${target.node.path}: register entry ${match.entry.id} is limited to ${match.entry.environments.join('/')}, not ${environment ?? 'a construct outside a Dev/Staging/Prod/Sandbox stage'}.${sandboxNote(environment)}`,
    );
  }
  return match;
}

/** One acknowledgement recorded on a construct (`Validations.acknowledge()` metadata). */
export interface RecordedAcknowledgement {
  node: IConstruct;
  /** Id as governed (`AwsSolutions-…`, `BASE-…`, `Annotation::@aws-cdk/…`, `CloudFormation-Validate::…`). */
  ruleId: string;
  reason: string;
}

/** Every `Validations.acknowledge()` record in the tree. */
export function acknowledgementsIn(root: IConstruct): RecordedAcknowledgement[] {
  const out: RecordedAcknowledgement[] = [];
  for (const node of root.node.findAll()) {
    for (const entry of node.node.metadata) {
      if (entry.type !== Validations.ACKNOWLEDGED_RULES_METADATA_KEY || !entry.data) continue;
      for (const [id, reason] of Object.entries(entry.data as Record<string, unknown>)) {
        out.push({ node, ruleId: normalizeSuppressedId(id), reason: String(reason) });
      }
    }
  }
  return out;
}

/** A tree-audit issue, located on the construct that carries the acknowledgement. */
export interface TreeAuditIssue extends ExceptionIssue {
  constructPath: string;
}

export interface TreeAuditOptions {
  /** Active register entries. */
  suppressions: readonly SuppressionEntry[];
  /** Active governed exceptions. */
  exceptions: readonly PolicyException[];
  /** Synthesized template of a stack, for the IAM5 action check (optional). */
  templateOf?: (stack: Stack) => CfnTemplateJson | undefined;
}

/**
 * Audits every acknowledgement in the construct tree: it must cite an active entry for the same
 * rule, sit EXACTLY on a node that entry names (no ancestor-wide acknowledgements), and respect the
 * entry's environments and IAM action allowlist. CloudFormation Validate acknowledgements that cite
 * nothing are aws-cdk-lib's own (e.g. F3002 on flow logs) and are skipped.
 */
export function auditConstructTree(root: IConstruct, options: TreeAuditOptions): TreeAuditIssue[] {
  const issues: TreeAuditIssue[] = [];
  for (const { node, ruleId, reason } of acknowledgementsIn(root)) {
    const at = (found: readonly ExceptionIssue[]) =>
      issues.push(...found.map((i) => ({ ...i, constructPath: node.node.path })));
    const citation = citedRegisterId(reason);
    const kind = suppressionKind(ruleId);
    const baseline = isBaselineRuleId(ruleId);
    const where = node.node.path;
    if (kind === 'cfn-validate' && citation === undefined) continue;
    const ungoverned = (detail: string) =>
      at([
        {
          level: 'error',
          code: 'UNGOVERNED_SUPPRESSION',
          message: `${where}: acknowledgement of ${ruleId} ${detail}`,
        },
      ]);
    const environment = stageEnvironment(node);
    if (citation?.startsWith('EXC-') && (baseline || kind === 'rule')) {
      const exc = options.exceptions.find((e) => e.id === citation && e.ruleId === ruleId);
      if (!exc) {
        ungoverned(`cites ${citation}, which is not an active exception for this rule`);
        continue;
      }
      if (!CfnResource.isCfnResource(node)) {
        at([
          {
            level: 'error',
            code: 'SCOPE_MISMATCH',
            exceptionId: exc.id,
            message: `${where}: ${exc.id} must be applied to CloudFormation resources, not to a construct subtree`,
          },
        ]);
        continue;
      }
      const logicalId = Stack.of(node).resolve(node.logicalId) as string;
      at(exceptionScopeIssues(exc, where, { cdkPath: where, logicalId, environment }));
      continue;
    }
    if (citation?.startsWith('SUP-') && !baseline && kind !== undefined) {
      const entry = options.suppressions.find((e) => e.id === citation && e.ruleId === ruleId);
      if (!entry) {
        ungoverned(`cites ${citation}, which is not an active register entry for this rule`);
        continue;
      }
      const owner = findOwner(node, entry.construct);
      const exact =
        owner !== undefined &&
        (kind === 'annotation' || CfnResource.isCfnResource(node)) &&
        matchesRelativeResource(entry, relativePath(owner, node));
      let resource: CfnResourceJson | undefined;
      if (CfnResource.isCfnResource(node) && options.templateOf) {
        const stack = Stack.of(node);
        const logicalId = stack.resolve(node.logicalId) as string;
        resource = options.templateOf(stack)?.Resources?.[logicalId];
      }
      at(registerScopeIssues(entry, where, { cdkPathInScope: exact, environment }, resource));
      continue;
    }
    ungoverned(
      citation
        ? `cites ${citation}, which cannot govern ${baseline ? 'a BASE-* rule (use exceptions.yaml)' : 'this id'}`
        : 'cites no register entry or exception (use acknowledgeRule() with a suppressions.yaml entry)',
    );
  }
  return issues;
}

export interface SuppressionAuditPluginProps {
  /** Register used by `acknowledgeRule()` (its errors are reported too). */
  register: SuppressionRegister;
  /** Active governed exceptions (exceptions.yaml). */
  exceptions?: readonly PolicyException[];
}

/**
 * Synth-time audit of every acknowledgement in the app (CDK validation plugin). Violations are
 * reported with severity `fatal`: CDK never lets an acknowledgement suppress a fatal violation,
 * so the audit itself cannot be acknowledged away.
 */
export class SuppressionAuditPlugin implements IPolicyValidationPlugin {
  public readonly name = 'BaselineSuppressionAudit';
  public readonly version = POLICY_BASELINE_VERSION;
  public readonly ruleIds = [SUPPRESSION_GOVERNANCE_RULE_ID];

  constructor(private readonly props: SuppressionAuditPluginProps) {}

  public validate(context: IPolicyValidationContext): PolicyValidationPluginReport {
    const templates = new Map(
      context.stackTemplates.map((s) => [s.stackConstructPath, s.templatePath]),
    );
    const cache = new Map<string, CfnTemplateJson>();
    const templateOf = (stack: Stack): CfnTemplateJson | undefined => {
      const file = templates.get(stack.node.path);
      if (!file) return undefined;
      let t = cache.get(file);
      if (!t) {
        t = JSON.parse(readFileSync(file, 'utf8')) as CfnTemplateJson;
        cache.set(file, t);
      }
      return t;
    };
    return this.validateScope(context.appConstruct, templateOf);
  }

  /** Direct invocation (tests): audits the tree; IAM5 actions only when `templateOf` is given. */
  public validateScope(
    scope: IConstruct,
    templateOf?: (stack: Stack) => CfnTemplateJson | undefined,
  ): PolicyValidationPluginReport {
    const root = scope.node.path || '/';
    const issues: TreeAuditIssue[] = [
      ...this.props.register.issues
        .filter((i) => i.level === 'error')
        .map((i) => ({ ...i, constructPath: root })),
      ...auditConstructTree(scope, {
        suppressions: this.props.register.active,
        exceptions: this.props.exceptions ?? [],
        ...(templateOf ? { templateOf } : {}),
      }),
    ];
    const violations: PolicyViolation[] = issues.map((issue) => ({
      ruleName: SUPPRESSION_GOVERNANCE_RULE_ID,
      description: `Suppression governance (${issue.code}): ${issue.message}`,
      severity: 'fatal',
      violatingResources: [{ constructPath: issue.constructPath, locations: [REGISTER_FILE_HINT] }],
    }));
    return { success: violations.length === 0, violations };
  }
}
