/**
 * scripts/podman/rootless-socket.sh on Linux (native rootless Podman) and macOS (podman machine),
 * driven with stub podman/systemctl/ssh/uname/id and a fake Podman API on a unix socket
 * (./support.ts). LOCAL SIMULATION: proves the helper's decisions and outputs; it does not start a
 * real Podman engine.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CURL,
  REPO_ROOT,
  createSandbox,
  killRecorded,
  run,
  startFakeApi,
  stub,
  type Sandbox,
} from './support.js';

const HELPER = path.join(REPO_ROOT, 'scripts/podman/rootless-socket.sh');
const NO_CURL = CURL ? false : 'curl is not installed on this machine; the helper needs it';

let sb: Sandbox;
let runtimeDir: string;

beforeEach(() => {
  sb = createSandbox('starter-sock-');
  runtimeDir = path.join(sb.dir, 'run');
  mkdirSync(runtimeDir, { mode: 0o700 });
  stub(sb, 'uname', 'echo "${FAKE_OS:-Linux}"');
  stub(sb, 'id', '[ "$1" = -u ] && echo "${FAKE_UID:-4242}" || echo "uid=${FAKE_UID:-4242}"');
  stub(sb, 'sudo', 'exit 99');
  stub(
    sb,
    'podman',
    `case "$1 $2" in
  "system service")
    [ "\${FAKE_SERVICE:-ok}" = hang ] && exec sleep 300
    exec node "$FAKE_API" "$@" ;;
  "machine inspect")
    [ "\${FAKE_MACHINE_STATE:-running}" = missing ] && exit 125
    case "$4" in
      '{{.State}}') echo "\${FAKE_MACHINE_STATE:-running}" ;;
      '{{.SSHConfig.Port}}') echo 40022 ;;
      '{{.SSHConfig.IdentityPath}}') echo "$HOME/machine-key" ;;
      '{{.SSHConfig.RemoteUsername}}') echo "\${FAKE_MACHINE_USER:-core}" ;;
    esac ;;
  *) exit 64 ;;
esac`,
  );
  stub(
    sb,
    'systemctl',
    `[ "\${FAKE_SYSTEMD:-no}" = yes ] || exit 1
case "$*" in
  "--user show-environment" | "--user cat podman.socket") exit 0 ;;
  "--user start podman.socket")
    nohup node "$FAKE_API" "unix://$XDG_RUNTIME_DIR/podman/podman.sock" >/dev/null 2>&1 &
    exit 0 ;;
esac
exit 1`,
  );
  stub(
    sb,
    'ssh',
    `fwd=""; prev=""
for a in "$@"; do [ "$prev" = "-L" ] && fwd="$a"; prev="$a"; done
if [ -n "$fwd" ]; then
  nohup node "$FAKE_API" "unix://\${fwd%%:*}" >/dev/null 2>&1 &
  i=0; while [ ! -S "\${fwd%%:*}" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done
  exit 0
fi
case "$*" in *"-O exit"*) exit 0 ;; esac
echo "\${FAKE_REMOTE_SOCK:-/run/user/1000/podman/podman.sock}"`,
  );
});

afterEach(() => {
  killRecorded(path.join(runtimeDir, 'starter-podman', 'service.pid'));
  sb.cleanup();
});

const helper = (cmd: string, env: Record<string, string | undefined> = {}) =>
  run(sb, 'bash', [HELPER, cmd], {
    XDG_RUNTIME_DIR: runtimeDir,
    STARTER_PODMAN_START_TIMEOUT: '10',
    ...env,
  });

const exportsOf = (stdout: string): Record<string, string> =>
  Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const m = /^export ([A-Z_]+)=(.*)$/.exec(line);
        if (!m?.[1] || m[2] === undefined) throw new Error(`not an export line: ${line}`);
        return [m[1], m[2]];
      }),
  );

describe('rootless-socket.sh — Linux (native rootless Podman)', () => {
  it.skipIf(NO_CURL)(
    'with a systemd user session: socket-activates podman.socket and exports the XDG runtime socket',
    () => {
      const r = helper('env', { FAKE_SYSTEMD: 'yes' });
      expect(r.status, r.stderr).toBe(0);
      const sock = path.join(runtimeDir, 'podman/podman.sock');
      expect(exportsOf(r.stdout)).toEqual({
        DOCKER_HOST: `unix://${sock}`,
        CONTAINER_HOST: `unix://${sock}`,
        // Host and engine share one filesystem: Ryuk mounts the very same path.
        TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE: sock,
      });
      const calls = sb.readCalls();
      expect(calls).toContain('systemctl --user start podman.socket');
      expect(calls).not.toContain('podman system service');
      expect(calls).not.toMatch(/^sudo/m);
    },
  );

  it.skipIf(NO_CURL)('stop never stops the systemd-owned socket (shared with other tools)', () => {
    expect(helper('start', { FAKE_SYSTEMD: 'yes' }).status).toBe(0);
    const stop = helper('stop', { FAKE_SYSTEMD: 'yes' });
    expect(stop.status).toBe(0);
    expect(stop.stderr).toMatch(/systemd podman\.socket.*left running/);
    expect(sb.readCalls()).not.toContain('systemctl --user stop');
    expect(helper('status', { FAKE_SYSTEMD: 'yes' }).status).toBe(0);
  });

  it.skipIf(NO_CURL)(
    'without systemd: serves the API from its own podman system service; stop ends exactly that one',
    () => {
      const sock = path.join(runtimeDir, 'podman/podman.sock');
      const start = helper('start');
      expect(start.status, start.stderr).toBe(0);
      expect(sb.readCalls()).toContain(`podman system service --time=0 unix://${sock}`);
      expect(existsSync(path.join(runtimeDir, 'starter-podman/service.pid'))).toBe(true);

      // Idempotent: a second start reuses the running service.
      expect(helper('start').status).toBe(0);
      expect(sb.readCalls().match(/podman system service/g)).toHaveLength(1);

      const status = helper('status');
      expect(status.status).toBe(0);
      expect(status.stderr).toContain('rootless Podman API (native)');

      const stop = helper('stop');
      expect(stop.status, stop.stderr).toBe(0);
      expect(stop.stderr).toMatch(/stopped podman system service \(pid \d+\)/);
      const after = helper('status');
      expect(after.status).toBe(1);
      expect(after.stderr).toContain('DOWN');
    },
  );

  it.skipIf(NO_CURL)('honours a custom socket path with its own service', () => {
    const custom = path.join(sb.dir, 'custom.sock');
    const r = helper('env', { FAKE_SYSTEMD: 'yes', STARTER_PODMAN_ROOTLESS_SOCK: custom });
    expect(r.status, r.stderr).toBe(0);
    expect(exportsOf(r.stdout).DOCKER_HOST).toBe(`unix://${custom}`);
    // systemd's podman.socket only listens on the default path, so it is not used here.
    expect(sb.readCalls()).not.toContain('systemctl --user start');
    expect(sb.readCalls()).toContain(`podman system service --time=0 unix://${custom}`);
  });

  it('refuses to run as root and never reaches podman, systemctl or sudo', () => {
    const r = helper('env', { FAKE_UID: '0', FAKE_SYSTEMD: 'yes' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/running as root: .*ROOTLESS Podman only.*never with sudo/);
    expect(sb.readCalls()).not.toMatch(/^(podman|systemctl|sudo) /m);
  });

  it.skipIf(NO_CURL)('refuses a ROOTFUL API that answers on the socket path', () => {
    const sock = path.join(runtimeDir, 'podman/podman.sock');
    mkdirSync(path.dirname(sock));
    startFakeApi(sb, sock, false);
    const r = helper('env', { FAKE_SYSTEMD: 'yes' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(''); // no DOCKER_HOST is ever printed for a rootful engine
    expect(r.stderr).toContain('ROOTFUL');
  });

  it('explains a missing XDG_RUNTIME_DIR instead of guessing a uid', () => {
    const r = helper('start', { XDG_RUNTIME_DIR: undefined, FAKE_UID: '4242' });
    // /run/user/4242 does not exist on a test machine (and is never created by the helper).
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/XDG_RUNTIME_DIR is not set and \/run\/user\/4242 does not exist/);
  });

  it.skipIf(NO_CURL)('times out with the service log when the API never answers', () => {
    const r = helper('env', { FAKE_SERVICE: 'hang', STARTER_PODMAN_START_TIMEOUT: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/did not answer as rootless on .* within 1s/);
  });

  it('fails clearly when the podman CLI is missing', () => {
    // A PATH with the stubs minus podman: remove the stub.
    run(sb, 'rm', [path.join(sb.stubs, 'podman')], {});
    const r = helper('start');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('podman CLI not found');
  });
});

describe('rootless-socket.sh — macOS (podman machine)', () => {
  const darwin = (extra: Record<string, string> = {}) => ({
    FAKE_OS: 'Darwin',
    XDG_RUNTIME_DIR: undefined,
    STARTER_PODMAN_ROOTLESS_SOCK: path.join(sb.dir, 'fwd/rootless.sock'),
    ...extra,
  });

  it.skipIf(NO_CURL)(
    "forwards the VM user's rootless socket and exports the VM-side path (no fixed uid)",
    () => {
      const r = helper('env', darwin({ FAKE_REMOTE_SOCK: '/run/user/1234/podman/podman.sock' }));
      expect(r.status, r.stderr).toBe(0);
      const fwd = path.join(sb.dir, 'fwd/rootless.sock');
      expect(exportsOf(r.stdout)).toEqual({
        DOCKER_HOST: `unix://${fwd}`,
        CONTAINER_HOST: `unix://${fwd}`,
        TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE: '/run/user/1234/podman/podman.sock',
      });
      const calls = sb.readCalls();
      expect(calls).toContain(`-L ${fwd}:/run/user/1234/podman/podman.sock core@127.0.0.1`);
      expect(calls).not.toContain('root@');
      expect(readFileSync(path.join(sb.dir, 'fwd/podman-rootless.remote-path'), 'utf8')).toBe(
        '/run/user/1234/podman/podman.sock\n',
      );
    },
  );

  it('explains a stopped machine', () => {
    const r = helper('start', darwin({ FAKE_MACHINE_STATE: 'stopped' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/is 'stopped' \(run: podman machine start podman-machine-default\)/);
  });

  it('explains a missing machine', () => {
    const r = helper('start', darwin({ FAKE_MACHINE_STATE: 'missing' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/podman machine 'podman-machine-default' not found/);
  });

  it('refuses a machine whose SSH user is root', () => {
    const r = helper('start', darwin({ FAKE_MACHINE_USER: 'root' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('a non-root user is required for rootless');
    expect(sb.readCalls()).not.toMatch(/^ssh /m);
  });

  it('rejects native mode on macOS', () => {
    const r = helper('start', darwin({ STARTER_PODMAN_MODE: 'native' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('STARTER_PODMAN_MODE=native needs Linux');
  });
});

describe('rootless-socket.sh — unsupported setups', () => {
  it('names the supported platforms on any other OS', () => {
    const r = helper('start', { FAKE_OS: 'FreeBSD' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unsupported OS 'FreeBSD': use macOS .* or Linux/);
    expect(sb.readCalls()).not.toMatch(/^(podman|ssh|systemctl) /m);
  });

  it('rejects an unknown mode and an unknown command', () => {
    expect(helper('start', { STARTER_PODMAN_MODE: 'rootful' }).stderr).toContain(
      'STARTER_PODMAN_MODE must be auto, machine or native',
    );
    const usage = helper('restart');
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('usage:');
  });
});
