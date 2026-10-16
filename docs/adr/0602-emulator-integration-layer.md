# ADR 0602 — Emulator integration layer: socket-less MiniStack, shared guard, governed gaps

- Status: Accepted
- Supersedes a socket-mounting local emulator setup
- Amended: CDK CLI phone-home off and an egress audit (decision 7); the emulator layer is
  gate-defining (decision 8)

## Context

The simplest way to run the workflow integration stack (`IntegrationWorkflowStack`) against
MiniStack, a third-party AWS emulator, with handler error names intact is to mount the operator's
rootless Podman API socket into the MiniStack container (`LAMBDA_EXECUTOR=docker`). MiniStack runs
as root; whoever holds that socket can start sibling containers with any bind mount the Podman
machine can see, and such a machine typically shares the home directory read-write.

CI jobs get no container socket and no privileged mode (any generic Docker-executor runner; ADR
0110). Without a socket MiniStack
runs Lambda functions with its `local` executor: worker processes inside its own container.
Verified on 1.5.26 (source and a live probe): that executor reports every handler error as
`Runtime.HandlerError`, so Step Functions Retry/Catch rules that match handler error names
(`TransientDependencyError`, `DuplicateExecutionError`) cannot be exercised. The next release
(1.5.27) behaves the same.

Separate endpoint guards in the CDK app, the test harness and the shell scripts would drift
apart, and a CDK stack named after the emulator would blur what "MiniStack" refers to.

## Decision

1. **Socket-less is the default and the only CI mode.** MiniStack runs as a
   GitLab service (alias `ministack`, `LAMBDA_EXECUTOR=local`) or, locally, as a rootless Podman
   container with no volume, no socket, no host directory, no credentials, all capabilities
   dropped and the port bound to 127.0.0.1. A socket mode stays available only behind
   `up.sh --socket-mode` and is refused unless `STARTER_EMULATOR_SOCKET_MACHINE` names a dedicated
   Podman machine (never `podman-machine-default`) whose configuration has no host mounts.
2. **One guard.** `infra/lib/emulator-guard.ts` (exported as `@starter/infra/emulator-guard`, no
   dependencies) is used by `resolveDeployTarget` (CDK app), `resolveTarget` (test harness) and,
   through `emulator-guard-cli.js`, every emulator script. Accepted: a loopback endpoint, or — only
   with `GITLAB_CI=true` and `STARTER_EMULATOR_MODE=ci-service` — exactly
   `STARTER_EMULATOR_ALLOWED_ENDPOINT`, itself restricted to a plain-HTTP single-label service alias.
   Refused (exit 5, before the scripts make any `cdk`, SDK or HTTP call): profiles, session tokens,
   web identity and role variables, container credentials, any `AWS_ENDPOINT_URL_<SERVICE>`,
   `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS`, a redirected IMDS endpoint, any key but the fake
   `000000000001` (real-looking `AKIA…`/`ASIA…` keys are named as such), config or credentials
   files other than `/dev/null`, a CDK `TELEMETRY_ENDPOINT`, CDK CLI telemetry or version check not
   switched off, and (effective phase) any proxy variable. The guard governs where the SDK and the
   CDK CLI are pointed; it cannot see what else a process does — decision 7 covers that.
   The package choice: `@starter/tests-aws-integration` already depends on `infra` in
   `components.yaml`, so the guard lives in `@starter/infra` and the test package adds the workspace
   dependency; nothing in `infra` depends on test code.
3. **One CI entry point.** `tests/aws-integration/emulator/ci.sh cdk|workflows` never calls
   Podman. It checks the guard, the exact MiniStack version (`/_ministack/health`), STS identity
   (the fake account) and, with a probe Lambda executed by MiniStack itself, that no engine socket
   or `DOCKER_HOST` is reachable from inside the service. It bootstraps, synthesizes and deploys
   the synthesized assembly (stack `starter-it-ci<CI_PIPELINE_IID>-…`), runs the suite, destroys,
   verifies the destruction and resets the emulator. In CI every `cdk`/SDK child talks to the
   service through a TCP forwarder on 127.0.0.1 whose only target is the guard-validated
   allowlisted endpoint: against a host name the SDK addresses S3 virtual-hosted style
   (`<bucket>.ministack`), which no alias resolves, and the CDK CLI has no path-style switch; teardown and the artifacts (JUnit,
   diagnostics, template, outputs, reconciliation, not-applicable JSONL) come from an `EXIT` trap.
4. **Reconciliation, not `CREATE_COMPLETE`.** `cdk` mode reads every resource of the synthesized
   template back from its service and compares it with the template after token resolution
   (`src/emulator-reconcile.ts`), then proves an update deploy (new Lambda versions, aliases moved)
   and a destroy. Every template property lands in exactly one category: **match**, **mismatch**
   (fails), **compared-not-enforced** (MiniStack stores and returns the value but does not apply it,
   e.g. a log group's KMS key or Lambda tracing — compared, a mismatch fails, never counted as a
   semantic verification), **unsupported** (not stored or returned; a concrete reason per property)
   or **uncompared** (an explicit allowlist with a reason, e.g. Lambda `Code`). A property in no list
   fails the run, as does a no-op placeholder. Lambda functions must reach `State=Active` and
   `LastUpdateStatus=Successful` within a bounded wait. Only resources with no mismatch and no
   unknown property count as reconciled; compared-not-enforced and unsupported resources are
   skipped in JUnit, never passed.
