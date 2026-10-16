# ADR 0221 — RDS IAM authentication for runtime identities; rotation and ECS task lifecycle

- Status: Accepted. IAM authentication of the runtime roles was validated once in a disposable
  sandbox deployment; Secrets Manager rotation and a governed environment were not.
- Related: ADR 0220,
  ADR 0511 (BASE-ECS-008/009)

## Context

The API task received the RDS master credentials as ECS secrets (`DB_USER`/`DB_PASSWORD`), and
rotation was off everywhere, because a rotated password would strand running tasks until a restart. The interface contract forbids long-lived database passwords in tasks and Lambdas on AWS.
Synth-time rules BASE-ECS-008/009 and BASE-LMB-007/008 enforce this. This decision adds the token lifecycle and
the connection budget.

Options for the runtime identities (`starter_app`, `starter_migrator`, `starter_processor`, `starter_retention`):

| Option                                   | Long-lived secret in the workload | Rotation story                                                                         | Moving parts                                          |
| ---------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Per-role Secrets Manager secrets via ECS | yes (injected at task start)      | rotation strands running tasks until restart                                           | one secret + rotation Lambda per role                 |
| Per-role secrets read at runtime         | yes (task can read it)            | works, but every task needs `GetSecretValue` + KMS                                     | as above, plus SDK calls on the connect path          |
| **RDS IAM authentication**               | **no**                            | **nothing to rotate in the database**; the role's IAM credentials rotate automatically | `rds-db:connect` per role, a token per new connection |

## Decision

1. **Runtime identities use RDS IAM authentication** (`DB_AUTH=iam`).
   - The bootstrap grants `rds_iam` and removes passwords (`PASSWORD NULL`).
   - Each task or function role gets `rds-db:connect` on exactly
     `arn:<partition>:rds-db:<region>:<account>:dbuser:<DbiResourceId>/<role>`
     (`RelationalDatabase.grantConnect`; the master user is refused).
   - `@starter/db` passes `pg` an async `password` callback. **A new token is signed for every new
     physical connection** (`@aws-sdk/rds-signer`), never once at start-up, so connections opened
     after the first 15 minutes still authenticate. Tested with a fake signer and the real
     signer offline.
2. **The master secret is used by exactly one one-off task**, `DatabaseBootstrapTask`.
   - It reads the secret when it opens its connection (`DB_AUTH=secrets-manager`, `DB_SECRET_ARN`;
     task role `secretsmanager:GetSecretValue` on that secret and `kms:Decrypt` via Secrets
     Manager). The value is never in the task definition.
   - Governed exception EXC-0005 (BASE-ECS-009) covers exactly that task definition. The API schema
     and the other CLIs reject `secrets-manager`.
3. **Hosted rotation of the master secret is on in every environment** (30 days). Because the only
   consumer reads the secret at connect time, rotation never strands a task. No suppression of AwsSolutions-SMG4 is needed, and the
   environment schema requires rotation.
4. **Connection budget**.
   - `CONNECTION LIMIT` per role, set by the bootstrap:
     - `starter_app` = 2 × `api.maxCapacity` × `database.apiPoolMax` (rolling deployments run up to
       200 % of the tasks);
     - `starter_processor`, `starter_migrator`, `starter_retention` from `database.connectionLimits`.
   - Pools recycle connections after 15 minutes (`maxLifetimeSeconds`).
   - Lambdas use `createPgPool(…, { max: 1, allowExitOnIdle: true })`. Reserved concurrency bounds
     `starter_processor` connections (2 functions × reserved concurrency ≤ the role limit). RDS Proxy (IAM
     auth to the proxy, pooled connections to the database) is the documented alternative if bursts
     outgrow this.
   - `classifyDbError` marks `53300`, `57P01-03`, `08xxx`, socket errors, `pg` connect/read timeouts
     and credential-service hiccups as transient, and everything else as permanent.

## Rotation behaviour and ECS task lifecycle

| Event                                       | Effect on running tasks / Lambdas                                                                                                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IAM token expiry (15 min after signing)     | None for established connections (a token only authenticates the connection start); new connections sign a new token.                                                                                |
| Task role credential refresh (ECS / Lambda) | Transparent: the SDK credential provider refreshes them; the next token uses the new credentials.                                                                                                    |
| `rds-db:connect` revoked / role dropped     | New connections fail immediately; existing ones live until recycled (≤ 15 min, `maxLifetimeSeconds`) or until an admin terminates them (`pg_terminate_backend`).                                     |
| Master secret rotation                      | Nothing runs with it; the next bootstrap run reads the current value.                                                                                                                                |
| Local/CI password rotation                  | `DB_PASSWORD`: restart. `DB_PASSWORD_FILE`: re-read for each new connection, so no restart is needed; old sessions keep working until recycled. Tested against real PostgreSQL (`rotation.test.ts`). |
| RDS CA rotation                             | Ship the new bundle in the image (`packages/db/certs`), then rotate the instance's CA (ADR 0222).                                                                                                    |

The "safely testable rotation strategy" of the brief is the per-connection credential hook. One
mechanism serves IAM tokens, Secrets Manager reads and the password file. Its behaviour (old sessions
keep working, new ones use the new credential, the old one is rejected, connections are recycled) is
proven locally with the file source. **AWS-managed rotation and IAM authentication were not
exercised.**

## Consequences

- No task definition or Lambda holds a database credential, except the governed bootstrap secret ARN.
  Synth rules and infra tests assert it.
- Each role needs `rds-db:connect` and network reachability: `grantConnect` + `allowFrom`. The
  workflow wires `starter_processor` the same way.
- Verify on the first AWS run: token acceptance (`rds_iam` membership via the bootstrap), the
  `DbiResourceId` in the policy, failover with the 15-minute recycling, the hosted-rotation Lambda's
  networking (Secrets Manager endpoint or egress) and the `GetSecretValue` path of the bootstrap.
