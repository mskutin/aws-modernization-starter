/**
 * The emulator scripts (tests/aws-integration/emulator/) must never be able to reach real AWS:
 * each refuses (exit 5, the shared guard's code) before any `cdk`, SDK, HTTP or Podman call when a
 * real credential, profile, service-specific endpoint or non-allowlisted endpoint is present.
 * Runs the scripts with a minimal environment and stub `pnpm`/`podman`/`curl`/`cdk` that record any
 * call; nothing starts. Needs the workspace build (the guard is compiled TypeScript).
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const EMULATOR_DIR = fileURLToPath(new URL('../emulator/', import.meta.url));
const NODE_DIR = path.dirname(process.execPath);

let work: string;
let stubBin: string;
let calls: string;

const stub = (tool: string, body = '') => {
  const file = path.join(stubBin, tool);
  writeFileSync(file, `#!/bin/sh\n${body}echo "${tool} $*" >> "${calls}"\nexit 97\n`);
  chmodSync(file, 0o755);
};

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'starter-emu-scripts-'));
  stubBin = path.join(work, 'bin');
  calls = path.join(work, 'calls.log');
  mkdirSync(stubBin);
  for (const tool of ['pnpm', 'podman', 'curl', 'cdk', 'aws', 'docker']) stub(tool);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

function runScript(
  script: string,
  env: Record<string, string>,
  args: string[] = [],
  dir = EMULATOR_DIR,
) {
  rmSync(calls, { force: true });
  const reportDir = path.join(work, 'reports', `${script}-${Math.random().toString(16).slice(2)}`);
  const r = spawnSync('bash', [path.join(dir, script), ...args], {
    env: {
      PATH: `${stubBin}:${NODE_DIR}:/usr/bin:/bin`,
      HOME: work,
      STARTER_EMULATOR_REPORT_DIR: reportDir,
      ...env,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const called = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
  const runIds = existsSync(reportDir) ? readdirSync(reportDir) : [];
  return { ...r, called, reportDir, runIds };
}

/** The complete environment of the CI job (interface contract with the CI side). */
const CI_JOB_ENV: Record<string, string> = {
  GITLAB_CI: 'true',
  CI_PIPELINE_IID: '4711',
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
};

