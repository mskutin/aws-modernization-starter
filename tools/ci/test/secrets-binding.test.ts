import { describe, expect, it } from 'vitest';
import { checkSecretsAbsent, renderSecretsBindingMarkdown } from '../src/secrets-binding.ts';

const none = (): boolean => false;

describe('secrets binding: shared-runner jobs see no protected secret', () => {
  it('passes with ordinary CI variables only', () => {
    const r = checkSecretsAbsent(
      { CI_JOB_TOKEN: 'x', CI_REGISTRY_PASSWORD: 'y', AWS_REGION: 'ap-southeast-1', PATH: '/bin' },
      none,
    );
    expect(r.ok).toBe(true);
    expect(r.deniedNames).toEqual([]);
    expect(r.checkedNames).toBe(4);
  });

  it.each([
    'COSIGN_PASSWORD',
    'COSIGN_PRIVATE_KEY',
    'COSIGN_PRIVATE_KEY_B64',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'STARTER_SIGNING_KEY',
  ])('fails when %s is present, reporting the name only', (name) => {
    const r = checkSecretsAbsent({ [name]: 'super-secret-value', PATH: '/bin' }, none);
    expect(r.ok).toBe(false);
    expect(r.deniedNames).toEqual([name]);
    const md = renderSecretsBindingMarkdown(r, {});
    expect(md).toContain(name);
    expect(md).not.toContain('super-secret-value');
  });

  it('fails when a runner-scoped secret mount reaches the job', () => {
    const r = checkSecretsAbsent({}, (p) => p === '/run/starter-signing');
    expect(r.ok).toBe(false);
    expect(r.mounts).toEqual(['/run/starter-signing']);
  });

  it('allows exactly the non-secret AWS switch and region names', () => {
    const r = checkSecretsAbsent(
      { AWS_JOBS_ENABLED: 'true', AWS_REGION: 'r', AWS_DEFAULT_REGION: 'r' },
      none,
    );
    expect(r.ok).toBe(true);
    for (const name of ['AWS_JOBS_ENABLED_X', 'AWS_JOBS', 'AWS_REGION_KEY'])
      expect(checkSecretsAbsent({ [name]: 'x' }, none).deniedNames).toEqual([name]);
  });

  it('allows the non-secret signing switch and runner tag names, denies STARTER_SIGNING_*', () => {
    expect(
      checkSecretsAbsent(
        { STARTER_RELEASE_SIGNING: 'true', STARTER_SIGNER_RUNNER_TAG: 'signer' },
        none,
      ).ok,
    ).toBe(true);
    expect(checkSecretsAbsent({ STARTER_SIGNING_KEY_FILE: 'x' }, none).ok).toBe(false);
  });

  it('ignores declared-but-undefined variables', () => {
    expect(checkSecretsAbsent({ COSIGN_PASSWORD: undefined }, none).ok).toBe(true);
  });
});
