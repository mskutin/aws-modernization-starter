# Full sandbox lifecycle — runbook (live validation)

Deploys the full reference application as the `Sandbox` stage into the dedicated sandbox account
(`SANDBOX_REGION`, default `ap-southeast-1`; SSO profile `starter-sandbox-developer`), tests it live, exercises an ECS rollback,
tears everything down and verifies the account is clean. The integration mini-stack lifecycle is in
`../scripts/`; this directory is the full `Sandbox` stage (`--phase 2` in `tools/aws-sandbox`; the
mini-stack is `--phase 1`). Overview of both paths: `docs/aws-deployment.md`.

> This validates functional behaviour on ordinary AWS. It does **not** demonstrate
> compliance with any organizational control set. Every sandbox-only relaxation is a recorded deviation.

This lifecycle does not depend on the mini-stack lifecycle, and nothing here assumes it ran.
`bootstrap.sh` (creating `starter-cdk-toolkit` when absent) is the first AWS mutation; only
read-only calls (the guard's STS check, the finops baseline) precede it.

**Before the first `up.sh`: adopt the sandbox policy exceptions.** The sandbox relaxations ship only
as an example register (`policies/exceptions/examples/sandbox/`, `status: example`) that nothing
loads, so the sandbox synth fails closed until you adopt the entries you accept: copy them into
`policies/exceptions/exceptions.yaml` / `suppressions.yaml`, remove `status: example` and set your
own short validity dates (`docs/policy-as-code.md`, "Adopting an entry").

## Rules the scripts enforce

- **Account guard first**: each script sources
  `tools/aws-preflight/scripts/sandbox-guard.sh` with `SANDBOX_PROFILE=starter-sandbox-developer`,
  `SANDBOX_GUARD_LOG=<run dir>/guard.log` and `SANDBOX_EXPECTED_ACCOUNT_FILE`, calls
  `sandbox_guard_init`, and runs **every** AWS mutation as
  `guarded "<label> [<runId>]" -- <executable> …` (helpers `mut`, `aws_mut`): `aws`, `cdk` through
  `pnpm`/`npm`, `skopeo`. The guard accepts executables only (no shell functions), so `PNPM` must
  name one (`pnpm` on `PATH`, or `PNPM="npm exec --yes pnpm@12.11.2 --"`). Labels never contain an
  account id (12-digit sequences are masked). The guarded command is always one of the pinned
  tool arrays (`PNPM`, `aws`, `SKOPEO`; the mini-stack scripts also the cleanup verifier `node <file>`): the guard
  refuses shells, wrappers (`env`, `timeout`, `nohup`, `nix`, `command`, …) and inline interpreter
  code (`node -e`), so **a time limit is applied outside `guarded`, never inside it**. Read-only
  calls (`awsr`) pin `--profile starter-sandbox-developer --region <SANDBOX_REGION>` on the command line as
  well. `test.sh` re-runs the STS check before every check.
- **One run at a time**: stack names are fixed (`Sandbox-*`), so `up.sh` refuses (exit 4) while
  stacks of another run id exist.
- **Secrets stay in the run directory** (mode 0700; files 0600): the origin-verify value, the
  issuer private key, registry logins (deleted right after use). They are never printed. The
  origin-verify value reaches the CDK app as a file (`-c originVerifySecretFile=<run dir>/origin-verify`),
  never on a command line; the synthesized templates (which contain it by design) go to
  `<run dir>/cdk.out`, never to `infra/cdk.out`. The listener rules kept as evidence are redacted.
- **Deploys refuse placeholders**: every `cdk deploy` carries `-c requireDeployInputs=true` (the app
  then refuses a placeholder account, run id, expiry, image digest or secret) and the same context
  for the whole run (`run.env`); `cdk destroy` never does, so an expired run can still be torn down.
- **Never a pass for something that did not run**: every check writes JSON result lines
  (`check, name, status, evidence, detail`); `skipped` and `not-run` are never counted as passed,
  and a summary with nothing passed is not green.
- **Teardown always**: `all.sh` runs `down.sh` from an `EXIT` trap (deployment failure, test
  failure, Ctrl-C, SIGTERM); the teardown ignores further interrupts.

## Prerequisites (operator workstation)

| What                | How                                                                                                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools               | AWS CLI 2.35.11 (the guard pins it), Node 24, `curl`, `skopeo`; `cosign` for the CI image; rootless `podman` for the fallback build (`nix shell nixpkgs#skopeo nixpkgs#cosign`)                                                                                                     |
| pnpm                | an executable for the guard: `pnpm` on `PATH`, or `export PNPM="npm exec --yes pnpm@12.11.2 --"`                                                                                                                                                                                    |
| Login               | `aws sso login --profile starter-sandbox-developer`; no `AWS_*` credential/endpoint/config variables in the environment, no `[default]` profile, an empty or absent `~/.aws/credentials`, no `profile` key in `~/.cdk.json` / `infra/cdk.json` (the guard refuses each, exit 12/15) |
| Expected account    | `${SANDBOX_HOME:-~/.config/starter-aws-sandbox}/expected-account` (0600, 12 digits); `operator-role-arn` (0600, the operator's IAM role ARN in that account: `-c operatorPrincipalArn` on every app synth)                                                                          |
| Build               | `pnpm install --frozen-lockfile && pnpm build`; Playwright: `pnpm --filter @starter/tests-e2e browsers:install`                                                                                                                                                                     |
| Other components    | guard `tools/aws-preflight/scripts/sandbox-guard.sh` + `dist/guard-cli.js`; sandbox CDK profile (`-c envs=sandbox`); `tools/test-idp/dist/sandbox-issuer.js`; `tests/e2e/support/aws-auth.ts`; finops `tools/aws-sandbox/dist/bin.js`                                               |
| CI image (optional) | a login for your GitLab project's container registry: `SBX_SOURCE_AUTHFILE=<skopeo auth file>`; trust anchor `SBX_COSIGN_PUBKEY=<the project's release-signing public key>` (without it, a local build is used)                                                                     |
| Bash                | the scripts run on macOS `/bin/bash` 3.2                                                                                                                                                                                                                                            |

## Commands

The guard needs AWS CLI **2.35.11** (not group/other-writable) and a fresh build of
`tools/aws-preflight` (a stale `dist/` is refused, exit 17). Run every script under the pinned CLI:

```bash
pnpm build                                             # includes @starter/tool-aws-preflight
export PNPM="npm exec --yes pnpm@12.11.2 --"           # unless pnpm is on PATH
export SANDBOX_ROLE_PATTERN='AWSReservedSSO_ExampleDeveloper_*'   # optional: pin the SSO role
AWSCLI='github:NixOS/nixpkgs/e8be7818e19ada32105a8af937a6a473b38167ca#awscli2'

# Pre-deploy, offline (no AWS): the browser sign-in routing the live E2E depends on.
pnpm --filter @starter/tests-e2e run test:aws-auth-offline   # Playwright Chromium + openssl

# Everything, teardown guaranteed (≈ 2–2.5 h wall clock):
nix shell "$AWSCLI" nixpkgs#skopeo nixpkgs#cosign -c bash tests/aws-integration/sandbox/all.sh

# Step by step (each step is idempotent; resume a run with SBX_RUN_ID=sbx-<6 hex>):
tests/aws-integration/sandbox/bootstrap.sh              # cdk bootstrap only if starter-cdk-toolkit is absent
tests/aws-integration/sandbox/up.sh                     # new run sbx-<6 hex>, prints the run id
tests/aws-integration/sandbox/test.sh                   # live checks (current run)
tests/aws-integration/sandbox/rollback.sh               # circuit-breaker rollback experiment
tests/aws-integration/sandbox/down.sh                   # teardown + verify.sh
tests/aws-integration/sandbox/verify.sh                 # read-only: finops verify-clean
tests/aws-integration/sandbox/bootstrap.sh --destroy    # only if this experiment created the bootstrap
tests/aws-integration/sandbox/verify.sh --include-bootstrap
```

(The step-by-step commands are meant to run inside the same `nix shell "$AWSCLI" … -c bash`.)
`SBX_RUN_ID` selects a run; otherwise the scripts use `${SANDBOX_HOME}/runs/current`.

Guard exit codes (a refusal stops the script; nothing was run): 2 usage/CI/command shape,
3 account mismatch, 4 principal rejected, 6 SSO session expired (`aws sso login`), 10 region,
11 profile, 12 environment conflict (static keys, `AWS_CONFIG_FILE`, endpoint overrides, another
`AWS_PROFILE`), 13 STS failure, 14 AWS CLI not 2.35.11, 15 `~/.aws` configuration refused, 16 guard
log not private, 17 stale guard build. The scripts' own codes: 1 failure, 2 usage, 3 not verified
(`verify.sh`), 4 refused (no expected account, another run deployed), 5 clean with unverifiable
categories (`verify.sh`, `down.sh`, `all.sh`; see Teardown).

### Environment

| Variable                                     | Default                                                       | Meaning                                                                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SANDBOX_HOME`                               | `~/.config/starter-aws-sandbox`                               | expected-account file, `runs/<runId>/`, `bootstrap.json`                                                                                                                                                                                                   |
| `SBX_RUN_ID`                                 | new id (`up.sh`, `all.sh`) / `runs/current`                   | the run to deploy, resume, test or tear down                                                                                                                                                                                                               |
| `SBX_IMAGE_SOURCE`                           | `auto`                                                        | `ci`: CI-published, Cosign-verified image only; `local`: local rootless build; `auto`: CI if usable                                                                                                                                                        |
| `SBX_CI_IMAGE`                               | `registry.example.invalid/aws-modernization-starter/api:main` | CI image reference (tag or `@sha256:`)                                                                                                                                                                                                                     |
| `SBX_SOURCE_AUTHFILE`                        | –                                                             | skopeo/cosign auth file for the CI registry                                                                                                                                                                                                                |
| `SBX_COSIGN_PUBKEY`                          | –                                                             | path to the project's **own** release-signing public key (`cosign.pub` of the opt-in signing setup, `docs/ci-cd.md` §11); the CI image is used only when it verifies against this key. Unset or not a file: `auto` falls back to a local build, `ci` fails |
| `SBX_TTL_HOURS`                              | `8`                                                           | `starter:expires-at`, 1–24 h; the app refuses a deploy after it (tear down and start a new run instead of resuming)                                                                                                                                        |
| `SBX_RESERVED_CONCURRENCY`                   | –                                                             | `none` or `<n>` → `-c sandbox.reservedConcurrency` (a Lambda concurrency quota below 105 needs `none`)                                                                                                                                                     |
| `SBX_ORIGIN_PREFIX_LIST_ID`                  | `pl-31a34658`                                                 | `-c sandbox.originPrefixListId` (the CloudFront origin-facing list of `ap-southeast-1`; set the id of your region's list elsewhere; empty = the app's default)                                                                                             |
| `SBX_MASTER_SECRET_ROTATION`                 | `on`                                                          | `on`/`off` → `-c sandbox.masterSecretRotation` (hosted-rotation transform; the CDK CLI sends `CAPABILITY_AUTO_EXPAND`)                                                                                                                                     |
| `SBX_TESTS`                                  | all                                                           | `test.sh` subset: `spa,health,origin-protection,smoke,canary,security,rate-limit,e2e,db-probe,leak-scan,step-functions`                                                                                                                                    |
| `SBX_SECTEST_TARGETS`                        | `web`                                                         | `both` also sets `API_BASE_URL` (= CloudFront; the ALB is not reachable directly)                                                                                                                                                                          |
| `SBX_MAX_EXHAUST`                            | `300`                                                         | largest rate limit the rate-limit suite exhausts                                                                                                                                                                                                           |
| `SBX_FORCE_STEPS`                            | –                                                             | comma-separated `up.sh` steps to re-run on resume (e.g. `publish-spa`)                                                                                                                                                                                     |
| `SBX_DESTROY_BOOTSTRAP`                      | `true` (`all.sh`)                                             | delete the bootstrap at the end — only when this experiment created it and the teardown was clean                                                                                                                                                          |
| `SBX_DOWN_FORCE_CFN`                         | –                                                             | `true`: `down.sh` uses `delete-stack` instead of `cdk destroy`                                                                                                                                                                                             |
| `SBX_SKIP_BUILD`                             | –                                                             | `true`: use existing builds                                                                                                                                                                                                                                |
| `SBX_POLL_SECONDS`, `SBX_*_DEADLINE_SECONDS` | 10–15 s; see the scripts                                      | polling interval and bounded waits                                                                                                                                                                                                                         |

## What happens, how long it takes

| Step (script)                        | What                                                                                                                                                                                                                                                                                                         | ≈ minutes |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `bootstrap.sh`                       | `cdk bootstrap aws://<acct>/<SANDBOX_REGION> --qualifier starter --toolkit-stack-name starter-cdk-toolkit` (experiment tags, no termination protection) unless present; `bootstrap.json` records whether it pre-existed                                                                                      | 2–3       |
| `up.sh` secrets                      | `origin-verify` (32 random bytes, hex), issuer key (`sandbox-issuer.js keygen`)                                                                                                                                                                                                                              | –         |
| image select, finops baseline        | CI image (skopeo inspect, `cosign verify` with the trust anchor, revision's API sources equal HEAD, arm64) or a local `podman build --platform linux/arm64` + `skopeo inspect` of the archive: the digest every deploy carries; `verify.sh --baseline` before the first deploy                               | 0–10      |
| Foundation, TestIssuer               | VPC/NAT/KMS; issuer bucket + CloudFront                                                                                                                                                                                                                                                                      | 10–15     |
| publish issuer                       | `sandbox-issuer.js export` → `aws s3 cp --content-type application/json --cache-control no-cache` (discovery, JWKS) → invalidation; local IdP on `127.0.0.1:9400`; check: both documents 200 with the right content, and a locally minted token verifies against the published key (≤ 15 min for CloudFront) | 2–15      |
| Platform, image push, Data, Workflow | ECS cluster/ECR; `skopeo copy --preserve-digests` to ECR (the pushed digest must equal the selected one; `image/image.json`); RDS PostgreSQL 17 + DynamoDB; Step Functions + Lambdas                                                                                                                         | 15–25     |
| Migrations + tasks                   | `ecs run-task` bootstrap (its own `BootstrapSecurityGroupId`), then migrations (`TaskSecurityGroupId`); exit code 0 required, logs kept                                                                                                                                                                      | 5–8       |
| Api, Frontend, SPA, Observability    | same context; the SPA is published right after Frontend (next row)                                                                                                                                                                                                                                           | 15–20     |
| SPA                                  | `pnpm --filter @starter/web build`, `aws s3 sync` (immutable assets) + `index.html` (no-cache), invalidation `/*`; IdP restarted with redirect `https://<distribution>/`; `outputs.json`, `endpoints.json`, finops `inventory.json`                                                                          | 3–6       |
| `test.sh`                            | see the next table                                                                                                                                                                                                                                                                                           | 15–30     |
| `rollback.sh`                        | unhealthy revision → circuit breaker → baseline                                                                                                                                                                                                                                                              | 8–20      |
| `down.sh`                            | reverse-order destroy (CloudFront, RDS, VPC Lambda ENIs dominate) + leftovers + verify                                                                                                                                                                                                                       | 30–50     |

Cost while up: roughly USD 0.15–0.25 per hour (NAT gateway, RDS `db.t4g.micro`, ALB, one Fargate
arm64 task, KMS keys, CloudFront requests). A full `all.sh` stays far below the USD 13 stop line;
check the finops estimate before starting and after teardown.

## Live checks (`test.sh`) and how pass/fail is decided

Results: `<run dir>/test-<UTC>/results.jsonl` and `summary.json` (`test-latest` points to the newest).

| Check (`check`)                    | Covers                                                                                                                    | Pass when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clock`                            | (precondition of every token check)                                                                                       | the local clock is within 30 s of CloudFront's `Date` (tokens are minted locally; also checked by `up.sh` before the issuer check)                                                                                                                                                                                                                                                                                                                                                                                     |
| `spa`                              | SPA via CloudFront                                                                                                        | `/` 200 `text/html` with the root element; CSP names the issuer origin, no wildcard script source; `/config.json` names the sandbox issuer and client `starter-web-sandbox`                                                                                                                                                                                                                                                                                                                                            |
| `health`                           | health/readiness                                                                                                          | `/health/live` and `/health/ready` through CloudFront answer 200 (polled ≤ 5 min)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `origin-protection`                | API only via the intended origin                                                                                          | direct `http://<AlbDnsName>` without and with a wrong `X-Origin-Verify` is 403 or gets no connection (security group); the listener's default action is a fixed 403; every forwarding rule requires the run's value; the ALB security group admits only a prefix list                                                                                                                                                                                                                                                  |
| `smoke`                            | JWT validation, invalid auth rejected, DynamoDB ops, Step Functions executions, Lambda failure path                       | each of the 6 smoke steps passes (health, 401 without a token, a job SUCCEEDED with a correct checksum, a business-invalid job FAILED with `JobValidationError`, 400 problem+json); steps after a failure are `not-run`                                                                                                                                                                                                                                                                                                |
| `canary`                           | (input of the leak scan)                                                                                                  | a canary job SUCCEEDED and a business-invalid job FAILED through CloudFront                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `security`                         | JWT validation, invalid auth rejected, Alice≠Bob isolation, idempotency, response hygiene, audit trail, DynamoDB contents | `tests/security` with `SECTEST_MODE=external` (all suites but rate-limit) against CloudFront, the real DynamoDB table (read-only scan) and the real API log stream followed from CloudWatch; per-test results; self-mode-only tests are `skipped` with the reason                                                                                                                                                                                                                                                      |
| `rate-limit`                       | rate limiting                                                                                                             | the rate-limit suite alone (it exhausts the per-address budget): request N+1 → 429 + `Retry-After` for reads, writes and failed authentications (when the limit ≤ `SBX_MAX_EXHAUST`; else `skipped`)                                                                                                                                                                                                                                                                                                                   |
| `e2e`                              | browser E2E                                                                                                               | preflight first: `pnpm --filter @starter/tests-e2e run test:aws-auth-offline` (offline routing check; when it fails the live E2E is `not-run`); then Playwright against CloudFront with `E2E_AUTH_MODE=aws-test-issuer` (traces, screenshots and videos off: the browser carries live tokens); `not-run` when `tests/e2e/support/aws-auth.ts` is missing                                                                                                                                                               |
| `db-probe`                         | PostgreSQL TLS verify, app role cannot do privileged ops                                                                  | one-off task of the API task definition (command override only): `starter_app` connects with IAM auth + `verify-full`; a trust store without the RDS CA and a host name not in the certificate are rejected; no-TLS is refused by the server; the API task role cannot log in as `starter_migrator`; `SELECT` on `jobs` allowed; UPDATE/DELETE/TRUNCATE/DDL/role changes/`pg_authid`/`pg_read_file`/`COPY TO PROGRAM`/extensions/`CREATE DATABASE`/`ALTER SYSTEM` fail with SQLSTATE 42501; every case must be present |
| `leak-scan`, `lambda-failure-path` | no sensitive content in logs/histories, Lambda failure paths                                                              | positive controls first (the owner's GET shows the title canary, the API log group names both jobs, both execution histories were read and name their jobs); then no canary (ours and the security suite's), JWT, origin-verify value or private-key parameter in any experiment log group or execution history since the run started; the business-invalid execution caught `JobValidationError` and entered `RecordFailure`. Log delivery lag: re-downloaded until the controls hold (≤ 15 min)                      |
| `step-functions`                   | Step Functions executions                                                                                                 | executions started during the run exist and are all terminal (none running, timed out or aborted)                                                                                                                                                                                                                                                                                                                                                                                                                      |

`rollback.sh` (results in `rollback-<UTC>/`): baseline settled and healthy → `FROM <api>@<digest>`
with a CMD that exits 1 (built from an OCI layout, pushed by digest) → new task-definition revision
→ `update-service` → pass when the circuit breaker marked the deployment FAILED and ECS returned to
the baseline revision at full count; then the running containers carry the baseline digest, health
and a smoke run pass through CloudFront. Deployments, service events, alarm states, timings and the
rollout state are recorded. Without an automatic rollback the script restores the baseline itself
and the check **fails**; the service is never left on the unhealthy revision.

## Teardown and failure handling

- `up.sh` fails: it prints the teardown command; `all.sh` runs it. Resume instead with
  `SBX_RUN_ID=<id> up.sh` (finished steps are skipped).
- `down.sh` is idempotent and safe to repeat. The account is shared (other stacks, VPCs, RDS
  instances, the default `CDKToolkit`), so it only acts on **our** stacks — `Sandbox-*` names that
  also carry `starter:experiment=live-validation` / `starter:run-id=sbx-…` — and on resources captured from them
  (`<run dir>/captured-resources.tsv`, kept for re-runs), plus names under the stage prefix
  `starter-sbx`. Without the run directory it finds the stacks by name and tag and uses
  `delete-stack`; `--all-runs` takes every experiment stack. A `DELETE_FAILED` stack gets its
  buckets emptied and its repositories deleted (`ecr delete-repository --force`) and one more
  delete. Afterwards it removes task-definition revisions of our families (incl. rollback.sh's),
  our ECR repository if retained, log groups of our resources (exact names from captured Lambda
  functions, DB instances, clusters and log groups, plus `/starter/starter-sbx/`,
  `/aws/lambda/starter-sbx-`, `/aws/vendedlogs/states/starter-sbx-`,
  `/aws/ecs/containerinsights/starter-sbx-`; by name the two created outside CloudFormation:
  `/aws/ecs/containerinsights/starter-sbx-cluster/performance` and
  `/aws/lambda/starter-sbx-rds-rotation`), RDS automated backups and manual snapshots of our
  instances, deletes the local issuer key and origin-verify value once no stack is left, and runs
  `verify.sh`. It **reports** (cannot act, see below) KMS keys not pending deletion and the
  fixed-name secret `starter-sbx/rds/master` (NOT VERIFIED: Secrets Manager is denied; a secret
  pending deletion under that name blocks the next deploy until an administrator force-deletes it).
  Exit 1 lists failures in `down-<UTC>/failures.txt`; notes are in `notes.txt`. The finops
  inventory names the same teardown command: `SBX_RUN_ID=<id> tests/aws-integration/sandbox/down.sh`.
- **Operator permission set** (the Developer SSO permission set the scripts were designed for): no `kms:ScheduleKeyDeletion`
  (CloudFormation schedules our keys on stack delete; a key left enabled is reported for an
  administrator), no Secrets Manager at all (a secret pending deletion, e.g. `starter-sbx/rds/master`,
  blocks a redeploy under that name until an administrator force-deletes it), no
  `ecr:BatchDeleteImage` (repositories are deleted with `--force` instead of being emptied), no
  `tag:GetResources`, `ssm:GetParameters` only. CDK cannot assume the starter deploy/publishing roles
  and proceeds with the operator's credentials (the "could not assume … proceeding anyway" warning
  is expected).
- Export evidence **before** `down.sh`: it deletes the log groups. `test.sh` already keeps the
  downloaded log events and histories under `test-<UTC>/scan/`.
- `verify.sh` runs `verify-clean --strict` (retained, billed RDS snapshots/backups fail the verdict;
  strict is also the tool's default, `--lenient` is never passed) with the run's
  `--inventory <run dir>/inventory.json` when up.sh got that far, and `--baseline`. The finops tool
  runs the guard before each of its own AWS calls. Exit: 0 clean; 1 experiment resources remain;
  3 not verifiable (finops tool missing, refused, incomplete, or no report written) — never
  reported clean; **5 clean with unverifiable categories**: nothing found, but KMS keys / Secrets
  Manager secrets could only be settled through fallbacks because this role cannot list them —
  every category is printed as `UNVERIFIABLE <category> (<status>)` with its `evidence:` lines (the
  report is `verify-clean.json`). Read that evidence before calling the account clean; `all.sh`
  still deletes an experiment-created bootstrap (a re-run cannot change what the role may list)
  and exits 5. `all.sh` runs `verify.sh` once more with `--include-bootstrap` after deleting an
  experiment-created bootstrap.
- `bootstrap.sh --destroy` deletes the toolkit stack only if `bootstrap.json` says this experiment
  created it and no `Sandbox-*`/`starter-it-*` stack is left; it empties the asset repository first and
  deletes the retained staging bucket afterwards.
- Budget stop (USD 13): run `down.sh` immediately; it does not depend on the test state.
- finops baseline: `all.sh` (and `up.sh` when missing) records `verify-clean` **before** the first
  deploy as `<run dir>/verify-baseline.json` (`verify.sh --baseline`); every later `verify.sh` passes
  it to `verify-clean --baseline`.

## Run directory

`${SANDBOX_HOME}/runs/<runId>/` (0700): `run.env`, `origin-verify` and `issuer-key.jwk` (0600,
deleted by `down.sh`), `issuer-public/`, `outputs.json`, `endpoints.json`, `describe-stacks/`,
`cdk-outputs/`, `cdk.out/`, `guard.log`, `steps.jsonl`, `state/`, `logs/<script>-<UTC>.log`,
`idp.pid`/`idp.log`, `image/`, `tasks/<name>-<UTC>/`, `test-<UTC>/`, `rollback-<UTC>/`,
`down-<UTC>/`, `inventory.json`. Raw, never committed; publish only sanitized
evidence. In AWS mode Playwright records no
traces, screenshots or videos (they would hold live tokens of the test issuer).

The origin-verify value is part of the CloudFormation templates and the CloudFront configuration
by design; it is per run and deleted locally by `down.sh`.

## Offline self-test

```bash
pnpm --filter @starter/tests-aws-integration test   # includes src/sandbox/*.test.ts
```

`src/sandbox/sandbox-all.test.ts` and `sandbox-scripts.test.ts` run these scripts against a fake AWS world
(`src/sandbox/fixtures/fake-world.js`: `aws` limited to the operator permission set in
`fixtures/permission-set.json`, `cdk`, `skopeo`, `cosign`, `podman`, test IdP, smoke, finops, plus
foreign resources of other teams that must stay untouched) and a fake guard
(`src/sandbox/fixtures/fake-guard.ts`) that enforces the real guard's command rules (executables
only, no wrappers or inline code, pinned profile/region incl. abbreviations, no account id in
labels) and brackets every guarded command. They check ordering, a guard bracket around every
mutation, the deploy inputs on every deploy (`requireDeployInputs`, secret file, operator
principal, image digest, rotation switch), teardown after failures and guard refusals, no secret
in outputs or run-directory files, idempotent re-runs, the run-mixing refusal, teardown without
the run directory, `not-run` results, the E2E preflight, `verify.sh` without a report, finops
exit 5, and the rollback restore path. `sandbox-real-guard.test.ts` runs `all.sh` under the
**real** guard (the helper and the guard CLI's current sources; its `aws` is the fake world's, its
HOME private): every guarded command shape must pass it and its STS call must come right before
each mutation; an account mismatch and a `~/.aws/credentials` file stop everything. A static audit
(`sandbox-tools.test.ts`) checks that every `cdk`/AWS CLI/image-push call site is guarded, every AWS
call is in the permission set and no guarded command is a wrapper. `SBX_SELFTEST_KEEP=1` keeps the
fake world for debugging.
