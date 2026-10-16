/**
 * Policy hook: registers policy-as-code packs on an App or Stage.
 *
 * cdk-nag 3.x packs are CDK policy-validation plugins (`Validations.of(app)
 * .addPlugins(...)`), not Aspects. Error-level findings fail `cdk synth`; warnings (e.g. the
 * advisory BASE-LMB-004) are reported but do not fail it.
 *
 * Suppressions are GOVERNED. `acknowledgeRule()`,
 * `acknowledgeAnnotation()` and `acknowledgeCfnValidate()` resolve every acknowledgement against
 * the suppression register (`policies/exceptions/suppressions.yaml`, see docs/policy-as-code.md) and
 * attach it ONLY to the resources the matching entry names — never to a whole construct subtree.
 * No active entry, more than one, an overdue review date or an environment the entry does not list
 * throws while the construct is built. `applyPolicyChecks()` additionally registers
 * `SuppressionAuditPlugin`, which re-audits every acknowledgement in the app at synth time
 * (including direct `Validations.acknowledge()` calls) with violations CDK cannot suppress.
 *
 * The infra app wires additional packs (e.g. the `@starter/policies` NagPack)
 * through `additionalPacks`.
 */
import {
  DEFAULT_EXCEPTIONS_FILE,
  DEFAULT_SUPPRESSIONS_FILE,
  SuppressionAuditPlugin,
  loadExceptionsFile,
  loadSuppressionsFile,
  resolveSuppression,
  suppressionReason,
  type SuppressionRegister,
} from '@starter/policies';
import { Aspects, Stage, Validations, type IPolicyValidationPlugin } from 'aws-cdk-lib';
import { AwsSolutionsChecks, WriteNagSuppressionsToCloudFormationAspect } from 'cdk-nag';
import type { IConstruct } from 'constructs';

/** A plugin instance, or a factory that receives the scope (NagPack ctor needs it). */
export type PolicyPack = IPolicyValidationPlugin | ((scope: IConstruct) => IPolicyValidationPlugin);

export interface PolicyHookOptions {
  /** Packs to run in addition to AwsSolutionsChecks. */
  readonly additionalPacks?: readonly PolicyPack[];
  /** Include rule explanations in findings. @default true */
  readonly verbose?: boolean;
  /**
   * Copy acknowledgments into template Metadata (`cdk_nag.rules_to_suppress`)
   * so template-level tools (cfn-guard, checkov, auditors, `check-exceptions`)
   * see the reasons and register citations.
   * @default true
   */
  readonly writeSuppressionsToCloudFormation?: boolean;
  /** Disable the AwsSolutions pack (tests of custom packs only). @default true */
  readonly awsSolutions?: boolean;
  /**
   * Audit every acknowledgement in the app at synth time against the suppression register and
   * the governed exceptions (`SuppressionAuditPlugin`). @default true
   */
  readonly auditSuppressions?: boolean;
  /**
   * Governed exceptions file whose `[EXC-NNNN]` citations the audit accepts.
   * @default policies/exceptions/exceptions.yaml
   */
  readonly exceptionsFile?: string;
}

let registerOverride: SuppressionRegister | undefined;
let repositoryRegister: SuppressionRegister | undefined;

/** The register acknowledgements are resolved against (default: the repository file, loaded once). */
export function suppressionRegister(): SuppressionRegister {
  if (registerOverride) return registerOverride;
  repositoryRegister ??= loadSuppressionsFile(DEFAULT_SUPPRESSIONS_FILE);
  return repositoryRegister;
}

/**
 * Test hook: resolve acknowledgements (and audit) against `register`; `undefined` restores the
 * repository register. CI re-audits the synthesized templates against the committed file
 * independently (`check-exceptions --templates`), so an override cannot hide a suppression there.
 */
export function useSuppressionRegister(register: SuppressionRegister | undefined): void {
  registerOverride = register;
}

/**
 * Registers the packs on `scope` (App or Stage) and returns them. Call it
 * after all stages are constructed so the metadata writer reaches them.
 */
