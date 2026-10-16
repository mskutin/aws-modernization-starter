/**
 * The fake AWS world of the Phase 2 lifecycle self-tests (sandbox-*.test.ts): `aws`, `pnpm` (cdk,
 * builds, vitest, playwright), `skopeo`, `cosign`, `podman`, the test-IdP tools, the smoke CLI and
 * the finops CLI are fakes over one JSON state (fake-world.js); the account guard is the faithful
 * fake of fake-guard.ts, which brackets every guarded command in the call log. Network-facing
 * sbx-tool commands are simulated; everything else is the real compiled CLI.
 */

import { execFileSync, spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import {
  ALLOW_STATEMENTS,
  DENY_OUTSIDE_TRANSACTION,
  DENY_STATEMENTS,
  PROBE_MARKER,
} from '../db-probe.js';
import { FAKE_GUARD } from './fake-guard.js';
import { installRealGuard } from './real-guard.js';

export { isMutation, unguardedMutations } from './fake-guard.js';

export const SUITE = fileURLToPath(new URL('../../..', import.meta.url));
export const SANDBOX = join(SUITE, 'sandbox');
export const FAKE_WORLD = fileURLToPath(new URL('./fake-world.js', import.meta.url));
export const ACCOUNT = '111122223333';
export const OPERATOR_ARN = `arn:aws:iam::111122223333:role/aws-reserved/sso.amazonaws.com/ap-southeast-1/AWSReservedSSO_Developer_0123456789abcdef`;
export const JWK_D = 'PRIVATEdPRIVATEdPRIVATEdPRIVATEdPRIVATEd123';
export const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: SUITE,
  encoding: 'utf8',
}).trim();

/** sbx-tool with the network commands simulated (everything else: the real CLI). */
export const FAKE_TOOL = `#!/usr/bin/env bash
results=""; check=""; outf=""
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[$i]}" in
    --results) results="\${args[$((i + 1))]}" ;;
    --check) check="\${args[$((i + 1))]}" ;;
    --out) outf="\${args[$((i + 1))]}" ;;
  esac
done
case "$1" in
  issuer-check | spa-check | health-check | alb-direct-check | clock-skew)
    echo "TOOL $1" >> "$FAKE_LOG"
    if [[ -n "$results" ]]; then
      node "$SBX_REAL_CLI" results-add --results "$results" --check "\${check:-$1}" --name "$1 (simulated)" --status passed --evidence simulated
    fi
    exit 0 ;;
  canary-submit)
    echo "TOOL $1" >> "$FAKE_LOG"
    cp "$FAKE_CANARY_TEMPLATE" "$outf"
    cp "$outf" "$FAKE_CANARY_RUN"
    exit 0 ;;
  log-follow)
    echo "TOOL $1" >> "$FAKE_LOG"
    exec sleep 120 ;;
  *) exec node "$SBX_REAL_CLI" "$@" ;;
esac
`;

