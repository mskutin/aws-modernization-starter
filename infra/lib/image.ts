/**
 * The API container image is always referenced by immutable digest. CI passes
 * the digest of the image it built/promoted via `-c apiImageDigest=sha256:...`
 * (or API_IMAGE_DIGEST). Synth without one uses an all-zero placeholder so
 * templates can be validated offline; `-c requireImageDigest=true` (used by
 * deploy jobs) turns a missing digest into a hard error.
 */
export const PLACEHOLDER_IMAGE_DIGEST = `sha256:${'0'.repeat(64)}`;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export interface ImageDigestResolution {
  readonly digest: string;
  readonly isPlaceholder: boolean;
}

export function resolveImageDigest(
  tryGetContext: (key: string) => unknown,
  env: NodeJS.ProcessEnv = process.env,
): ImageDigestResolution {
  const ctx = tryGetContext('apiImageDigest');
  const value = typeof ctx === 'string' && ctx !== '' ? ctx : env.API_IMAGE_DIGEST;
  // `requireDeployInputs` (the sandbox deploy guard) implies `requireImageDigest`.
  const required =
    String(tryGetContext('requireImageDigest') ?? 'false') === 'true' ||
    String(tryGetContext('requireDeployInputs') ?? 'false') === 'true';
  if (value === undefined || value === '') {
    if (required) {
      throw new Error(
        'requireImageDigest=true but no apiImageDigest context / API_IMAGE_DIGEST was given',
      );
    }
    return { digest: PLACEHOLDER_IMAGE_DIGEST, isPlaceholder: true };
  }
  if (!DIGEST.test(value)) {
    throw new Error(`Invalid apiImageDigest "${value}": expected sha256:<64 lowercase hex chars>`);
  }
  if (required && value === PLACEHOLDER_IMAGE_DIGEST) {
    throw new Error('requireImageDigest=true but the placeholder digest was given');
  }
  return { digest: value, isPlaceholder: value === PLACEHOLDER_IMAGE_DIGEST };
}

const APP_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** Optional `-c appVersion=<git sha or semver>` exposed to workloads as APP_VERSION. */
export function resolveAppVersion(tryGetContext: (key: string) => unknown): string | undefined {
  const value = tryGetContext('appVersion');
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !APP_VERSION.test(value)) {
    throw new Error(`Invalid appVersion=${String(value)}: expected 1-64 chars of [A-Za-z0-9._+-]`);
  }
  return value;
}
