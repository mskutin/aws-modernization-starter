# Interface contracts

The public surfaces that every package, test and pipeline relies on. Change the contract (and its
version, where it has one) before the implementation; never fork a contract locally.

## 1. Workspace package names (scope `@starter/`)

| Path                     | Package                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `apps/web`               | `@starter/web`                                                                                    |
| `apps/api`               | `@starter/api`                                                                                    |
| `functions/validator`    | `@starter/fn-validator`                                                                           |
| `functions/processor`    | `@starter/fn-processor`                                                                           |
| `functions/reconciler`   | `@starter/fn-reconciler` (scheduled stale-job reconciler, ADR 0231)                               |
| `workflows/processing`   | `@starter/workflow-processing` (root export = runtime-safe spec; `./cdk` export = CDK definition) |
| `packages/contracts`     | `@starter/contracts`                                                                              |
| `packages/domain`        | `@starter/domain`                                                                                 |
| `packages/observability` | `@starter/observability`                                                                          |
| `packages/config`        | `@starter/config`                                                                                 |
| `packages/testing`       | `@starter/testing`                                                                                |
| `packages/db`            | `@starter/db` (PostgreSQL connections, role bootstrap, TLS, the vendored RDS CA bundle)           |
| `packages/documents`     | `@starter/documents` (document loading for the workflow steps, ADR 0230)                          |
| `packages/job-state`     | `@starter/job-state` (DynamoDB job-state store on the spec key layout + in-memory twin)           |
| `infra`                  | `@starter/infra`                                                                                  |
| `policies`               | `@starter/policies`                                                                               |
| `tests/<suite>`          | `@starter/tests-<suite>`                                                                          |
| `tools/<tool>`           | `@starter/tool-<tool>`                                                                            |

Every package exposes the standard scripts where meaningful:
`build`, `typecheck`, `lint` (optional; root lint covers all), `test`, `test:unit`.
Packages use `"type": "module"`, extend `../../tsconfig.base.json`, emit to `dist/`.
Internal dependencies use `"workspace:*"`.

## 2. Workflow spec

`workflows/processing/src/spec.ts` is the single source of
truth for state names, statuses, retry/timeout policy, error names, the DynamoDB
key layout and the deterministic execution name. Both the CDK definition and the
API's local workflow adapter import it. Change it (and its version) before either consumer.

## 3. API runtime contract (`@starter/api`)

- Listens on `PORT` (default `8080`), `0.0.0.0`.
- `GET /health/live` — liveness; 200 unless the process is shutting down.
- `GET /health/ready` — readiness (local compose, smoke checks, alarms — **not** the ECS/ALB
  health check, which uses liveness so a dependency outage does not kill every task); 200
  only when PostgreSQL and DynamoDB are
  reachable and the server is not draining; otherwise 503.
- `POST /v1/jobs`, `GET /v1/jobs/{jobId}`, `GET /v1/jobs` — versioned REST API.
  `Idempotency-Key` request header supported on POST.
- `GET /openapi.json` — OpenAPI 3.1 document generated from `@starter/contracts`.
- Errors use RFC 9457 `application/problem+json`.
- Graceful shutdown on SIGTERM: readiness flips to 503, in-flight requests drain,
  pools close, exit within `SHUTDOWN_TIMEOUT_MS` (default 20000, below the ECS
  `stopTimeout` of 30 s).