export const FAKE_IDP_SERVER = `import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const e = process.env;
appendFileSync(e.FAKE_LOG, \`IDP start runtime=\${e.APP_RUNTIME} issuer=\${e.TEST_IDP_ISSUER} redirect=\${e.TEST_IDP_REDIRECT_URIS} aud=\${e.TEST_IDP_AUDIENCE} client=\${e.TEST_IDP_CLIENT_ID} test=\${e.TEST_IDP_ENABLE_TEST_ENDPOINTS} key=\${e.TEST_IDP_SIGNING_KEY_FILE}\\n\`);
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ issuer: e.TEST_IDP_ISSUER }));
});
server.listen(Number(e.TEST_IDP_PORT), e.TEST_IDP_HOST);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

export const via = (tool: string) =>
  `process.argv.splice(2, 0, '${tool}');\nawait import(${JSON.stringify(FAKE_WORLD)});\n`;

/** The current fake world (one per test) and the per-file build of the CLI. */
export const w = {
  dir: '',
  home: '',
  log: '',
  idpPort: 0,
  template: '',
  cli: '',
  /** The call log of the template world (bootstrap.sh + up.sh). */
  templateCalls: [] as string[],
  /** Run the scripts under the REAL account guard instead of the fake (useWorld option). */
  realGuard: false,
  /** SANDBOX_GUARD_SCRIPT of the current world. */
  guardScript: '',
};

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export const probeLines = (): string[] => {
  const line = (name: string, ok: boolean, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ probe: PROBE_MARKER, runId: '__RUN__', name, ok, ...extra });
  return [
    line('tls-verify-full', true, { user: 'starter_app', ssl: true, tls: 'TLSv1.3' }),
    line('tls-wrong-ca', false, { code: 'SELF_SIGNED_CERT_IN_CHAIN' }),
    line('tls-wrong-hostname', false, { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
    line('tls-disabled', false, { code: '28000' }),
    line('iam-other-role', false, { code: '28P01' }),
    ...ALLOW_STATEMENTS.map(([n]) => line(`allow:${n}`, true)),
    ...[...DENY_STATEMENTS, ...DENY_OUTSIDE_TRANSACTION].map(([n]) =>
      line(`deny:${n}`, false, { code: '42501' }),
    ),
    line('done', true),
  ];
};

export async function setUpWorld(): Promise<void> {
  w.dir = await mkdtemp(join(tmpdir(), 'starter-sbx-scripts-'));
  w.home = join(w.dir, 'sandbox-home');
  w.log = join(w.dir, 'calls.log');
  w.idpPort = await freePort();
  const bin = join(w.dir, 'bin');
  await mkdir(bin, { recursive: true });
  for (const tool of ['aws', 'pnpm', 'skopeo', 'cosign', 'podman']) {
    // FAKE_LOG / FAKE_STATE are baked in: the real guard runs `aws` with a reduced environment.
    await writeFile(
      join(bin, tool),
      `#!/bin/sh\n: "\${FAKE_LOG:=${w.log}}" "\${FAKE_STATE:=${join(w.dir, 'state.json')}}"\n` +
        `export FAKE_LOG FAKE_STATE\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_WORLD)} ${tool} "$@"\n`,
    );
    await chmod(join(bin, tool), 0o755);
  }
  await writeFile(join(bin, 'sbx-tool'), FAKE_TOOL);
  await chmod(join(bin, 'sbx-tool'), 0o755);
  if (w.realGuard) {
    w.guardScript = await installRealGuard(w.dir, w.dir);
  } else {
    w.guardScript = join(w.dir, 'sandbox-guard.sh');
    await writeFile(w.guardScript, FAKE_GUARD);
  }
  const idp = join(w.dir, 'test-idp-dist');
  await mkdir(idp, { recursive: true });
  await writeFile(join(idp, 'sandbox-issuer.js'), via('issuer-tool'));
  await writeFile(join(idp, 'server.js'), FAKE_IDP_SERVER);
  await writeFile(join(w.dir, 'smoke.js'), via('smoke'));
  await writeFile(join(w.dir, 'finops.js'), via('finops'));
  await mkdir(join(w.dir, 'infra', 'dist', 'bin'), { recursive: true });
  await writeFile(join(w.dir, 'infra', 'dist', 'bin', 'app.js'), '// fake app (cdk is faked)\n');
  await mkdir(join(w.dir, 'web-dist'), { recursive: true });
  await writeFile(join(w.dir, 'web-dist', 'index.html'), '<div id="root"></div>');
  await writeFile(join(w.dir, 'aws-auth.ts'), '// present\n');
  // The project's own signing public key (the fake cosign accepts any key file).
  await writeFile(
    join(w.dir, 'cosign.pub'),
    '-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n',
  );
  await writeFile(join(w.dir, 'probe-lines.json'), JSON.stringify(probeLines()));
  await writeFile(
    join(w.dir, 'canary-template.json'),
    JSON.stringify({
      runId: 'sbx',
      submittedAt: new Date().toISOString(),
      canaryJobId: '11111111-1111-4111-8111-111111111111',
      canaryStatus: 'SUCCEEDED',
      failureJobId: '22222222-2222-4222-8222-222222222222',
      failureStatus: 'FAILED',
      failureErrorName: 'JobValidationError',
      canaries: {
        title: 'sbx canary title t~live~0001',
        sentence: 'the silent beacon aa~bb stays inside the database.',
        token: 'cnry~aaaaaaaaaaaa~bbbbbbbbbbbb',
      },
      ownerView: { titleFound: true, contentCanariesFound: 0 },
    }),
  );
  await mkdir(w.home, { recursive: true, mode: 0o700 });
  await writeFile(join(w.home, 'expected-account'), `${ACCOUNT}\n`, { mode: 0o600 });
  await writeFile(join(w.home, 'operator-role-arn'), `${OPERATOR_ARN}\n`, { mode: 0o600 });
  await writeFile(w.log, '');
}

