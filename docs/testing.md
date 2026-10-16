# Testing

How the repository shows that the system works, what each layer can and cannot prove, and how to
run every suite locally and in CI.

## 1. Three layers

| Layer                             | Where it runs                                             | Talks to                                                                      | Proves                                                                                                                     |
| --------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **1. Unit and local integration** | every developer machine and every CI pipeline             | nothing (unit), or PostgreSQL 17 + DynamoDB Local in containers / CI services | business logic, contracts, the API as a black box, security controls, the browser flow, CDK templates and policies         |
| **2. MiniStack emulator**         | GitLab CI (`integration:ministack:*`); optionally locally | a socket-less MiniStack emulator with fake credentials                        | the integration mini-stack deploys, reconciles, updates and destroys; the real handlers and state machine run the workflow |
| **3. Live AWS (optional)**        | an operator's workstation, a dedicated AWS account        | real AWS                                                                      | functional behaviour of the workflow (mini-stack) or the whole application (sandbox) on ordinary AWS                       |

Layers 1 and 2 run without an AWS account. Layer 3 runs only when an operator starts it
([aws-deployment.md](aws-deployment.md)); CI has no AWS credentials by default.

```text
  layer 3   live AWS (opt-in)     AWS mini-stack · full sandbox             tests/aws-integration (*.aws.test.ts, sandbox/)
  layer 2   emulator              MiniStack: cdk reconcile · workflows      tests/aws-integration/emulator
            ─────────────────────────────────────────────────────────────────
  layer 1   browser               E2E (Playwright, Chromium)                tests/e2e
            deployed / running    smoke (any BASE_URL)                      tests/smoke
            black box, two paths  security (authN/Z, IDOR, limits, leakage) tests/security
            running API + stores  integration + negative + outage           tests/integration
            in-process            unit / component / CDK assertions         packages/*, apps/*, functions/*, infra, policies
```

## 2. What each layer does and does not prove

### Local simulation is not AWS

`WORKFLOW_MODE=local` runs the workflow **inside the API process**, calling the same validator and
processor logic and the same `workflows/processing/src/spec.ts` state names, statuses, DynamoDB key
layout and error names as the Step Functions definition. It proves the business behaviour and the
data layout, but **not**:

- the Amazon States Language definition (Retry/Catch wiring, `ResultPath`s, JSONPath, timeouts);
- the native DynamoDB service integration used by `RecordSuccess` / `RecordFailure`;
- IAM permissions, Lambda packaging, cold starts, VPC and endpoint reachability;
- Step Functions execution-name idempotency (`ExecutionAlreadyExists`) and the input size quota.

The ASL is covered statically by the CDK assertion tests (the synthesized `Retry`, `TimeoutSeconds`
and `Catch` blocks must equal the spec), dynamically by the emulator (layer 2, within its declared
gaps) and on real AWS by the optional mini-stack suite (layer 3).

### DynamoDB Local is not DynamoDB

DynamoDB Local implements the API, not the service: it does not enforce capacity or throttling,
does not delete expired items by TTL, makes GSIs effectively read-after-write consistent (the real
service is eventually consistent; the GSI assertions poll with a deadline so they hold on both),
does not validate SigV4 signatures or IAM, and has no streams, PITR or encryption semantics.
Conditional writes and transactions behave the same, which is what idempotency relies on.

### MiniStack is not AWS

The emulator layer shows that the templates deploy and the workflow runs on an AWS-compatible API.
It does not evaluate IAM or KMS policies, cannot exercise retries that match handler error names in
socket-less mode, and has further declared gaps. See [ministack.md](ministack.md).

### Suite matrix

