# Emulator layer runbook: MiniStack (NOT AWS)

The workflow integration stack (`infra/stacks/integration-workflow-stack.ts`, variant
`-c target=emulator`) deployed to **MiniStack 1.5.26**, an AWS emulator, with the real constructs
(`ProcessingWorkflow`, `JobStateTable`, `JobReconciler`), the shared ASL and the bundled real
handlers. Results say how the stack behaves on MiniStack; they are never AWS evidence (every record
carries `target: ministack-emulator`). Decision record: `docs/adr/0602-emulator-integration-layer.md`.

## Socket-less by default

MiniStack is an untrusted third-party image running as root. It gets **no** container-engine
socket, no host directory, no credentials: Lambda functions run as worker processes inside its own
container (`LAMBDA_EXECUTOR=local`). `ci.sh` proves this on every run with a probe Lambda that
MiniStack executes (`diagnostics.json`: `socketMounted: false`, `socketEvidence`).

The price: the local executor reports every handler error as `Runtime.HandlerError`, so name-based
Retry/Catch cannot be exercised (gap `localExecutorErrorNames`, see below).

## Entry points

| Script                         | What it does                                                                |
| ------------------------------ | --------------------------------------------------------------------------- |
| `ci.sh cdk`                    | deploy, reconcile every resource, update deploy, destroy, verify, reset     |
| `ci.sh workflows`              | deploy, run `src/*.aws.test.ts` on the emulator, governance, destroy, reset |
| `up.sh` / `run.sh` / `down.sh` | local container (socket-less), `ci.sh` against it (loopback), teardown      |
| `all.sh [cdk] [workflows]`     | `up.sh` → `ci.sh` per suite → `down.sh` (always, EXIT trap)                 |
| `expected-not-applicable.json` | versioned baseline of what the emulator cannot check                        |

`ci.sh` never calls Podman. Prerequisite: the workspace is built —
`pnpm --filter '@starter/infra...' --filter '@starter/tests-aws-integration...' build` (exit 3 otherwise).
Package scripts: `pnpm --filter @starter/tests-aws-integration test:emulator cdk|workflows` (`ci.sh`)
and `test:emulator:local` (`all.sh`).

## Environment contract

The shared guard (`infra/lib/emulator-guard.ts`) checks it before any `cdk`, SDK or HTTP call and
exits **5** on a refusal.

| Variable                                                 | CI (`ci-service`)                             | Local (`loopback`, default)                                       |
| -------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| `STARTER_EMULATOR_MODE`                                  | `ci-service`                                  | unset or `loopback`                                               |
| `GITLAB_CI`                                              | `true` (required)                             | –                                                                 |
| `STARTER_EMULATOR_ALLOWED_ENDPOINT`                      | `http://ministack:4566`                       | –                                                                 |
| `AWS_ENDPOINT_URL`                                       | exactly the allowlisted                       | set by `ci.sh`: `http://127.0.0.1:$STARTER_EMULATOR_PORT` (45660) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`            | `000000000001` / `ministack-local-only`       | set by `ci.sh`                                                    |
| `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`         | `/dev/null`                                   | set by `ci.sh`                                                    |
| `AWS_EC2_METADATA_DISABLED`                              | `true`                                        | set by `ci.sh`                                                    |
| `AWS_REGION`, `AWS_DEFAULT_REGION`                       | `ap-southeast-1`                              | set by `ci.sh`                                                    |
| `CDK_DISABLE_CLI_TELEMETRY`, `CDK_DISABLE_VERSION_CHECK` | `true` (job variables; `ci.sh` sets them too) | set by `ci.sh`                                                    |
| `STARTER_MINISTACK_EXPECTED_VERSION`                     | `1.5.26`                                      | default `1.5.26`                                                  |
| `STARTER_MINISTACK_IMAGE`                                | `$IMG_MINISTACK`                              | default: the pinned digest                                        |
| `STARTER_EMULATOR_HEALTH_TIMEOUT`                        | optional (default 90 s)                       | optional                                                          |

Always refused: `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, `AWS_SESSION_TOKEN`, `AWS_SECURITY_TOKEN`,
`AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`, `AWS_ROLE_SESSION_NAME`,
`AWS_CONTAINER_CREDENTIALS_*`, `AWS_CONTAINER_AUTHORIZATION_TOKEN*`, any `AWS_ENDPOINT_URL_<SERVICE>`,
`AWS_IGNORE_CONFIGURED_ENDPOINT_URLS`, `AWS_EC2_METADATA_SERVICE_ENDPOINT`, `TELEMETRY_ENDPOINT`,
any other access key (a real-looking `AKIA…`/`ASIA…` key is named as such), any config file other
than `/dev/null`, a CDK telemetry/version-check switch other than `true`, and every other endpoint.
Proxy variables (`HTTPS_PROXY`, `http_proxy`, `ALL_PROXY`, `npm_config_*proxy`, any case) are
removed by `ci.sh` and refused if one is left in the effective environment.

