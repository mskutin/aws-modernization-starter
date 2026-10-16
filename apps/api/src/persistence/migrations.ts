/**
 * Versioned SQL migrations: the runner lives in `@starter/db` (shared with other packages' tests);
 * this module keeps the API's import path. See `packages/db/src/migrations.ts` and ADR 0203/0220.
 */
export {
  MigrationError,
  assumeOwnerRole,
  checksumOf,
  loadMigrations,
  migrate,
  migrationStatus,
  plan,
  type Migration,
  type MigrationPlan,
  type MigrationRunOptions,
} from '@starter/db';