export async function stopIdps(root: string): Promise<void> {
  const runs = join(root, 'sandbox-home', 'runs');
  for (const r of await readdir(runs).catch(() => [] as string[])) {
    const pidFile = join(runs, r, 'idp.pid');
    const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    await rm(pidFile, { force: true });
  }
}

/**
 * A world after `bootstrap.sh` + `up.sh`, deployed once (beforeAll) and copied into the tests
 * that start from a deployed run (its IdP is stopped; test/up/rollback scripts restart it).
 */

export async function deployedWorld(): Promise<string> {
  await rm(w.home, { recursive: true, force: true });
  await cp(join(w.template, 'sandbox-home'), w.home, { recursive: true, verbatimSymlinks: true });
  await cp(join(w.template, 'state.json'), join(w.dir, 'state.json'));
  return runDir();
}

export interface Run {
  code: number | null;
  output: string;
}

export function runScript(
  script: string,
  env: Record<string, string> = {},
  args: string[] = [],
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [join(SANDBOX, script), ...args], {
      cwd: SUITE,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${join(w.dir, 'bin')}:${process.env.PATH ?? ''}`,
        HOME: w.dir,
        AWS_EC2_METADATA_DISABLED: 'true',
        SANDBOX_HOME: w.home,
        SANDBOX_GUARD_SCRIPT: w.guardScript,
        PNPM: join(w.dir, 'bin', 'pnpm'),
        PODMAN: join(w.dir, 'bin', 'podman'),
        SBX_TOOL: join(w.dir, 'bin', 'sbx-tool'),
        SBX_REAL_CLI: w.cli,
        SBX_TEST_IDP_DIST: join(w.dir, 'test-idp-dist'),
        SBX_SMOKE_CLI: join(w.dir, 'smoke.js'),
        SBX_FINOPS_CLI: join(w.dir, 'finops.js'),
        SBX_COSIGN_PUBKEY: join(w.dir, 'cosign.pub'),
        SBX_INFRA_DIR: join(w.dir, 'infra'),
        SBX_WEB_DIST: join(w.dir, 'web-dist'),
        SBX_E2E_AUTH_MODULE: join(w.dir, 'aws-auth.ts'),
        SBX_IDP_PORT: String(w.idpPort),
        SBX_SKIP_BUILD: 'true',
        SBX_POLL_SECONDS: '0',
        SBX_LEAK_SCAN_RETRY_SECONDS: '0',
        SBX_LEAK_SCAN_DEADLINE_SECONDS: '5',
        SBX_TASK_LOG_DEADLINE_SECONDS: '5',
        FAKE_LOG: w.log,
        FAKE_STATE: join(w.dir, 'state.json'),
        FAKE_HEAD: HEAD,
        FAKE_JWK_D: JWK_D,
        FAKE_PROBE_LINES: join(w.dir, 'probe-lines.json'),
        FAKE_CANARY_TEMPLATE: join(w.dir, 'canary-template.json'),
        FAKE_CANARY_RUN: join(w.dir, 'canary-run.json'),
        ...env,
      },
    });
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr.on('data', (c: Buffer) => (output += c.toString()));
    if (process.env.SBX_SELFTEST_KEEP) {
      child.stdout.on(
        'data',
        (c: Buffer) => void writeFile(join(w.dir, 'output.log'), c, { flag: 'a' }),
      );
      child.stderr.on(
        'data',
        (c: Buffer) => void writeFile(join(w.dir, 'output.log'), c, { flag: 'a' }),
      );
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

export const calls = async () => (await readFile(w.log, 'utf8')).split('\n').filter(Boolean);
export const state = async () =>
  JSON.parse(await readFile(join(w.dir, 'state.json'), 'utf8')) as {
    stacks: Record<string, unknown>;
    toolkit: unknown;
    retainedBucket: string | null;
    secret: string | null;
    logGroups: string[];
    taskDefs: Record<string, { status: string }>;
    keys: Record<string, string>;
    service: { taskDefinition: string; baseline: string } | null;
    tasks: Record<string, { name: string; sg: string | null }>;
    foreign: { stacks: Record<string, unknown>; logGroups: string[]; taskDefs: string[] };
    foreignTouched: string[];
  };

export async function filesUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Secrets never in script output or any run-directory file (other than their own 0600 files). */
export async function expectNoSecretLeak(output: string, secret: string): Promise<void> {
  const needles = {
    'origin-verify value': secret,
    'issuer private key d': JWK_D,
    'ECR token': 'fake-ecr-token-0123456789',
  };
  for (const [label, value] of Object.entries(needles))
    expect(output.includes(value), `${label} in script output`).toBe(false);
  for (const f of await filesUnder(w.home)) {
    const rel = relative(w.home, f);
    if (/(^|\/)(origin-verify|issuer-key\.jwk)$/.test(rel) || rel.includes('/cdk.out/')) continue;
    const text = await readFile(f, 'utf8');
    for (const [label, value] of Object.entries(needles))
      expect(text.includes(value), `${label} in ${rel}`).toBe(false);
  }
}

export const deployOrder = (lines: readonly string[]) =>
  lines.flatMap((l) => /exec cdk deploy Sandbox\/(\w+)/.exec(l)?.[1] ?? []);
export const destroyOrder = (lines: readonly string[]) =>
  lines.flatMap(
    (l) =>
      /exec cdk destroy Sandbox\/(\w+)/.exec(l)?.[1] ??
      /cloudformation delete-stack --stack-name Sandbox-(\w+)/.exec(l)?.[1] ??
      [],
  );
export const CONTRACT_ORDER = [
  'Foundation',
  'TestIssuer',
  'Platform',
  'Data',
  'Workflow',
  'Migrations',
  'Api',
  'Frontend',
  'Observability',
];

export async function runDir(): Promise<string> {
  const runs = (await readdir(join(w.home, 'runs'))).filter((r) => /^sbx-[0-9a-f]{6}$/.test(r));
  expect(runs).toHaveLength(1);
  return join(w.home, 'runs', runs[0] as string);
}

export async function results(
  file: string,
): Promise<{ check: string; name: string; status: string }[]> {
  return (await readFile(file, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { check: string; name: string; status: string });
}

/**
 * Registers the hooks of a lifecycle self-test file: a private build of the sbx-tool CLI (one per
 * file, so files can run in parallel), a fresh fake world per test, and — with `template` — one
 * world after `bootstrap.sh` + `up.sh`, copied into tests by `deployedWorld()`.
 */
export function useWorld(opts: { template: boolean; realGuard?: boolean }): void {
  let outDir = '';
  beforeAll(() => {
    w.realGuard = opts.realGuard ?? false;
    // The scripts call the compiled CLI dozens of times: compile it once for this file.
    outDir = join(
      SUITE,
      'dist',
      `.selftest-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const tsc = createRequire(join(SUITE, 'package.json')).resolve('typescript/bin/tsc');
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--outDir', outDir], {
      cwd: SUITE,
      stdio: 'pipe',
    });
    w.cli = join(outDir, 'sandbox', 'cli.js');
  }, 120_000);
  afterAll(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true });
  });
  if (opts.template) {
    beforeAll(async () => {
      await setUpWorld();
      const b = await runScript('bootstrap.sh');
      const u = await runScript('up.sh');
      if (b.code !== 0 || u.code !== 0)
        throw new Error(`template world failed:\n${b.output}\n${u.output}`);
      await stopIdps(w.dir);
      w.templateCalls = await calls();
      w.template = w.dir;
    }, 120_000);
    afterAll(async () => {
      if (w.template && !process.env.SBX_SELFTEST_KEEP)
        await rm(w.template, { recursive: true, force: true });
    });
  }
  beforeEach(setUpWorld);
  afterEach(async () => {
    // Stop any fake IdP a test left running (down.sh normally does).
    await stopIdps(w.dir);
    // SBX_SELFTEST_KEEP=1 keeps the fake world for debugging (path printed).
    if (process.env.SBX_SELFTEST_KEEP) console.log(`kept ${w.dir}`);
    else await rm(w.dir, { recursive: true, force: true });
  });
}