| Suite                                             | Proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Does not prove                                                                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| unit (`pnpm test`)                                | domain rules, handlers against an in-memory store, contracts and OpenAPI drift, API routes with `fastify.inject`, the SPA with Testing Library, CDK assertions and cdk-nag, policy rules with pass/fail fixtures, CI tooling                                                                                                                                                                                                                                                                         | anything that needs a real store or network                                                                                         |
| package integration (`pnpm test:integration`)     | repositories and adapters against PostgreSQL 17 and DynamoDB Local; one behavioural contract suite runs against both the in-memory job-state store and DynamoDB Local; database identities, migrations, TLS `verify-full`                                                                                                                                                                                                                                                                            | Step Functions, IAM, real DynamoDB consistency                                                                                      |
| `tests/smoke`                                     | the running system is alive: live/ready, a job succeeds with a correct checksum, a business rule fails cleanly, schema errors are 400 problem+json                                                                                                                                                                                                                                                                                                                                                   | edge cases, concurrency, persistence details                                                                                        |
| `tests/integration`                               | API contract (every response parsed with the `@starter/contracts` schemas), lifecycle, idempotent replay, key/body mismatch (422), concurrent duplicates (exactly one 202), pagination, 400/404/413/415 problem+json, workflow failure path, PostgreSQL row and DynamoDB items against the spec layout                                                                                                                                                                                               | Step Functions, IAM, real DynamoDB consistency                                                                                      |
| `tests/integration` `outage` project (local only) | readiness flips to 503 naming the failed dependency while liveness stays 200; writes fail fast with 503; automatic recovery                                                                                                                                                                                                                                                                                                                                                                          | network partitions or latency (only hard stops)                                                                                     |
| `tests/security`                                  | every `/v1` route rejects missing, malformed and forged tokens with 401 before reading the body; 403 without scope; foreign job ids answer exactly like missing ones; lists, cursors and idempotency keys are principal-scoped; 429 per principal and per address that `X-Forwarded-For` rotation does not bypass; JWKS outage handling; problem+json without internals; CORS; canaries never in logs, DynamoDB, other users' responses or the Step Functions input — directly and through the proxy | AWS edge behaviour (CloudFront, WAF, ALB): the self-started proxy only simulates their `X-Forwarded-For` semantics; IAM; a real IdP |
| `tests/e2e`                                       | a user can submit through the SPA (mouse and keyboard only) and sees SUCCEEDED results or a FAILED message; client-side validation; same-origin routing through the web tier                                                                                                                                                                                                                                                                                                                         | visual regressions, browsers other than Chromium                                                                                    |
| emulator (`tests/aws-integration/emulator`)       | layer 2: deploy, property-level reconciliation, update and destroy of the mini-stack; the workflow suites with the real handlers                                                                                                                                                                                                                                                                                                                                                                     | AWS behaviour; the declared gaps ([ministack.md](ministack.md))                                                                     |
| `tests/aws-integration` on AWS                    | layer 3: real ASL + Lambda + DynamoDB: happy path, `JobValidationError` failure path without retries, execution-name idempotency, state item and GSI written per spec                                                                                                                                                                                                                                                                                                                                | the API/ECS/ALB/CloudFront path (covered by the sandbox lifecycle)                                                                  |

## 3. Layer 1: running the suites

All commands run from the repository root. Reports go to `reports/` (ignored by Git): JUnit XML in
`reports/junit/`, Playwright HTML in `reports/e2e-html/`.