export function applyPolicyChecks(
  scope: Stage,
  options: PolicyHookOptions = {},
): IPolicyValidationPlugin[] {
  const verbose = options.verbose ?? true;
  const packs: IPolicyValidationPlugin[] = [];
  if (options.awsSolutions ?? true) {
    packs.push(new AwsSolutionsChecks(scope, { verbose }));
  }
  if (options.writeSuppressionsToCloudFormation ?? true) {
    // Aspects do not cross Stage boundaries, so register the metadata writer on
    // the scope AND on every nested Stage that already exists.
    const stages = [scope, ...scope.node.findAll().filter((c): c is Stage => Stage.isStage(c))];
    for (const stage of new Set(stages)) {
      Aspects.of(stage).add(new WriteNagSuppressionsToCloudFormationAspect());
    }
  }
  for (const pack of options.additionalPacks ?? []) {
    packs.push(typeof pack === 'function' ? pack(scope) : pack);
  }
  if (options.auditSuppressions ?? true) {
    const exceptions = loadExceptionsFile(options.exceptionsFile ?? DEFAULT_EXCEPTIONS_FILE);
    packs.push(
      new SuppressionAuditPlugin({
        register: suppressionRegister(),
        exceptions: exceptions.active,
      }),
    );
  }
  if (packs.length > 0) Validations.of(scope).addPlugins(...packs);
  return packs;
}

/** A recorded acknowledgment (for audit listings and stale-suppression tests). */
export interface AcknowledgmentRecord {
  /** Node the acknowledgment is attached to: a CloudFormation resource, or the annotated construct. */
  readonly path: string;
  /** Acknowledged id (`AwsSolutions-…`, `Annotation::@aws-cdk/…`, `CloudFormation-Validate::…`). */
  readonly id: string;
  /** Reason written to the construct metadata: `[SUP-NNNN] <register justification> (owner; review by)`. */
  readonly reason: string;
  /** Register entry that governs it. */
  readonly suppressionId: string;
  /** Construct passed to acknowledge*() (diagnostics). */
  readonly requestedPath: string;
  /** The in-code note passed by the caller. */
  readonly note: string;
}

const registry: AcknowledgmentRecord[] = [];
let acknowledgmentsEnabled = true;

/** Every acknowledgment made in this process (target path, rule id, register reason). */
export function recordedAcknowledgments(): readonly AcknowledgmentRecord[] {
  return registry;
}

/**
 * Test hook: when disabled, acknowledgments are resolved and recorded but NOT applied, so a
 * test can compare raw findings with the acknowledgments (no stale entries).
 */
export function setAcknowledgmentsEnabled(enabled: boolean): void {
  acknowledgmentsEnabled = enabled;
}

function acknowledge(construct: IConstruct, id: string, note: string): void {
  if (note.trim().length < 20) {
    throw new Error(`Acknowledgment of ${id} on ${construct.node.path} needs a meaningful reason`);
  }
  // Throws UngovernedSuppressionError unless exactly one active register entry covers it.
  const { entry, targets } = resolveSuppression(construct, id, suppressionRegister());
  const reason = suppressionReason(entry);
  for (const target of targets) {
    registry.push({
      path: target.node.path,
      id,
      reason,
      suppressionId: entry.id,
      requestedPath: construct.node.path,
      note,
    });
    if (acknowledgmentsEnabled) Validations.of(target).acknowledge({ id, reason });
  }
}

/**
 * Acknowledges ONE policy rule (or one finding, e.g. `AwsSolutions-IAM5[Resource::*]`) under
 * `construct`, on exactly the resources its suppression-register entry names. BASE-* rules are
 * rejected: they are waived only by governed exceptions (policies/exceptions/exceptions.yaml).
 */
export function acknowledgeRule(construct: IConstruct, id: string, reason: string): void {
  if (!/^[A-Za-z][\w-]*-\w+(\[.+\])?$/.test(id)) {
    throw new Error(
      `Acknowledgment id "${id}" must be a single rule id, optionally with [finding]`,
    );
  }
  acknowledge(construct, id, reason);
}

/** Acknowledges ONE CDK construct annotation warning (`@aws-cdk/<module>:<id>`). */
export function acknowledgeAnnotation(construct: IConstruct, id: string, reason: string): void {
  if (!/^@aws-cdk\/[\w-]+:\w+$/.test(id)) {
    throw new Error(`Annotation id "${id}" must look like @aws-cdk/<module>:<warningId>`);
  }
  acknowledge(construct, `Annotation::${id}`, reason);
}

/** Acknowledges ONE CloudFormation Validate (cfn-lint) finding, e.g. `W3010`. */
export function acknowledgeCfnValidate(construct: IConstruct, code: string, reason: string): void {
  if (!/^[EWI]\d{4}$/.test(code)) {
    throw new Error(`CloudFormation Validate code "${code}" must look like W3010`);
  }
  acknowledge(construct, `CloudFormation-Validate::${code}`, reason);
}
