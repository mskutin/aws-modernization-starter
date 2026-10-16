/**
 * Integration-test helpers (`@starter/db/testing`): prepare a database with the REAL role model
 * (bootstrap) and the migrations, then connect as each identity. Used by `@starter/api` and by other
 * packages whose tests read the `jobs` table (e.g. `starter_processor` document loading).
 *
 *   const prepared = await prepareRoleDatabase(adminEndpointOfAnEmptyDatabase, { migrationsDir });
 *   const pool = new pg.Pool(prepared.roles.starter_app);
 *
 * Roles are cluster-wide; the passwords are derived from the admin endpoint, so every suite that
 * prepares a database on the same cluster converges to the same credentials.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { bootstrapDatabaseRoles, loginPasswords, type BootstrapResult } from './bootstrap.js';
import { loadMigrations, migrate, type MigrationLogger } from './migrations.js';
import { DB_LOGIN_ROLES, DB_ROLES, type DbLoginRole } from './roles.js';

/** Plain connection settings (the shape `@starter/testing` endpoints and `pg.ClientConfig` share). */
export interface PgEndpoint {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Deterministic test-only password of a login role on the admin's cluster. */
export function testRolePassword(admin: PgEndpoint, role: DbLoginRole): string {
  return createHash('sha256')
    .update(`starter-test-role|${admin.host}|${admin.port}|${admin.password}|${role}`)
    .digest('base64url');
}

export interface PreparedDatabase {
  admin: PgEndpoint;
  /** One endpoint per login role, same database. */
  roles: Record<DbLoginRole, PgEndpoint>;
  bootstrap: BootstrapResult;
  /** Migrations applied by `starter_migrator` (empty without `migrationsDir`). */
  migrations: string[];
}

const silent: MigrationLogger = { info: () => undefined };

/** Runs the bootstrap as the admin, then (optionally) the migrations as `starter_migrator`. */
export async function prepareRoleDatabase(
  admin: PgEndpoint,
  options: { migrationsDir?: string; logger?: MigrationLogger } = {},
): Promise<PreparedDatabase> {
  const passwords = Object.fromEntries(
    DB_LOGIN_ROLES.map((role) => [role, testRolePassword(admin, role)]),
  ) as Record<DbLoginRole, string>;
  const roles = Object.fromEntries(
    DB_LOGIN_ROLES.map((role) => [role, { ...admin, user: role, password: passwords[role] }]),
  ) as Record<DbLoginRole, PgEndpoint>;

  const adminClient = new pg.Client(admin);
  await adminClient.connect();
  let bootstrap: BootstrapResult;
  try {
    bootstrap = await bootstrapDatabaseRoles(adminClient, {
      loginAuth: 'password',
      passwords: loginPasswords(passwords),
    });
  } finally {
    await adminClient.end();
  }

  let applied: string[] = [];
  if (options.migrationsDir) {
    const migrator = new pg.Client(roles[DB_ROLES.migrator]);
    await migrator.connect();
    try {
      ({ applied } = await migrate(
        migrator,
        await loadMigrations(options.migrationsDir),
        options.logger ?? silent,
      ));
    } finally {
      await migrator.end();
    }
  }
  return { admin, roles, bootstrap, migrations: applied };
}
