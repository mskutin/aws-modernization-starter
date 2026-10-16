/**
 * Truthful status reports for optional, opt-in CI capabilities (ADR 0403). The check jobs of a
 * capability that is not configured do not exist, so nothing pretends to have run; the status job
 * says so in plain words. Exit codes:
 *   0                    reported (also "not configured — not executed": a status, not a pass)
 *   NOT_CONFIGURED_EXIT  opted in but incomplete, or a coverage-reducing opt-out (allowed warning)
 *   1                    an opted-in capability is misconfigured where it must run (fails)
 * Secrets are reported by PRESENCE only, never by value; non-secret switches and runner tags are
 * shown as set.
 */

export const NOT_CONFIGURED_EXIT = 78;

export interface FeatureStatus {
  feature: string;
  configured: boolean;
  summary: string;
  variables: Array<{ name: string; present: boolean; note?: string }>;
  jobs: Array<{ job: string; purpose: string; status: string }>;
  /** One-line status lines printed first in the job log ("signing: not configured", …). */
  lines?: string[];
  /** Process exit code of `status <feature>` (see above). */
  exitCode: number;
}

type Env = Record<string, string | undefined>;
const present = (env: Env, name: string): boolean => (env[name] ?? '').length > 0;

/**
 * AWS jobs (ADR 0111), opt-in: credentials are NOT CI/CD variables — a protected variable reaches
 * every job of a protected-ref pipeline on any runner — but files mounted read-only by a dedicated
 * protected runner only (/run/starter-aws). The jobs exist only when the non-secret switch
 * AWS_JOBS_ENABLED=true is set and the ref is protected. Always exit 0: the report is the job's
 * whole purpose, and the AWS jobs themselves fail when enabled without credentials.
 */
export function awsStatus(env: Env): FeatureStatus {
  const enabled = env.AWS_JOBS_ENABLED === 'true';
  const protectedRef = env.CI_COMMIT_REF_PROTECTED === 'true';
  const configured = enabled && protectedRef;
  const jobs = [
    {
      job: 'aws:cdk-diff',
      purpose: 'real `cdk diff` against the target account (default branch, infra changes)',
    },
    {
      job: 'aws:integration:deploy',
      purpose: 'deploy the ephemeral integration mini-stack (manual, default branch)',
    },
    { job: 'aws:integration:test', purpose: 'run tests/aws-integration against the mini-stack' },
    {
      job: 'aws:integration:cleanup',
      purpose: 'destroy + verify the mini-stack (always after deploy)',
    },
    { job: 'aws:drift', purpose: 'scheduled drift detection (SCHEDULE_TASK=drift)' },
    {
      job: 'aws:sweeper',
      purpose: 'scheduled sweeper for expired ephemeral stacks (SCHEDULE_TASK=sweep)',
    },
  ];
  const summary = configured
    ? 'AWS jobs are enabled on this protected ref: they run on the protected runner with runner-scoped credentials (deploy is manual).'
    : enabled
      ? 'AWS jobs are enabled, but never run on an unprotected ref (MR or branch): the credentials exist only as runner-scoped files on the protected runner. Nothing was executed here — NOT passing.'
      : 'AWS jobs are NOT configured (AWS_JOBS_ENABLED is not "true"): no AWS job was created. Nothing was deployed, diffed, drift-checked or swept — these results are NOT passing, they were not executed.';
  return {
    feature: 'aws',
    configured,
    exitCode: 0,
    lines: [
      configured
        ? 'aws: configured — AWS jobs enabled on this protected ref'
        : enabled
          ? 'aws: enabled, not on this ref (protected refs only) — not executed'
          : 'aws: not configured — not executed',
    ],
    summary,
    variables: [
      {
        name: 'AWS_JOBS_ENABLED',
        present: present(env, 'AWS_JOBS_ENABLED'),
        note: `non-secret switch, value: ${enabled ? 'true' : '(not "true")'}`,
      },
      {
        name: 'CI_COMMIT_REF_PROTECTED',
        present: present(env, 'CI_COMMIT_REF_PROTECTED'),
        note: `protected ref: ${protectedRef ? 'yes' : 'no'}`,
      },
      {
        name: '(credentials)',
        present: false,
        note: 'never CI/CD variables: runner-scoped files /run/starter-aws on the protected runner (STARTER_PROTECTED_RUNNER_TAG; docs/ci-cd.md)',
      },
    ],
    jobs: jobs.map((j) => ({
      ...j,
      status: configured ? 'enabled (subject to job rules)' : 'not configured — not executed',
    })),
  };
}

