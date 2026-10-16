import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { main } from '../src/cli.ts';
import { eslintToCodeQuality } from '../src/codequality.ts';
import { evaluate, fromPnpmJson, parseSpdx, validatePolicy } from '../src/licenses.ts';
import { buildStatement, provenanceStatus, validateMetadata } from '../src/provenance.ts';
import { aiReviewStatus, awsStatus, NOT_CONFIGURED_EXIT, releaseStatus } from '../src/status.ts';

const repoRoot = join(import.meta.dirname, '../../..');
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'tool-ci-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('licenses', () => {
  const policy = validatePolicy(
    parse(readFileSync(join(repoRoot, '.gitlab/security/license-policy.yaml'), 'utf8')),
  );

  it('parses SPDX expressions with AND/OR/WITH and parentheses', () => {
    expect(parseSpdx('(MIT OR Apache-2.0) AND BSD-3-Clause')).toMatchObject({ kind: 'and' });
    expect(parseSpdx('Apache-2.0 WITH LLVM-exception')).toEqual({
      kind: 'id',
      id: 'Apache-2.0 WITH LLVM-exception',
    });
    expect(() => parseSpdx('(MIT')).toThrow(/unbalanced|end/);
  });

  it('allows permissive licenses and denies copyleft / unknown', () => {
    const pkgs = fromPnpmJson({
      MIT: [{ name: 'a', versions: ['1.0.0'], license: 'MIT' }],
      '(MIT OR GPL-3.0)': [{ name: 'b', versions: ['1.0.0'], license: '(MIT OR GPL-3.0)' }],
      'GPL-3.0': [{ name: 'c', versions: ['1.0.0'], license: 'GPL-3.0' }],
      'MIT AND GPL-2.0': [{ name: 'd', versions: ['1.0.0'], license: 'MIT AND GPL-2.0' }],
      Unknown: [{ name: 'e', versions: ['1.0.0'], license: 'Unknown' }],
    });
    const { findings } = evaluate(pkgs, policy, '2026-10-13');
    const status = Object.fromEntries(findings.map((f) => [f.name, f.verdict.status]));
    expect(status).toEqual({ a: 'allowed', b: 'allowed', c: 'denied', d: 'denied', e: 'denied' });
    const c = findings.find((f) => f.name === 'c');
    expect(c?.verdict.status === 'denied' && c.verdict.reason).toMatch(/explicitly denied/);
  });

  it('honours unexpired exceptions and rejects expired ones', () => {
    const withException = {
      ...policy,
      exceptions: [
        {
          package: 'c',
          license: 'GPL-3.0',
          reason: 'build-time only',
          approvedBy: 'security',
          expires: '2026-12-01',
        },
        {
          package: 'z',
          license: 'GPL-3.0',
          reason: 'unused',
          approvedBy: 'security',
          expires: '2026-12-01',
        },
      ],
    };
    const pkgs = [{ name: 'c', versions: ['1'], license: 'GPL-3.0' }];
    expect(evaluate(pkgs, withException, '2026-10-13').findings[0]?.verdict.status).toBe(
      'excepted',
    );
    const expired = evaluate(pkgs, withException, '2027-01-01').findings[0];
    expect(expired?.verdict.status === 'denied' && expired.verdict.reason).toMatch(
      /exception expired/,
    );
    expect(evaluate(pkgs, withException, '2026-10-13').problems.join()).toMatch(
      /unused license exception for z/,
    );
  });

  it('rejects malformed policies', () => {
    expect(() =>
      validatePolicy({ version: 1, allowed: [], denied: [], exceptions: [{ package: 'x' }] }),
    ).toThrow(/license/);
  });
});

describe('code quality conversion', () => {
  it('maps ESLint messages to GitLab Code Quality issues with stable fingerprints', () => {
    const issues = eslintToCodeQuality(
      [
        {
          filePath: '/repo/apps/api/src/a.ts',
          messages: [{ ruleId: 'no-console', severity: 2, message: 'Unexpected console', line: 3 }],
        },
      ],
      '/repo',
    );
    expect(issues).toEqual([
      expect.objectContaining({
        check_name: 'no-console',
        severity: 'major',
        location: { path: 'apps/api/src/a.ts', lines: { begin: 3 } },
      }),
    ]);
    expect(issues[0]?.fingerprint).toHaveLength(32);
  });
});

