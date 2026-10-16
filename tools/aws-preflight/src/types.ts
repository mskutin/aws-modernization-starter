/** Shared types and constants of @starter/tool-aws-preflight (no I/O, no side effects). */

/**
 * Default workload region (`--region`). Mirrors DEFAULT_AWS_REGION of `@starter/config/region`, the
 * single source of truth; this tool is dependency-free on purpose and a test pins the copy.
 */
export const DEFAULT_WORKLOAD_REGION = 'ap-southeast-1';
/** Fixed region for global endpoints (Organizations, Budgets, CloudFront WAF/ACM/quotas). */
export const GLOBAL_REGION = 'us-east-1';
/** An AWS region name. Workload regions are validated by `workloadRegionProblem` (region.ts). */
export type Region = string;

/**
 * Every region a probe of a run may ever be sent to: its workload region and the global-endpoint
 * region (once, when they are the same).
 */
export function allowedRegions(workload: string = DEFAULT_WORKLOAD_REGION): readonly string[] {
  return workload === GLOBAL_REGION ? [workload] : [workload, GLOBAL_REGION];
}

/**
 * Discovery areas: `org-iam` (organization, IAM, CDK bootstrap), `network-edge` (network and edge),
 * `quotas-services` (quotas and service readiness), `finops` (budgets), `identity` (identity gate).
 */
export const AREAS = ['org-iam', 'network-edge', 'quotas-services', 'finops', 'identity'] as const;
export type Area = (typeof AREAS)[number];

export type ProbeStatus = 'ok' | 'access-denied' | 'not-found' | 'error' | 'timeout' | 'skipped';
export const PROBE_STATUSES: readonly ProbeStatus[] = [
  'ok',
  'access-denied',
  'not-found',
  'error',
  'timeout',
  'skipped',
];

/** Process exit codes (documented in README.md). */
export const EXIT = {
  /** Run completed (individual probes may still be access-denied / not-found / error). */
  OK: 0,
  /** Aborted on an unexpected error (identity could not be established, internal error). */
  ERROR: 1,
  /**
   * Refused before any AWS call (usage, CI, region, raw dir, AWS CLI, AWS CLI configuration,
   * offline account or role mismatch with the SSO profile, both override flags).
   */
  REFUSED: 2,
  /** The caller's account is not --expected-account. */
  ACCOUNT_MISMATCH: 3,
  /**
   * Root, IAM user, federated user, a role that does not match --expected-role-pattern, or a
   * different principal at the end-of-run re-check.
   */
  PRINCIPAL_REJECTED: 4,
  /**
   * Administrator-equivalent identity (no override); write-capable without --accept-write-capable;
   * data-capable or unverified without --attest-read-only or --accept-write-capable.
   */
  PRIVILEGE_CHECK_FAILED: 5,
  /** Expired or invalid credentials / SSO session (`aws sso login --profile <p>`). */
  CREDENTIALS: 6,
  /** Management account, not an organization member, or membership undeterminable. */
  ORGANIZATION: 7,
  /** The leak scanner refused the sanitized output; nothing was written. */
  LEAK_BLOCKED: 8,
  /** Interrupted (SIGINT/SIGTERM); partial evidence marked incomplete. */
  INTERRUPTED: 130,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
