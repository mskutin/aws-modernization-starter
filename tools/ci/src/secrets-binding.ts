/**
 * Proof: secrets are bound to protected JOBS, not to refs.
 *
 * GitLab gives a protected variable to every job of a protected-ref pipeline, whichever runner
 * runs it. The signing key, its password and AWS credentials are therefore never GitLab variables:
 * when a project opts in to signing or AWS jobs they are files mounted read-only by dedicated
 * protected runners only (/run/starter-signing, /run/starter-aws; the public trust anchor at
 * /run/starter-trust). A job on the DEFAULT runner (the one that runs MR code) — in MR, main and tag
 * pipelines alike — checks that no such variable NAME and no such mount reaches it. Only names are
 * ever reported, never values.
 */

/** Variable names that must never reach a shared-runner job. */
export const DENIED_NAME_PATTERNS: readonly RegExp[] = [
  /^COSIGN_/,
  // AWS credentials and profiles. Exactly three names are configuration, not secrets: the region
  // and the non-secret project switch AWS_JOBS_ENABLED (it must reach every job: it is a project
  // variable that only creates the AWS jobs, docs/ci-cd.md).
  /^AWS_(?!REGION$|DEFAULT_REGION$|JOBS_ENABLED$)/,
  /^STARTER_SIGNING_/,
];

/** Runner-scoped mounts of the protected runners (docs/security.md, ADR 0110/0411). */
export const RUNNER_SCOPED_MOUNTS: readonly string[] = [
  '/run/starter-signing',
  '/run/starter-trust',
  '/run/starter-aws',
];

export interface SecretsBindingResult {
  ok: boolean;
  deniedNames: string[];
  mounts: string[];
  checkedNames: number;
  checkedPatterns: string[];
  checkedMounts: string[];
}

export function checkSecretsAbsent(
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
): SecretsBindingResult {
  const names = Object.keys(env).filter((n) => env[n] !== undefined);
  const deniedNames = names.filter((n) => DENIED_NAME_PATTERNS.some((p) => p.test(n))).sort();
  const mounts = RUNNER_SCOPED_MOUNTS.filter((m) => exists(m));
  return {
    ok: deniedNames.length === 0 && mounts.length === 0,
    deniedNames,
    mounts: [...mounts],
    checkedNames: names.length,
    checkedPatterns: DENIED_NAME_PATTERNS.map((p) => p.source),
    checkedMounts: [...RUNNER_SCOPED_MOUNTS],
  };
}

export function renderSecretsBindingMarkdown(
  r: SecretsBindingResult,
  context: {
    runner?: string | undefined;
    ref?: string | undefined;
    protectedRef?: string | undefined;
  },
): string {
  return [
    '# Secrets binding',
    '',
    `**Result:** ${r.ok ? 'PASSED — no protected secret reaches this shared-runner job' : 'FAILED'}`,
    '',
    `- runner: \`${context.runner ?? '?'}\`, ref: \`${context.ref ?? '?'}\` (protected: ${context.protectedRef ?? '?'})`,
    `- variable names checked: ${r.checkedNames} against ${r.checkedPatterns.map((p) => `\`${p}\``).join(', ')}`,
    `- runner-scoped mounts checked: ${r.checkedMounts.map((m) => `\`${m}\``).join(', ')}`,
    '',
    ...(r.deniedNames.length
      ? [
          '## Denied variable names present (values not shown)',
          '',
          ...r.deniedNames.map((n) => `- \`${n}\``),
          '',
        ]
      : []),
    ...(r.mounts.length
      ? ['## Runner-scoped secret mounts present', '', ...r.mounts.map((m) => `- \`${m}\``), '']
      : []),
  ].join('\n');
}
