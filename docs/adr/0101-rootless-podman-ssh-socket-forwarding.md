# ADR 0101 — Run local containers on rootless Podman via an SSH-forwarded API socket

- Status: Accepted (amended: the same helper also covers Linux; see the note at the end)

## Context

- On macOS a Podman machine (by default `podman-machine-default`, a Fedora CoreOS VM) often has a
  **rootful default connection** that may already host other projects' containers and volumes.
  Our containers must not share that namespace, must not be able to touch it, and must not run
  as root in the VM.
- The machine also exposes a rootless connection for its VM user (subordinate uid/gid ranges,
  linger enabled, cgroup v2 controllers delegated, SELinux enforcing).
- `podman compose` on macOS delegates to the external `docker-compose` provider and **ignores
  `--connection`**: it always talks to the machine's default (rootful) API socket.

## Decision

1. Every local container of this repository runs **rootless as the VM user**.
2. `scripts/podman/rootless-socket.sh {start|stop|status|env}` forwards the rootless API socket
   (`$XDG_RUNTIME_DIR/podman/podman.sock` of the VM user, resolved inside the VM) to
   `~/.local/share/starter-podman/run/podman-rootless.sock` on macOS with
   `ssh -L <local.sock>:<remote.sock>`:
   - SSH port, identity and user are read from `podman machine inspect` (never hard-coded);
   - the remote path is resolved inside the VM; `podman.socket` is socket-activated if needed;
   - an SSH control socket makes `stop` precise; `status` succeeds only if the libpod
     `/info` endpoint reports `rootless: true`;
   - the run directory is `0700` and the socket `0600` (`StreamLocalBindMask=0177`): only the
     macOS user can reach it;
   - `env` prints `DOCKER_HOST`, `CONTAINER_HOST` (for compose, Testcontainers and the podman
     CLI) and `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` (the _VM-side_ path, for tools that
     bind-mount the engine socket into a helper container).
3. The compose helpers (`local/compose/bin/*`) use it and refuse to proceed unless
   `podman info` reports `Rootless=true`.

## Consequences

- Rootless isolation: container uid 0 maps to the VM user's uid, the rest to its subordinate
  range; nothing here can affect the rootful namespace or other projects.
- Ports: rootless containers can only bind VM ports ≥ 1024; the machine's port forwarding
  publishes them on `127.0.0.1` on macOS (verified). Nothing is bound to `0.0.0.0`.
- Bind mounts in compose resolve **in the VM**, which shares only the user's home directory with
  macOS; host paths that are bind-mounted (the per-user state directory with the generated secrets
  and TLS material) must therefore stay below `$HOME` (init SQL is injected with compose
  `configs.content`).
- The forward is a process on the host; after a macOS reboot or `podman machine stop/start`
  it must be re-established — `rootless-socket.sh start` does that idempotently.
- Containers survive a VM restart only if the `podman-restart.service` user unit is enabled
  (`systemctl --user enable podman-restart.service` in the VM; policy `unless-stopped` is honoured). Data always survives
  (named volumes).
- Known quirk: `podman compose up --abort-on-container-exit` (attached mode) hangs against
  the forwarded socket; use detached `up -d`.

## Alternatives considered

- **Switch the default connection to rootless** (`podman system connection default`) —
  rejected: changes behaviour for every other project on the same machine.
- **`podman-compose` (Python) with `--podman-args`** — needs an additional global Python tool and
  behaves differently from docker-compose v2.
- **Run compose inside the VM over SSH** — works, but compose files and relative paths would
  have to be synced into the VM; the socket forward keeps the developer workflow on macOS.
- **A dedicated second Podman machine** — strongest separation, but costs another 15 GB VM.

## Note: Linux

The helper has two modes (`STARTER_PODMAN_MODE=auto|machine|native`, chosen by `uname -s`). The
decision above is the **machine** mode for macOS. On Linux (including WSL2) the **native** mode uses
the user's own rootless socket `$XDG_RUNTIME_DIR/podman/podman.sock`: socket-activated with
`systemctl --user start podman.socket` when a systemd user session exists, otherwise served by a
`podman system service` that the helper starts and, on `stop`, ends. It refuses to run as uid 0 and
never uses `sudo`. The same `start|stop|status|env` interface and rootless check apply to both
modes (`docs/development.md` §4.0).
