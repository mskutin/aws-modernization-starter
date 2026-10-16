/**
 * Options for the proposed baseline (`applyBaselinePolicies`), shared by `bin/app.ts` and the
 * tests so both evaluate the pack identically.
 *
 * BASE-IAM-004 (roles carry the permissions boundary) is enforced PER STAGE, against the exact
 * boundary ARN that stage's configuration attaches: the imported landing-zone foundation always has one
 * (mandatory there); the sandbox foundation only when `permissionsBoundaryPolicyArn` is set. A
 * stage without a configured boundary is not applicable — and no longer switches enforcement off
 * for the other stages of the same synth.
 */
import { Stage, type CfnResource } from 'aws-cdk-lib';
import type { EnvironmentConfig } from '../environments/index.js';
import { STAGE_IDS } from '../stages/workload-stage.js';

/** The permissions boundary the stage of `config` attaches to every role, if any. */
export function permissionsBoundaryOf(config: EnvironmentConfig): string | undefined {
  return config.foundation.permissionsBoundaryPolicyArn;
}

export function hasPermissionsBoundary(config: EnvironmentConfig): boolean {
  return permissionsBoundaryOf(config) !== undefined;
}

export interface BaselinePolicyOptions {
  register: false;
  /** Expected boundary of a resource: the boundary of its stage's configuration. */
  permissionsBoundaryFor: (node: CfnResource) => string | undefined;
}

export function baselinePolicyOptions(
  configs: readonly EnvironmentConfig[],
): BaselinePolicyOptions {
  const byStage = new Map(configs.map((c) => [STAGE_IDS[c.name], permissionsBoundaryOf(c)]));
  return {
    register: false,
    permissionsBoundaryFor: (node) => {
      const stage = Stage.of(node);
      return stage ? byStage.get(stage.stageName) : undefined;
    },
  };
}
