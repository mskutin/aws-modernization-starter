# ADR 0220 — Least-privilege database identities, a separate bootstrap and owner-run migrations

- Status: Accepted
- Related: ADR 0203 (plain SQL migrations), ADR 0221 (credentials), ADR 0223 (retention)

## Context

Originally the API, the migration task and the local stack all used one database superuser: the RDS
master on AWS and, locally, `starter_app`, which `POSTGRES_USER=starter_app` had made the cluster's
bootstrap superuser. Any SQL injection or compromised dependency in the API therefore had DDL, role
management and `pgaudit` control. The claim-check workflow change (ADR 0230) also gives the
Lambdas database access for the first time. A plain read grant would let one compromised Lambda
dependency read every document ever stored.

## Decision

1. **Fixed identities** (`@starter/db/roles`):

   | Role                | Login | Rights                                                                                                         |
   | ------------------- | ----- | -------------------------------------------------------------------------------------------------------------- |
   | admin / master      | yes   | everything; used only by the one-off bootstrap                                                                 |
   | `starter_owner`     | no    | owns the schema `public` and every object in it                                                                |
   | `starter_migrator`  | yes   | member of `starter_owner` **WITH INHERIT FALSE, SET TRUE**: no rights until it runs `SET ROLE starter_owner`   |
   | `starter_app`       | yes   | `INSERT` on `jobs`, column `SELECT` on every column except `content` (+ a marked transitional `content` grant) |
   | `starter_processor` | yes   | no table grant; `EXECUTE` on `load_job_document(uuid)` only                                                    |
   | `starter_retention` | yes   | column `SELECT (id, created_at, content_purged_at)`, `UPDATE (title, content, content_purged_at)`              |

   Every login role has a `CONNECTION LIMIT`. Runtime roles get per-database `statement_timeout` and
   `idle_in_transaction_session_timeout` defaults. Every login role's `search_path` is pinned to
   `public`. None has SUPERUSER, CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS.

2. **Environment-level bootstrap, separate from migrations.** `bootstrapDatabaseRoles()` in
   `@starter/db`, run by `dist/db-bootstrap.js` as the admin, converges roles, attributes, limits,
   memberships, database privileges, ownership and credentials. It runs as one PL/pgSQL block plus
   credential statements, in one transaction, under an advisory lock:
   - it alters only the attributes that differ, because a non-superuser admin such as the RDS master
     may not even name `SUPERUSER` in `ALTER ROLE`;
   - it aborts on any unexpected membership;
   - it revokes `CONNECT`/`TEMPORARY`/`CREATE` on the database and `USAGE`/`CREATE` on `public` from
     `PUBLIC`;
   - it moves the schema and every non-extension object in it to `starter_owner`;
   - it sets SCRAM verifiers computed client-side (never a cleartext password in SQL, server logs,
     `pg_stat_activity` or pgaudit), or `PASSWORD NULL` plus `rds_iam` on RDS.

   It is idempotent. It is TypeScript with embedded SQL rather than a `.sql` file, so the image, the
   tests of other packages (`@starter/db/testing`) and the CLI share one implementation without
   file-path resolution.

3. **Object grants are versioned in migrations.** `0003_role_privileges` (grants, default privileges
   without `PUBLIC` `EXECUTE`, `load_job_document`) and `0004_job_content_retention`. The runner
   connects as `starter_migrator` and runs `SET ROLE starter_owner` first, so every object is owned by
   `starter_owner`. A migration that adds a column grants it (column-level `SELECT` does not cover new
   columns).

4. **The processor reads one document at a time**.
   - `load_job_document(p_job_id uuid)` returns at most one row: `title, content, options,
content_sha256, contract_version, content_purged_at`.
   - It returns a row only for jobs created within the last **hour**. That is the execution timeout
     (600 s) plus margin for the start, retries and clock skew.
   - From 0004 it never returns a purged row.
   - It is `SECURITY DEFINER`, owned by `starter_owner`, with `search_path = pg_catalog, public, pg_temp`.
     `EXECUTE` is revoked from `PUBLIC` and granted only to `starter_processor`.
   - No row means missing, out of window or purged. The workflow treats that as a permanent,
     non-sensitive failure.

5. **Legacy local volumes are upgraded, not recreated.** PostgreSQL 16+ cannot demote the bootstrap
   superuser.
   - The bootstrap renames a managed role that is the bootstrap superuser (oid 10) to
     `<name>_legacy_bootstrap`, sets it NOLOGIN, removes its password, and replaces it with a fresh
     least-privilege role.
   - Compose creates the separate admin once from the legacy credentials (`postgres-admin`).
   - The data is kept. `local/compose/postgres/check-upgrade.sh` proves this end to end.

## Consequences

- Proven against real PostgreSQL 17 (apps/api and @starter/db integration, CI and local):
  - every identity's allowed operations work;
  - forbidden ones fail with 42501, and a statement that unexpectedly succeeds fails the test;
  - an exact grant snapshot catches any widening.
    Removing a grant restriction (mutation check) fails the permission tests.
- The `content` grant of `starter_app` in migration 0003 is transitional; migration 0005 revokes it,
  and a test applies exactly that `REVOKE`.
- The RDS-specific parts ran on RDS only once, in a disposable sandbox deployment: `rds_iam` membership, the master's CREATEROLE
  semantics, `ALTER SCHEMA public OWNER` by a `pg_database_owner` member. They are written for the
  documented RDS master capabilities and tested with a non-superuser CREATEROLE admin that owns the
  database, which approximates the RDS master.
- Operations: deploy order is bootstrap task → migration task → API; the bootstrap reruns after any
  role-model change. Break-glass: an operator with the master secret may `SET ROLE starter_owner`.
