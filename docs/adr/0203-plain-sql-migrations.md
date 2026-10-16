# ADR 0203 — Plain `pg` with versioned SQL migrations (no ORM)

- Status: Accepted

## Context

The API stores one business table with a handful of queries. Migration tooling
must be reviewable, safe to run from a one-off ECS task and strict about
history.

## Decision

- Use `pg` with parameterised SQL in a single repository class; no ORM or query
  builder (fewer dependencies, SQL visible in review).
- `apps/api/migrations/NNNN_slug.sql`, applied by `dist/migrate.js` (also
  `status`). History in `schema_migrations` with SHA-256 checksums. The runner
  refuses modified, deleted or out-of-order migrations, serialises runners with
  a session advisory lock, sets `lock_timeout`, and runs each file in a
  transaction unless it opts out with `-- migrate:no-transaction`.
- Schema changes follow expand/contract (see `docs/development.md` §9).

## Consequences

- No generated types for rows: row shapes are mapped explicitly and covered by
  integration tests against PostgreSQL 17.
- Down-migrations are intentionally absent; roll forward with a new migration.