const realAws: [string, Record<string, string>][] = [
  ['a profile', { AWS_PROFILE: 'starter-sandbox-developer' }],
  ['a default profile', { AWS_DEFAULT_PROFILE: 'default' }],
  ['a session token', { AWS_SESSION_TOKEN: 'token' }],
  ['a real access key', { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE00', AWS_SECRET_ACCESS_KEY: 'x' }],
  [
    'a web identity',
    { AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/token', AWS_ROLE_ARN: 'arn:aws:iam::1:role/r' },
  ],
  ['container credentials', { AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1' }],
  ['a service-specific endpoint', { AWS_ENDPOINT_URL_DYNAMODB: 'http://127.0.0.1:45660' }],
  [
    'a non-emulator endpoint',
    { AWS_ENDPOINT_URL: 'https://dynamodb.ap-southeast-1.amazonaws.com' },
  ],
  ['a config file', { AWS_CONFIG_FILE: '/home/u/.aws/config' }],
  // The CDK CLI's phone-home: a redirected telemetry sender, telemetry on.
  ['a CDK telemetry endpoint', { TELEMETRY_ENDPOINT: 'https://127.0.0.1:47124/metrics' }],
  ['CDK CLI telemetry switched on', { CDK_DISABLE_CLI_TELEMETRY: 'false' }],
];

describe('local emulator scripts refuse anything that could reach real AWS (exit 5)', () => {
  it.each(realAws)('up.sh with %s', (_label, env) => {
    const r = runScript('up.sh', env);
    expect(r.status).toBe(5);
    expect(r.stderr).toMatch(/refusing/);
    expect(r.called).toBe('');
  });

  it.each(realAws)('run.sh with %s', (_label, env) => {
    const r = runScript('run.sh', env, ['em-abcdef']);
    expect(r.status).toBe(5);
    expect(r.stderr).toMatch(/refusing/);
    expect(r.called).toBe('');
  });

  it.each(realAws)('all.sh with %s', (_label, env) => {
    const r = runScript('all.sh', env);
    expect(r.status).toBe(5);
    expect(r.called).toBe('');
  });

  it('rejects a malformed run id before anything else', () => {
    const r = runScript('down.sh', {}, ['../../etc']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/invalid emulator run id/);
  });
});

describe('ci.sh (the CI entry point)', () => {
  const ciRefusals: [string, Record<string, string>][] = [
    ...realAws.map(([label, env]): [string, Record<string, string>] => [
      label,
      { ...CI_JOB_ENV, ...env },
    ]),
    [
      'an endpoint other than the allowlisted one',
      { ...CI_JOB_ENV, AWS_ENDPOINT_URL: 'http://evil:4566' },
    ],
    [
      'a dotted allowlist',
      {
        ...CI_JOB_ENV,
        STARTER_EMULATOR_ALLOWED_ENDPOINT: 'http://evil.example.com:4566',
        AWS_ENDPOINT_URL: 'http://evil.example.com:4566',
      },
    ],
    ['ci-service mode outside GitLab CI', { ...CI_JOB_ENV, GITLAB_CI: '' }],
    [
      'ci-service mode without the allowlist',
      { ...CI_JOB_ENV, STARTER_EMULATOR_ALLOWED_ENDPOINT: '' },
    ],
    ['the service alias without ci-service mode', { ...CI_JOB_ENV, STARTER_EMULATOR_MODE: '' }],
  ];

  it.each(ciRefusals)(
    'refuses %s before any cdk, SDK or HTTP call, and still reports',
    (_label, env) => {
      const r = runScript('ci.sh', env, ['workflows']);
      expect(r.status).toBe(5);
      expect(r.stderr).toMatch(/\[emulator-guard\] refusing: /);
      expect(r.called).toBe('');
      expect(r.runIds).toHaveLength(1);
      const runDir = path.join(r.reportDir, r.runIds[0]!);
      // Nothing past the guard ran: no preflight, no template, no deploy outputs, no reset.
      for (const f of ['preflight.json', 'template.json', 'outputs.json', 'reset.json']) {
        expect(existsSync(path.join(runDir, f)), f).toBe(false);
      }
      const junit = readFileSync(path.join(runDir, 'report', 'junit.xml'), 'utf8');
      expect(junit).toMatch(/name="guard"[^>]*>\s*<failure message="exit 5"/);
      expect(junit).toMatch(/name="deploy"[^>]*>\s*<skipped/);
      // The egress audit only starts behind the guard; it is reported as not reached.
      expect(junit).toMatch(/name="egress audit"[^>]*>\s*<skipped/);
      expect(existsSync(path.join(runDir, 'egress.jsonl')), 'egress.jsonl').toBe(false);
      const d = JSON.parse(readFileSync(path.join(runDir, 'diagnostics.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(d).toMatchObject({ target: 'ministack-emulator', socketMounted: null });
    },
  );

  it('names its run (and so the stack starter-it-<runId>) after CI_PIPELINE_IID', () => {
    const r = runScript('ci.sh', { ...CI_JOB_ENV, AWS_PROFILE: 'x' }, ['cdk']);
    expect(r.runIds[0]).toMatch(/^ci4711-cdk-[0-9a-f]{4}$/);
  });

  it('rejects an unknown suite and a docker executor in CI', () => {
    expect(runScript('ci.sh', CI_JOB_ENV, ['stages']).status).toBe(2);
    const docker = runScript(
      'ci.sh',
      { ...CI_JOB_ENV, STARTER_EMULATOR_LAMBDA_EXECUTOR: 'docker' },
      ['cdk'],
    );
    expect(docker.status).toBe(2);
    expect(docker.stderr).toMatch(/socket-less only/);
  });

  it('fails fast (exit 3) with a clear message when the workspace is not built', () => {
    // A copy of the scripts in a tree without any dist/ output.
    const tree = path.join(work, 'unbuilt', 'tests', 'aws-integration', 'emulator');
    mkdirSync(tree, { recursive: true });
    cpSync(EMULATOR_DIR, tree, { recursive: true });
    const r = runScript('ci.sh', CI_JOB_ENV, ['workflows'], tree);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/workspace not built .*pnpm --filter '@starter\/infra\.\.\.'/);
    expect(r.called).toBe('');
  });

  it('never calls Podman (MiniStack is a GitLab service in CI)', () => {
    const code = readFileSync(path.join(EMULATOR_DIR, 'ci.sh'), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(
      /\bpodman\b|(^|[\s;(&|])(p|docker)\s+(run|ps|rm|pull|network|image|exec|info|tag)\b/m,
    );
    expect(code).not.toMatch(/require_rootless|load_run/);
  });
});

describe('up.sh: socket-less by default, socket mode opt-in and refused on a shared machine', () => {
  it('refuses --socket-mode without a dedicated machine', () => {
    const r = runScript('up.sh', {}, ['--socket-mode']);
    expect(r.status).toBe(6);
    expect(r.stderr).toMatch(/STARTER_EMULATOR_SOCKET_MACHINE/);
    expect(r.called).toBe('');
  });

  it('refuses the shared default machine (it mounts the home directory)', () => {
    const r = runScript('up.sh', { STARTER_EMULATOR_SOCKET_MACHINE: 'podman-machine-default' }, [
      '--socket-mode',
    ]);
    expect(r.status).toBe(6);
    expect(r.stderr).toMatch(/shared machine/);
  });

  it('refuses a machine whose configuration has host mounts', () => {
    const configDir = path.join(work, 'machine');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, 'emu.json'),
      JSON.stringify({ Mounts: [{ Source: '/Users', Target: '/Users' }] }),
    );
    stub('podman', `if [ "$1" = machine ]; then echo "${configDir}"; exit 0; fi\n`);
    try {
      const r = runScript('up.sh', { STARTER_EMULATOR_SOCKET_MACHINE: 'emu' }, ['--socket-mode']);
      expect(r.status).toBe(6);
      expect(r.stderr).toMatch(/has 1 host mount\(s\); it must have none/);
      expect(r.called).toBe('');
    } finally {
      stub('podman');
    }
  });

  it('the default container has no volume, no socket, the local executor and dropped caps', () => {
    const up = readFileSync(path.join(EMULATOR_DIR, 'up.sh'), 'utf8');
    const start = up.indexOf('if ! $SOCKET_MODE; then\n  p run');
    const end = up.indexOf('else\n  p image exists');
    expect(start).toBeGreaterThan(0);
    const defaultRun = up.slice(start, end);
    expect(defaultRun).toMatch(/LAMBDA_EXECUTOR=local/);
    expect(defaultRun).toMatch(/--cap-drop=ALL/);
    expect(defaultRun).toMatch(/-p "127\.0\.0\.1:/);
    expect(defaultRun).not.toMatch(/-v |--volume|docker\.sock|--privileged/);
  });
});
