import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Trust boundary of the MiniStack emulator jobs (.gitlab/ci/emulator.yml, docs/ci-cd.md
 * §7a): default (generic) runner only, no socket or privilege, fake credentials only, blocking,
 * selected by impact, after the gate, artifacts leak-scanned. Reads the committed CI files.
 */
const repo = join(import.meta.dirname, '../../..');
type Job = Record<string, unknown>;
const load = (file: string): Record<string, Job> =>
  parse(readFileSync(join(repo, file), 'utf8')) as Record<string, Job>;

const emulator = load('.gitlab/ci/emulator.yml');
const template = emulator['.ministack'] ?? {};
const JOBS = ['integration:ministack:cdk', 'integration:ministack:workflows'];
const vars = template.variables as Record<string, string>;

/** Every string value anywhere below `node`. */
function strings(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(strings);
  if (node && typeof node === 'object') return Object.values(node).flatMap(strings);
  return [];
}

/** Every key anywhere below `node`. */
function keys(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(keys);
  if (node && typeof node === 'object')
    return Object.entries(node).flatMap(([k, v]) => [k, ...keys(v)]);
  return [];
}

describe('MiniStack emulator jobs', () => {
  it('is included from .gitlab-ci.yml', () => {
    const include = (load('.gitlab-ci.yml') as unknown as { include: Array<{ local: string }> })
      .include;
    expect(include.map((i) => i.local)).toContain('.gitlab/ci/emulator.yml');
  });

  it.each(JOBS)('%s extends the template and selects its suite', (name) => {
    const job = emulator[name] ?? {};
    expect(job.extends).toEqual(['.ministack']);
    expect(Object.keys(job).sort()).toEqual(['extends', 'variables']);
    expect((job.variables as Record<string, string>).STARTER_MINISTACK_SUITE).toBe(
      name.split(':')[2],
    );
  });

  it('is impact-selected, post-gate and not itself a gate job', () => {
    expect(template.extends).toEqual(['.node', '.impact:tests-aws-integration']);
    expect(template.stage).toBe('integration');
    expect(template.needs).toEqual([
      { job: 'impact', artifacts: false },
      { job: 'gates:mandatory', artifacts: false },
    ]);
    expect(template.resource_group).toBe('ci-ministack');
  });

  it('runs on the default runner only, never on a protected, release or signing runner', () => {
    expect(template.tags).toEqual(['$STARTER_RUNNER_TAG']);
    const all = strings(emulator).join('\n');
    expect(all).not.toMatch(
      /STARTER_(PROTECTED|RELEASE|SIGNER)_RUNNER_TAG|starter-(local|protected|signing)/,
    );
    expect(strings(template.extends)).not.toContain('.protected-runner');
    // Nothing that assumes a bespoke runner: no fixed network, host pins or runner-mounted files.
    expect(all).not.toMatch(/network_mode|extra_hosts|allowed_services|\/run\/starter-/);
  });

  it('never fails open and keeps the impact rules', () => {
    expect(keys(emulator)).not.toContain('allow_failure');
    for (const job of [template, ...JOBS.map((n) => emulator[n] ?? {})]) {
      expect(job.rules).toBeUndefined();
      expect(job.when).toBeUndefined();
    }
  });

  it('mounts no container socket and asks for no privilege', () => {
    const all = strings(emulator).join('\n');
    expect(all).not.toMatch(
      /docker\.sock|podman\.sock|DOCKER_HOST|CONTAINER_HOST|tcp:\/\/.*:237[56]/,
    );
    expect(keys(emulator)).not.toContain('privileged');
    expect(keys(emulator)).not.toContain('volumes');
    expect(keys(emulator)).not.toContain('id_tokens');
    expect(keys(emulator)).not.toContain('secrets');
  });

  it('starts exactly one service: the pinned MiniStack image, Lambdas in-process', () => {
    expect(template.services).toEqual([
      {
        name: '$IMG_MINISTACK',
        alias: 'ministack',
        variables: expect.objectContaining({ LAMBDA_EXECUTOR: 'local' }),
      },
    ]);
    const images = load('.gitlab/ci/images.yml') as unknown as {
      variables: Record<string, string>;
    };
    expect(images.variables.IMG_MINISTACK).toMatch(
      /^docker\.io\/ministackorg\/ministack:1\.5\.26@sha256:[a-f0-9]{64}$/,
    );
  });

  it('uses fake credentials, the allowlisted endpoint and no AWS configuration files', () => {
    expect(vars).toMatchObject({
      STARTER_EMULATOR_MODE: 'ci-service',
      STARTER_EMULATOR_ALLOWED_ENDPOINT: 'http://ministack:4566',
      AWS_ENDPOINT_URL: 'http://ministack:4566',
      AWS_ACCESS_KEY_ID: '000000000001',
      AWS_SECRET_ACCESS_KEY: 'ministack-local-only',
      AWS_REGION: 'ap-southeast-1',
      AWS_DEFAULT_REGION: 'ap-southeast-1',
      AWS_CONFIG_FILE: '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      AWS_EC2_METADATA_DISABLED: 'true',
      CDK_DISABLE_CLI_TELEMETRY: 'true',
      CDK_DISABLE_VERSION_CHECK: 'true',
      STARTER_MINISTACK_EXPECTED_VERSION: '1.5.26',
      STARTER_MINISTACK_IMAGE: '$IMG_MINISTACK',
    });
    // Nothing that redirects or re-enables the CDK CLI's phone-home, and no proxy.
    expect(keys(emulator)).not.toContain('TELEMETRY_ENDPOINT');
    expect(
      keys(emulator).filter((n) => /^(?:npm_config_)?(?:https?_|all_)?proxy$/i.test(n)),
    ).toEqual([]);
    // Nothing that selects real credentials or a service-specific endpoint.
    const names = keys(emulator);
    for (const denied of [
      'AWS_PROFILE',
      'AWS_DEFAULT_PROFILE',
      'AWS_SESSION_TOKEN',
      'AWS_ROLE_ARN',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
      'AWS_CONTAINER_CREDENTIALS_FULL_URI',
      'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    ])
      expect(names).not.toContain(denied);
    expect(names.filter((n) => n.startsWith('AWS_ENDPOINT_URL_'))).toEqual([]);
    expect(vars.AWS_ACCESS_KEY_ID).not.toMatch(/^(AKIA|ASIA)/);
  });

  it('labels a guard refusal and keeps its non-zero exit', () => {
    const script = strings(template.script).join('\n');
    expect(script).toContain(
      'bash tests/aws-integration/emulator/ci.sh "$STARTER_MINISTACK_SUITE"',
    );
    expect(script).toMatch(/exit "\$rc"\s*$/);
    expect(script).not.toMatch(/\|\|\s*true|exit 0/);
  });

  it('keeps reports on failure and the leak scan reads them', () => {
    expect(template.artifacts).toEqual({
      when: 'always',
      expire_in: '2 weeks',
      paths: ['reports/aws-integration/emulator/'],
      reports: { junit: 'reports/aws-integration/emulator/*/report/junit.xml' },
    });
    const scan = load('.gitlab/ci/integration.yml')['security:artifact-scan'] ?? {};
    for (const job of JOBS)
      expect(scan.needs).toContainEqual({ job, artifacts: true, optional: true });
  });
});