**MiniStack service variables** (1.5.26, read from the image source): `LAMBDA_EXECUTOR=local`,
`MINISTACK_REGION=ap-southeast-1`, `MINISTACK_HOST=ministack` (host name in URLs MiniStack
returns; `MINISTACK_HOSTNAME` only names the container for the docker executor's reaper), and
`AWS_ENDPOINT_URL=http://127.0.0.1:4566`. The last one matters: a GitLab service inherits the job's
variables, and MiniStack's local Lambda workers inherit MiniStack's environment, so without it the
handlers would call `http://ministack:4566` from inside the service.

**Transport in CI.** Against a host-name endpoint (`http://ministack:4566`) the AWS SDK addresses
S3 buckets virtual-hosted style (`<bucket>.ministack`), which no service alias resolves, so the CDK
asset upload fails; the CDK CLI has no path-style switch. After the guard has accepted the job
environment, `ci.sh` therefore starts a TCP forwarder on `127.0.0.1` whose only target is the
guard-validated `STARTER_EMULATOR_ALLOWED_ENDPOINT`, and runs every `cdk`/SDK child in loopback mode
through it (path-style S3, exactly as locally; the guard checks the children again).
`diagnostics.json` records it under `transport`.

Exit codes of `ci.sh`: 0 pass; 5 guard refusal; 3 workspace not built; 2 usage; 1 any failure.

## Egress: no CDK CLI phone-home, and the audit that proves it

CDK CLI 2.1144 phones home on its own: telemetry (a detached sender to
`cdk-cli-telemetry.us-east-1.api.aws` or `TELEMETRY_ENDPOINT`), notices
(`cli.cdk.dev-tools.aws.dev`) and an npm version check (`registry.npmjs.org`). Every `cdk` call of
these scripts goes through `cdk_run` (`_emulator.sh`): `CDK_DISABLE_CLI_TELEMETRY=true`,
`CDK_DISABLE_VERSION_CHECK=true`, `--no-notices --context cli-telemetry=false`, an empty private
`HOME` (no `~/.cdk.json`), no proxy, and `CDK_DOCKER=no-container-engine.sh` (asset bundling stays
local; a container-engine call is refused and recorded). The bootstrap runs from an empty
directory with its own `cdk.json` repeating the switches.

`ci.sh` then preloads `egress-audit.mjs` into every Node process (`NODE_OPTIONS=--import=…`). It
lets each process reach only the guard-validated endpoint, and blocks and records in `egress.jsonl`
every other connection, DNS query and UDP send, plus detached child processes and worker threads
(they would escape the audit). The last step, `egress audit` (`egress-report.mjs`), writes
`egress.json` and fails the run on any violation or if `cdk` was never audited. A caller-supplied
`lookup` for an allowed host name and `dns.lookupService` are refused; every child process (async
or `spawnSync`/`execSync`/`execFileSync`) is recorded and gets the audit back into its environment
even when its caller passed a clean `env`. Not covered: non-Node executables (esbuild, the pnpm
executable, `sh`, `curl`, …), which are recorded as `uncovered` but not intercepted; Node
processes such an executable starts with a cleared environment (`env -i node …`); and the MiniStack
container.
`src/emulator-egress.test.ts` reproduces the original leak (the pre-fix bootstrap sends a TLS
ClientHello to a loopback sink) and requires zero violations from the fixed commands.

## Artifacts

`reports/aws-integration/emulator/<runId>/` (`ci<CI_PIPELINE_IID>-<cdk|wf>-<4 hex>` in CI,
`em-<6 hex>` locally; the stack is `starter-it-<runId>`), written on success and failure:

- `report/junit.xml`: no host names. It holds:
  - the lifecycle steps;
  - the per-resource reconciliation. `compared-not-enforced`, `unsupported` and `metadata-only` are
    skipped, never passed;
  - the vitest suites. A not-applicable test is skipped. A pass with not-applicable assertions
    carries `emulator-not-applicable` properties (gap, baseline id) and a `system-out` line;
- `diagnostics.json`: MiniStack version (reported and expected), image, executor, health payload,
  `socketMounted` with the probe evidence, the endpoint the Lambdas see, step durations, counts,
  `leakScan` (see below);
- `steps.jsonl`, `preflight.json`, `template.json`, `outputs.json`, `stack-resources.json`,
  `destroy.json`, `reset.json`;
- `egress.jsonl` (audit records: process, kind, target, allowed) and `egress.json` (verdict:
  allowed targets with counts, violations, audited processes);
- `cdk`: `reconciliation.json`, `functions-before.json`, `update.json`,
  `reconciliation-after-update.json`;
- `workflows`: `report/results.json` (pass, full pass, pass with n/a assertions, fail,
  not-applicable, governance), `report/results/*.json`, `report/not-applicable.jsonl`,
  `report/evidence/*.json`.

## Gaps and the baseline

`expected-not-applicable.json` lists every test and assertion the emulator cannot check, each
with a stable id, gap, technical reason and the MiniStack version or capability it depends on.
`ci.sh workflows` fails when a not-applicable item is not listed, an entry is stale, a test is
skipped for any other reason, or fewer tests pass (in total or fully) than `minimumPasses`. Change
the file only in a reviewed MR; never reuse an id. This directory is a gate-defining path
(docs/ci-cd.md §4a): once the list is adopted on the live policy, a change needs Maintainer
gate approval.

| Gap                       | Why (MiniStack 1.5.26)                                                           |
| ------------------------- | -------------------------------------------------------------------------------- |
| `localExecutorErrorNames` | local executor: every handler error is `Runtime.HandlerError` (socket-less only) |
| `retryJitterMaxDelay`     | Retrier `MaxDelaySeconds` / `JitterStrategy` not implemented                     |
| `failStatePaths`          | Fail state `ErrorPath`/`CausePath` ignored                                       |
| `executionTimeout`        | state machine `TimeoutSeconds` not enforced                                      |
| `versionsAliases`         | no CloudFormation state machine versions/aliases                                 |
| `taskInputNotInHistory`   | no task input in the execution history                                           |
| `iamNotEnforced`          | IAM not evaluated (`AUTH` unset)                                                 |
| `kmsNotEnforced`          | no key-policy evaluation, no real crypto                                         |
| `lambdaThrottle`          | reserved concurrency 0 does not throttle task invocations                        |
| `ddbUpdateTypeCheck`      | no `ValidationException` for `SET a = a + :n` on a non-number                    |
| `sfnExecutionLogs`        | no execution events delivered to CloudWatch Logs                                 |

## Reconciliation categories

`emulator-reconcile.ts` compares every template property with the service read-back _before_ it
classifies it. Every property ends in one category, and `reconciliation.json` records the
per-property `classification` and the `propertyCounts`.

| Category                | Meaning                                                                  | Fails the run       |
| ----------------------- | ------------------------------------------------------------------------ | ------------------- |
| `match`                 | read-back equals the template                                            | no                  |
| `mismatch`              | read-back differs                                                        | **yes**             |
| `compared-not-enforced` | stored and equal, but without effect on the emulator; a difference fails | no (never verified) |
| `unsupported`           | not stored: read-back absent or default; a non-default difference fails  | no (never verified) |
| `uncompared`            | listed in `UNCOMPARED_PROPERTIES` with a reason                          | no                  |
| `unknown`               | a template property no comparer or list covers (a new property)          | **yes**             |

A resource is `reconciled` only with no mismatch, no unknown, no unsupported and no not-enforced
property. IAM roles and policies and the KMS key are always `unsupported`, because MiniStack does
not enforce their semantics. A Lambda function must be `Active` with `LastUpdateStatus=Successful`
after the bounded settle-wait. MiniStack 1.5.26 returns `LastUpdateStatus`, so a missing value
fails as well. Tags are compared: template tags plus the stack tags CloudFormation propagates.
CloudFormation's own `aws:` tags are ignored.

Classification on MiniStack 1.5.26 (local socket-less run, `ci.sh cdk`, 29 resources):

| Category                | Property (resources)                                                                                            | Reason                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `compared-not-enforced` | `Logs::LogGroup.KmsKeyId` (4)                                                                                   | stored and returned; log events are not encrypted                                                         |
| `compared-not-enforced` | `Lambda::Function.TracingConfig.Mode` (3)                                                                       | stored and returned; no X-Ray                                                                             |
| `unsupported`           | `DynamoDB::Table` `SSESpecification` (2), `PointInTimeRecoverySpecification` (2), `TimeToLiveSpecification` (1) | MiniStack CloudFormation does not apply them: no `SSEDescription`, PITR and TTL report `DISABLED`         |
| `unsupported`           | `StepFunctions::StateMachine` `LoggingConfiguration`, `TracingConfiguration`, `EncryptionConfiguration` (1)     | not stored: `DescribeStateMachine` returns no level/destinations, no tracing, no encryption configuration |
| `uncompared`            | `Lambda::Function.Code` (3)                                                                                     | only `CodeSha256` is readable; the code is exercised by `verify update` and the workflows suite           |
| `uncompared`            | `KMS::Key.PendingWindowInDays` (1)                                                                              | only takes effect at deletion; `verify destroyed` checks `PendingDeletion`                                |
| `uncompared`            | `CDK::Metadata.Analytics` (1)                                                                                   | template-only record                                                                                      |

Resources: 7 `reconciled` (versions, aliases, the event invoke configuration), 7
`compared-not-enforced` (3 functions, 4 log groups), 14 `unsupported` (10 IAM, 1 KMS key,
2 tables, 1 state machine), 1 `metadata-only`, 0 `failed`. A new template property fails as
`unknown` until it gets a comparison or a reviewed `UNCOMPARED_PROPERTIES` entry.

## Leak scan

`diagnostics.json` records a `leakScan` of the run directory: AWS endpoint URLs
(`https://….amazonaws.com`, `….api.aws`, but not XML namespace URIs) and account ids, in ARNs or
account fields, other than the fake `000000000001`. It skips `asset.*` bundles, which contain
static SDK URLs, and binary files. `node dist/emulator-ci.js scan-leaks --dir <runDir>` exits 1 on
a finding. A service log written into the run directory is scanned too.

`ci.sh` runs it as the blocking `leak scan` step (account ids in findings are redacted).
Residual: in CI the MiniStack service log goes only to the job trace (`CI_DEBUG_SERVICES`), which no scanner reads.

## Local runs

```bash
pnpm install --frozen-lockfile
pnpm --filter '@starter/infra...' --filter '@starter/tests-aws-integration...' build
tests/aws-integration/emulator/all.sh                      # cdk + workflows, then teardown
# or step by step
STARTER_EMULATOR_PORT=45661 tests/aws-integration/emulator/up.sh
tests/aws-integration/emulator/run.sh cdk
tests/aws-integration/emulator/run.sh workflows
tests/aws-integration/emulator/down.sh
```

The container is labelled `starter.emulator.run-id=<runId>`; `down.sh` removes only that container
(with the image's two empty anonymous init volumes) and, in socket mode, its Lambda containers and
network. Rootless Podman connection only (`podman-machine-default`); never the rootful one.

## Reproducing on a standard GitLab Runner

No socket, no privileged mode, no runner changes are needed:

1. Pin the image in `.gitlab/ci/images.yml` as `IMG_MINISTACK` (multi-arch index digest).
2. Add a job in the `.node` image with a `ministack` service (variables above), a
   `resource_group` (service aliases are network-wide when `FF_NETWORK_PER_BUILD=false`), the job
   environment of the contract table, and `script:` build `@starter/infra...` and
   `@starter/tests-aws-integration...`, then `bash tests/aws-integration/emulator/ci.sh cdk` (or
   `workflows`).
3. Collect `reports/aws-integration/emulator/` as artifacts and
   `reports/aws-integration/emulator/*/report/junit.xml` as the JUnit report. Do not set
   `allow_failure`.

The project's jobs are `integration:ministack:cdk` and `integration:ministack:workflows`
(`.gitlab/ci/emulator.yml`).

## Opt-in socket mode (full fidelity, local only)

`up.sh --socket-mode` uses MiniStack's docker executor (handler error names kept, the real Lambda
Node.js 24 image). It is refused unless `STARTER_EMULATOR_SOCKET_MACHINE` names a dedicated Podman
machine — not `podman-machine-default` — whose configuration has no host mounts; it then uses that
machine's connection for everything. `run.sh` passes the executor on, and `ci.sh` refuses the
docker executor in CI.