describe('provenance', () => {
  const meta = {
    component: 'api',
    image: 'starter/api',
    tag: 'abc12345',
    digest: `sha256:${'1'.repeat(64)}`,
    archive: 'oci-out/api/image.oci.tar',
    archiveSha256: '2'.repeat(64),
    dockerfile: 'apps/api/Dockerfile',
    dockerfileSha256: '3'.repeat(64),
    context: '.',
    baseImages: [
      {
        ref: `docker.io/library/node:24@sha256:${'4'.repeat(64)}`,
        digest: `sha256:${'4'.repeat(64)}`,
      },
    ],
    buildArgs: { VCS_REF: 'a'.repeat(40) },
    lockfileSha256: '5'.repeat(64),
    builder: { buildahVersion: '1.43.4', isolation: 'chroot', storageDriver: 'vfs' },
    git: { commit: 'a'.repeat(40), ref: 'main', repository: 'http://gitlab/root/starter' },
    ci: { CI_JOB_URL: 'http://gitlab/job/1' },
  };

  it('builds an in-toto v1 statement with SLSA v1 predicate and materials', () => {
    const s = buildStatement(validateMetadata(meta), 'localhost/starter/api') as {
      _type: string;
      subject: Array<{ digest: { sha256: string } }>;
      predicateType: string;
      predicate: { buildDefinition: { resolvedDependencies: Array<{ name: string }> } };
    };
    expect(s._type).toBe('https://in-toto.io/Statement/v1');
    expect(s.predicateType).toBe('https://slsa.dev/provenance/v1');
    expect(s.subject[0]?.digest.sha256).toBe('1'.repeat(64));
    expect(s.predicate.buildDefinition.resolvedDependencies.map((d) => d.name)).toEqual([
      'source',
      'base-image',
      'dockerfile',
      'lockfile',
    ]);
  });

  it('refuses metadata without digests', () => {
    expect(() => validateMetadata({ ...meta, digest: 'latest', baseImages: [] })).toThrow(
      /digest must be|baseImages/,
    );
  });

  it('CLI writes statement, predicate and an explicit unsigned status', async () => {
    const dir = tmp();
    const input = join(dir, 'image.json');
    writeFileSync(input, JSON.stringify(meta));
    const saved = process.env.CI_COMMIT_REF_PROTECTED;
    delete process.env.CI_COMMIT_REF_PROTECTED;
    expect(await main(['provenance', '--image-json', input, '--out', dir])).toBe(0);
    if (saved !== undefined) process.env.CI_COMMIT_REF_PROTECTED = saved;
    const status = JSON.parse(readFileSync(join(dir, 'api.status.json'), 'utf8'));
    expect(status.signed).toBe(false);
    expect(status.signing).toMatch(/NOT SIGNED/);
    expect(
      JSON.parse(readFileSync(join(dir, 'api.predicate.json'), 'utf8')).buildDefinition,
    ).toBeDefined();
  });
});

