/**
 * PostgreSQL identities of the workload (ADR 0220).
 * The names are fixed: CDK (`rds-db:connect` ARNs, `DB_USER`), the bootstrap, the migrations and
 * the permission tests all import them from here. Dependency-free on purpose
 * (`@starter/db/roles` is imported by the CDK app).
 *
 * | Role            | Login | Used by                              | Privileges                                                     |
 * | --------------- | ----- | ------------------------------------ | -------------------------------------------------------------- |
 * | admin / master  | yes   | one-off bootstrap task (break-glass) | everything; never in the API task or Lambdas                   |
 * | `starter_owner`     | no    | owns the schema objects              | DDL on the application schema                                  |
 * | `starter_migrator`  | yes   | migration task                       | `SET ROLE starter_owner` only (no inherited rights, no CREATEROLE) |
 * | `starter_app`       | yes   | API runtime                          | `SELECT, INSERT` on `jobs`                                     |
 * | `starter_processor` | yes   | validator/processor Lambdas          | column-level `SELECT` on `jobs` (see below)                    |
 * | `starter_retention` | yes   | retention job (disabled by default)  | column-level `SELECT`/`UPDATE` for the content purge           |
 */
export const DB_ROLES = {
  owner: 'starter_owner',
  migrator: 'starter_migrator',
  app: 'starter_app',
  processor: 'starter_processor',
  retention: 'starter_retention',
} as const;

export type DbRoleKey = keyof typeof DB_ROLES;
export type DbRoleName = (typeof DB_ROLES)[DbRoleKey];

/** Every role the bootstrap manages, in creation order. */
export const DB_MANAGED_ROLES: readonly DbRoleName[] = [
  DB_ROLES.owner,
  DB_ROLES.migrator,
  DB_ROLES.app,
  DB_ROLES.processor,
  DB_ROLES.retention,
];

/** Roles that log in (RDS IAM on AWS, passwords locally/CI). `starter_owner` is NOLOGIN. */
export const DB_LOGIN_ROLES = [
  DB_ROLES.migrator,
  DB_ROLES.app,
  DB_ROLES.processor,
  DB_ROLES.retention,
] as const;

export type DbLoginRole = (typeof DB_LOGIN_ROLES)[number];

export function isDbLoginRole(name: string): name is DbLoginRole {
  return (DB_LOGIN_ROLES as readonly string[]).includes(name);
}

/** Role the migration runner switches to (`SET ROLE`), so every object is owned by it. */
export const MIGRATION_OWNER_ROLE = DB_ROLES.owner;

/** Columns of `jobs` that `starter_processor` may read (`content_purged_at` from 0005). */
export const PROCESSOR_JOB_COLUMNS = [
  'id',
  'title',
  'content',
  'options',
  'content_sha256',
  'contract_version',
  'content_purged_at',
] as const;

/** Columns of `jobs` the retention job reads (to select candidates) and writes (to purge). */
export const RETENTION_JOB_COLUMNS = {
  select: ['id', 'created_at', 'content_purged_at'],
  update: ['title', 'content', 'content_purged_at'],
} as const;
