/**
 * Validators for every value that can reach an AWS CLI argument vector. Values are interpolated
 * into argv only after they pass one of these patterns, and the executor re-validates them. No
 * interpolated value may start with '-' (it could be parsed as an option), and every interpolated
 * argument uses the `--option=<value>` form.
 */
import { leakRulesIn, PHONE_NUMBER_RE } from './leak.ts';

export const PATTERNS = {
  /** AWS CLI profile. Stricter than the CLI: no leading '-' (could be parsed as an option). */
  profile: /^(?!-)[A-Za-z0-9_.+-]{1,64}$/,
  account: /^\d{12}$/,
  qualifier: /^[a-z0-9]{1,10}$/,
  vpcId: /^vpc-[0-9a-f]{8,17}$/,
  kmsKeyRef: /^alias\/[A-Za-z0-9/_-]{1,250}$/,
  boundaryPolicyArn:
    /^arn:aws:iam::(\d{12}|aws):policy\/(?:[A-Za-z0-9+=,.@_-]+\/)*[A-Za-z0-9+=,.@_-]{1,128}$/,
  /** A customer managed policy attached to the caller's role (read for the privilege check). */
  customerPolicyArn:
    /^arn:aws:iam::\d{12}:policy\/(?:[A-Za-z0-9+=,.@_-]+\/)*[A-Za-z0-9+=,.@_-]{1,128}$/,
  policyVersionId: /^v[1-9]\d{0,5}$/,
  dbEngineVersion: /^\d+\.\d+$/,
  /** IAM role name (from the caller's assumed-role ARN); IAM allows '@' (permission sets). */
  roleName: /^(?!-)[A-Za-z0-9+=,.@_-]{1,64}$/,
  /** Inline policy name (from list-role-policies). */
  policyName: /^(?!-)[A-Za-z0-9+=,.@_-]{1,128}$/,
  /** Glob over role names: IAM role-name characters plus `*` and `?`. */
  rolePattern: /^[A-Za-z0-9+=,.@_*?-]{1,128}$/,
  /** Budget name read back from describe-budgets (conservative subset of what AWS allows). */
  budgetName: /^[A-Za-z0-9][A-Za-z0-9 _.,()+@&#'-]{0,99}$/,
} as const;

export type PatternName = keyof typeof PATTERNS;

export const isValid = (name: PatternName, value: unknown): value is string =>
  typeof value === 'string' && PATTERNS[name].test(value);

/**
 * Compiles `--expected-role-pattern` (a glob: `*` any run, `?` one character) to an anchored
 * RegExp. Only `.` and `+` of the allowed characters are regular-expression syntax.
 */
export function compileRolePattern(pattern: string): RegExp | { error: string } {
  if (!PATTERNS.rolePattern.test(pattern)) {
    return { error: 'only IAM role-name characters plus * and ? are allowed (max 128)' };
  }
  if (pattern.replace(/[*?]/g, '').length < 3) {
    return { error: 'the pattern must contain at least 3 literal characters' };
  }
  // Bounds the backtracking of the compiled expression (no pathological globs).
  if ((pattern.match(/\*/g) ?? []).length > 4) return { error: 'at most 4 * wildcards' };
  const body = [...pattern]
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`);
}

/**
 * Operator text that is copied verbatim into committable evidence (`--attest-read-only`,
 * `--accept-write-capable`) must already pass the leak scanner: no e-mail addresses (also
 * URL-encoded), account IDs (also separated), phone numbers or key material.
 */
export function operatorTextProblem(text: string): string | undefined {
  if (text.length < 10 || text.length > 500) return 'must be 10-500 characters';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return 'must be one line without control characters';
  const hits = leakRulesIn(text);
  if (PHONE_NUMBER_RE.test(text)) hits.push('phone-number');
  if (hits.length > 0) {
    return `must not contain ${hits.join(', ')} (name the permission set and the person by name and role, not by e-mail address or ID)`;
  }
  return undefined;
}

/** `111122223333` -> `********3333` (for console output and the evidence identity section). */
export const maskAccount = (account: string): string =>
  /^\d{12}$/.test(account) ? `********${account.slice(8)}` : '<invalid-account>';