describe('not-configured status', () => {
  it('reports AWS as not configured without leaking values', () => {
    const s = awsStatus({ AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE' });
    expect(s.configured).toBe(false);
    expect(s.jobs.every((j) => j.status === 'not configured — not executed')).toBe(true);
    expect(JSON.stringify(s)).not.toContain('AKIAEXAMPLE');
  });

  it('AWS jobs need the switch AND a protected ref (credentials are runner-scoped files)', () => {
    expect(
      awsStatus({ AWS_JOBS_ENABLED: 'true', CI_COMMIT_REF_PROTECTED: 'true' }).configured,
    ).toBe(true);
    const mr = awsStatus({ AWS_JOBS_ENABLED: 'true', CI_COMMIT_REF_PROTECTED: 'false' });
    expect(mr.configured).toBe(false);
    expect(mr.summary).toMatch(/never run on an unprotected ref/);
    expect(awsStatus({ CI_COMMIT_REF_PROTECTED: 'true' }).configured).toBe(false);
  });

  it('requires the explicit switch plus endpoint, model and token for AI review', () => {
    expect(
      aiReviewStatus({
        AI_REVIEW_ENABLED: 'true',
        AI_REVIEW_GITLAB_TOKEN: 't',
        AI_REVIEW_API_BASE: 'u',
      }).summary,
    ).toMatch(/missing AI_REVIEW_MODEL/);
    expect(
      aiReviewStatus({ AI_REVIEW_GITLAB_TOKEN: 't', AI_REVIEW_API_BASE: 'u', AI_REVIEW_MODEL: 'm' })
        .configured,
    ).toBe(false);
    expect(
      aiReviewStatus({
        AI_REVIEW_ENABLED: 'true',
        AI_REVIEW_GITLAB_TOKEN: 'secret',
        AI_REVIEW_API_BASE: 'u',
        AI_REVIEW_MODEL: 'm',
      }),
    ).toMatchObject({ configured: true });
  });

  it('CLI: an unconfigured optional integration is a green report that says "not executed"', async () => {
    const dir = tmp();
    const saved = { ...process.env };
    delete process.env.AWS_JOBS_ENABLED;
    try {
      expect(await main(['status', 'aws', '--out', dir])).toBe(0);
      expect(readFileSync(join(dir, 'aws.md'), 'utf8')).toMatch(/NOT CONFIGURED — NOT EXECUTED/);
      expect(readFileSync(join(dir, 'aws.md'), 'utf8')).toContain(
        'aws: not configured — not executed',
      );
    } finally {
      process.env = saved;
    }
  });

  it('AI review: off is a plain report; opted in but incomplete is a warning (78)', () => {
    expect(aiReviewStatus({}).exitCode).toBe(0);
    expect(aiReviewStatus({}).lines).toEqual([
      'ai-review: off (AI_REVIEW_ENABLED is not "true") — not executed',
    ]);
    expect(aiReviewStatus({ AI_REVIEW_ENABLED: 'true' }).exitCode).toBe(NOT_CONFIGURED_EXIT);
    expect(
      aiReviewStatus({
        AI_REVIEW_ENABLED: 'true',
        AI_REVIEW_GITLAB_TOKEN: 'secret-token',
        AI_REVIEW_API_BASE: 'u',
        AI_REVIEW_MODEL: 'm',
      }).exitCode,
    ).toBe(0);
    expect(
      JSON.stringify(
        aiReviewStatus({ AI_REVIEW_ENABLED: 'true', AI_REVIEW_GITLAB_TOKEN: 'secret-token' }),
      ),
    ).not.toContain('secret-token');
  });
});

describe('release status (signing opt-in)', () => {
  const MAIN = {
    CI_COMMIT_REF_PROTECTED: 'true',
    CI_COMMIT_BRANCH: 'main',
    CI_DEFAULT_BRANCH: 'main',
    CI_REGISTRY_IMAGE: 'registry.example.com/group/app',
  };
  const TAGS = {
    STARTER_RELEASE_RUNNER_TAG: 'protected',
    STARTER_PROTECTED_RUNNER_TAG: 'protected',
    STARTER_SIGNER_RUNNER_TAG: 'signer',
  };

  it('MR pipeline, zero configuration: green, says images are unsigned and not published', () => {
    const s = releaseStatus({ CI_COMMIT_REF_PROTECTED: 'false', CI_REGISTRY_IMAGE: 'r/x' });
    expect(s.exitCode).toBe(0);
    expect(s.lines).toEqual([
      'container build: enabled (rootless Buildah; scan, SBOM, provenance gated)',
      'publish: not a protected release ref — images of this pipeline are UNSIGNED build artifacts, nothing is published',
      'signing: not configured (opt in: STARTER_RELEASE_SIGNING=true)',
    ]);
  });

  it('default branch, zero configuration: green, publishes and states "signing: not configured"', () => {
    const s = releaseStatus(MAIN);
    expect(s.exitCode).toBe(0);
    expect(s.configured).toBe(false);
    expect(s.lines).toContain(
      'signing: not configured — published images are UNSIGNED (opt in: STARTER_RELEASE_SIGNING=true)',
    );
    expect(s.lines?.join('\n')).toMatch(/publish: container:publish pushes .*TLS verification on/);
    expect(s.jobs.filter((j) => j.job !== 'container:publish:<id>').map((j) => j.status)).toEqual([
      'not configured — not executed',
      'not configured — not executed',
      'not configured — not executed',
    ]);
  });

  it('default branch without a registry: nothing published, still green', () => {
    const s = releaseStatus({ ...MAIN, CI_REGISTRY_IMAGE: '' });
    expect(s.exitCode).toBe(0);
    expect(s.lines?.join('\n')).toMatch(
      /publish: not configured — the project container registry is disabled/,
    );
  });

  it('an image-build opt-out is an allowed warning, never green', () => {
    const s = releaseStatus({ ...MAIN, STARTER_CONTAINER_BUILD: 'false' });
    expect(s.exitCode).toBe(NOT_CONFIGURED_EXIT);
    expect(s.lines?.[0]).toMatch(/^container build: DISABLED/);
  });

  it('signing opted in: fails closed on a release ref without its runners or registry', () => {
    const missing = releaseStatus({ ...MAIN, STARTER_RELEASE_SIGNING: 'true' });
    expect(missing.exitCode).toBe(1);
    expect(missing.configured).toBe(false);
    for (const name of [
      'STARTER_SIGNER_RUNNER_TAG',
      'STARTER_PROTECTED_RUNNER_TAG',
      'STARTER_RELEASE_RUNNER_TAG',
    ])
      expect(missing.lines?.join('\n')).toContain(`signing is enabled but ${name} is empty`);
    expect(missing.lines).toContain(
      'signing: configured but INCOMPLETE — see errors; nothing is reported as signed',
    );
    const noRegistry = releaseStatus({
      ...MAIN,
      ...TAGS,
      CI_REGISTRY_IMAGE: '',
      STARTER_RELEASE_SIGNING: 'true',
    });
    expect(noRegistry.exitCode).toBe(1);
    expect(noRegistry.lines?.join('\n')).toMatch(
      /registry is disabled: nothing can be published, signed/,
    );
  });

  it('signing opted in and complete: configured, green; on an MR it only says "release refs only"', () => {
    const ok = releaseStatus({ ...MAIN, ...TAGS, STARTER_RELEASE_SIGNING: 'true' });
    expect(ok).toMatchObject({ exitCode: 0, configured: true });
    expect(ok.lines).toContain(
      'signing: configured — container:sign, container:verify and container:chain-report run after the gate',
    );
    const mr = releaseStatus({ STARTER_RELEASE_SIGNING: 'true', CI_COMMIT_REF_PROTECTED: 'false' });
    expect(mr.exitCode).toBe(0);
    expect(mr.lines).toContain(
      'signing: configured — runs on protected release refs only, not in this pipeline',
    );
  });

  it('an invalid REGISTRY_TLS_VERIFY fails; false is reported as OFF', () => {
    expect(releaseStatus({ ...MAIN, REGISTRY_TLS_VERIFY: 'yes' }).exitCode).toBe(1);
    expect(releaseStatus({ ...MAIN, REGISTRY_TLS_VERIFY: 'false' }).lines?.join('\n')).toMatch(
      /TLS verification OFF \(REGISTRY_TLS_VERIFY=false\)/,
    );
  });

  it('CLI exit codes follow the status (0 / 78 / 1)', async () => {
    const saved = { ...process.env };
    try {
      for (const [extra, code] of [
        [{}, 0],
        [{ STARTER_CONTAINER_BUILD: 'false' }, NOT_CONFIGURED_EXIT],
        [{ STARTER_RELEASE_SIGNING: 'true' }, 1],
      ] as const) {
        process.env = { PATH: saved.PATH, ...MAIN, ...extra };
        const dir = tmp();
        expect(await main(['status', 'release', '--out', dir])).toBe(code);
        expect(readFileSync(join(dir, 'release.md'), 'utf8')).toContain('# release:');
      }
    } finally {
      process.env = saved;
    }
  });

  it('provenance on a release ref without signing says NOT SIGNED — signing: not configured', () => {
    expect(String(provenanceStatus(true, false).signing)).toMatch(
      /^NOT SIGNED — signing: not configured/,
    );
    expect(String(provenanceStatus(true, true).signing)).toMatch(/container:sign attests/);
    expect(String(provenanceStatus(false, true).signing)).toMatch(/^NOT SIGNED — unprotected ref/);
  });
});
