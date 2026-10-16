import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * "Bring your own GitLab" (docs/ci-cd.md): the committed pipeline must run on any GitLab with
 * one generic Docker-executor runner and zero project configuration. These tests pin the
 * properties of the CI YAML and release scripts that make that true, and the opt-in switches that
 * keep optional capabilities (runner tags, signing, AI review, plain-HTTP registry) explicit.
 */
const repo = join(import.meta.dirname, '../../..');
type Doc = Record<string, unknown>;
type Job = Record<string, unknown>;

const ciFiles = [
  '.gitlab-ci.yml',
  ...readdirSync(join(repo, '.gitlab/ci'))
    .filter((f) => f.endsWith('.yml'))
    .map((f) => `.gitlab/ci/${f}`),
  '.gitlab/ci/generated/components.yml',
];
const load = (file: string): Doc => (parse(readFileSync(join(repo, file), 'utf8')) ?? {}) as Doc;
const docs = Object.fromEntries(ciFiles.map((f) => [f, load(f)]));
const root = docs['.gitlab-ci.yml'] as Doc;
const rootVars = root.variables as Record<string, string | { value: string; options?: string[] }>;
const valueOf = (name: string): string | undefined => {
  const v = rootVars[name];
  return typeof v === 'string' ? v : v?.value;
};
const allJobs: Array<[string, string, Job]> = Object.entries(docs).flatMap(([file, doc]) =>
  Object.entries(doc)
    .filter(([, body]) => body && typeof body === 'object' && !Array.isArray(body))
    .map(([name, body]) => [file, name, body as Job] as [string, string, Job]),
);
const job = (name: string): Job => {
  const hit = allJobs.find(([, n]) => n === name);
  if (!hit) throw new Error(`no job ${name}`);
  return hit[2];
};
const ifs = (j: Job): string[] =>
  ((j.rules as Array<{ if?: string; when?: string }> | undefined) ?? []).map(
    (r) => `${r.if ?? '(no if)'} -> ${r.when ?? 'on_success'}`,
  );