**Script names.** Root `pnpm test` (every package's `test` script) and `pnpm test:integration`
(every `test:integration` script) run without a deployed stack: `test:integration` starts its
stores with Testcontainers, or uses the endpoints CI provides. Suites that need a running system use
explicit names: `test:api` and `test:outage` (`@starter/tests-integration`), `test:e2e`
(`@starter/tests-e2e`), `test:security` (`@starter/tests-security`, external mode), `test:aws`
(`@starter/tests-aws-integration`). Request documents come from `@starter/testing`, with a unique
title per submission.

### 3.1 Local stack

The black-box suites run against the local compose stack (rootless Podman). Starting it, host
setup, ports and Testcontainers configuration are described in [development.md](development.md).
One command runs every suite against it:

```bash
local/compose/bin/dev-up.sh app --build
local/compose/bin/test-all.sh            # smoke (API and web tier), integration, outage, E2E,
                                         # security (both paths), leak scan, image config check
local/compose/bin/test-all.sh --no-outage --no-e2e --no-security   # a subset
```

### 3.2 Smoke

```bash
pnpm --filter @starter/tests-smoke build
BASE_URL=http://127.0.0.1:8080 node tests/smoke/dist/cli.js   # API directly
BASE_URL=http://127.0.0.1:4173 node tests/smoke/dist/cli.js   # through the web tier
SMOKE_JUNIT=reports/junit/smoke.xml BASE_URL=... node tests/smoke/dist/cli.js
```

Dependency-free (Node `fetch`), so it runs from a plain `node` image against any environment. Exit
0 = pass, 1 = a step failed, 2 = bad configuration. Tunables: `SMOKE_READY_DEADLINE_MS` (60000),
`SMOKE_JOB_DEADLINE_MS` (60000), `SMOKE_REQUEST_TIMEOUT_MS` (10000), `SMOKE_POLL_INTERVAL_MS` (250),
`SMOKE_BUSINESS_INVALID_CONTENT`; a bearer token from `SMOKE_ACCESS_TOKEN` or the test IdP. Its own
self-tests (`pnpm --filter @starter/tests-smoke test`) run it against an in-process fake API and show
that it fails on each regression class.

### 3.3 Integration and negative tests

```bash
eval "$(local/compose/bin/env.sh)"                          # API_BASE_URL and store endpoints
pnpm --filter @starter/tests-integration test:api           # project "api" -> reports/junit/integration.xml
eval "$(scripts/podman/rootless-socket.sh env)"             # DOCKER_HOST for the outage project
LOCAL_CONTAINER_CONTROL=true pnpm --filter @starter/tests-integration test:outage   # local only
```

| Variable                                                       | Purpose                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `API_BASE_URL`                                                 | API under test (default `http://127.0.0.1:8080`)                                |
| `DB_HOST` `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` `DB_SSL` | PostgreSQL behind that API: enables row assertions (else skipped, reason shown) |
| `DYNAMODB_ENDPOINT` `JOBS_TABLE_NAME` `AWS_REGION`             | DynamoDB Local behind that API: enables item assertions (never real AWS)        |
| `IT_JOB_DEADLINE_MS` / `IT_READY_DEADLINE_MS`                  | polling deadlines (30000 / 60000)                                               |
| `LOCAL_CONTAINER_CONTROL=true`, `DOCKER_HOST`                  | enables the outage project, which stops and starts the store containers         |
| `IT_POSTGRES_CONTAINER`, `IT_DYNAMODB_CONTAINER`               | container names for the outage project                                          |

Every submission carries a unique nonce, so the suite is re-runnable against a long-lived database
and safe with parallel files. The `outage` project must never run concurrently with `api`; it
always restarts the containers in `afterAll`. It is not run in CI.

### 3.4 E2E (Playwright)

```bash
pnpm --filter @starter/tests-e2e browsers:install      # Chromium, once
WEB_BASE_URL=http://127.0.0.1:4173 pnpm --filter @starter/tests-e2e test:e2e
pnpm --filter @starter/tests-e2e report                # open reports/e2e-html
```

Selectors are role, label and text only. The test signs in through the test IdP's sign-in page.
`@playwright/test` and the CI image (`IMG_PLAYWRIGHT`) are pinned to the same version.

### 3.5 In CI

CI jobs cannot start containers (no socket), so the suites take **pre-provisioned endpoints from the
environment**: the integration jobs run PostgreSQL and DynamoDB Local as GitLab `services:`, prepare
the database roles and migrations, and start the built API as a background process. The job
definitions are in `.gitlab/ci/integration.yml` and the generated `integration:<component>` jobs;
the shared shell steps are in `tools/ci/scripts/`. Testcontainers is never used in CI.

## 4. Security suite (`tests/security`)

Black box, parameterised by base URL: every check runs against each **target** — the API directly
and through the web proxy — and passes only when the control rejects the attack (a 2xx for an
unauthorized request fails it). Each negative check has a positive control in the same test.

| File                     | Proves                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authentication.test.ts` | 401 with an RFC 6750 challenge on every `/v1` route and unknown `/v1` path; malformed headers; every token defect in `NEGATIVE_TOKEN_CASES` (including `jku`/`x5u`/`x5c`/`jwk` headers, `crit`, ID tokens, `nonce`, `typ`, token age); tokens of other clients; identical 401 bodies; an anonymous large POST is rejected before the body is read |
| `authorization.test.ts`  | the owner can read (control); a foreign id is indistinguishable from a missing id; list and cursor isolation; 403 `insufficient_scope`; the same `sub` from another issuer is not the owner                                                                                                                                                       |
| `idempotency.test.ts`    | the same key and body from two principals create two jobs; body-derived keys likewise; the owner's replay still works                                                                                                                                                                                                                             |
| `rate-limit.test.ts`     | request N+1 → 429 + `Retry-After` + `RateLimit-*` per principal; other principals unaffected; a failed-authentication budget per address that rotating `X-Forwarded-For` does not reset                                                                                                                                                           |
| `jwks.test.ts`           | during an IdP outage cached keys keep working and an unknown key gets 503; after rotation the new key is accepted and the old one rejected (self mode)                                                                                                                                                                                            |
| `hygiene.test.ts`        | problem+json without stack traces, source paths, SQL, ARNs, internal hosts or secrets; `nosniff` and `no-store`; CORS never grants a foreign origin                                                                                                                                                                                               |
| `leakage.test.ts`        | canaries (unique per run) never appear in logs, DynamoDB items, other users' responses, error responses or the Step Functions execution input; tokens and database passwords are never logged                                                                                                                                                     |
| `audit.test.ts`          | every `/v1` request yields exactly one audit event with the right outcome and a principal pseudonym, without subject, token, title or content; a client that disconnects while its request is held yields one `aborted` event                                                                                                                     |
| `configuration.test.ts`  | with `APP_RUNTIME` unset (= `aws`, as CDK deploys it) the built API refuses to start without `AUTH_ALLOWED_CLIENT_IDS`, before it logs `starting API` (self mode)                                                                                                                                                                                 |

**Modes.**

- `SECTEST_MODE=self`: `pnpm --filter @starter/tests-security test:integration` (also the CI job
  `integration:tests-security`). The suite starts what it tests: PostgreSQL and DynamoDB Local (CI
  services via `TEST_DB_*` / `TEST_DYNAMODB_ENDPOINT`, else Testcontainers), a fresh database with
  the real role model, TEST ONLY issuers, fake Step Functions endpoints and several instances of the
  **built** API (`apps/api/dist/server.js`): direct, behind two `X-Forwarded-For`-appending proxies
  (the CloudFront → ALB chain the CDK app configures), with low rate limits, with its own issuer for
  JWKS outage tests, with `WORKFLOW_MODE=stepfunctions` against a capturing fake, and with a fake that
  holds `StartExecution` so that a client disconnect can be tested deterministically. CI sets
  `SECTEST_REQUIRE_ALL=1`, so every check must run. Evidence goes to `reports/security/<runId>/`.
- `SECTEST_MODE=external`: `pnpm --filter @starter/tests-security test:security` against a running
  stack; `local/compose/bin/test-all.sh` runs it on the compose stack, and the sandbox lifecycle runs
  it against CloudFront.

| Variable                                       | Mode     | Meaning                                                                                                            |
| ---------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `API_BASE_URL` / `WEB_BASE_URL`                | external | targets "direct" / "proxy" (at least one)                                                                          |
| `TEST_IDP_URL`                                 | external | the test IdP with `TEST_IDP_ENABLE_TEST_ENDPOINTS=true` (`POST /test/token`, `/test/rotate`)                       |
| `AUTH_AUDIENCE`                                | external | expected audience (default `starter-jobs-api`)                                                                     |
| `DB_*`, `DYNAMODB_ENDPOINT`, `JOBS_TABLE_NAME` | external | stores behind the API, for leakage assertions and the database password as a known secret                          |
| `SECTEST_DYNAMODB_AWS=true`                    | external | with `JOBS_TABLE_NAME`: scan the real DynamoDB table with the default credential chain (deployed environment)      |
| `SECTEST_KNOWN_SECRET_FILES`                   | external | comma-separated files whose contents must never appear in responses or logs                                        |
| `SECTEST_LOG_FILES`                            | external | comma-separated API log files to assert on (else scanned afterwards by `starter-leak-scan`; the audit checks skip) |
| `SECTEST_MAX_TOKEN_AGE_SECONDS`                | external | the stack's `AUTH_MAX_TOKEN_AGE_SECONDS` (default 3600)                                                            |
| `SECTEST_ALLOWED_ORIGIN`                       | external | an origin the API allows, for the CORS positive control                                                            |
| `SECTEST_REQUIRE_ALL=1`                        | both     | a check that cannot run **fails** instead of skipping                                                              |
| `SECTEST_MAX_EXHAUST`                          | both     | largest limit the rate-limit tests exhaust (default 300; above it they skip with the reason)                       |
| `SECTEST_RUN_ID`                               | both     | run id (default random); names `reports/security/<runId>`                                                          |
| `SECTEST_API_DIR`, `SECTEST_HARNESS_MUTATION`  | self     | mutation runs only (below)                                                                                         |

External mode needs, on the stack under test, `RATE_LIMIT_UNAUTHENTICATED_MAX` raised (the negative
matrix sends many failed authentications from one address) and
`AUTH_ALLOWED_CLIENT_IDS=starter-web-local`; limit exhaustion is then shown in self mode.

**Mutation runs** (evidence that the checks bite; run by hand, never in CI): each mutation must make
the named checks fail while their positive controls still pass.

| Mutation                                  | How                                            | Expected failures                             |
| ----------------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| API without authentication                | `SECTEST_API_DIR=<export>/apps/api`            | most of the suite                             |
| owner predicate removed from get/list SQL | patched `dist/persistence/job-repository.js`   | IDOR, list, cursor and leakage checks         |
| idempotency keys not principal-scoped     | patched `packages/domain/dist/idempotency.js`  | every cross-user idempotency check            |
| direct API trusts `X-Forwarded-For`       | `SECTEST_HARNESS_MUTATION=trust-xff`           | the `X-Forwarded-For` rotation check (direct) |
| no client allow-list                      | `SECTEST_HARNESS_MUTATION=no-client-allowlist` | the other-client check (both paths)           |
| client disconnects not audited            | patched `dist/auth/audit.js`                   | the `aborted` check                           |
| every API accepts day-old tokens          | `SECTEST_HARNESS_MUTATION=long-token-age`      | the token-age checks (both paths)             |
| start-up checks run with `APP_RUNTIME=ci` | `SECTEST_HARNESS_MUTATION=relaxed-runtime`     | the missing-allow-list refusal                |

**Artifact leakage scanner** (`starter-leak-scan`):

```bash
pnpm --filter @starter/tests-security build
node tests/security/dist/scanner/cli.js --dir reports [--secret-env DB_PASSWORD] [--report reports/security/leak-scan.json]
```

It flags JWTs, bearer headers, private keys, AWS and GitLab tokens, database URLs with passwords,
the values of the named environment variables and every canary listed in a `canaries.json` under
the scanned directories. Output carries redacted previews only. Exit 0 clean, 1 findings, 2 usage.
The CI job `security:artifact-scan` scans the reports of the integration, E2E and emulator jobs,
also when they failed.

**Image configuration check** (`starter-image-check --archive <image.oci.tar>`): non-root numeric
user, exec-form entrypoint without a shell, no credential-like `ENV`, only the expected ports,
provenance labels. CI job `security:image-config:api`; `test-all.sh` runs it on the local image.

## 5. Layer 3: AWS integration mini-stack (opt-in)

Opt-in and isolated per run. Nothing touches AWS unless `AWS_INTEGRATION_ENABLED=true` **and** an
expected account is configured (exit 4 otherwise). How to run it: [aws-deployment.md](aws-deployment.md).

- **Run id** `it[-<CI_PIPELINE_ID>]-<6 hex>`; the stack is `starter-it-<runId>`. The scripts build
  `@starter/infra...` and run `cdk` with `--app "node dist/bin/integration.js"` and the context
  `runId`, `region` and — on deploy only — `expiresAt` (TTL `AWS_INTEGRATION_TTL_HOURS`, default 4,
  maximum 24). Optional: `AWS_INTEGRATION_CDK_QUALIFIER` → `-c qualifier=…`,
  `AWS_INTEGRATION_PERMISSIONS_BOUNDARY_ARN` → `-c permissionsBoundaryArn=…`. The stack is tagged
  `starter:ephemeral=true`, `starter:run-id=<id>` and `starter:expires-at=<ISO-8601>`; its outputs
  are read from `reports/aws-integration/outputs.json`.
- **Account guard.** Every `cdk` call carries `-c account=<expected>` (the CDK CLI compares it with
  the caller identity) and `-c qualifier=starter`; deploy uses `--toolkit-stack-name
starter-cdk-toolkit`. With `AWS_INTEGRATION_GUARD=sandbox` (the default outside CI) every mutation
  runs through the account guard of `tools/aws-preflight`; in CI (`ci`) the CDK check and the
  cleanup verifier's account check apply. A run region other than the configured one
  (`AWS_INTEGRATION_REGION`, default `ap-southeast-1`) is refused before anything runs.
- **Seeded state.** The mini-stack has no API, so each test writes the `PENDING` state item exactly as
  the API does before `StartExecution`.
- **Skips are explicit.** Without the flag, a region or resolvable credentials each test is skipped
  with the reason in its name. `run.sh` sets `AWS_INTEGRATION_REQUIRED=true`, which turns any skip
  into a failure.
- **Interruption.** `deploy.sh` destroys a partial deployment on failure or signal; `lifecycle.sh`
  runs the cleanup from an `EXIT` trap; `cleanup.sh` is idempotent and falls back to `DeleteStack` by
  run-id tag when `cdk destroy` fails.
- **Verification** (`cleanup-status.json`). `clean` only when no stack with the run id remains and
  the Resource Groups Tagging API lists no tagged resource. KMS keys confirmed `PendingDeletion` are
  listed separately and not counted as leaks. Only `clean` exits 0; otherwise 1 `leaked`, 2 `error`,
  3 `stacks-clean` (the resource sweep was not permitted), 4 `clean-with-residual-resources`
  (`leaked` with `AWS_INTEGRATION_STRICT_RESOURCES=true`), 6 `unverifiable`. In sandbox mode
  `cleanup.sh` also runs the read-only `verify-clean --strict` sweep (exit 5 when categories the role
  cannot list were settled only through fallbacks).
- **Sweeper** (safety net for stacks a dead pipeline leaked):

  ```bash
  pnpm --filter @starter/tests-aws-integration build
  node tests/aws-integration/dist/sweeper.js --region <region> --name-prefix starter-it-   # dry run
  node tests/aws-integration/dist/sweeper.js --region <region> --name-prefix starter-it- \
       --apply --wait-seconds 900 --report reports/aws-integration/sweeper.json
  ```

  It deletes only stacks tagged exactly `starter:ephemeral=true` whose `starter:expires-at` has
  passed (or, without a valid tag, that are older than `--max-age-hours`, default 24), skips stacks
  mid-operation, never overrides termination protection and retries `DELETE_FAILED`. The scheduled
  `aws:sweeper` job exists only with `AWS_JOBS_ENABLED=true` and runs as a dry run unless
  `SWEEP_APPLY=true`. A real deployment would give it a role restricted to stacks carrying
  `starter:ephemeral=true`.

The **full sandbox lifecycle** (`tests/aws-integration/sandbox/`) and its offline self-tests are
described in its [runbook](../tests/aws-integration/sandbox/README.md). The self-tests run the
lifecycle scripts against a fake AWS world limited to the operator permission set, under both a fake
and the real account guard, and are part of the unit tests.

## 6. Testcontainers

Package-level integration tests (`@starter/testing`) use CI-provided endpoints (`TEST_DB_*`,
`TEST_DYNAMODB_ENDPOINT`) when they are set, and otherwise start PostgreSQL and DynamoDB Local with
Testcontainers on the local container engine. The black-box suites in `tests/` never start
containers themselves; they assert against the stores of the API under test. Engine setup for
rootless Podman (including the Ryuk reaper settings) is in [development.md](development.md). If the
reaper is disabled or a run is killed, `local/compose/bin/tc-cleanup.sh --apply` removes every
container labelled `org.testcontainers=true` (dry run without `--apply`).

## 7. Determinism and flake policy

- **No fixed sleeps for synchronisation.** Every wait is a poll with a deadline and bounded backoff
  (`pollUntil`, Playwright web-first assertions); a timeout fails with what was awaited.
- **Unique data per test** (UUID nonces in titles and `Idempotency-Key`s), so suites are re-runnable
  against persistent stores and safe in parallel.
- **No real network** beyond the system under test; only layer 3 talks to AWS, and only when
  explicitly enabled.
- **Skips state their reason** in the test name (visible in JUnit); the `*_REQUIRED` and
  `SECTEST_REQUIRE_ALL` modes turn skips into failures where a skip would hide a broken pipeline.
- **Flakes.** No automatic retries locally. In CI, Playwright retries once only to capture a trace
  and `failOnFlakyTests` still fails the job. Fix or quarantine a flaky test promptly
  (`test.fixme` with an issue link); never quarantine smoke or the AWS cleanup verification.
