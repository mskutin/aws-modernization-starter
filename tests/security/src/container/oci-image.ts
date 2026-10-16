/**
 * Security checks on a BUILT container image, read from its OCI archive (the artifact CI's
 * `container:build:<id>` produces: `oci-out/<id>/image.oci.tar`, or `podman save --format
 * oci-archive`). Complements the build-time non-root check (tools/ci/scripts/container-build.sh)
 * and Trivy's vulnerability/secret scan of the layers with the image CONFIG view:
 *
 *   - runs as a non-root numeric user (not root, 0, root:* or 0:*; a name could map to uid 0);
 *   - exec-form entrypoint without a shell (a shell as PID 1 would also swallow SIGTERM);
 *   - no credential-like environment variable names and no secret-looking values in ENV;
 *   - only the expected ports; provenance labels present.
 *
 * Minimal, dependency-free reader: USTAR/PAX tar entries, OCI index → manifest → config.
 */
import { readFileSync } from 'node:fs';
import { findLeaks } from '../leaks.js';

/** Credential-looking ENV names (same list as BASE-ECS-006 for task definitions). */
export const SECRET_ENV_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY)$/;

export interface ImageConfig {
  User?: string;
  Entrypoint?: string[] | null;
  Cmd?: string[] | null;
  Env?: string[] | null;
  ExposedPorts?: Record<string, unknown> | null;
  Labels?: Record<string, string> | null;
  Healthcheck?: { Test?: string[] } | null;
}

/** Entries of an uncompressed tar archive (name → content). Handles PAX long names. */
export function readTar(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  let paxName: string | undefined;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    const name = paxName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const body = buf.subarray(offset + 512, offset + 512 + size);
    paxName = undefined;
    if (type === 'x') {
      const path = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1];
      paxName = path;
    } else if (type === '0' || type === '' || type === '\0') {
      entries.set(name.replace(/^\.\//, ''), Buffer.from(body));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

const blobPath = (digest: string) => `blobs/${digest.replace(':', '/')}`;

/** The image config of a single-image OCI archive (first manifest of the index). */
export function imageConfigFromOciArchive(file: string): ImageConfig {
  const entries = readTar(readFileSync(file));
  const json = (name: string): Record<string, unknown> => {
    const data = entries.get(name);
    if (!data) throw new Error(`${file}: ${name} not found in the archive`);
    return JSON.parse(data.toString('utf8')) as Record<string, unknown>;
  };
  let manifest = json('index.json');
  // An index may point at another index (multi-arch) or directly at the manifest.
  for (let depth = 0; depth < 3 && Array.isArray(manifest['manifests']); depth++) {
    const first = (manifest['manifests'] as { digest?: string }[])[0];
    if (!first?.digest) throw new Error(`${file}: empty OCI index`);
    manifest = json(blobPath(first.digest));
  }
  const config = manifest['config'] as { digest?: string } | undefined;
  if (!config?.digest) throw new Error(`${file}: manifest without a config`);
  const image = json(blobPath(config.digest));
  return (image['config'] ?? {}) as ImageConfig;
}

export interface ImagePolicy {
  /** Ports the image may expose (e.g. ['8080/tcp']). */
  allowedPorts: readonly string[];
  /** Labels that must be present and non-empty. */
  requiredLabels: readonly string[];
}

export const API_IMAGE_POLICY: ImagePolicy = {
  allowedPorts: ['8080/tcp'],
  requiredLabels: ['org.opencontainers.image.revision', 'org.opencontainers.image.source'],
};

/** Problems with an image config (empty = compliant). */
export function checkImageConfig(
  config: ImageConfig,
  policy: ImagePolicy = API_IMAGE_POLICY,
): string[] {
  const problems: string[] = [];
  const user = (config.User ?? '').trim();
  const [uid = '', gid = ''] = user.split(':');
  if (!/^\d+$/.test(uid) || Number(uid) === 0) {
    problems.push(`User "${user}" must be a non-root numeric uid (a name may resolve to uid 0)`);
  }
  if (gid !== '' && (!/^\d+$/.test(gid) || Number(gid) === 0)) {
    problems.push(`User "${user}": the group must be a non-root numeric gid`);
  }
  const argv = [...(config.Entrypoint ?? []), ...(config.Cmd ?? [])];
  if (argv.length === 0) problems.push('no Entrypoint/Cmd');
  if (argv.some((a) => /(^|\/)(ba|da|a)?sh$/.test(a)) || argv.includes('-c')) {
    problems.push(`Entrypoint/Cmd runs a shell (${argv.join(' ')}); use the exec form`);
  }
  for (const entry of config.Env ?? []) {
    const [name = '', ...rest] = entry.split('=');
    const value = rest.join('=');
    if (SECRET_ENV_NAME.test(name)) problems.push(`ENV ${name} looks like a credential`);
    if (findLeaks(value).length > 0) problems.push(`ENV ${name} has a secret-looking value`);
  }
  for (const port of Object.keys(config.ExposedPorts ?? {})) {
    if (!policy.allowedPorts.includes(port)) problems.push(`unexpected exposed port ${port}`);
  }
  for (const label of policy.requiredLabels) {
    if (!config.Labels?.[label]) problems.push(`missing label ${label}`);
  }
  return problems;
}
