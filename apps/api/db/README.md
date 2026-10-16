# `apps/api/db` — database identity tooling (ADR 0220)

| File                  | Purpose                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare-database.sh` | Local/CI only: role bootstrap as the admin (`dist/db-bootstrap.js`), then migrations as `starter_migrator` (`dist/migrate.js up`). Used by `tools/ci/scripts/api-lib.sh`. |

The role model itself (SQL and logic) lives in `@starter/db` (`packages/db/src/bootstrap.ts`), so the
API image, other packages' integration tests and the CLIs share one implementation; the object
grants are versioned in `apps/api/migrations/0003_role_privileges.sql` and later migrations.