- Environment variables (identical names locally and on ECS), validated at start-up by
  `@starter/config` (`packages/config/src/*.ts`; full reference with defaults in
  [development.md](development.md) §5):

  | Variable                                                     | Meaning                                                                                                 |
  | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
  | `PORT`, `LOG_LEVEL`, `NODE_ENV`                              | server basics                                                                                           |
  | `APP_RUNTIME`                                                | `aws` (default; strict), `ci` or `local`; every local/CI relaxation is gated on it, never on `NODE_ENV` |
  | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`                   | PostgreSQL; `DB_USER` is the least-privilege runtime role                                               |
  | `DB_AUTH`                                                    | `iam` on AWS (RDS IAM token per connection); `password` only with `APP_RUNTIME=local\|ci`               |
  | `DB_SSL`, `DB_SSL_ROOT_CERT`                                 | `verify-full` against the given CA bundle (default); `disable` only with `APP_RUNTIME=local\|ci`        |
  | `JOBS_TABLE_NAME`                                            | DynamoDB job-state table                                                                                |
  | `DYNAMODB_ENDPOINT`                                          | local only (DynamoDB Local); unset on AWS                                                               |
  | `AWS_REGION`                                                 | region                                                                                                  |
  | `WORKFLOW_MODE`                                              | `stepfunctions` (default) or `local` (in-process simulation, refused on `APP_RUNTIME=aws`)              |
  | `STATE_MACHINE_ARN`                                          | required when `WORKFLOW_MODE=stepfunctions`                                                             |
  | `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_ALLOWED_CLIENT_IDS`, … | bearer-token verification (ADR 0210); `AUTH_ALLOWED_CLIENT_IDS` is required on `APP_RUNTIME=aws`        |
  | `RATE_LIMIT_*`, `TRUST_PROXY_HOPS`                           | rate limits and the number of trusted proxies (ADR 0212)                                                |
  | `CORS_ALLOWED_ORIGINS`                                       | comma-separated; empty = same-origin only                                                               |

- Build output: `apps/api/dist/server.js` (start: `node dist/server.js`),
  `apps/api/dist/migrate.js` (runs versioned SQL migrations from
  `apps/api/migrations/`).

## 4. Lambda handlers

- `functions/<name>/src/handler.ts` exports `handler`; pure logic is exported
  separately so the local workflow adapter can call it in-process.
- Env: `JOBS_TABLE_NAME`, `AWS_REGION`, `LOG_LEVEL`, optional `DYNAMODB_ENDPOINT`; the
  validator and processor also get the `DB_*` settings of the `starter_processor` role
  (`DB_AUTH=iam`, `DB_SSL=verify-full`) to load the document (ADR 0230).
- Runtime: Node.js 24 (`NODEJS_24_X`), arm64, bundled with esbuild.
- Errors thrown with `name` from `WorkflowError` in the spec.

## 5. Web

- Calls the API at relative `/v1/...` by default; `VITE_API_BASE_URL` overrides.
- In AWS, CloudFront serves the SPA from a private S3 origin (OAC) and routes
  `/v1/*` to the ALB origin, so the browser stays same-origin.
- Locally, the Vite dev server proxies `/v1` and `/health` to `http://127.0.0.1:8080`.

## 6. Local ports (host, bound to 127.0.0.1)

| Service                  | Port        |
| ------------------------ | ----------- |
| API                      | 8080        |
| Web (Vite dev / preview) | 5173 / 4173 |
| PostgreSQL (app dev)     | 15432       |
| DynamoDB Local           | 18000       |
| TEST ONLY IdP            | 9400        |

The compose stack's host ports can be moved with `STARTER_{PG,DYNAMODB,API,WEB,IDP}_HOST_PORT` when one
is taken; the defaults above are the contract.

## 7. Local container engine

All local containers (the compose stack, Testcontainers, the local emulator) run on a **rootless**
Podman engine; the helper scripts refuse a rootful engine. Compose and Testcontainers reach it
through `DOCKER_HOST`, provided on macOS and Linux by `scripts/podman/rootless-socket.sh`. Host-specific
setup: [development.md](development.md) §4.0.

## 8. Policy gate at synth (cdk-nag v3)

- cdk-nag 3.x packs are CDK **policy-validation plugins** (`Validations.of(app).addPlugins`),
  not Aspects. Any **error**-level finding fails `cdk synth`; warnings are reported only.
- `infra/lib/policy-hook.ts` `applyPolicyChecks(app, { additionalPacks })` registers
  `AwsSolutionsChecks` plus the proposed baseline from `@starter/policies`
  (`(scope) => applyBaselinePolicies(scope, { register: false }).pack`). It is called at the end of
  BOTH `infra/bin/app.ts` and `infra/bin/integration.ts`, after every stage/stack exists.
- `aws-cdk-lib` must be the **same exact version** in `infra` and `policies` (2.272.0):
  two copies at synth time break construct checks.
- Waivers live only in the registers under `policies/exceptions/`: governed exceptions
  (`exceptions.yaml`) and in-code acknowledgements (`suppressions.yaml`, applied per construct and
  rule through `acknowledgeRule()`). Reference-design entries are undated; project entries expire
  after at most 180 days ([policy-as-code.md](policy-as-code.md)).
- `infra/test/baseline-policies.test.ts` runs the baseline pack over every deployable variant
  (the stages and the integration mini-stack) and allows only the advisory `BASE-LMB-004`.
- Lambda bundling runs `pnpm exec esbuild`, so a `pnpm` binary must be on `PATH` for synth
  and infra tests (CI images: install pnpm; locally: `npm exec --yes pnpm@12.11.2 --` shim).

## 9. Required tags

Every stage/stack carries exactly `Project`, `Environment`, `Owner`, `CostCentre`,
`DataClassification`, `ManagedBy`. `Environment` ∈ `dev | staging | prod` (BASE-TAG-002;
environment-aware rules key off it). The ephemeral integration mini-stack deploys into the
non-production account and is therefore tagged `Environment=dev`
(`integrationRequiredTags()`); its ephemeral nature is carried by `starter:ephemeral=true`,
`starter:run-id` and `starter:expires-at` (used by the sweeper).
