import { fileURLToPath } from 'node:url';
import { CfnResource, Stack, Stage, Validations } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import {
  exceptionReason,
  findException,
  loadExceptionsFile,
  type ExceptionsCheckResult,
  type PolicyException,
} from '../exceptions/exceptions.js';
import { ENVIRONMENTS, type Environment } from '../types.js';
import { BaselineChecks, type BaselineChecksProps } from './pack.js';

/** The repository's governed exceptions file (shipped with this package). */
export const DEFAULT_EXCEPTIONS_FILE = fileURLToPath(
  new URL('../../exceptions/exceptions.yaml', import.meta.url),
);

/** The repository's suppression register (shipped with this package). */
export const DEFAULT_SUPPRESSIONS_FILE = fileURLToPath(
  new URL('../../exceptions/suppressions.yaml', import.meta.url),
);

/**
 * EXAMPLE registers for the live-validation sandbox (shipped with this package). Nothing loads
 * them: a project reviews their entries and adopts the ones it accepts into the two files above.
 */
export const SANDBOX_EXAMPLE_EXCEPTIONS_FILE = fileURLToPath(
  new URL('../../exceptions/examples/sandbox/exceptions.yaml', import.meta.url),
);
export const SANDBOX_EXAMPLE_SUPPRESSIONS_FILE = fileURLToPath(
  new URL('../../exceptions/examples/sandbox/suppressions.yaml', import.meta.url),
);

export interface ApplyBaselinePoliciesOptions extends BaselineChecksProps {
  /** Exceptions YAML path (default: `policies/exceptions/exceptions.yaml`); `false` disables exceptions. */
  exceptionsFile?: string | false;
  /** Evaluation date for exception expiry, `YYYY-MM-DD` (UTC). Default: today. */
  today?: string;
  /**
   * Environment of a construct, used to match exception `environments`.
   * Default: name of the nearest enclosing Stage when it is dev/staging/prod or the non-governed
   * sandbox (case-insensitive), otherwise `environment`.
   */
  resolveEnvironment?: (construct: IConstruct) => Environment | undefined;
  /** Record applied exceptions in template Metadata (`cdk_nag.rules_to_suppress`) for audit. Default: true. */
  recordExceptionsInTemplate?: boolean;
  /**
   * Register the pack with `Validations.of(scope).addPlugins()`. Set to false
   * when another hook registers the returned `pack` (e.g. infra's
   * `applyPolicyChecks({ additionalPacks })`). Default: true.
   */
  register?: boolean;
}

export interface AppliedException {
  exceptionId: string;
  ruleId: string;
  constructPath: string;
  environment: Environment;
}

export interface AppliedBaselinePolicies {
  pack: BaselineChecks;
  exceptions: ExceptionsCheckResult;
  applied: AppliedException[];
}

const NO_EXCEPTIONS: ExceptionsCheckResult = { ok: true, exceptions: [], active: [], issues: [] };

export function stageEnvironment(construct: IConstruct): Environment | undefined {
  const stage = Stage.of(construct);
  const name = stage?.stageName.toLowerCase();
  return (ENVIRONMENTS as readonly string[]).includes(name ?? '')
    ? (name as Environment)
    : undefined;
}

/**
 * Registers the baseline pack on an App or Stage and applies governed
 * exceptions as targeted cdk-nag acknowledgements.
 *
 * Call it AFTER all stacks are constructed (end of `bin/app.ts` / the policy
 * hook): acknowledgements are attached to the CfnResources that exist at call
 * time. Resources created later receive none (fail-closed).
 *
 * - Malformed exceptions file → throws (synth stops).
 * - Expired exceptions → not applied, and reported as BASE-EXC-001 errors.
 */
export function applyBaselinePolicies(
  scope: IConstruct,
  options: ApplyBaselinePoliciesOptions = {},
): AppliedBaselinePolicies {
  const file = options.exceptionsFile ?? DEFAULT_EXCEPTIONS_FILE;
  const exceptions =
    file === false
      ? NO_EXCEPTIONS
      : loadExceptionsFile(file, options.today ? { today: options.today } : {});
  const malformed = exceptions.issues.filter((i) => i.code === 'MALFORMED');
  if (malformed.length > 0) {
    throw new Error(
      `Policy exceptions file ${String(file)} is malformed:\n` +
        malformed.map((i) => `  - ${i.message}`).join('\n'),
    );
  }
  const resolve =
    options.resolveEnvironment ?? ((c: IConstruct) => stageEnvironment(c) ?? options.environment);
  const applied = acknowledgeExceptions(
    scope,
    exceptions.active,
    resolve,
    options.recordExceptionsInTemplate ?? true,
  );
  const pack = new BaselineChecks(scope, { ...options, exceptionIssues: exceptions.issues });
  if (options.register ?? true) Validations.of(scope).addPlugins(pack);
  return { pack, exceptions, applied };
}

/** Attaches `Validations.acknowledge()` for every active exception that matches a CfnResource. */
export function acknowledgeExceptions(
  scope: IConstruct,
  active: readonly PolicyException[],
  resolveEnvironment: (construct: IConstruct) => Environment | undefined,
  recordInTemplate = true,
): AppliedException[] {
  const applied: AppliedException[] = [];
  if (active.length === 0) return applied;
  for (const node of scope.node.findAll()) {
    if (!CfnResource.isCfnResource(node)) continue;
    const environment = resolveEnvironment(node);
    if (!environment) continue;
    const logicalId = Stack.of(node).resolve(node.logicalId) as string;
    for (const exc of active) {
      const match = findException([exc], {
        ruleId: exc.ruleId,
        environment,
        cdkPath: node.node.path,
        logicalId,
      });
      if (!match) continue;
      const reason = exceptionReason(exc);
      Validations.of(node).acknowledge({ id: exc.ruleId, reason });
      if (recordInTemplate) recordSuppression(node, exc.ruleId, reason);
      applied.push({
        exceptionId: exc.id,
        ruleId: exc.ruleId,
        constructPath: node.node.path,
        environment,
      });
    }
  }
  return applied;
}

/** cdk-nag v2-compatible audit metadata (`cdk_nag.rules_to_suppress`). */
function recordSuppression(node: CfnResource, id: string, reason: string): void {
  const existing = node.getMetadata('cdk_nag') as
    { rules_to_suppress?: { id: string; reason: string }[] } | undefined;
  const rules = [...(existing?.rules_to_suppress ?? []).filter((r) => r.id !== id), { id, reason }];
  node.addMetadata('cdk_nag', { ...existing, rules_to_suppress: rules });
}
