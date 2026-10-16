# Getting started

This guide takes you from a fresh clone to each of the four tiers in which the reference can run.
Each tier adds prerequisites and proves more; none of them needs the next one.

| Tier | Where                    | Needs                                                       | Proves                                                                              |
| ---- | ------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 0    | your machine, offline    | Node.js 24, pnpm 12                                         | unit tests, type checks, offline CDK synth with policy checks                       |
| 1    | your machine, containers | + rootless Podman                                           | the running application against PostgreSQL and DynamoDB Local (workflow simulated)  |
| 2    | GitLab CI                | a GitLab project and one generic runner                     | the full pipeline, including CDK deploys to the MiniStack emulator                  |
| 3    | a dedicated AWS account  | + AWS CLI, an AWS account you own, explicit operator action | functional behaviour on real AWS (sandbox only; not compliance of any landing zone) |

What each layer of tests can and cannot prove: [testing.md](testing.md).

## Prerequisites

Tiers 0 and 1 run on **macOS** and **Linux** (including WSL2). The full per-platform matrix (Podman
machine vs native rootless Podman, compose provider, `curl`, `openssl`, `ssh`) is in
[development.md](development.md) §1.

| Tool                    | Version                                                                                               | Needed for |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| Node.js                 | 24 (`.node-version`); `pnpm install` refuses any other major (`engines` + `engineStrict`)             | all tiers  |
| pnpm                    | 12.11.2 (`packageManager`), without a global install: `npm exec --yes pnpm@12.11.2 -- <args>`         | all tiers  |
| Git, `curl`             | any recent                                                                                            | all tiers  |
| Podman 5+, **rootless** | macOS: `podman machine`; Linux: rootless Podman with a systemd user session; plus `docker-compose` v2 | tier 1     |
| GitLab + GitLab Runner  | self-managed (verified) or GitLab.com (untested); Docker executor                                     | tier 2     |
| AWS CLI v2              | the version the sandbox guard pins (see `tools/aws-preflight`)                                        | tier 3     |

