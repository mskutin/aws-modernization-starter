/**
 * local/compose: where the generated local secrets live (outside the repository), the host
 * preflight of bin/_lib.sh, and the portability properties of compose.yaml (macOS podman machine
 * and Linux rootless Podman, SELinux enforcing or not). Runs a COPY of the compose helpers in a
 * temp dir, with stub podman and a fake Podman API: the developer's real env file, TLS material
 * and containers are never touched.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CURL,
  OPENSSL,
  REPO_ROOT,
  createSandbox,
  run,
  startFakeApi,
  stub,
  type Sandbox,
} from './support.js';

const COMPOSE_SRC = path.join(REPO_ROOT, 'local/compose');
const NO_CURL = CURL ? false : 'curl is not installed on this machine; the helpers need it';
const NO_OPENSSL = OPENSSL ? false : 'openssl is not installed on this machine; dev-up.sh needs it';

let sb: Sandbox;
let compose: string; // the copy's local/compose

beforeEach(() => {
  sb = createSandbox('starter-cmp-');
  compose = path.join(sb.dir, 'repo/local/compose');
  mkdirSync(path.join(compose, 'bin'), { recursive: true });
  for (const f of ['bin/_lib.sh', 'bin/env.sh', '.env.example', 'compose.yaml']) {
    cpSync(path.join(COMPOSE_SRC, f), path.join(compose, f));
  }
  stub(
    sb,
    'podman',
    `case "$*" in
  *"volume exists starter-app-pgdata"*) [ "\${FAKE_VOLUME:-no}" = yes ]; exit $? ;;
esac
exit 64`,
  );
});
afterEach(() => sb.cleanup());

/** Sources the copy's _lib.sh and runs `script` (bash) with it. */
const lib = (script: string, env: Record<string, string | undefined> = {}) =>
  run(
    sb,
    'bash',
    ['-c', `set -euo pipefail; source "$1"; ${script}`, 'bash', path.join(compose, 'bin/_lib.sh')],
    { DOCKER_HOST: 'unix:///nonexistent.sock', ...env },
  );

const defaultState = () => path.join(sb.dir, '.local/state/starter-app/compose');
const envValue = (file: string, key: string) =>
  new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(file, 'utf8'))?.[1];

describe('generated local secrets live outside the repository', () => {
  it('creates the env file in the per-user state dir: mode 600, one random value per placeholder', () => {
    const r = lib('ensure_env_file; printf "%s\\n" "$ENV_FILE"');
    expect(r.status, r.stderr).toBe(0);
    const envFile = r.stdout.trim();
    expect(envFile).toBe(path.join(defaultState(), '.env'));
    expect(envFile.startsWith(path.join(sb.dir, 'repo'))).toBe(false);
    expect(existsSync(path.join(compose, '.env'))).toBe(false);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(statSync(defaultState()).mode & 0o777).toBe(0o700);

    const text = readFileSync(envFile, 'utf8');
    expect(text).not.toContain('__GENERATE__');
    const keys = [
      'POSTGRES_ADMIN_PASSWORD',
      'STARTER_MIGRATOR_PASSWORD',
      'STARTER_APP_PASSWORD',
      'STARTER_PROCESSOR_PASSWORD',
      'STARTER_RETENTION_PASSWORD',
    ];
    const values = keys.map((k) => envValue(envFile, k));
    for (const v of values) expect(v).toMatch(/^[0-9a-f]{36}$/);
    expect(new Set(values).size).toBe(keys.length);
  });

  it('is idempotent: a second run keeps every existing value', () => {
    expect(lib('ensure_env_file').status).toBe(0);
    const first = readFileSync(path.join(defaultState(), '.env'), 'utf8');
    const again = lib('ensure_env_file');
    expect(again.status, again.stderr).toBe(0);
    expect(readFileSync(path.join(defaultState(), '.env'), 'utf8')).toBe(first);
  });

  it('honours XDG_STATE_HOME, and STARTER_LOCAL_STATE_DIR above it', () => {
    const xdg = path.join(sb.dir, 'xdg-state');
    const r1 = lib('printf "%s|%s|%s" "$ENV_FILE" "$TLS_DIR" "$STARTER_TLS_DIR"', {
      XDG_STATE_HOME: xdg,
    });
    const s1 = path.join(xdg, 'starter-app/compose');
    expect(r1.stdout).toBe(`${s1}/.env|${s1}/postgres-tls|${s1}/postgres-tls`);

    const own = path.join(sb.dir, 'elsewhere');
    const r2 = lib('printf "%s" "$ENV_FILE"', {
      XDG_STATE_HOME: xdg,
      STARTER_LOCAL_STATE_DIR: own,
    });
    expect(r2.stdout).toBe(`${own}/.env`);
  });

  it('moves a worktree-local .env of an older checkout (values kept, file removed)', () => {
    const legacy = path.join(compose, '.env');
    writeFileSync(
      legacy,
      'POSTGRES_ADMIN_USER=starter_admin\nPOSTGRES_ADMIN_PASSWORD=keepme\nPOSTGRES_DB=starter_app\n',
      { mode: 0o600 },
    );
    const r = lib('ensure_env_file');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('moved');
    expect(existsSync(legacy)).toBe(false);
    const envFile = path.join(defaultState(), '.env');
    expect(envValue(envFile, 'POSTGRES_ADMIN_PASSWORD')).toBe('keepme');
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    // Missing role passwords are added; the existing value is not regenerated.
    expect(envValue(envFile, 'STARTER_APP_PASSWORD')).toMatch(/^[0-9a-f]{36}$/);
  });

  it('refuses to invent new passwords when the data volume already exists', () => {
    const r = lib('ensure_env_file', { FAKE_VOLUME: 'yes' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/volume starter-app-pgdata exists but .*\.env does not/);
    expect(r.stderr).toContain('STARTER_LOCAL_STATE_DIR');
    expect(existsSync(path.join(defaultState(), '.env'))).toBe(false);
  });

  it.skipIf(NO_OPENSSL)(
    'generates the PostgreSQL TLS material in the state dir (key 600, chain verifies)',
    () => {
      const r = lib('ensure_local_tls');
      expect(r.status, r.stderr).toBe(0);
      const tls = path.join(defaultState(), 'postgres-tls');
      expect(statSync(path.join(tls, 'server.key')).mode & 0o777).toBe(0o600);
      expect(existsSync(path.join(compose, 'postgres/tls'))).toBe(false);
      const verify = run(
        sb,
        'openssl',
        ['verify', '-CAfile', path.join(tls, 'ca.pem'), path.join(tls, 'server.pem')],
        {},
      );
      expect(verify.stdout, verify.stderr).toContain('OK');
    },
  );

  it('env.sh points host processes at the state dir (CA) and the generated role password', () => {
    expect(lib('ensure_env_file').status).toBe(0);
    const r = run(sb, 'bash', [path.join(compose, 'bin/env.sh')], {});
    expect(r.status, r.stderr).toBe(0);
    const envFile = path.join(defaultState(), '.env');
    expect(r.stdout).toContain(
      `export DB_SSL_ROOT_CERT='${path.join(defaultState(), 'postgres-tls/ca.pem')}'`,
    );
    expect(r.stdout).toContain(
      `export DB_PASSWORD='${envValue(envFile, 'STARTER_APP_PASSWORD') ?? '<missing>'}'`,
    );
  });

  it('env.sh without a generated env file says how to create it', () => {
    const r = run(sb, 'bash', [path.join(compose, 'bin/env.sh')], {});
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing .*\.env; run local\/compose\/bin\/dev-up\.sh first/);
  });
});

