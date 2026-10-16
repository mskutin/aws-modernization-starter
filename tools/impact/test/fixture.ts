import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isolatedGitEnv } from '../src/git.ts';

/**
 * Builds a small but realistic monorepo on disk:
 *
 *   contracts <- domain <- fn-validator <- api <- tests-integration
 *   contracts <- web <- tests-e2e (also depends on api)
 *   infra --dependsOn--> fn-validator ; policies / tool-finops feed infra checks
 */

export const FIXTURE_COMPONENTS = `
schemaVersion: 1
global:
  - package.json
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
  - tsconfig.base.json
  - components.yaml
  - .gitlab-ci.yml
  - .gitlab/**/*
nonComponent:
  - '*.md'
  - docs/**/*
components:
  - id: web
    kind: spa
    path: apps/web
    package: '@fx/web'
    build: { artifact: { type: static-site, location: apps/web/dist } }
    deploy:
      stack: '{Stage}/Web'
      strategy: s3
      rollback: { automated: false, mechanism: redeploy previous artifact }
  - id: api
    kind: service
    path: apps/api
    package: '@fx/api'
    extraPaths: [.hadolint.yaml]
    build:
      artifact: { type: container-image, dockerfile: apps/api/Dockerfile, image: fx/api, ignoreFile: apps/api/.dockerignore }
    deploy:
      stack: '{Stage}/Api'
      strategy: ecs-rolling
      healthChecks: [{ type: http, target: /health/ready }]
      rollback: { automated: true, mechanism: circuit breaker }
  - id: fn-validator
    kind: lambda
    path: functions/validator
    package: '@fx/fn-validator'
    deploy:
      stack: '{Stage}/Workflow'
      strategy: alias
      rollback: { automated: false, mechanism: alias shift }
  - id: contracts
    kind: library
    path: packages/contracts
    package: '@fx/contracts'
  - id: domain
    kind: library
    path: packages/domain
    package: '@fx/domain'
  - id: infra
    kind: infra
    path: infra
    package: '@fx/infra'
    dependsOn: [fn-validator]
    infra:
      environments: [dev, prod]
      policyComponents: [policies]
      finopsComponents: [tool-finops]
  - id: policies
    kind: policy
    path: policies
    package: '@fx/policies'
  - id: tool-finops
    kind: tool
    path: tools/finops
    package: '@fx/tool-finops'
  - id: tests-integration
    kind: test-suite
    path: tests/integration
    package: '@fx/tests-integration'
    dependsOn: [api]
    test: { unit: null, integration: pnpm --filter @fx/tests-integration run test }
  - id: tests-e2e
    kind: test-suite
    path: tests/e2e
    package: '@fx/tests-e2e'
    dependsOn: [web, api]
    test: { unit: null }
  - id: db
    kind: datastore
    dependsOn: [infra]
    deploy:
      stack: '{Stage}/Data'
      strategy: in-place
      rollback: { automated: false, mechanism: forward-fix only }
`;

const PACKAGES: Record<string, { name: string; deps?: string[] }> = {
  'apps/web': { name: '@fx/web', deps: ['@fx/contracts'] },
  'apps/api': { name: '@fx/api', deps: ['@fx/contracts', '@fx/domain', '@fx/fn-validator'] },
  'functions/validator': { name: '@fx/fn-validator', deps: ['@fx/contracts', '@fx/domain'] },
  'packages/contracts': { name: '@fx/contracts' },
  'packages/domain': { name: '@fx/domain', deps: ['@fx/contracts'] },
  infra: { name: '@fx/infra' },
  policies: { name: '@fx/policies' },
  'tools/finops': { name: '@fx/tool-finops' },
  'tests/integration': { name: '@fx/tests-integration' },
  'tests/e2e': { name: '@fx/tests-e2e' },
};

const CI_MAIN = `
include:
  - local: .gitlab/ci/jobs.yml
  - local: .gitlab/ci/generated/components.yml
`;

const CI_JOBS = `
.rules:always:
  rules:
    - when: on_success
.gated:
  after_script: [echo]
.component-test:
  extends: [.gated]
  script: [echo]
lint:
  extends: [.rules:always, .gated]
  stage: verify
  script: [echo lint]
contracts:openapi-drift:
  extends: [.gated, '.impact:contracts']
  script: [echo drift]
e2e:playwright:
  extends: ['.impact:tests-e2e']
  stage: integration
  script: [echo e2e]
aws:status:
  script:
    - !reference [.gated, after_script]
`;

function write(root: string, rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export function makeRepo(overrides: { components?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'impact-fixture-'));
  write(root, 'package.json', JSON.stringify({ name: 'fixture-root', private: true }, null, 2));
  write(
    root,
    'pnpm-workspace.yaml',
    'packages:\n  - apps/*\n  - functions/*\n  - packages/*\n  - infra\n  - policies\n  - tools/*\n  - tests/*\n',
  );
  write(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  write(root, 'components.yaml', overrides.components ?? FIXTURE_COMPONENTS);
  write(root, '.gitlab-ci.yml', CI_MAIN);
  write(root, '.gitlab/ci/jobs.yml', CI_JOBS);
  write(root, 'README.md', '# fixture\n');
  for (const [dir, pkg] of Object.entries(PACKAGES)) {
    const deps = Object.fromEntries((pkg.deps ?? []).map((d) => [d, 'workspace:*']));
    write(
      root,
      `${dir}/package.json`,
      JSON.stringify({ name: pkg.name, dependencies: deps }, null, 2),
    );
    write(root, `${dir}/src/index.ts`, `export const name = '${pkg.name}';\n`);
  }
  write(root, 'apps/api/Dockerfile', 'FROM scratch\n');
  return root;
}

/**
 * git inside a fixture repository ONLY: `-C root`, the environment without GIT_DIR/GIT_INDEX_FILE &
 * co. (inherited from a git hook they would point at the real repository) and a ceiling directory
 * so discovery never climbs above the fixture.
 */
export function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...isolatedGitEnv(),
      GIT_CEILING_DIRECTORIES: dirname(root),
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: root,
    },
  }).trim();
}

export function initGit(root: string): string {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base', '--no-verify');
  return git(root, 'rev-parse', 'HEAD');
}

export function commitChange(root: string, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'change', '--no-verify');
  return git(root, 'rev-parse', 'HEAD');
}
