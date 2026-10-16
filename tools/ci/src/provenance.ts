/**
 * in-toto Statement v1 with a SLSA Provenance v1 predicate for an image built
 * by the rootless Buildah job. The statement is UNSIGNED: it is signed (as an
 * attestation) only by `container:sign:<id>` when a Cosign key is configured.
 * We deliberately do not claim a SLSA build level: the builder is a
 * self-hosted runner and the statement is generated inside the build pipeline.
 */

export interface ImageMetadata {
  component: string;
  image: string;
  tag: string;
  digest: string;
  archive: string;
  archiveSha256: string;
  dockerfile: string;
  dockerfileSha256: string;
  context: string;
  ignoreFile?: string;
  baseImages: Array<{ ref: string; digest: string }>;
  buildArgs: Record<string, string>;
  lockfileSha256?: string;
  sourceDateEpoch?: number;
  startedOn?: string;
  finishedOn?: string;
  builder: { buildahVersion: string; image?: string; isolation: string; storageDriver: string };
  git: { commit: string; ref?: string; repository?: string };
  ci?: Record<string, string | undefined>;
}

export const BUILD_TYPE =
  'https://aws-modernization-starter.local/buildtypes/gitlab-ci-buildah-rootless/v1';

export function validateMetadata(raw: unknown): ImageMetadata {
  const m = raw as Partial<ImageMetadata> | null;
  const problems: string[] = [];
  if (!m || typeof m !== 'object') throw new Error('image metadata: not an object');
  if (!/^sha256:[a-f0-9]{64}$/.test(m.digest ?? ''))
    problems.push('digest must be sha256:<64 hex>');
  if (!/^[a-f0-9]{64}$/.test(m.archiveSha256 ?? '')) problems.push('archiveSha256 must be 64 hex');
  if (!/^[a-f0-9]{40}$/.test(m.git?.commit ?? '')) problems.push('git.commit must be a full SHA-1');
  if (!Array.isArray(m.baseImages) || m.baseImages.length === 0)
    problems.push('baseImages must list the resolved FROM images');
  for (const b of m.baseImages ?? []) {
    if (!/^sha256:[a-f0-9]{64}$/.test(b.digest)) problems.push(`base image ${b.ref} has no digest`);
  }
  if (!m.image || !m.component || !m.dockerfile)
    problems.push('image, component and dockerfile are required');
  if (problems.length > 0) throw new Error(`image metadata invalid: ${problems.join('; ')}`);
  return m as ImageMetadata;
}

const hex = (digest: string): string => digest.replace(/^sha256:/, '');

export function buildStatement(m: ImageMetadata, subjectName: string): Record<string, unknown> {
  const repo = m.git.repository ?? 'unknown';
  const resolvedDependencies: Array<Record<string, unknown>> = [
    {
      uri: `git+${repo}${m.git.ref ? `@refs/${m.git.ref}` : ''}`,
      digest: { gitCommit: m.git.commit },
      name: 'source',
    },
    ...m.baseImages.map((b) => ({
      uri: `pkg:docker/${b.ref.split('@')[0]}`,
      digest: { sha256: hex(b.digest) },
      name: 'base-image',
    })),
    { uri: `file:${m.dockerfile}`, digest: { sha256: m.dockerfileSha256 }, name: 'dockerfile' },
  ];
  if (m.lockfileSha256) {
    resolvedDependencies.push({
      uri: 'file:pnpm-lock.yaml',
      digest: { sha256: m.lockfileSha256 },
      name: 'lockfile',
    });
  }
  const ci = m.ci ?? {};
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: subjectName, digest: { sha256: hex(m.digest) } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: BUILD_TYPE,
        externalParameters: {
          source: { uri: `git+${repo}`, digest: { gitCommit: m.git.commit }, ref: m.git.ref },
          dockerfile: m.dockerfile,
          context: m.context,
          ...(m.ignoreFile ? { ignoreFile: m.ignoreFile } : {}),
          buildArgs: m.buildArgs,
        },
        internalParameters: {
          builder: 'buildah',
          buildahVersion: m.builder.buildahVersion,
          builderImage: m.builder.image,
          isolation: m.builder.isolation,
          storageDriver: m.builder.storageDriver,
          privileged: false,
          sourceDateEpoch: m.sourceDateEpoch,
          pipelineId: ci.CI_PIPELINE_ID,
          jobId: ci.CI_JOB_ID,
        },
        resolvedDependencies,
      },
      runDetails: {
        builder: {
          id:
            ci.CI_SERVER_URL && ci.CI_RUNNER_ID
              ? `${ci.CI_SERVER_URL}/runners/${ci.CI_RUNNER_ID}`
              : 'local',
          version: { gitlabRunner: ci.CI_RUNNER_VERSION, gitlab: ci.CI_SERVER_VERSION },
        },
        metadata: {
          invocationId: ci.CI_JOB_URL ?? 'local',
          startedOn: m.startedOn,
          finishedOn: m.finishedOn,
        },
        byproducts: [
          { name: 'oci-archive', uri: `file:${m.archive}`, digest: { sha256: m.archiveSha256 } },
        ],
      },
    },
  };
}

/**
 * Signing status of the statement written by this job. The statement file itself is never signed;
 * on a protected release ref the protected chain attests it (ADR 0411).
 */
export function provenanceStatus(
  protectedReleaseRef: boolean,
  signingEnabled = false,
): Record<string, unknown> {
  return {
    signed: false,
    statement: 'in-toto Statement v1 / SLSA Provenance v1 predicate, generated by the pipeline',
    signing: !protectedReleaseRef
      ? 'NOT SIGNED — unprotected ref (MR or branch): images and provenance are signed only on protected release refs; treat this statement as an unauthenticated build record'
      : signingEnabled
        ? 'protected release ref: container:sign attests this predicate with the runner-scoped Cosign key (signing runner) and container:verify checks it against the runner-mounted trust anchor (reports/signing/, reports/verify/)'
        : 'NOT SIGNED — signing: not configured (STARTER_RELEASE_SIGNING is not "true"); treat this statement as an unauthenticated build record',
    slsaBuildLevel: 'none claimed (provenance generated in-pipeline by the build job itself)',
  };
}
