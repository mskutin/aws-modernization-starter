/**
 * Per-run inputs of the sandbox stage that never live in the repository: the X-Origin-Verify secret and, for a deploy, proof that every
 * placeholder (account, run id, expiry, image digest, secret) was replaced.
 *
 * Offline synth and unit tests work with placeholders. `-c requireDeployInputs=true` (the deploy
 * command; never `cdk destroy`, so an expired run can still be torn down) refuses them — the same
 * pattern as `requireImageDigest`.
 */
import { readFileSync, statSync } from 'node:fs';
import { CfnRule, Fn, type Stack } from 'aws-cdk-lib';
import {
  PLACEHOLDER_ACCOUNT_ID,
  PLACEHOLDER_OPERATOR_PRINCIPAL_ARN,
  type EnvironmentConfig,
} from '../environments/schema.js';
import { PLACEHOLDER_SANDBOX_RUN } from '../environments/sandbox.js';
import { PLACEHOLDER_PREFIX_LIST_ID } from './region.js';

/** Placeholder X-Origin-Verify value for offline synth. Never deployable. */
export const PLACEHOLDER_ORIGIN_VERIFY_SECRET = 'placeholder-origin-verify-not-deployable';
/** ALB header conditions compare case-insensitively: demand a long random token. */
export const ORIGIN_VERIFY_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
/** Longest sandbox lifetime a deploy may announce in `starter:expires-at`. */
export const SANDBOX_MAX_TTL_HOURS = 72;

export function isDeployRequested(tryGetContext: (key: string) => unknown): boolean {
  return String(tryGetContext('requireDeployInputs') ?? 'false') === 'true';
}

/**
 * The X-Origin-Verify value: `-c originVerifySecretFile=<path>` (preferred: the run directory's
 * `origin-verify`, mode 0600, so the value never appears in a process list or shell history),
 * `-c originVerifySecret=<token>`, or the placeholder (offline synth only).
 */
export function resolveOriginVerifySecret(tryGetContext: (key: string) => unknown): string {
  const file = tryGetContext('originVerifySecretFile');
  const inline = tryGetContext('originVerifySecret');
  if (file !== undefined && file !== '' && inline !== undefined && inline !== '') {
    throw new Error('Pass originVerifySecret or originVerifySecretFile, not both');
  }
  let value: unknown = inline;
  if (typeof file === 'string' && file !== '') {
    const mode = statSync(file).mode;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `originVerifySecretFile ${file} must not be readable by group or others (chmod 600)`,
      );
    }
    value = readFileSync(file, 'utf8').trim();
  }
  if (value === undefined || value === '') return PLACEHOLDER_ORIGIN_VERIFY_SECRET;
  if (typeof value !== 'string' || !ORIGIN_VERIFY_SECRET_PATTERN.test(value)) {
    // Never echo the value: it is a secret.
    throw new Error('Invalid originVerifySecret: expected 32-128 characters of [A-Za-z0-9_-]');
  }
  return value;
}

export interface SandboxDeployInputs {
  readonly originVerifySecret: string;
  readonly imageDigestIsPlaceholder: boolean;
}

/**
 * The committed placeholders still in use by a sandbox config + inputs (as `-c` hints), without
 * time-dependent checks: account, operator role, run id, expiry, origin-facing prefix list (a
 * region without a confirmed id), origin-verify value, image digest.
 */
export function sandboxPlaceholders(
  config: EnvironmentConfig,
  inputs: SandboxDeployInputs,
): string[] {
  const found: string[] = [];
  if (config.account === PLACEHOLDER_ACCOUNT_ID) found.push('-c account.sandbox=<account id>');
  if (
    !config.operatorPrincipalArn ||
    config.operatorPrincipalArn === PLACEHOLDER_OPERATOR_PRINCIPAL_ARN
  ) {
    found.push('-c operatorPrincipalArn=<operator role ARN with path>');
  }
  if (!config.run || config.run.runId === PLACEHOLDER_SANDBOX_RUN.runId) {
    found.push('-c runId=sbx-<6 hex>');
  }
  if (!config.run || config.run.expiresAt === PLACEHOLDER_SANDBOX_RUN.expiresAt) {
    found.push('-c expiresAt=<ISO-8601 UTC>');
  }
  if (config.foundation.edge.cloudFrontOriginFacingPrefixListId === PLACEHOLDER_PREFIX_LIST_ID) {
    // No confirmed id for this region (lib/region.ts): never another region's id.
    found.push(
      `-c sandbox.originPrefixListId=<id of com.amazonaws.global.cloudfront.origin-facing in ${config.region}>`,
    );
  }
  if (inputs.originVerifySecret === PLACEHOLDER_ORIGIN_VERIFY_SECRET) {
    found.push('-c originVerifySecretFile=<0600 file>');
  }
  if (inputs.imageDigestIsPlaceholder) found.push('-c apiImageDigest=sha256:<digest>');
  return found;
}

/**
 * Deploy guard for the sandbox stage (`-c requireDeployInputs=true`): every placeholder still in
 * place, plus an expiry in the next `SANDBOX_MAX_TTL_HOURS`, all reported at once. `now` is
 * injectable for tests. Independently of this flag, a sandbox template synthesized with any
 * placeholder carries a failing CloudFormation rule (`guardSandboxPlaceholders`).
 */
export function assertSandboxDeployable(
  config: EnvironmentConfig,
  inputs: SandboxDeployInputs,
  now: Date = new Date(),
): void {
  const problems = sandboxPlaceholders(config, inputs).filter((p) => !p.startsWith('-c expiresAt'));
  const expires = config.run ? Date.parse(config.run.expiresAt) : Number.NaN;
  if (
    Number.isNaN(expires) ||
    expires <= now.getTime() ||
    expires - now.getTime() > SANDBOX_MAX_TTL_HOURS * 3_600_000
  ) {
    problems.push(`-c expiresAt=<ISO-8601 UTC time in the next ${SANDBOX_MAX_TTL_HOURS} h>`);
  }
  if (problems.length > 0) {
    throw new Error(
      `requireDeployInputs=true: the sandbox stage still has placeholders; pass ${problems.join(', ')}`,
    );
  }
}

/** Logical id of the always-failing rule in sandbox templates built from placeholders. */
export const SANDBOX_PLACEHOLDER_RULE_ID = 'SandboxPlaceholderInputsNotDeployable';

/**
 * Makes placeholder-built sandbox templates NON-DEPLOYABLE regardless of flags: when
 * any placeholder is in use, every stack gets a CloudFormation `Rules` entry whose assertion is
 * always false, so CloudFormation rejects CreateChangeSet/CreateStack before any resource exists.
 * Offline synth and tests are unaffected.
 */
export function guardSandboxPlaceholders(stacks: readonly Stack[], placeholders: string[]): void {
  if (placeholders.length === 0) return;
  for (const stack of stacks) {
    new CfnRule(stack, SANDBOX_PLACEHOLDER_RULE_ID, {
      assertions: [
        {
          assert: Fn.conditionEquals('placeholder-inputs', 'deployable-inputs'),
          assertDescription:
            'NOT DEPLOYABLE: this sandbox template was synthesized with placeholder inputs ' +
            `(${placeholders.join('; ')}). Re-synthesize with the real values and ` +
            '-c requireDeployInputs=true.',
        },
      ],
    });
  }
}
