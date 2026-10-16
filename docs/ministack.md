# MiniStack emulator layer

The emulator layer deploys the AWS integration mini-stack (`IntegrationWorkflowStack`, the same
`ProcessingWorkflow`, `JobStateTable` and `JobReconciler` constructs the application stages use) to
**MiniStack**, a third-party AWS emulator, and runs the workflow tests against it. It runs in every
relevant GitLab CI pipeline without an AWS account, and on a workstation with rootless Podman.

**Emulator results are never AWS evidence.** Every record the layer writes carries
`target: ministack-emulator`. What the emulator cannot show is listed below and in a versioned
baseline; it stays covered by the static template tests and, optionally, by a real AWS run
([aws-deployment.md](aws-deployment.md)).

Decision record: [ADR 0602](adr/0602-emulator-integration-layer.md). Runbook with every variable,
artifact and per-property classification: [tests/aws-integration/emulator/README.md](../tests/aws-integration/emulator/README.md).
CI jobs and their trust boundary: [ci-cd.md](ci-cd.md) §7a.

## What it proves

| Suite (`ci.sh <suite>`) | CI job                            | Checks                                                                                                                                                                                                                                          |
| ----------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cdk`                   | `integration:ministack:cdk`       | MiniStack version and health, CDK bootstrap, synth and deploy of the mini-stack, a read-back **reconciliation** of every template resource, an update deploy (new Lambda versions, aliases moved), destroy and its verification, emulator reset |
| `workflows`             | `integration:ministack:workflows` | deploy, then the `src/*.aws.test.ts` workflow suites against the emulator with the real bundled handlers and the shared state-machine definition, governed not-applicable items, destroy, reset                                                 |

In other words: the synthesized CloudFormation templates deploy, update and destroy cleanly on an
AWS-compatible API; the deployed configuration matches the templates property by property where the
emulator stores it; and the real handlers and state machine complete the workflow's happy and
failure paths.

## What it does not prove

- **AWS behaviour.** MiniStack implements AWS APIs, not AWS services. IAM policies, KMS key policies
  and encryption, quotas, throttling, eventual consistency and service limits are not evaluated.
- **Error-name retries.** In socket-less mode Lambda functions run in MiniStack's `local` executor,
  which reports every handler error as `Runtime.HandlerError`. Step Functions `Retry`/`Catch` rules
  that match handler error names (`TransientDependencyError`, `DuplicateExecutionError`) cannot be
  exercised (gap `localExecutorErrorNames`).
- **Other declared gaps** of the pinned MiniStack version, each an entry in the baseline:

  | Gap                     | What MiniStack does not do                        |
  | ----------------------- | ------------------------------------------------- |
  | `retryJitterMaxDelay`   | Retrier `MaxDelaySeconds` / `JitterStrategy`      |
  | `failStatePaths`        | Fail state `ErrorPath` / `CausePath`              |
  | `executionTimeout`      | enforce the state machine's `TimeoutSeconds`      |
  | `versionsAliases`       | CloudFormation state machine versions and aliases |
  | `taskInputNotInHistory` | record task input in the execution history        |
  | `iamNotEnforced`        | evaluate IAM                                      |
  | `kmsNotEnforced`        | evaluate key policies or encrypt                  |
  | `lambdaThrottle`        | throttle invocations at reserved concurrency 0    |
  | `ddbUpdateTypeCheck`    | reject `SET a = a + :n` on a non-number attribute |
  | `sfnExecutionLogs`      | deliver execution events to CloudWatch Logs       |

- **The application stages.** Only the workflow mini-stack is deployed. The `dev`/`staging`/`prod`
  stages use resource types MiniStack does not register; they are covered by offline synth, the
  assertion tests and the policy checks.
- **The region.** Emulator runs use a fixed region (`ap-southeast-1`) independent of the configured
  deployment region.

## Socket-less service

MiniStack runs as root inside its image and is treated as untrusted. It gets **no** container-engine
socket, no host directory and no credentials:

- **In CI** it is a GitLab service (alias `ministack`) on the default runner: a generic Docker
  executor without privileged mode, socket or runner-mounted files. The jobs never use the
  protected, release or signer runner tags, so they never reach a runner that holds AWS credentials
  or a signing key.
- **Locally** (`up.sh`, `all.sh`) it is a rootless Podman container with no volume, all capabilities
  dropped and its port bound to `127.0.0.1`.
- `LAMBDA_EXECUTOR=local`: functions run as worker processes inside the MiniStack container. No
  Docker-in-Docker, no `DOCKER_HOST`, no Podman socket. Every run proves it with a probe Lambda that
  MiniStack executes (`diagnostics.json`: `socketMounted: false`).
- The service sets `AWS_ENDPOINT_URL=http://127.0.0.1:4566` for itself, so its Lambda workers call
  their own MiniStack rather than the job's service alias.

A higher-fidelity **socket mode** (`up.sh --socket-mode`, MiniStack's docker executor, handler error
names kept) exists for local use only. It is refused unless `STARTER_EMULATOR_SOCKET_MACHINE` names
a dedicated Podman machine without host mounts, and `ci.sh` refuses it in CI.

## Fake credentials

Every run uses a fixed fake identity: `AWS_ACCESS_KEY_ID=000000000001` (MiniStack derives the
account id from it), `AWS_SECRET_ACCESS_KEY=ministack-local-only`, `AWS_CONFIG_FILE` and
`AWS_SHARED_CREDENTIALS_FILE` set to `/dev/null`, and the instance-metadata endpoint disabled. Only
synthetic data reaches the emulator. A GitLab service receives only the job's public variables,
never masked or protected ones.

## Fail-closed guard

One guard, `infra/lib/emulator-guard.ts`, is used by the CDK app (`-c target=emulator`), the test
harness (`AWS_INTEGRATION_TARGET=emulator`) and, through its CLI, every emulator script. It checks
the environment **before** any `cdk`, AWS SDK or HTTP call and exits **5** on a refusal, which the
CI job reports as a visible failure, never as a skip.

- **Accepted endpoints:** a loopback endpoint (`http://127.0.0.1:<port>`; mode `loopback`, the
  default), or, only with `GITLAB_CI=true` and `STARTER_EMULATOR_MODE=ci-service`, exactly
  `STARTER_EMULATOR_ALLOWED_ENDPOINT`, which must itself be a plain-HTTP single-label service alias
  (`http://ministack:4566`).
- **Refused:** profiles, session tokens, web-identity and role variables, container credentials,
  any `AWS_ENDPOINT_URL_<SERVICE>`, switching configured endpoints off, a redirected
  instance-metadata endpoint, any access key other than the fake one (a real-looking key is named as
  such), configuration or credential files other than `/dev/null`, a CDK `TELEMETRY_ENDPOINT`, CDK
  CLI telemetry or version checks left on, proxy variables, and every other endpoint.

The scripts also switch off every outbound call the CDK CLI makes on its own (telemetry, notices,
version check), run `cdk` with an empty private `HOME`, and preload an **egress audit** into every
Node process they start: any connection, DNS query or UDP send to something other than the
guard-validated endpoint is blocked, recorded, and fails the job. The audit does not cover non-Node
executables (recorded as `uncovered`) or the MiniStack container's own traffic; it is a tripwire for
accidental egress, not a sandbox for hostile code. Details: ADR 0602 §7.

In CI the CDK CLI and SDK reach the service through a TCP forwarder on `127.0.0.1` whose only
upstream is the allowlisted endpoint (S3 virtual-hosted addressing would otherwise need DNS for
`<bucket>.ministack`); every child process passes the guard again in loopback mode.

## Reconciliation categories

A `CREATE_COMPLETE` stack status proves little on an emulator. The `cdk` suite therefore reads every
resource of the synthesized template back from its service and compares each template property
**before** classifying it (`tests/aws-integration/src/emulator-reconcile.ts`). Every property ends
in exactly one category:

| Category                | Meaning                                                                                                                                                                                        | Effect                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `match`                 | the read-back equals the template                                                                                                                                                              | pass                      |
| `mismatch`              | the read-back differs                                                                                                                                                                          | **fails the run**         |
| `compared-not-enforced` | MiniStack stores and returns the value and it equals the template, but the setting has no effect on the emulator (e.g. a log group's KMS key, Lambda tracing); a different value is a mismatch | never counted as verified |
| `unsupported`           | MiniStack does not store the property: the read-back is absent or a default; a non-default, different value is a mismatch                                                                      | never counted as verified |
| `uncompared`            | an allowlisted property with a stated reason (e.g. Lambda `Code`, where only `CodeSha256` is readable)                                                                                         | listed with the reason    |
| `unknown`               | a template property no comparer or list covers (for example after a CDK upgrade)                                                                                                               | **fails the run**         |

A resource counts as `reconciled` only with no mismatch, no unknown, no unsupported and no
not-enforced property; in JUnit the others are skipped, never passed. IAM roles and policies and
the KMS key are always `unsupported`. Lambda functions must reach `State=Active` and
`LastUpdateStatus=Successful` within a bounded wait. Tags are compared, including the stack tags
CloudFormation propagates.

## Not-applicable baseline

`tests/aws-integration/emulator/expected-not-applicable.json` is a versioned list of every test and
assertion the emulator cannot check, each with a stable id, the gap, the technical reason and the
MiniStack version or capability it depends on. `ci.sh workflows` fails when:

- a not-applicable item is not listed, or a listed entry no longer occurs (stale);
- a test is skipped for any reason the baseline does not declare;
- fewer tests pass, in total or fully, than the baseline's minimum.

In the JUnit report a test that passes with not-applicable assertions stays a pass but carries one
`emulator-not-applicable` property per assertion; a fully not-applicable test is skipped with its
reason. Change the baseline only in a reviewed merge request and never reuse an id. With the
optional gate-integrity policy installed, the guard, this directory and the code that decides the
verdicts are gate-defining paths ([ci-cd.md](ci-cd.md) §4a).

## Other safeguards

- **Pinned image.** `IMG_MINISTACK` in `.gitlab/ci/images.yml`, by multi-arch digest; the scripts
  check the exact version through `/_ministack/health`. A pin younger than the 14-day image
  release-age rule needs an exception in `.gitlab/security/image-age-exceptions.yaml`; once the
  release is old enough the lint only warns that the entry can be deleted.
- **Leak scan.** A blocking step scans the run directory for AWS endpoint URLs and account ids other
  than the fake one. In CI the MiniStack service log goes only to the job log
  (`CI_DEBUG_SERVICES=true`), which no scanner reads.
- **Serialisation.** The CI jobs share a `resource_group`, so two emulator jobs never run at the same
  time on runners that put every job on one network.
- **Artifacts.** `reports/aws-integration/emulator/<runId>/` on success and failure: JUnit,
  diagnostics, template, outputs, reconciliation, egress records and not-applicable records.

## Running it

```bash
# Local (rootless Podman), teardown always runs
pnpm --filter '@starter/infra...' --filter '@starter/tests-aws-integration...' build
bash tests/aws-integration/emulator/all.sh              # cdk, then workflows
bash tests/aws-integration/emulator/all.sh workflows    # one suite
```

In CI the jobs run `bash tests/aws-integration/emulator/ci.sh cdk|workflows` against the service;
`ci.sh` never calls Podman. On your own GitLab nothing needs configuring beyond a runner that allows
services and can pull the pinned image from `docker.io` ([ci-cd.md](ci-cd.md) §7a and §11). Budget
host memory for the MiniStack service on top of the job container.
