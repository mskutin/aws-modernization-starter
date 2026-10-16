/**
 * Mutation runs (evidence that the checks bite; never used in CI): SECTEST_HARNESS_MUTATION is a
 * comma-separated list of misconfigurations applied to what the self-started harness runs. Each one
 * must make specific tests FAIL — see docs/testing.md "Security suite".
 *   trust-xff            direct APIs trust X-Forwarded-For from any client (TRUST_PROXY_HOPS=10)
 *   no-client-allowlist  no AUTH_ALLOWED_CLIENT_IDS (tokens of other OAuth clients accepted)
 *   long-token-age       AUTH_MAX_TOKEN_AGE_SECONDS=86400 on every API (old tokens accepted)
 *   relaxed-runtime      the start-up refusal checks run with APP_RUNTIME=ci (local relaxations)
 */
export type HarnessMutation =
  'trust-xff' | 'no-client-allowlist' | 'long-token-age' | 'relaxed-runtime';

export function harnessMutations(
  value = process.env['SECTEST_HARNESS_MUTATION'],
): ReadonlySet<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
  );
}

export const mutated = (mutation: HarnessMutation): boolean => harnessMutations().has(mutation);