In this guide `pnpm` means either a `pnpm` on your `PATH` or `npm exec --yes pnpm@12.11.2 --`; no
corepack and no global install are needed. CDK synth bundles the Lambdas with `pnpm exec esbuild`, so
`pnpm` must be resolvable by child processes: run synth and the infra tests through
`npm exec --yes pnpm@12.11.2 -- …` (which puts `pnpm` on the child's `PATH`) or with a `pnpm` on your
`PATH`.

`pnpm install` also installs optional Git hooks (`scripts/git-hooks/install.sh`). Skip them with
`LEFTHOOK=0 pnpm install` and remove them with `sh scripts/git-hooks/install.sh --uninstall`; CI
re-runs every check either way.

## Tier 0 — offline build and unit tests

```bash
git clone <your copy of this repository> && cd aws-modernization-starter
pnpm install --frozen-lockfile        # the only step that needs the npm registry
pnpm format:check && pnpm lint && pnpm build && pnpm typecheck && pnpm test
```

Build before `typecheck` and `test`: workspace packages resolve each other through `dist/`. The unit
tests start no containers and make no network calls.

Synthesize every stage offline (no AWS credentials, no context lookups) and run the policy checks:

```bash
pnpm --filter @starter/infra synth                      # dev, staging, prod (cdk-nag runs inside synth)
pnpm --filter @starter/infra synth:integration -c runId=local-dev1   # the integration mini-stack (runId required)
pnpm -C policies run guard:install                      # downloads the pinned, SHA-256-verified cfn-guard
pnpm -C policies run guard:validate --dir infra/cdk.out # CloudFormation Guard over the synthesized templates
```

Without the Guard binary the Guard-backed policy tests skip; set `REQUIRE_CFN_GUARD=1` to make them
fail instead (CI does). Two more checks CI runs on every pipeline:

```bash
pnpm ci:check                                                      # generated CI rules + supply-chain lint
node tools/impact/src/cli.ts analyze --base "$(git merge-base origin/main HEAD)"   # which jobs a change selects
```

## Tier 1 — local stack

The local stack runs on **rootless** Podman on macOS or Linux: PostgreSQL 17 (TLS only), DynamoDB
Local, the API built as its production image, the web tier behind nginx (same routing as
CloudFront) and a **TEST ONLY** OpenID Connect provider with the users `alice`, `bob` and `mallory`.

```bash
scripts/podman/rootless-socket.sh start   # optional: the compose scripts call it when DOCKER_HOST is unset
local/compose/bin/dev-up.sh app --build   # web http://127.0.0.1:4173, API :8080, test IdP :9400
local/compose/bin/test-all.sh             # smoke, integration, outage, E2E, security, leak scan
local/compose/bin/dev-down.sh             # stop (volumes kept; --volumes deletes them)
```

The socket helper (`start|stop|status|env`) gives both platforms a rootless API socket: on macOS it
forwards the rootless socket out of `podman machine`; on Linux it uses
`$XDG_RUNTIME_DIR/podman/podman.sock` (systemd `podman.socket`, or a `podman system service` it
starts itself). It refuses a rootful engine and never uses `sudo`. The first `dev-up.sh app` build
pulls pinned images and npm packages, so it needs registry access once.

| Setting                        | Default                                                              | Purpose                                                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host ports                     | PostgreSQL 15432, DynamoDB Local 18000, API 8080, web 4173, IdP 9400 | all bound to `127.0.0.1`; override with `STARTER_{PG,DYNAMODB,API,WEB,IDP}_HOST_PORT`                                                                         |
| `STARTER_LOCAL_STATE_DIR`      | `${XDG_STATE_HOME:-~/.local/state}/starter-app/compose`              | generated `.env` (secrets, mode 600) and `postgres-tls/`, outside the repository; on macOS keep it below `$HOME` (the only host path `podman machine` shares) |
| `STARTER_PODMAN_MODE`          | `auto`                                                               | `machine` (macOS) or `native` (Linux) to override the detection                                                                                               |
| `PODMAN_MACHINE`               | `podman-machine-default`                                             | the machine to use in machine mode                                                                                                                            |
| `STARTER_PODMAN_ROOTLESS_SOCK` | per mode (see [development.md](development.md) §4.0)                 | socket path used by host tools                                                                                                                                |
| `STARTER_PODMAN_START_TIMEOUT` | `20`                                                                 | seconds to wait for the API socket after starting it                                                                                                          |
| `COMPOSE_CMD`                  | `podman compose`                                                     | another compose command line                                                                                                                                  |

Testcontainers (package integration tests) uses the same socket
(`eval "$(scripts/podman/rootless-socket.sh env)"`); on SELinux hosts (the `podman machine` VM,
Fedora/RHEL) it also needs `TESTCONTAINERS_RYUK_PRIVILEGED=true`.

The workflow runs **in-process** (`WORKFLOW_MODE=local`): it reuses the Lambda step code and the
workflow spec, but it is not Step Functions. Socket helper, state directory, the non-container
development loop and Testcontainers in detail: [development.md](development.md) §4 and §6. Suites
and their environment variables: [testing.md](testing.md).

The emulator layer also runs locally, against a socket-less MiniStack container:

```bash
pnpm --filter '@starter/infra...' --filter '@starter/tests-aws-integration...' build
bash tests/aws-integration/emulator/all.sh   # cdk, then workflows; teardown always runs
```

## Tier 2 — GitLab CI

The pipeline needs **one generic Docker-executor runner** that accepts untagged jobs (no privileged
mode, no container socket) and no CI/CD variables. It is verified on a self-managed GitLab CE with
such a runner; GitLab.com hosted runners are expected to work but are untested. Push the repository to a GitLab project and open a merge request: the impact
analysis selects the affected jobs, the mandatory gate checks that every required job passed, and
the integration, E2E and MiniStack emulator jobs run after the gate. Every MR pipeline ends with
`approval:human`, a manual job that someone other than the head-commit author runs (an audit record;
set `REQUIRE_HUMAN_APPROVAL=false` to remove it).

Runner setup, the jobs that run with zero configuration and the opt-ins (release signing, gate
integrity, AI review, AWS jobs): [ci-cd.md](ci-cd.md) §11. What the emulator jobs prove:
[ministack.md](ministack.md).

## Tier 3 — optional AWS sandbox

Two operator-run paths deploy to a dedicated AWS account you own: the integration mini-stack (the
workflow resources only) and the full sandbox profile of the application. Both are guarded, tear
everything down and verify the account afterwards; `tools/aws-sandbox` estimates their cost offline
before you start. Nothing runs
in CI and nothing runs without your explicit action. Read [aws-deployment.md](aws-deployment.md)
before you start.

## Next steps

- Rename the project, its npm scope and resource prefixes, change the region, or add a component:
  [customization.md](customization.md).
- Connect the CDK stages to an existing landing zone: [landing-zone-adaptation.md](landing-zone-adaptation.md).
- Understand the limits before you reuse anything: [limitations.md](limitations.md).