export function aiReviewStatus(env: Env): FeatureStatus {
  const enabled = env.AI_REVIEW_ENABLED === 'true';
  const required = ['AI_REVIEW_GITLAB_TOKEN', 'AI_REVIEW_API_BASE', 'AI_REVIEW_MODEL'];
  const missing = required.filter((n) => !present(env, n));
  const configured = enabled && missing.length === 0;
  const reason = !enabled ? 'AI_REVIEW_ENABLED is not "true"' : `missing ${missing.join(', ')}`;
  return {
    feature: 'ai-review',
    configured,
    // Off by default: not enabled is a plain report; enabled but incomplete is a warning.
    exitCode: enabled && !configured ? NOT_CONFIGURED_EXIT : 0,
    lines: [
      configured
        ? 'ai-review: configured (advisory)'
        : enabled
          ? `ai-review: enabled but not configured (${reason}) — not executed`
          : 'ai-review: off (AI_REVIEW_ENABLED is not "true") — not executed',
    ],
    summary: configured
      ? 'AI review is configured; review:ai runs for this merge request (advisory only).'
      : `AI review not configured (${reason}). No model endpoint was contacted and no review was produced. Deterministic gates are unaffected.`,
    variables: [
      {
        name: 'AI_REVIEW_ENABLED',
        present: present(env, 'AI_REVIEW_ENABLED'),
        note: `value: ${env.AI_REVIEW_ENABLED ?? '(unset)'}`,
      },
      ...required.map((name) => ({ name, present: present(env, name) })),
      { name: 'AI_REVIEW_API_KEY', present: present(env, 'AI_REVIEW_API_KEY'), note: 'optional' },
    ],
    jobs: [
      {
        job: 'review:ai',
        purpose: 'PR-Agent review of the MR diff (allow_failure, advisory)',
        status: configured ? 'enabled' : 'not configured — not executed',
      },
    ],
  };
}

/** Non-secret switches/tags: shown with their value (never a secret by contract, ADR 0111). */
const shown = (env: Env, name: string): { name: string; present: boolean; note: string } => ({
  name,
  present: present(env, name),
  note: `value: ${present(env, name) ? `"${env[name] ?? ''}"` : '(empty)'}`,
});

/**
 * Release chain status (ADR 0411): image build opt-out, publication to the project registry and
 * opt-in signing. "signing: not configured" is stated in every pipeline in which it applies. Once a
 * project opted in to signing, a protected release ref without the prerequisites FAILS here (before
 * the sign/verify jobs would), so a misconfiguration is never reported as a signed release.
 */
