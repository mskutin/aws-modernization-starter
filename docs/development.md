# Development guide

How to build, run and change the application part of the monorepo: the React
SPA (`apps/web`), the Fastify API (`apps/api`), the workflow Lambdas
(`functions/*`) and the shared packages (`packages/*`).

> **The local workflow is a simulation.** With `WORKFLOW_MODE=local` the API runs
> the processing workflow in-process. It reuses the Lambda step code and the
> retry/timeout numbers from `workflows/processing/src/spec.ts`, but it is **not**
> AWS Step Functions. A local run tells you nothing about how the deployed state
> machine behaves.

## 1. Prerequisites

| Tool                            | macOS                                                           | Linux (incl. WSL2)                                                                                | Needed for                                                       |
| ------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Node.js 24 (`.node-version`)    | any install; `pnpm install` refuses another major               | same                                                                                              | everything; runtime of the ECS image and Lambdas (`NODEJS_24_X`) |
| pnpm 12.11.2 (`packageManager`) | `npm exec --yes pnpm@12.11.2 -- <args>` (no corepack needed)    | same                                                                                              | everything                                                       |
| git                             | yes                                                             | yes                                                                                               | hooks, impact analysis                                           |
| Podman 5+, **rootless**         | `podman machine` (default VM)                                   | rootless Podman as your user, with a systemd user session (Podman schedules healthchecks with it) | compose stack, Testcontainers (`docs/contracts.md` §7)           |
| compose provider                | `docker-compose` v2 (used by `podman compose`)                  | same                                                                                              | compose stack                                                    |
| curl, openssl                   | preinstalled                                                    | distro packages                                                                                   | socket helper; local PostgreSQL TLS                              |
| ssh                             | preinstalled (socket forward into the VM)                       | —                                                                                                 | socket helper                                                    |
| Playwright Chromium             | `pnpm --filter @starter/tests-e2e browsers:install` (downloads) | same                                                                                              | E2E suite only                                                   |

Never root: the helpers refuse a rootful Podman API and never use `sudo`. First runs pull pinned
images from `docker.io` and `gcr.io` (distroless, for the API image build) and packages from the npm
registry; after that, unit tests and the deps profile work offline.

Supply-chain settings in `pnpm-workspace.yaml` apply: dependencies younger than
3 days are refused (`minimumReleaseAge`) and only allow-listed packages may run
install scripts. Pin exact versions (no `^`) when adding dependencies.

## 2. Install, build, check

```bash
pnpm install           # or: npm exec --yes pnpm@12.11.2 -- install   (no corepack, no global pnpm)
pnpm -r build          # topological: contracts → domain → … → api, functions, web
pnpm -r typecheck      # needs the dist/ of workspace dependencies → build first
pnpm lint              # eslint . --max-warnings=0
pnpm format:check      # prettier --check .
pnpm -r test           # unit tests only (no containers, no network)
pnpm -r test:integration   # PostgreSQL 17 + DynamoDB Local (see §6)
```

Workspace packages resolve each other through `exports` → `dist/`, so a fresh
checkout must run `pnpm -r build` before `typecheck`/`test` of a dependent package.
`pnpm --filter <pkg>... build` builds one package and its dependencies.