const RUNNER_TAG_VARS = [
  'STARTER_RUNNER_TAG',
  'STARTER_PROTECTED_RUNNER_TAG',
  'STARTER_RELEASE_RUNNER_TAG',
  'STARTER_SIGNER_RUNNER_TAG',
];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('runner selection: untagged by default, tags only through optional variables', () => {
  it('every tags entry is exactly one runner-tag variable, never a literal tag', () => {
    const seen = new Set<string>();
    for (const [file, name, body] of allJobs) {
      if (!('tags' in body)) continue;
      expect(body.tags, `${file}: ${name}`).toEqual([
        expect.stringMatching(/^\$STARTER_[A-Z_]+_TAG$/),
      ]);
      const v = (body.tags as string[])[0]?.slice(1) ?? '';
      expect(RUNNER_TAG_VARS, `${file}: ${name}`).toContain(v);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([...RUNNER_TAG_VARS].sort());
  });

  it('every runner-tag variable is defined at the top level and empty by default', () => {
    // An UNDEFINED variable stays a literal "$NAME" tag that no runner has (GitLab 19.4 dry run);
    // a defined empty one is dropped, so the job is untagged.
    for (const name of RUNNER_TAG_VARS) expect(valueOf(name), name).toBe('');
  });

  it('names no bespoke runner, network, host pin or runner-mounted file outside the opt-in paths', () => {
    for (const file of ciFiles) {
      const text = readFileSync(join(repo, file), 'utf8');
      // Not even in comments: the reference platform's runner names are gone.
      expect(text, file).not.toMatch(/(?<!\/run\/)starter-(local|protected|signing|sbx)\b/);
      // Configuration (comment lines may explain what a runner operator might do).
      const code = text
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
      expect(code, file).not.toMatch(
        /\b(network_mode|extra_hosts|allowed_services|STARTER_LOCAL_GITLAB)\b/,
      );
      expect(code, file).not.toMatch(/docker\.sock|podman\.sock|DOCKER_HOST|privileged/);
      // Runner-mounted files appear only in the opt-in AWS jobs (credentials) and comments.
      const mounts = code.split('\n').filter((l) => l.includes('/run/starter-'));
      if (file !== '.gitlab/ci/aws.yml') expect(mounts, file).toEqual([]);
    }
  });

  it('jobs that run MR code or services stay on the default runner explicitly', () => {
    expect(root.default).toMatchObject({ tags: ['$STARTER_RUNNER_TAG'] });
    expect(job('security:protected-secrets').tags).toEqual(['$STARTER_RUNNER_TAG']);
    expect(job('.ministack').tags).toEqual(['$STARTER_RUNNER_TAG']);
    expect(job('.protected-runner').tags).toEqual(['$STARTER_PROTECTED_RUNNER_TAG']);
    expect(job('.container-sign').tags).toEqual(['$STARTER_SIGNER_RUNNER_TAG']);
    for (const t of [
      '.container-build',
      '.container-scan',
      '.container-sbom',
      '.container-provenance',
    ])
      expect(job(t).tags, t).toEqual(['$STARTER_RELEASE_RUNNER_TAG']);
  });

  it('workflow:rules set no runner tag (nested variables are not expanded in tags)', () => {
    const text = JSON.stringify((root.workflow as Doc).rules);
    expect(text).not.toMatch(/RUNNER_TAG/);
  });
});

describe('optional capabilities are explicit opt-ins', () => {
  it('defaults: signing off, AI review off, container build on, registry TLS verified', () => {
    expect(valueOf('STARTER_RELEASE_SIGNING')).toBe('false');
    expect(valueOf('AI_REVIEW_ENABLED')).toBe('false');
    expect(valueOf('STARTER_CONTAINER_BUILD')).toBe('true');
    expect(valueOf('REGISTRY_TLS_VERIFY')).toBe('true');
  });

  it('AI review jobs do not exist unless AI_REVIEW_ENABLED=true', () => {
    const ai = ifs(job('review:ai'));
    expect(ai[0]).toBe('$CI_PIPELINE_SOURCE != "merge_request_event" -> never');
    // Fork MRs never receive the AI review token and key.
    expect(ai[1]).toBe('$CI_MERGE_REQUEST_SOURCE_PROJECT_ID != $CI_PROJECT_ID -> never');
    expect(ai[2]).toMatch(
      /^\$AI_REVIEW_ENABLED == "true" && \$AI_REVIEW_GITLAB_TOKEN && \$AI_REVIEW_API_BASE && \$AI_REVIEW_MODEL -> on_success$/,
    );
    expect(ai).toHaveLength(3);
    expect(ifs(job('review:ai-status'))).toEqual([
      '$CI_PIPELINE_SOURCE != "merge_request_event" -> never',
      '$AI_REVIEW_ENABLED != "true" -> never',
      '$AI_REVIEW_GITLAB_TOKEN && $AI_REVIEW_API_BASE && $AI_REVIEW_MODEL -> never',
      '(no if) -> on_success',
    ]);
    expect(job('review:ai').allow_failure).toBe(true);
  });

  it('approval:human logs user names and ids only, never an e-mail address', () => {
    const script = (job('approval:human').script as string[]).join('\n');
    expect(script).not.toMatch(/echo[^\n]*GITLAB_USER_EMAIL/);
    const run = (author: string) =>
      spawnSync('sh', ['-c', script], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GITLAB_USER_LOGIN: 'alice',
          GITLAB_USER_ID: '42',
          GITLAB_USER_EMAIL: 'alice@example.invalid',
          CI_COMMIT_AUTHOR: author,
          CI_MERGE_REQUEST_IID: '7',
          CI_COMMIT_SHA: '0123abc',
        },
      });
    const other = run('Bob Example <bob@example.invalid>');
    expect(other.status).toBe(0);
    expect(other.stdout).toContain('Approved by: alice (user id 42)');
    expect(other.stdout).toContain('Commit author: Bob Example');
    const self = run('Alice Example <alice@example.invalid>');
    expect(self.status).toBe(1);
    expect(self.stderr).toMatch(/approver authored the head commit/);
    for (const r of [other, self]) expect(`${r.stdout}${r.stderr}`).not.toContain('@');
  });

  it('sign, verify and the chain report need STARTER_RELEASE_SIGNING; publish needs the registry', () => {
    for (const step of ['sign', 'verify', 'chain-report']) {
      const rules = ifs(job(`container:${step}:api`));
      expect(rules, step).toContain('$STARTER_RELEASE_SIGNING != "true" -> never');
      expect(rules, step).toContain(
        '$CI_REGISTRY_IMAGE == null || $CI_REGISTRY_IMAGE == "" -> never',
      );
      expect(rules.indexOf('$STARTER_RELEASE_SIGNING != "true" -> never'), step).toBeLessThan(
        rules.findIndex((r) => r.endsWith('-> on_success')),
      );
    }
    const publish = ifs(job('container:publish:api'));
    expect(publish).toContain('$CI_REGISTRY_IMAGE == null || $CI_REGISTRY_IMAGE == "" -> never');
    expect(publish).not.toContain('$STARTER_RELEASE_SIGNING != "true" -> never');
    // Publish exists only when the registry does: no "not configured" exit code to allow.
    expect(job('.container-publish')).not.toHaveProperty('allow_failure');
  });

  it('a project opt-out of image builds removes the whole chain and its dependants, not lint', () => {
    const optOut = '$STARTER_CONTAINER_BUILD == "false" -> never';
    expect(ifs(job('.impact-image:api'))[0]).toBe(optOut);
    for (const step of ['build', 'scan', 'sbom', 'provenance'])
      expect(job(`container:${step}:api`).extends, step).toContain('.impact-image:api');
    for (const step of ['publish', 'sign', 'verify', 'chain-report'])
      expect(ifs(job(`container:${step}:api`)), step).toContain(optOut);
    expect(job('security:image-config:api').extends).toContain('.impact-image:api');
    expect(job('container:lint:api').extends).toContain('.impact:api');
  });

  it('release:status reports in every full pipeline and fails only on a broken opt-in', () => {
    const s = job('release:status');
    expect(s.extends).toEqual(['.status-report', '.rules:always']);
    expect(s.script).toEqual(['node tools/ci/src/cli.ts status release --out reports/status']);
    expect(job('.status-report').allow_failure).toEqual({ exit_codes: [78] });
    expect(job('aws:status').extends).toEqual(['.status-report']);
  });
});