5. **Governed gaps.** Every not-applicable test and assertion is listed in the versioned
   `tests/aws-integration/emulator/expected-not-applicable.json` (stable id, gap, reason, the
   MiniStack version or capability it depends on). An unlisted or stale entry, an undeclared skip
   or fewer passes than the baseline fails the job. Name-dependent checks are the declared gap
   `localExecutorErrorNames` (executor-specific: it does not apply to the docker executor);
   `retryJitterMaxDelay` covers MaxDelaySeconds/JitterStrategy. The static ASL tests keep
   asserting the Retry/Catch rules.
6. **Names.** The CDK stack is `IntegrationWorkflowStack` (file `integration-workflow-stack.ts`),
   the harness `LiveHarness`, the outputs type `IntegrationStackOutputs`; "MiniStack" means only
   the emulator. Emulator suite titles start with `[ministack-emulator]` and drop AWS-only claims.
7. **No phone-home, and proof of it.** A bootstrap run from an empty directory without
   `infra/cdk.json` lets CDK CLI 2.1144's default-on telemetry POST to
   `cdk-cli-telemetry.us-east-1.api.aws` from every emulator job. The CLI's outbound
   hosts besides the AWS endpoint (read from `aws-cdk/lib/index.js`) and how each is closed:
   - telemetry (`TELEMETRY_ENDPOINT` or the default host, a detached sender process):
     `CDK_DISABLE_CLI_TELEMETRY=true`, `--context cli-telemetry=false` on every call, a bootstrap
     `cdk.json` with `cli-telemetry: false`; the guard refuses `TELEMETRY_ENDPOINT`;
   - notices (`cli.cdk.dev-tools.aws.dev/notices.json`): `--no-notices` on every call,
     `notices: false` in the bootstrap `cdk.json`;
   - npm version check (`registry.npmjs.org`, TTY only): `CDK_DISABLE_VERSION_CHECK=true`;
   - proxies (`HTTPS_PROXY` & co., `proxy` in `~/.cdk.json`): proxy variables removed by the scripts
     and refused by the guard; `cdk` runs with an empty private `HOME`;
   - IMDS region lookup: `AWS_REGION` set, `AWS_EC2_METADATA_DISABLED=true`, endpoint override
     refused; container-engine fallback of asset bundling: `CDK_DOCKER` is a refusing stub.
     `ci.sh` proves the result on every run: `egress-audit.mjs`, preloaded into every Node process
     through `NODE_OPTIONS`, allows only the guard-validated endpoint, blocks and records anything
     else (connections, DNS including `lookupService`, UDP, a caller-supplied `lookup` for an allowed
     name, detached children, worker threads), re-injects itself into every child's environment
     (sync and async), and the `egress audit` step fails the job on any record. Outside this audit:
     non-Node executables (esbuild, the pnpm executable, `sh`, `curl`; recorded as `uncovered`),
     Node processes such an executable starts with a cleared environment, the MiniStack
     container, and Node code that deliberately bypasses the public `net`/`dns`/`dgram` modules
     (for example the deprecated `process.binding('tcp_wrap')`). The audit is a tripwire for
     accidental egress by the tools and tests the job runs, not a sandbox against hostile MR code;
     that code is contained by the default (unprivileged, credential-free) runner, fake credentials
     and synthetic data.
8. **Gate-defining.** The guard
   (`infra/lib/emulator-guard*.ts`), `tests/aws-integration/emulator/`,
   `tests/aws-integration/src/emulator-{ci,gaps,reconcile,results}.ts`, and what decides which
   emulator tests run and how the guard resolves (`live-harness.ts`, `aws-gate.ts`, the suite's
   `package.json`/`tsconfig.build.json`/`vitest.config.ts`, `infra/bin/integration.ts`,
   `infra/package.json`, `infra/tsconfig.json`) are in `DEFAULT_GATE_PATHS` (ADR 0410). Once a
   Maintainer has adopted the list on the live policy (`gate-policy sync --adopt-default-paths`),
   relaxing the guard, the baseline, a skip or the reconciliation's tables needs Maintainer gate
   approval; until then this is the intended state, not the enforced one.

## Consequences

- No container-engine socket is ever handed to the third-party image in CI or by default; the socket risk is
  closed for the default path. The residual risk is the image's own network egress during a job
  (mitigated by the digest pin, fake credentials and synthetic data only): the egress audit covers
  the job's Node processes, not the service container.
- Retry by handler error name, `DuplicateExecutionError` routing, error-name assertions, retry
  jitter and the gaps listed in the baseline are not verified by the emulator. They stay covered by
  the static ASL tests and by real AWS. Closing `localExecutorErrorNames` needs an upstream fix
  that keeps `err.name` in the local worker, or a dedicated, disposable runner with a nested engine.
- The MiniStack service inherits the job's variables; its Lambda workers inherit MiniStack's
  environment. The service must therefore set `AWS_ENDPOINT_URL=http://127.0.0.1:4566` for itself,
  so the workers call their own MiniStack rather than the job's alias.
- The emulator results are never AWS evidence: every record carries `target: ministack-emulator`.
- Deploying the application stages to MiniStack stays out of scope: several resource types the
  stages use are not registered in MiniStack 1.5.26.
