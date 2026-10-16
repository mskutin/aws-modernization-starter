# ADR 0601 — Rootless Podman for local containers; Testcontainers without Ryuk

- Status: Accepted

## Context

The development Mac runs one Podman machine whose default connection is **rootful** and hosts
unrelated projects. This project's containers must run **rootless** and must never touch other
projects' containers or volumes. `podman compose` (docker-compose provider) ignores
`--connection` and always targets the default socket unless `DOCKER_HOST` is set. GitLab CI jobs
have no container socket at all.

## Decision

1. All local containers (compose stack, Testcontainers) use `DOCKER_HOST` pointing at a rootless
   socket provided by `scripts/podman/rootless-socket.sh` (forwarded out of `podman machine` on
   macOS, the user's own `$XDG_RUNTIME_DIR/podman/podman.sock` on Linux; ADR 0101). Helper scripts verify via the
   libpod `/info` endpoint that the engine is rootless and refuse otherwise.
2. Every resource is namespaced `starter-app-*` (compose project `starter-app`); `dev-down.sh` never
   deletes volumes unless `--volumes` is passed explicitly.
3. Images are pinned by digest and multi-arch (`linux/amd64` and `linux/arm64`).
4. Testcontainers runs with `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=<the engine-side socket path>`
   (printed by `scripts/podman/rootless-socket.sh env`) **and**, on SELinux hosts (the
   `podman machine` VM, Fedora/RHEL), `TESTCONTAINERS_RYUK_PRIVILEGED=true` — measured on macOS
   with a Podman machine: without the override the host-side socket path is mounted into the
   reaper; without privileged mode SELinux denies it the socket; together the reaper works. In rootless mode "privileged" cannot exceed the user's own
   rights. `TESTCONTAINERS_RYUK_DISABLED=true` is the fallback; a label-scoped sweeper
   (`local/compose/bin/tc-cleanup.sh`) removes leftovers in that case.
5. Suites never require a container runtime: endpoints come from env (CI `services:`); local-only
   tests that control containers (`outage` project) skip with a reason unless
   `LOCAL_CONTAINER_CONTROL=true`.

## Consequences

- Zero interference with rootful workloads; the same compose file works for every developer.
- With the reaper disabled, a killed test run can leave containers behind; mitigated by explicit
  stops and `tc-cleanup.sh`.
- Podman builds OCI images (no `HEALTHCHECK`), so compose declares healthchecks itself.