describe('release scripts', () => {
  const scripts = join(repo, 'tools/ci/scripts');
  const sh = (script: string, env: Record<string, string>) =>
    spawnSync('sh', ['-c', script], {
      cwd: repo,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    });

  it('registry TLS is verified by default, off only for exactly "false", invalid values fail', () => {
    const tls = '. tools/ci/scripts/registry-tls.sh; registry_tls_verify';
    const flags = '. tools/ci/scripts/registry-tls.sh; registry_cosign_flags';
    expect(sh(tls, {}).stdout.trim()).toBe('true');
    expect(sh(tls, { REGISTRY_TLS_VERIFY: 'true' }).stdout.trim()).toBe('true');
    const off = sh(tls, { REGISTRY_TLS_VERIFY: 'false' });
    expect(off.stdout.trim()).toBe('false');
    expect(off.stderr).toMatch(/TLS verification is OFF/);
    for (const bad of ['no', '0', 'FALSE', 'yes']) {
      const r = sh(tls, { REGISTRY_TLS_VERIFY: bad });
      expect(r.status, bad).toBe(2);
      expect(r.stdout, bad).toBe('');
    }
    expect(sh(flags, {}).stdout.trim()).toBe('');
    expect(sh(flags, { REGISTRY_TLS_VERIFY: 'false' }).stdout.trim()).toBe(
      '--allow-insecure-registry --allow-http-registry',
    );
    expect(sh(`${flags} || echo failed`, { REGISTRY_TLS_VERIFY: 'maybe' }).stdout.trim()).toBe(
      'failed',
    );
  });

  it('every script that talks to the registry uses the shared TLS policy', () => {
    for (const f of [
      'container-publish.sh',
      'cosign-sign.sh',
      'cosign-verify.sh',
      'cosign-rescan-target.sh',
      'trivy.sh',
    ]) {
      const text = readFileSync(join(scripts, f), 'utf8');
      expect(text, f).toContain('. tools/ci/scripts/registry-tls.sh');
      expect(text, f).not.toMatch(/--allow-http-registry|--tls-verify=false|STARTER_LOCAL_GITLAB/);
    }
  });

  it('the rescan refuses to pick a target when signing is not configured', () => {
    const r = sh('sh tools/ci/scripts/cosign-rescan-target.sh', {
      COMPONENT_ID: 'api',
      IMAGE_NAME: 'x/api',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/signing: not configured/);
  });

  it('a Buildah failure caused by the runner is diagnosed; an ordinary build error is not', () => {
    const d = mkdtempSync(join(tmpdir(), 'buildah-diag-'));
    dirs.push(d);
    const diagnose = (log: string) => {
      const file = join(d, 'log');
      writeFileSync(file, log);
      return sh(`sh tools/ci/scripts/buildah-diagnose.sh ${file}`, {
        CI_RUNNER_DESCRIPTION: 'generic',
      });
    };
    for (const log of [
      'STEP 2/9: RUN corepack enable pnpm\nerror running container: from /usr/bin/crun creating container: unshare: operation not permitted\n',
      'Error: cannot set up namespace using "/usr/bin/newuidmap": exit status 1\n',
      'mount /proc: operation not permitted\n',
    ]) {
      const r = diagnose(log);
      expect(r.status, log).toBe(0);
      expect(r.stdout).toMatch(/could not create the namespaces or mounts/);
      expect(r.stdout).toContain('STARTER_CONTAINER_BUILD=false');
      expect(r.stdout).toMatch(/Do NOT enable privileged mode/);
    }
    const ordinary = diagnose('STEP 5/9: RUN pnpm install\nERR_PNPM_FETCH_404 not found\n');
    expect(ordinary.status).toBe(1);
    expect(ordinary.stdout).toBe('');
    const build = readFileSync(join(scripts, 'container-build.sh'), 'utf8');
    expect(build).toContain('sh tools/ci/scripts/buildah-diagnose.sh "$build_log"');
    expect(build).toMatch(/exit "\$rc"/);
  });
});