export function releaseStatus(env: Env): FeatureStatus {
  const releaseRef =
    env.CI_COMMIT_REF_PROTECTED === 'true' &&
    (present(env, 'CI_COMMIT_TAG') ||
      (present(env, 'CI_COMMIT_BRANCH') && env.CI_COMMIT_BRANCH === env.CI_DEFAULT_BRANCH));
  const build = env.STARTER_CONTAINER_BUILD !== 'false';
  const registry = present(env, 'CI_REGISTRY_IMAGE');
  const signing = env.STARTER_RELEASE_SIGNING === 'true';
  const tlsValue = env.REGISTRY_TLS_VERIFY ?? 'true';
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines: string[] = [];

  if (tlsValue !== 'true' && tlsValue !== 'false' && tlsValue !== '')
    errors.push('REGISTRY_TLS_VERIFY must be "true" or "false"');

  if (build)
    lines.push('container build: enabled (rootless Buildah; scan, SBOM, provenance gated)');
  else {
    lines.push(
      'container build: DISABLED (STARTER_CONTAINER_BUILD=false) — no image is built, scanned, described or published',
    );
    warnings.push('the project opted out of the image build chain');
  }

  if (!build) lines.push('publish: not executed (image builds opted out)');
  else if (!releaseRef)
    lines.push(
      'publish: not a protected release ref — images of this pipeline are UNSIGNED build artifacts, nothing is published',
    );
  else if (!registry)
    lines.push(
      'publish: not configured — the project container registry is disabled (CI_REGISTRY_IMAGE unset); nothing is published',
    );
  else
    lines.push(
      `publish: container:publish pushes to the project registry (TLS verification ${tlsValue === 'false' ? 'OFF (REGISTRY_TLS_VERIFY=false)' : 'on'})`,
    );

  if (!signing) {
    lines.push(
      releaseRef && build && registry
        ? 'signing: not configured — published images are UNSIGNED (opt in: STARTER_RELEASE_SIGNING=true)'
        : 'signing: not configured (opt in: STARTER_RELEASE_SIGNING=true)',
    );
  } else if (!releaseRef) {
    lines.push('signing: configured — runs on protected release refs only, not in this pipeline');
  } else {
    if (!build) warnings.push('signing is enabled but image builds are opted out: nothing to sign');
    if (build && !registry)
      errors.push(
        'signing is enabled but the project container registry is disabled: nothing can be published, signed or verified',
      );
    for (const [name, role] of [
      ['STARTER_SIGNER_RUNNER_TAG', 'container:sign (the runner that mounts the signing key)'],
      ['STARTER_PROTECTED_RUNNER_TAG', 'publish, verify and the chain report (trust anchor mount)'],
      ['STARTER_RELEASE_RUNNER_TAG', 'the image build chain on protected refs (chain report)'],
    ] as const) {
      if (build && !present(env, name))
        errors.push(`signing is enabled but ${name} is empty: set it to the runner for ${role}`);
    }
    lines.push(
      errors.length > 0
        ? 'signing: configured but INCOMPLETE — see errors; nothing is reported as signed'
        : 'signing: configured — container:sign, container:verify and container:chain-report run after the gate',
    );
  }
  for (const e of errors) lines.push(`ERROR: ${e}`);
  for (const w of warnings) lines.push(`WARNING: ${w}`);

  return {
    feature: 'release',
    configured: build && releaseRef && registry && signing && errors.length === 0,
    exitCode: errors.length > 0 ? 1 : warnings.length > 0 ? NOT_CONFIGURED_EXIT : 0,
    lines,
    summary:
      'Release chain of this pipeline: image build, publication to the project registry and opt-in signing (ADR 0411).',
    variables: [
      shown(env, 'STARTER_CONTAINER_BUILD'),
      shown(env, 'STARTER_RELEASE_SIGNING'),
      shown(env, 'REGISTRY_TLS_VERIFY'),
      shown(env, 'STARTER_RELEASE_RUNNER_TAG'),
      shown(env, 'STARTER_PROTECTED_RUNNER_TAG'),
      shown(env, 'STARTER_SIGNER_RUNNER_TAG'),
      {
        name: 'CI_REGISTRY_IMAGE',
        present: registry,
        note: 'predefined; set when the project container registry is enabled',
      },
      {
        name: 'CI_COMMIT_REF_PROTECTED',
        present: present(env, 'CI_COMMIT_REF_PROTECTED'),
        note: `protected release ref: ${releaseRef ? 'yes' : 'no'}`,
      },
      {
        name: '(signing key)',
        present: false,
        note: 'never a CI/CD variable: runner-mounted files /run/starter-signing (signing runner) and /run/starter-trust/cosign.pub (protected runner)',
      },
    ],
    jobs: [
      {
        job: 'container:publish:<id>',
        purpose: 'push the scanned image (digest-preserving) to the project registry',
        status: build && releaseRef && registry ? 'enabled' : 'not executed',
      },
      ...['sign', 'verify', 'chain-report'].map((step) => ({
        job: `container:${step}:<id>`,
        purpose:
          step === 'sign'
            ? 'sign the digest, attest SLSA provenance + CycloneDX SBOM'
            : step === 'verify'
              ? 'verify signature and attestations with the trust anchor; negative controls'
              : 'every chain job ran on a protected runner from a fresh clone',
        status:
          signing && build && releaseRef && registry
            ? 'enabled'
            : signing
              ? 'configured — not executed here'
              : 'not configured — not executed',
      })),
    ],
  };
}

export function renderStatusMarkdown(s: FeatureStatus): string {
  const lines = [
    `# ${s.feature}: ${s.configured ? 'configured' : 'NOT CONFIGURED — NOT EXECUTED'}`,
    '',
    ...(s.lines?.length ? [...s.lines.map((l) => `- ${l}`), ''] : []),
    s.summary,
    '',
    '| Variable | Present | Note |',
    '| --- | --- | --- |',
    ...s.variables.map((v) => `| \`${v.name}\` | ${v.present ? 'yes' : 'no'} | ${v.note ?? ''} |`),
    '',
    '| Job | Purpose | Status |',
    '| --- | --- | --- |',
    ...s.jobs.map((j) => `| \`${j.job}\` | ${j.purpose} | ${j.status} |`),
    '',
  ];
  return lines.join('\n');
}