`pnpm install` fails with `Unsupported engine … wanted: {"node":">=24.11.0 <25"}` on any other
Node.js major (`engines` in `package.json` + `engineStrict: true` in `pnpm-workspace.yaml`; pnpm 12
ignores `engine-strict` in `.npmrc`). It also installs the git hooks (`scripts/git-hooks/install.sh`):
wrappers without absolute paths, so worktrees can share one hooks directory. They are optional —
`LEFTHOOK=0 pnpm install` skips them, `sh scripts/git-hooks/install.sh --uninstall` removes them —
and CI re-runs every check. Use the script, not `lefthook install` (its hooks embed one checkout's path).

## 3. Layout (application part)

| Path                     | Package                  | What lives there                                                                                                     |
| ------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`     | `@starter/contracts`     | zod v4 API schemas (`v1`), RFC 9457 problem, OpenAPI 3.1 generator + committed `openapi/v1.json`                     |
| `packages/domain`        | `@starter/domain`        | pure logic: lifecycle state machine, business rules, document analysis, idempotency keys, Step Functions retry maths |
| `packages/observability` | `@starter/observability` | pino logger factory (redaction), request/correlation id helpers                                                      |
| `packages/config`        | `@starter/config`        | fail-fast env parsing for the API, the migration runner and the Lambdas                                              |
| `packages/job-state`     | `@starter/job-state`     | DynamoDB job-state/idempotency store (spec key layout) + in-memory twin                                              |
| `packages/testing`       | `@starter/testing`       | fixtures and PostgreSQL / DynamoDB Local endpoints (env or Testcontainers)                                           |
| `functions/validator`    | `@starter/fn-validator`  | `ValidateJob` Lambda (`src/handler.ts`) + `validateStep` used by the simulator                                       |
| `functions/processor`    | `@starter/fn-processor`  | `ProcessJob` Lambda (`src/handler.ts`) + `processStep` used by the simulator                                         |
| `apps/api`               | `@starter/api`           | Fastify 5 API, SQL migrations (`migrations/`), workflow adapters                                                     |
| `apps/web`               | `@starter/web`           | React 19 + Vite 8 SPA                                                                                                |

## 4. Run the application locally

### 4.0 Rootless Podman socket

Compose and Testcontainers talk to the engine through `DOCKER_HOST`. One helper gives both
platforms a rootless socket, with the same commands:

```bash
scripts/podman/rootless-socket.sh start     # idempotent; status | stop | env
eval "$(scripts/podman/rootless-socket.sh env)"   # DOCKER_HOST, CONTAINER_HOST, TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE
```

| Platform | What `start` does                                                                                              | `DOCKER_HOST` socket                                     |
| -------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| macOS    | SSH-forwards the VM user's rootless socket out of `podman machine` (`PODMAN_MACHINE` picks the machine)        | `~/.local/share/starter-podman/run/podman-rootless.sock` |
| Linux    | `systemctl --user start podman.socket`; without a systemd user session it runs its own `podman system service` | `$XDG_RUNTIME_DIR/podman/podman.sock`                    |

`stop` only stops what the helper started (the SSH forward, or its own `podman system service`);
systemd's `podman.socket` is left running. `STARTER_PODMAN_MODE=machine|native` overrides the
detection, `STARTER_PODMAN_ROOTLESS_SOCK` the socket path. The `local/compose/bin/*.sh` scripts call
the helper themselves when `DOCKER_HOST` is unset and refuse a rootful engine.

### 4.1 Dependencies (PostgreSQL 17 + DynamoDB Local)

Preferred: the shared compose file (all ports on `127.0.0.1`):

```bash
local/compose/bin/dev-up.sh                # deps: PostgreSQL :15432, DynamoDB Local :18000
local/compose/bin/dev-up.sh app            # + API :8080, web :4173, TEST ONLY IdP :9400 (--build to rebuild)
eval "$(local/compose/bin/env.sh)"         # DB_* as starter_app over verify-full TLS, etc.
local/compose/bin/dev-down.sh              # stop; data volumes kept (--volumes deletes them)
```

Ports: `STARTER_{PG,DYNAMODB,API,WEB,IDP}_HOST_PORT` (environment or env file) when one is taken.
Generated secrets live **outside the repository**, per user and shared by all worktrees (like the
data volumes): `${STARTER_LOCAL_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/starter-app/compose}`
holds `.env` (from `local/compose/.env.example`, mode 600) and `postgres-tls/` (local CA + server
certificate). A `local/compose/.env` of an older checkout is moved there on the next `dev-up.sh`. On
macOS keep the directory below `$HOME` (the only host path `podman machine` shares with the VM). Bind
mounts carry the SELinux `z` option, needed on Fedora/RHEL-like hosts and a no-op elsewhere.

PostgreSQL accepts TLS only (local CA in the state directory's `postgres-tls/`), and every process uses its
own least-privilege role (§11).

### 4.2 API

```bash
eval "$(local/compose/bin/env.sh)"          # APP_RUNTIME=local, DB_* (starter_app), DynamoDB Local, ...
export NODE_ENV=development LOG_LEVEL=info
# Identity: the API trusts a TEST ONLY issuer; see §13 for running one.
export AUTH_ISSUER=http://127.0.0.1:19400 AUTH_AUDIENCE=starter-jobs-api \
  AUTH_ALLOW_INSECURE_ISSUER=true AUTH_ALLOWED_CLIENT_IDS=starter-web-local

pnpm --filter @starter/api... build
pnpm --filter @starter/api run db:prepare       # roles as the admin (db-bootstrap), then migrate as starter_migrator
pnpm --filter @starter/api start                # node dist/server.js as starter_app → http://127.0.0.1:8080
```

With `DYNAMODB_ENDPOINT` set the API creates the job-state table if it is missing
(local only; on AWS the table belongs to CDK). The first log lines include a
`LOCAL SIMULATION — not AWS Step Functions` warning.

### 4.3 Web

```bash
pnpm --filter @starter/web dev      # http://127.0.0.1:5173, proxies /v1 and /health → 127.0.0.1:8080
pnpm --filter @starter/web build && pnpm --filter @starter/web preview   # http://127.0.0.1:4173
```

`API_PROXY_TARGET` changes the dev/preview proxy target; `VITE_API_BASE_URL`
(build time) makes the SPA call another origin (then add that origin to the
API's `CORS_ALLOWED_ORIGINS`).

### 4.4 Quick scenario with curl

```bash
B=http://127.0.0.1:5173   # through the Vite proxy, like the browser (or :8080 directly)
# Every /v1 call needs a bearer token; the TEST ONLY IdP mints one (§13):
T=$(curl -s -X POST http://127.0.0.1:19400/test/token -H 'content-type: application/json' -d '{"sub":"alice"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')
alias curl='curl -H "authorization: Bearer $T"'

# Valid document → SUCCEEDED with results
curl -s -X POST $B/v1/jobs -H 'content-type: application/json' -H 'idempotency-key: demo-0001' \
  -d '{"title":"Notes","content":"Cloud migration is a journey. Every migration starts with discovery and planning!"}'
curl -s $B/v1/jobs/<jobId>          # PENDING → VALIDATING → PROCESSING → SUCCEEDED (+ result)

# Same key + same body → 200 with `Idempotent-Replayed: true`; same key + other body → 422

# Passes the API schema but violates a business rule → FAILED (JobValidationError)
curl -s -X POST $B/v1/jobs -H 'content-type: application/json' -d '{"title":"Short","content":"Far too short."}'

curl -s "$B/v1/jobs?limit=5"        # newest first, `nextCursor` for the next page
curl -s http://127.0.0.1:8080/openapi.json
```

## 5. Configuration reference

All variables are validated at start-up (`@starter/config`); invalid or missing
values stop the process with a list of variable names (never values). Empty
strings count as unset.

### API (`apps/api`, contract: `docs/contracts.md` §3)

| Variable                                     | Default               | Notes                                                                                                                                               |
| -------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                       | `8080`                | listens on `0.0.0.0`                                                                                                                                |
| `LOG_LEVEL`                                  | `info`                | `fatal`…`trace`, `silent`                                                                                                                           |
| `NODE_ENV`                                   | `production`          | `development` / `test` / `production`                                                                                                               |
| `DB_HOST`, `DB_NAME`, `DB_USER`              | —                     | required; `DB_USER` is the least-privilege role (`starter_app` for the API), never the admin (§11)                                                  |
| `DB_PORT`                                    | `5432`                |                                                                                                                                                     |
| `DB_AUTH`                                    | `password`            | `iam` (RDS IAM token per new connection; AWS) or `password` (only with `APP_RUNTIME` `local`/`ci`)                                                  |
| `DB_PASSWORD` / `DB_PASSWORD_FILE`           | —                     | exactly one with `DB_AUTH=password`; the file is re-read for every new connection (rotation without restart); forbidden with `iam`                  |
| `DB_SSL`                                     | `verify-full`         | `verify-full` (CA chain + host name against `DB_SSL_ROOT_CERT` only) or `disable` (only with `APP_RUNTIME` `local`/`ci`); no `require`              |
| `DB_SSL_ROOT_CERT`                           | —                     | PEM CA bundle; required with `verify-full` (image: `/app/certs/rds-global-bundle.pem`)                                                              |
| `DB_POOL_MAX`                                | `10`                  | optional extra (CDK sets `database.apiPoolMax`)                                                                                                     |
| `APP_RUNTIME`                                | `aws`                 | `aws`, `ci`, `local`; database relaxations (`disable`, `password`) only outside `aws`                                                               |
| `JOBS_TABLE_NAME`                            | —                     | DynamoDB job-state table                                                                                                                            |
| `DYNAMODB_ENDPOINT`                          | unset                 | local only (DynamoDB Local); dummy credentials are used when no AWS credentials are set                                                             |
| `AWS_REGION`                                 | —                     | required                                                                                                                                            |
| `WORKFLOW_MODE`                              | `stepfunctions`       | `local` = in-process simulation (development only)                                                                                                  |
| `STATE_MACHINE_ARN`                          | —                     | required when `WORKFLOW_MODE=stepfunctions`                                                                                                         |
| `CORS_ALLOWED_ORIGINS`                       | empty                 | comma-separated exact origins; empty = same-origin only (no CORS headers); `*` is rejected                                                          |
| `SHUTDOWN_TIMEOUT_MS`                        | `20000`               | hard ceiling for graceful shutdown (below ECS `stopTimeout` 30 s)                                                                                   |
| `APP_VERSION`, `APP_ENVIRONMENT`             | `unknown`, `NODE_ENV` | optional extras: `version` / `env` fields on every log line                                                                                         |
| `AUTH_*`, `RATE_LIMIT_*`, `TRUST_PROXY_HOPS` | see §13               | bearer authentication (required: `AUTH_ISSUER`, `AUTH_AUDIENCE`; `AUTH_ALLOWED_CLIENT_IDS` with `APP_RUNTIME=aws`), rate limits, trusted proxy hops |

The database CLIs need only `DB_*`/`APP_RUNTIME` plus optional `LOG_LEVEL` and `APP_*`:
`dist/migrate.js` (as `starter_migrator`; `MIGRATIONS_DIR`), `dist/db-bootstrap.js` (as the admin;
`DB_BOOTSTRAP_*`, §11) and `dist/retention.js` (as `starter_retention`; `RETENTION_*`, see
[ADR 0223](adr/0223-data-retention.md)).

### Lambdas (`functions/*`, contract: `docs/contracts.md` §4)

`JOBS_TABLE_NAME`, `AWS_REGION`, `LOG_LEVEL` (default `info`), optional
`DYNAMODB_ENDPOINT`, `APP_VERSION`, `APP_ENVIRONMENT`.

### Web (`apps/web`)

`VITE_API_BASE_URL` (build time, default relative `/v1`), `API_PROXY_TARGET`
(dev/preview proxy only, default `http://127.0.0.1:8080`).

## 6. Tests

| Command                        | Scope                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm -r test` (= `test:unit`) | pure logic, `fastify.inject` with fakes, Lambda handlers with the in-memory store, SPA with Testing Library + jsdom                                     |
| `pnpm -r test:integration`     | `@starter/job-state` (DynamoDB Local) and `@starter/api` (PostgreSQL 17 + DynamoDB Local, migrations, the built `dist/server.js` process incl. SIGTERM) |

`@starter/job-state` runs **one behavioural contract suite** against both the
in-memory twin (unit) and DynamoDB Local (integration), so the fake used in unit
tests cannot silently drift from the real adapter.

Integration infrastructure (`@starter/testing`) comes from environment variables when
they are set — GitLab CI jobs use `services:` and have no container socket —
otherwise Testcontainers starts containers locally:

| Variable                                                           | Default                                                | Meaning                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------- |
| `TEST_DB_HOST`                                                     | unset → start a container                              | admin connection; each suite creates and drops its own database  |
| `TEST_DB_PORT`, `TEST_DB_USER`, `TEST_DB_PASSWORD`, `TEST_DB_NAME` | `5432`, `postgres`, `postgres`, `postgres`             |                                                                  |
| `TEST_DYNAMODB_ENDPOINT`                                           | unset → start a container                              | e.g. `http://dynamodb-local:8000`; each suite uses its own table |
| `TEST_POSTGRES_IMAGE`                                              | `IMG_POSTGRES` (`postgres:17.11`, digest-pinned)       | container image override; the default is the CI service pin      |
| `TEST_DYNAMODB_IMAGE`                                              | `IMG_DYNAMODB` (`dynamodb-local:3.3.1`, digest-pinned) | container image override; the default is the CI service pin      |

Testcontainers on rootless Podman (macOS and Linux) needs:

```bash
eval "$(scripts/podman/rootless-socket.sh env)"   # incl. TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE (engine-side path)
export TESTCONTAINERS_RYUK_PRIVILEGED=true   # SELinux (podman machine, Fedora/RHEL) blocks the reaper's socket mount otherwise
# alternative: TESTCONTAINERS_RYUK_DISABLED=true (suites stop their own containers)
```

`pnpm --filter @starter/tests-integration test` checks these local-environment scripts themselves
(socket helper on both platforms, secrets location, hook installer) with stub tools — no engine needed.

The API integration suite spawns `dist/server.js`, so build first
(`pnpm --filter @starter/api... build`). Browser E2E suites live in `tests/e2e`.

## 7. Adding a new Lambda or service

1. Put the business rule/algorithm in `@starter/domain` (pure, unit-tested, no I/O).
2. Create `functions/<name>/` by copying `functions/validator`: `package.json`
   (`@starter/fn-<name>`, `build` = `tsc` + `scripts/bundle.mjs`), `src/step.ts`
   (logic taking `{ store, logger, now }`), `src/runtime.ts` (`createHandler`),
   `src/handler.ts` (env via `loadLambdaConfig`, clients created once, exports
   `handler`), `src/index.ts` (side-effect-free library entry).
3. Validate the event at the boundary (`parseExecutionInput` or a zod schema);
   throw errors whose `name` comes from `WorkflowError` in the spec; wrap AWS SDK
   failures with `asWorkflowError` so throttling becomes `TransientDependencyError`.
4. Add the state to `workflows/processing/src/spec.ts` (the shared workflow contract,
   see `docs/contracts.md` §2) and to the CDK definition; mirror it in
   `LocalWorkflowSimulator` if it should run locally.
5. Unit-test with `InMemoryJobStateStore` from `@starter/job-state` and fixtures from
   `@starter/testing`; add any new store behaviour to the shared contract suite.

A new HTTP service follows `apps/api`: `buildApp(deps)` for pure wiring, adapters
behind small interfaces, `server.ts` for process concerns (config, signals).

## 8. Contract versioning rules

- `@starter/contracts` is the source of truth. `CONTRACT_VERSION` follows SemVer and
  is echoed in every job (`contractVersion`) and the OpenAPI `info.version`.
- **Non-breaking (minor/patch):** new optional response fields, new endpoints,
  relaxed request validation, new problem `type`s. Clients must ignore unknown
  response fields (the SPA's zod parsing strips them).
- **Breaking (new major):** removing/renaming fields, tightening validation,
  new required request fields, changed semantics. Add `src/v2/`, export it as
  `v2`, serve it under `/v2/...` next to `/v1`, and keep `v1` until consumers
  migrate. The Lambdas reject execution inputs whose major they do not support.
- After any schema change run `pnpm --filter @starter/contracts run openapi:generate`
  and commit `openapi/v1.json`; the drift test fails otherwise.

## 9. Database migration rules

- Files: `apps/api/migrations/NNNN_slug.sql` (4-digit, lower-case slug). Never
  edit or delete an applied migration — the runner refuses checksum changes,
  missing files and versions that sort before the latest applied one.
- Each migration runs in its own transaction; add `-- migrate:no-transaction`
  for statements such as `CREATE INDEX CONCURRENTLY`. A no-transaction migration must contain
  exactly ONE statement (PostgreSQL runs a multi-statement string in an implicit transaction) and
  should be idempotent (`IF NOT EXISTS`; a failed `CONCURRENTLY` build leaves an invalid index
  to drop first). A session advisory lock serialises concurrent runners; `lock_timeout` is 10 s.
- Run migrations as a separate step before the new application version starts
  (`node dist/migrate.js`, e.g. a one-off ECS task), never from the API process.
- The runner connects as `starter_migrator` and runs `SET ROLE starter_owner` first: every object is
  owned by `starter_owner`. The roles come from the bootstrap (§11), which must have run.
- **Grants live in the migration that creates the object.** `starter_app` and the other runtime roles
  have column-level privileges, so a migration that adds a column also grants it to the roles that
  need it (`GRANT SELECT (<col>) ON jobs TO starter_app`); a new table gets its grants explicitly. The
  permission snapshot in `apps/api/test/integration/permissions.test.ts` fails on any unreviewed
  change. Never grant `content` to `starter_app` or any table privilege to `starter_processor`.
- Numbers follow the **merge order**: a branch that merges later
  renumbers its migrations after the latest one on `main`.
- **Expand / contract** for zero-downtime changes:
  1. _Expand_: add nullable columns / new tables / indexes (`IF NOT EXISTS`,
     `CONCURRENTLY` for large tables); deploy code that writes both shapes.
  2. Backfill in batches (a migration or a job), then switch reads.
  3. _Contract_: only after no running version needs the old shape, drop it in a
     later migration.
     Renames are expand (new column) + contract (drop old), never `RENAME COLUMN`
     while old code is live.
- Index caveat: `0002_jobs_listing_index.sql` uses a plain `CREATE INDEX` in a
  transaction, which blocks `INSERT INTO jobs` while it builds — harmless on a new, small
  table, but its "safe while the previous release runs" comment overstates it for large
  tables. Applied migrations are immutable, so the comment stays; **every future index
  migration on a populated table must use `CREATE INDEX CONCURRENTLY` with
  `-- migrate:no-transaction`.**

## 10. Observability conventions

- JSON logs on stdout: `level`, `time` (ISO), `service`, `version`, `env`, `msg`;
  API request lines carry `requestId` (incoming `X-Request-Id` if well-formed,
  echoed in the response); workflow lines carry `jobId` — the correlation id from
  API → Step Functions → Lambda.
- Never log secrets or document `content`; `@starter/observability` redacts common
  secret paths, auth headers and `content` fields.
- Errors returned to clients are RFC 9457 problems without internal details;
  the details go to the logs with the same `requestId`.

## 11. Database identities, TLS and retention

ADRs [0220](adr/0220-database-identities-and-bootstrap.md) (identities),
[0221](adr/0221-rds-iam-authentication-rotation-and-task-lifecycle.md) (IAM, rotation),
[0222](adr/0222-postgresql-tls-verify-full.md) (TLS), [0223](adr/0223-data-retention.md)
(retention); code in `@starter/db`.

| Identity            | Used by                                   | Can                                                                                    |
| ------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------- |
| admin               | `db-bootstrap` only (RDS master on AWS)   | everything                                                                             |
| `starter_owner`     | nobody logs in; owns every object         | DDL                                                                                    |
| `starter_migrator`  | `dist/migrate.js`                         | `SET ROLE starter_owner`, nothing on its own                                           |
| `starter_app`       | API                                       | `INSERT` + `SELECT` on every column except `content`                                   |
| `starter_processor` | Lambdas, local simulator                  | `SELECT * FROM load_job_document($1)`: one job, created within the last hour, unpurged |
| `starter_retention` | `dist/retention.js` (disabled by default) | find expired jobs, redact `title`/`content`                                            |

**Bootstrap.** `dist/db-bootstrap.js` converges roles, limits, memberships, database privileges and
ownership in one transaction. It is idempotent: rerun it after any change to the role model. Its
environment (`@starter/config` `loadDatabaseBootstrapConfig`):

| Variable                                                           | Meaning                                                                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `DB_*`                                                             | the admin connection; on AWS `DB_AUTH=secrets-manager` + `DB_SECRET_ARN` (master secret read at runtime) |
| `DB_BOOTSTRAP_LOGIN_AUTH`                                          | `iam` (RDS: `rds_iam`, no passwords) or `password` (local/CI)                                            |
| `DB_BOOTSTRAP_{MIGRATOR,APP,PROCESSOR,RETENTION}_PASSWORD`         | with `password`: printable ASCII, ≥ 16 characters; sent as SCRAM verifiers only                          |
| `DB_BOOTSTRAP_{MIGRATOR,APP,PROCESSOR,RETENTION}_CONNECTION_LIMIT` | optional; defaults 3 / 40 / 20 / 2                                                                       |

Local and CI: `apps/api/db/prepare-database.sh` (`pnpm --filter @starter/api run db:prepare`) runs the
bootstrap as `DB_ADMIN_USER`/`DB_ADMIN_PASSWORD` and then the migrations as `starter_migrator`.
`local/compose/bin/env.sh` and the CI variables provide everything it needs.

**Local compose.**

- `bin/dev-up.sh` creates the env file (§4.1, outside the repository) with one random password per role, the TLS material
  and the containers: `postgres-admin` → `db-bootstrap` → `migrate` → `api`.
- Legacy volumes, whose `starter_app` was the bootstrap superuser, are upgraded in place on
  the next `dev-up.sh app`. Existing `.env` values are kept, and the data stays.
- `local/compose/postgres/check-upgrade.sh` proves fresh and legacy volumes in an isolated copy.

**Tests that need PostgreSQL.**

| Command                                           | Where                          | What                                                                                                                           |
| ------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --filter @starter/api run test:integration` | CI (`integration:api`) + local | permission matrix of every identity, migrations as `starter_migrator` and upgrades, retention, CLI canaries                    |
| `pnpm --filter @starter/db run test:integration`  | CI (`integration:db`) + local  | `verify-full` through a TLS proxy (wrong CA, wrong host), rotation, credential canaries, bootstrap incl. a non-superuser admin |
| `pnpm --filter @starter/db run test:containers`   | local only (own containers)    | PostgreSQL's own TLS, the legacy bootstrap-superuser upgrade                                                                   |

The admin endpoint of `@starter/testing` (`TEST_DB_USER`) must be a superuser, so that the bootstrap can
run on each suite's database. Other packages get a ready database with the real roles from
`@starter/db/testing` `prepareRoleDatabase(admin, { migrationsDir })`.

## 12. Workflow data protection and the stale-job reconciler

**Claim check (ADR 0230).** The workflow input is `{ jobId, contractVersion, submittedAt }` only
(spec 2.0.0); the steps load the document by job id with `SELECT * FROM load_job_document($1)` as
`starter_processor` and store the analysis on the job-state item themselves. Nothing of the document
travels through Step Functions, step outputs or logs (`title` is redacted by default).

| Variable (API process, `WORKFLOW_MODE=local` only)     | Meaning                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `PROCESSOR_DB_USER`                                    | identity of the simulator's document reads (default `starter_processor`)     |
| `PROCESSOR_DB_PASSWORD` / `PROCESSOR_DB_PASSWORD_FILE` | its password (local/CI runtimes only); compose: `STARTER_PROCESSOR_PASSWORD` |
| `PROCESSOR_DB_AUTH`, `PROCESSOR_DB_POOL_MAX`           | optional; host, port, database and TLS come from the API's `DB_*`            |
| `RECONCILER_LOCAL_INTERVAL_SECONDS`                    | in-process reconciler every N s (default `0` = off; single API process only) |

| Variable (Lambdas)                                                                                                                                                              | Meaning                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER=starter_processor`                                                                                                                    | validator/processor document source (set by CDK)                  |
| `DB_AUTH=iam`, `DB_SSL=verify-full`, `DB_SSL_ROOT_CERT=/var/task/rds-global-bundle.pem`                                                                                         | RDS IAM token per connection; RDS CA bundle shipped in each asset |
| `JOB_AUDIT_TTL_DAYS`                                                                                                                                                            | STEP# audit retention in days; **unset = kept** (ADR 0233)        |
| `STATE_MACHINE_ARN`, `RECONCILER_STALE_AFTER_SECONDS` (≥ 660, default 900), `RECONCILER_BATCH_SIZE` (25), `RECONCILER_DRY_RUN` (`false`), `RECONCILER_MAX_RUNTIME_SECONDS` (45) | the scheduled reconciler (ADR 0231)                               |

Local loop, e.g. while testing failure paths: `RECONCILER_LOCAL_INTERVAL_SECONDS=60` in
the compose env file (§4.1; jobs are only reconciled once older than the threshold). Tests:
`pnpm --filter @starter/documents test:integration`, `pnpm --filter @starter/fn-reconciler test:integration`
(Testcontainers or CI services), plus the canary leakage tests in `apps/api` (unit and integration).
The local simulation and DynamoDB Local are not Step Functions/DynamoDB; the emulator layer and the
opt-in AWS suite (`tests/aws-integration`) cover the deployed shape ([testing.md](testing.md)).

## 13. Authentication and authorization (identity)

Every `/v1` request needs `Authorization: Bearer <access token>` from the configured OpenID Connect
issuer (ADRs 0210–0213). `/health/*` and `/openapi.json` stay public. There is no switch that turns
authentication off; locally a **TEST ONLY** identity provider issues real signed tokens.

### 13.1 The test identity provider

```bash
pnpm --filter @starter/tool-test-idp... build
APP_RUNTIME=local TEST_IDP_PORT=19400 TEST_IDP_ENABLE_TEST_ENDPOINTS=true \
  TEST_IDP_REDIRECT_URIS=http://127.0.0.1:5173/ node tools/test-idp/dist/server.js
```

- Users `alice`, `bob`, `mallory`; sign-in page at `/authorize` (code + PKCE S256), JWKS at
  `/jwks.json`, discovery at `/.well-known/openid-configuration`.
- `POST /test/token` with `{"sub":"alice","scope":"jobs:read","options":{"expiresInSeconds":-600}}`
  mints any token, including negative cases (options = `MintOptions` of `@starter/testing/auth`);
  `POST /test/rotate` rotates the signing key. Both exist only with
  `TEST_IDP_ENABLE_TEST_ENDPOINTS=true`.
- It refuses to start unless `APP_RUNTIME` is `local` or `ci`. Port 9400 belongs to the local
  compose stack (`local/compose/bin/dev-up.sh app` runs the IdP there); pick another port for an
  IdP of your own, as above.
- In tests use the in-process issuer instead: `startTestIssuer()` / `createTestIssuer()` from
  `@starter/testing` (HTTP JWKS server with request counters and an outage switch).

### 13.2 API configuration (`packages/config/src/auth.ts`)

| Variable                               | Default                    | Notes                                                                                                    |
| -------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `AUTH_ISSUER`                          | —                          | exact `iss`; https (parsed scheme) unless `AUTH_ALLOW_INSECURE_ISSUER=true` with `APP_RUNTIME=local\|ci` |
| `AUTH_AUDIENCE`                        | —                          | identifies the API; must not be one of `AUTH_ALLOWED_CLIENT_IDS` (e.g. the SPA client id)                |
| `AUTH_JWKS_URI`                        | discovery                  | override (same https rule); compose uses the in-network URL                                              |
| `AUTH_ALGORITHMS`                      | `RS256,ES256`              | asymmetric only; `none`/`HS*` fail at start-up                                                           |
| `AUTH_CLOCK_TOLERANCE_SECONDS`         | `30`                       | 0–120                                                                                                    |
| `AUTH_MAX_TOKEN_AGE_SECONDS`           | `3600`                     | 60–86400; tokens need `iat` and are accepted until min(`exp`, `iat` + this)                              |
| `AUTH_SCOPE_READ` / `AUTH_SCOPE_WRITE` | `jobs:read` / `jobs:write` | GET / POST                                                                                               |
| `AUTH_ALLOWED_CLIENT_IDS`              | — (required on AWS)        | `azp`/`client_id` allow-list (CDK: the SPA client); may be empty only with `APP_RUNTIME=local\|ci`       |
| `AUTH_ALLOW_INSECURE_ISSUER`           | `false`                    | local/CI only (`APP_RUNTIME=local\|ci`); never on AWS                                                    |
| `RATE_LIMIT_WINDOW_SECONDS`            | `60`                       | fixed window, per task                                                                                   |
| `RATE_LIMIT_READ_MAX` / `_WRITE_MAX`   | `120` / `20`               | per principal and window                                                                                 |
| `RATE_LIMIT_UNAUTHENTICATED_MAX`       | `30`                       | per client address (IPv6 /64), failed authentications only                                               |
| `TRUST_PROXY_HOPS`                     | `0`                        | nginx 1, CloudFront → ALB 2 (CDK)                                                                        |

Answers: 401 (one body for every token problem; reason in the audit log), 403 (scope), 404 (missing
**or another user's** job), 429 (`Retry-After`, `RateLimit-*`), 503 when the issuer keys cannot be
obtained. Each `/v1` request writes one `audit` log event (principal pseudonym, job ids, outcome;
`aborted` when the client disconnected before the response finished).

### 13.3 SPA sign-in

The SPA reads `/config.json` (`{"auth":{"issuer","clientId","scope"}}`): Vite dev/preview serve it
from `SPA_AUTH_ISSUER` / `SPA_AUTH_CLIENT_ID` / `SPA_AUTH_SCOPE` (defaults: `http://127.0.0.1:9400`,
`starter-web-local`, `openid jobs:read jobs:write`), compose's nginx renders it from the same
variables, and CloudFront answers it with a function on AWS. Example with the IdP of §13.1:

```bash
SPA_AUTH_ISSUER=http://127.0.0.1:19400 pnpm --filter @starter/web dev   # sign in as alice/bob/mallory
```

Tokens stay in memory (a reload means signing in again; the IdP session makes it a redirect).

### 13.4 Tests

- `apps/api`: unit (`fastify.inject`, static keys) and integration (`auth.test.ts`: real HTTP,
  PostgreSQL, DynamoDB Local, JWKS over HTTP; `proxy.test.ts`: the same assertions through the real
  nginx config via Testcontainers; `job-owner.test.ts`: migrations, grants, `SELECT content` → 42501).
- Black-box suites get tokens from the test IdP's `/test/token` (`TEST_IDP_URL`, default
  `http://127.0.0.1:9400`); smoke uses `SMOKE_ACCESS_TOKEN` or that endpoint.
- Playwright signs in through the IdP's sign-in page (`signIn(page, 'alice')`).