describe('bin/_lib.sh host preflight', () => {
  it.skipIf(NO_CURL)('refuses a DOCKER_HOST that serves a ROOTFUL engine', () => {
    const sock = path.join(sb.dir, 'rootful.sock');
    startFakeApi(sb, sock, false);
    const r = lib('ensure_rootless_docker_host', { DOCKER_HOST: `unix://${sock}` });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/is not a rootless Podman API \(rootless=false\); refusing/);
  });

  it.skipIf(NO_CURL)('accepts a rootless engine', () => {
    const sock = path.join(sb.dir, 'rootless.sock');
    startFakeApi(sb, sock, true);
    const r = lib('ensure_rootless_docker_host; printf "%s" "$DOCKER_HOST"', {
      DOCKER_HOST: `unix://${sock}`,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`unix://${sock}`);
  });

  it('names every missing host tool at once', () => {
    rmSync(path.join(sb.toolbox, 'node'));
    rmSync(path.join(sb.toolbox, 'curl'), { force: true });
    const r = lib('ensure_rootless_docker_host');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing on PATH: curl node/);
  });

  it('explains a missing compose provider', () => {
    const r = lib('ensure_compose_provider', { COMPOSE_CMD: 'podman compose' });
    // The podman stub knows no `compose` subcommand: like podman without a provider.
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('install a compose provider (docker-compose v2');
  });
});

describe('compose.yaml portability', () => {
  const text = readFileSync(path.join(COMPOSE_SRC, 'compose.yaml'), 'utf8');
  const bindMounts = [...text.matchAll(/^\s+- ((?:\.{1,2}\/|\$\{)[^\n]*)$/gm)].map(
    (m) => m[1] ?? '',
  );

  it('relabels every bind mount for SELinux-enforcing Linux hosts (`z`; a no-op elsewhere)', () => {
    expect(bindMounts.length).toBeGreaterThanOrEqual(8);
    for (const m of bindMounts) expect(m, m).toMatch(/:ro,z$/);
  });

  it('mounts the TLS material from the state dir, never from the repository', () => {
    expect(text).not.toMatch(/\.\/postgres\/tls/);
    const tlsMounts = bindMounts.filter((m) => m.includes('/starter/tls'));
    expect(tlsMounts.length).toBeGreaterThanOrEqual(5);
    for (const m of tlsMounts) expect(m).toMatch(/^\$\{STARTER_TLS_DIR:\?/);
  });

  it('has no host-specific paths or user ids', () => {
    const withoutDigests = text.replace(/@sha256:[0-9a-f]{64}/g, '');
    // (/home/dynamodblocal is the image's own data dir, inside the container.)
    expect(withoutDigests).not.toMatch(
      /\/Users\/|\/home\/(?!dynamodblocal\/)|\/run\/user\/|host\.containers\.internal/,
    );
    expect(withoutDigests).not.toMatch(/\b501\b/); // a macOS-style uid
  });

  it('publishes ports on 127.0.0.1 only and pins every pulled image by digest', () => {
    for (const p of text.matchAll(/^\s+- ([^\n]*:\d+)$/gm)) expect(p[1]).toMatch(/^127\.0\.0\.1:/);
    for (const img of text.matchAll(/^\s+image: (\S+)$/gm)) {
      const ref = img[1] ?? '';
      if (ref.startsWith('localhost/')) continue; // built locally, pull_policy: never
      expect(ref).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });
});
