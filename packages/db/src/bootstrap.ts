/**
 * Idempotent role / privilege bootstrap (ADR 0220). Run by the database ADMIN (RDS master on
 * AWS, a local superuser elsewhere) once per environment and whenever the role model changes,
 * BEFORE the migrations. Re-running converges to the same state; nothing is dropped.
 *
 * What it establishes (environment level; object grants are versioned in the migrations, 0003+):
 *
 * 1. Roles `starter_owner` (NOLOGIN) and the login roles `starter_migrator`, `starter_app`,
 *    `starter_processor`, `starter_retention`: all NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/
 *    NOBYPASSRLS, a CONNECTION LIMIT each, `search_path` pinned to `public`, and per-database
 *    `statement_timeout` / `idle_in_transaction_session_timeout` defaults for the runtime roles.
 *    Only differing attributes are altered: a non-superuser admin such as the RDS
 *    master may not even name SUPERUSER in ALTER ROLE.
 *    A managed name that is the cluster's bootstrap superuser (legacy local volumes initialised
 *    with POSTGRES_USER=starter_app; PostgreSQL 16+ cannot demote it) is renamed to
 *    `<name>_legacy_bootstrap`, locked (NOLOGIN, no password) and replaced by a fresh role.
 * 2. Memberships: exactly `starter_migrator` -> `starter_owner` WITH INHERIT FALSE, SET TRUE (the
 *    migrator has no rights until it runs SET ROLE starter_owner), plus `rds_iam` for the login roles
 *    when they use IAM authentication; any other membership aborts the bootstrap.
 * 3. Database: owned by the admin; PUBLIC loses CONNECT/TEMPORARY/CREATE; CONNECT only for the
 *    login roles.
 * 4. Schema `public` and every object in it owned by `starter_owner`; PUBLIC loses USAGE/CREATE;
 *    USAGE for the runtime roles.
 * 5. Login credentials: SCRAM verifiers computed client-side (password mode) or no password at
 *    all (IAM mode on RDS: `rds_iam` members cannot use passwords).
 *
 * Everything runs in ONE transaction under an advisory lock: a failure changes nothing.
 * Not validated on Amazon RDS (no AWS account in this sandbox): the steps follow the documented
 * RDS master capabilities (CREATEROLE + rds_superuser, owner of the database) and are tested
 * locally with a superuser AND with a non-superuser CREATEROLE admin that owns the database.
 */
import type pg from 'pg';
import { SecretValue } from '@starter/config';
import { quoteIdent, quoteLiteral, sqlState } from './errors.js';
import { DB_LOGIN_ROLES, DB_MANAGED_ROLES, type DbLoginRole } from './roles.js';
import { scramSha256Verifier } from './scram.js';

export type LoginAuthMode = 'iam' | 'password';

/**
 * Default CONNECTION LIMIT per login role. Size `starter_app` for API tasks × DB_POOL_MAX and
 * `starter_processor` for the reserved concurrency of the DB-connected Lambdas (pool max 1 each).
 */
export const DEFAULT_CONNECTION_LIMITS: Readonly<Record<DbLoginRole, number>> = {
  starter_migrator: 3,
  starter_app: 40,
  starter_processor: 20,
  starter_retention: 2,
};

export interface BootstrapOptions {
  /** `iam` (RDS: rds_iam membership, no passwords) or `password` (local, CI, tests). */
  loginAuth: LoginAuthMode;
  /** Required for `password`: one per login role. */
  passwords?: Readonly<Record<DbLoginRole, SecretValue | string>>;
  /** Overrides of {@link DEFAULT_CONNECTION_LIMITS}. */
  connectionLimits?: Readonly<Partial<Record<DbLoginRole, number>>>;
}

export interface RoleState {
  role: string;
  login: boolean;
  superuser: boolean;
  createRole: boolean;
  createDb: boolean;
  replication: boolean;
  bypassRls: boolean;
  connectionLimit: number;
}

export interface MembershipState {
  role: string;
  member: string;
  admin: boolean;
  inherit: boolean;
  set: boolean;
}

export interface BootstrapResult {
  /** Changes made in this run (only the credential summary when already converged). */
  changes: string[];
  /** Server warnings raised while converging (e.g. privileges that could not be revoked). */
  warnings: string[];
  roles: RoleState[];
  memberships: MembershipState[];
}

export class BootstrapError extends Error {
  override readonly name = 'BootstrapError';
}

/** Arbitrary constant identifying the bootstrap lock (migrations use 727001). */
const BOOTSTRAP_LOCK_KEY = 727_002;

/**
 * The convergent part, as one PL/pgSQL block. Role names are the fixed contract names; the two
 * parameters arrive as transaction-local settings (`starter_bootstrap.login_auth`,
 * `starter_bootstrap.connection_limits` as JSON), so the block can also be run from psql in an
 * emergency after `SET starter_bootstrap.login_auth = 'iam'` (limits default to unlimited then).
 */
export const BOOTSTRAP_SQL = String.raw`
DO $bootstrap$
DECLARE
  login_auth constant text := current_setting('starter_bootstrap.login_auth', true);
  limits constant jsonb := COALESCE(NULLIF(current_setting('starter_bootstrap.connection_limits', true), ''), '{}')::jsonb;
  admin constant text := current_user;
  admin_is_superuser constant boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
  db constant text := current_database();
  managed constant text[] := ARRAY['starter_owner', 'starter_migrator', 'starter_app', 'starter_processor', 'starter_retention'];
  login_roles constant text[] := ARRAY['starter_migrator', 'starter_app', 'starter_processor', 'starter_retention'];
  role_name text;
  should_login boolean;
  connection_limit integer;
  a record;
  m record;
  o record;
BEGIN
  IF login_auth IS NULL OR login_auth NOT IN ('iam', 'password') THEN
    RAISE EXCEPTION 'starter_bootstrap.login_auth must be "iam" or "password"';
  END IF;
  IF admin = ANY (managed) THEN
    RAISE EXCEPTION 'run the bootstrap as the database admin, not as the managed role %', admin;
  END IF;
  IF current_setting('server_version_num')::int < 160000 THEN
    RAISE EXCEPTION 'PostgreSQL 16 or later is required (role membership options)';
  END IF;
  IF login_auth = 'iam' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam') THEN
    RAISE EXCEPTION 'login_auth "iam" needs the rds_iam role (Amazon RDS); use "password" elsewhere';
  END IF;

  -- 1. Roles, attributes and per-role settings ---------------------------------------------------
  FOREACH role_name IN ARRAY managed LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name AND oid = 10) THEN
      EXECUTE format('ALTER ROLE %I RENAME TO %I', role_name, role_name || '_legacy_bootstrap');
      EXECUTE format('ALTER ROLE %I NOLOGIN PASSWORD NULL', role_name || '_legacy_bootstrap');
      RAISE NOTICE 'role %: was the cluster bootstrap superuser (cannot be demoted); renamed to %, NOLOGIN, password removed',
        role_name, role_name || '_legacy_bootstrap';
    END IF;
    should_login := role_name = ANY (login_roles);
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I %s', role_name, CASE WHEN should_login THEN 'LOGIN' ELSE 'NOLOGIN' END);
      RAISE NOTICE 'role %: created', role_name;
    END IF;
    SELECT * INTO a FROM pg_roles WHERE rolname = role_name;
    IF a.rolsuper THEN
      EXECUTE format('ALTER ROLE %I NOSUPERUSER', role_name);
      RAISE NOTICE 'role %: SUPERUSER removed', role_name;
    END IF;
    IF a.rolcreaterole THEN
      EXECUTE format('ALTER ROLE %I NOCREATEROLE', role_name);
      RAISE NOTICE 'role %: CREATEROLE removed', role_name;
    END IF;
    IF a.rolcreatedb THEN
      EXECUTE format('ALTER ROLE %I NOCREATEDB', role_name);
      RAISE NOTICE 'role %: CREATEDB removed', role_name;
    END IF;
    IF a.rolreplication THEN
      EXECUTE format('ALTER ROLE %I NOREPLICATION', role_name);
      RAISE NOTICE 'role %: REPLICATION removed', role_name;
    END IF;
    IF a.rolbypassrls THEN
      EXECUTE format('ALTER ROLE %I NOBYPASSRLS', role_name);
      RAISE NOTICE 'role %: BYPASSRLS removed', role_name;
    END IF;
    IF a.rolcanlogin IS DISTINCT FROM should_login THEN
      EXECUTE format('ALTER ROLE %I %s', role_name, CASE WHEN should_login THEN 'LOGIN' ELSE 'NOLOGIN' END);
      RAISE NOTICE 'role %: LOGIN set to %', role_name, should_login;
    END IF;
    IF should_login THEN
      connection_limit := COALESCE((limits ->> role_name)::integer, -1);
      IF a.rolconnlimit IS DISTINCT FROM connection_limit THEN
        EXECUTE format('ALTER ROLE %I CONNECTION LIMIT %s', role_name, connection_limit);
        RAISE NOTICE 'role %: CONNECTION LIMIT %', role_name, connection_limit;
      END IF;
      EXECUTE format('ALTER ROLE %I IN DATABASE %I SET search_path = public', role_name, db);
    END IF;
  END LOOP;
  -- Defaults a session may lower but that bound runaway statements and abandoned transactions.
  EXECUTE format('ALTER ROLE starter_app IN DATABASE %I SET statement_timeout = %L', db, '5s');
  EXECUTE format('ALTER ROLE starter_app IN DATABASE %I SET idle_in_transaction_session_timeout = %L', db, '30s');
  EXECUTE format('ALTER ROLE starter_processor IN DATABASE %I SET statement_timeout = %L', db, '5s');
  EXECUTE format('ALTER ROLE starter_processor IN DATABASE %I SET idle_in_transaction_session_timeout = %L', db, '30s');
  -- Frozen Lambda environments keep their pooled connection open; close idle processor sessions so
  -- they cannot exhaust the role's CONNECTION LIMIT. The pool reconnects.
  EXECUTE format('ALTER ROLE starter_processor IN DATABASE %I SET idle_session_timeout = %L', db, '60s');
  EXECUTE format('ALTER ROLE starter_retention IN DATABASE %I SET statement_timeout = %L', db, '60s');
  EXECUTE format('ALTER ROLE starter_retention IN DATABASE %I SET idle_in_transaction_session_timeout = %L', db, '60s');

  -- 2. A non-superuser admin (RDS master) acts as starter_owner only through SET ROLE --------------
  IF NOT admin_is_superuser AND NOT pg_has_role(admin, 'starter_owner', 'SET') THEN
    EXECUTE format('GRANT starter_owner TO %I WITH INHERIT FALSE, SET TRUE', admin);
    RAISE NOTICE 'admin %: may SET ROLE starter_owner (no inherited rights)', admin;
  END IF;

  -- 3. Memberships ------------------------------------------------------------------------------
  FOR m IN
    SELECT r.rolname AS granted, u.rolname AS member
    FROM pg_auth_members am
    JOIN pg_roles r ON r.oid = am.roleid
    JOIN pg_roles u ON u.oid = am.member
    WHERE u.rolname = ANY (managed) OR r.rolname = ANY (managed)
  LOOP
    CONTINUE WHEN m.member = admin;
    CONTINUE WHEN m.granted = 'starter_owner' AND m.member = 'starter_migrator';
    CONTINUE WHEN m.granted = 'rds_iam' AND login_auth = 'iam' AND m.member = ANY (login_roles);
    RAISE EXCEPTION 'unexpected role membership: % is a member of % (review, REVOKE it and re-run)',
      m.member, m.granted;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members am
    WHERE am.roleid = 'starter_owner'::regrole AND am.member = 'starter_migrator'::regrole
      AND am.set_option AND NOT am.inherit_option AND NOT am.admin_option
  ) THEN
    GRANT starter_owner TO starter_migrator WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
    RAISE NOTICE 'role starter_migrator: member of starter_owner with SET only';
  END IF;
  IF login_auth = 'iam' THEN
    FOREACH role_name IN ARRAY login_roles LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_auth_members am
        WHERE am.roleid = 'rds_iam'::regrole AND am.member = role_name::regrole
      ) THEN
        EXECUTE format('GRANT rds_iam TO %I', role_name);
        RAISE NOTICE 'role %: member of rds_iam (IAM authentication only)', role_name;
      END IF;
    END LOOP;
  END IF;

  -- 4. Database ---------------------------------------------------------------------------------
  IF (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = db) <> admin THEN
    EXECUTE format('ALTER DATABASE %I OWNER TO %I', db, admin);
    RAISE NOTICE 'database %: owner set to the admin %', db, admin;
  END IF;
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', db);
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM starter_owner, starter_migrator, starter_app, starter_processor, starter_retention', db);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO starter_migrator, starter_app, starter_processor, starter_retention', db);

  -- 5. Ownership of the application schema and its objects --------------------------------------
  IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') <> 'starter_owner' THEN
    ALTER SCHEMA public OWNER TO starter_owner;
    RAISE NOTICE 'schema public: owner set to starter_owner';
  END IF;
  FOR o IN
    SELECT c.relkind, format('%I.%I', n.nspname, c.relname) AS name, pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
      AND c.relowner <> 'starter_owner'::regrole
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
      AND NOT (c.relkind = 'S' AND EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
          AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')))
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO starter_owner',
      CASE o.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'f' THEN 'FOREIGN TABLE' WHEN 'c' THEN 'TYPE' ELSE 'TABLE' END,
      o.name);
    RAISE NOTICE '%: owner % -> starter_owner', o.name, o.owner;
  END LOOP;
  FOR o IN
    SELECT p.oid::regprocedure::text AS name, p.prokind, pg_get_userbyid(p.proowner) AS owner
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proowner <> 'starter_owner'::regrole
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO starter_owner',
      CASE o.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END, o.name);
    RAISE NOTICE '%: owner % -> starter_owner', o.name, o.owner;
  END LOOP;
  FOR o IN
    SELECT t.oid::regtype::text AS name, t.typtype, pg_get_userbyid(t.typowner) AS owner
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('d', 'e', 'r')
      AND t.typowner <> 'starter_owner'::regrole
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO starter_owner',
      CASE o.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, o.name);
    RAISE NOTICE '%: owner % -> starter_owner', o.name, o.owner;
  END LOOP;

  -- 6. Schema privileges, granted by the owner -------------------------------------------------
  SET LOCAL ROLE starter_owner;
  REVOKE ALL ON SCHEMA public FROM PUBLIC;
  REVOKE ALL ON SCHEMA public FROM starter_migrator, starter_app, starter_processor, starter_retention;
  GRANT USAGE ON SCHEMA public TO starter_app, starter_processor, starter_retention;
  RESET ROLE;
END
$bootstrap$;
`;

function passwordStatement(role: DbLoginRole, secret: SecretValue | string | undefined): string {
  if (secret === undefined) {
    throw new BootstrapError(`a password for ${role} is required when loginAuth is "password"`);
  }
  const value = typeof secret === 'string' ? secret : secret.reveal();
  // Only the verifier is sent; scramSha256Verifier validates the password without echoing it.
  return `ALTER ROLE ${quoteIdent(role)} PASSWORD ${quoteLiteral(scramSha256Verifier(value))}`;
}

function connectionLimits(options: BootstrapOptions): Record<DbLoginRole, number> {
  const limits = { ...DEFAULT_CONNECTION_LIMITS, ...options.connectionLimits };
  for (const role of DB_LOGIN_ROLES) {
    const limit = limits[role];
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new BootstrapError(`connection limit of ${role} must be an integer from 1 to 10000`);
    }
  }
  return limits;
}

async function currentState(
  client: pg.ClientBase,
): Promise<Pick<BootstrapResult, 'roles' | 'memberships'>> {
  const roles = await client.query<RoleState>(
    `SELECT rolname AS role, rolcanlogin AS login, rolsuper AS superuser,
            rolcreaterole AS "createRole", rolcreatedb AS "createDb",
            rolreplication AS replication, rolbypassrls AS "bypassRls",
            rolconnlimit AS "connectionLimit"
     FROM pg_roles WHERE rolname = ANY ($1) ORDER BY rolname`,
    [DB_MANAGED_ROLES],
  );
  const memberships = await client.query<MembershipState>(
    `SELECT r.rolname AS role, u.rolname AS member, am.admin_option AS admin,
            am.inherit_option AS inherit, am.set_option AS set
     FROM pg_auth_members am
     JOIN pg_roles r ON r.oid = am.roleid
     JOIN pg_roles u ON u.oid = am.member
     WHERE u.rolname = ANY ($1) OR r.rolname = ANY ($1)
     ORDER BY r.rolname, u.rolname`,
    [DB_MANAGED_ROLES],
  );
  return { roles: roles.rows, memberships: memberships.rows };
}

/**
 * Applies the role model on the database the client is connected to (as the admin). Error
 * messages carry PostgreSQL's message and SQLSTATE, never a statement or a credential.
 */
export async function bootstrapDatabaseRoles(
  client: pg.ClientBase,
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  const limits = connectionLimits(options);
  if (options.loginAuth === 'password') {
    for (const role of DB_LOGIN_ROLES) {
      // Validate all passwords before touching the database.
      passwordStatement(role, options.passwords?.[role]);
    }
  }
  const changes: string[] = [];
  const warnings: string[] = [];
  const onNotice = (notice: { message?: string; severity?: string }) => {
    if (!notice.message) return;
    (notice.severity === 'NOTICE' ? changes : warnings).push(notice.message);
  };
  client.on('notice', onNotice);
  let step = 'begin';
  try {
    await client.query('BEGIN');
    step = 'lock';
    await client.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_KEY]);
    await client.query(`SET LOCAL client_min_messages = notice`);
    await client.query(
      `SELECT set_config('starter_bootstrap.login_auth', $1, true),
              set_config('starter_bootstrap.connection_limits', $2, true)`,
      [options.loginAuth, JSON.stringify(limits)],
    );
    step = 'role model';
    await client.query(BOOTSTRAP_SQL);
    for (const role of DB_LOGIN_ROLES) {
      step = `credentials of ${role}`;
      await client.query(
        options.loginAuth === 'password'
          ? passwordStatement(role, options.passwords?.[role])
          : `ALTER ROLE ${quoteIdent(role)} PASSWORD NULL`,
      );
    }
    changes.push(
      options.loginAuth === 'password'
        ? `login roles: SCRAM-SHA-256 passwords set (${DB_LOGIN_ROLES.join(', ')})`
        : `login roles: no password, IAM authentication only (${DB_LOGIN_ROLES.join(', ')})`,
    );
    step = 'commit';
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const code = sqlState(error);
    // Credential statements: never repeat the server message (defence in depth).
    const credentials = step.startsWith('credentials');
    const detail = credentials
      ? `SQLSTATE ${code ?? 'n/a'}`
      : `${(error as Error).message}${code ? ` (SQLSTATE ${code})` : ''}`;
    throw new BootstrapError(
      `database bootstrap failed at "${step}": ${detail}`,
      credentials ? undefined : { cause: error },
    );
  } finally {
    client.off('notice', onNotice);
  }
  return { changes, warnings, ...(await currentState(client)) };
}

/** Convenience for configs that carry passwords as plain strings (tests, local tooling). */
export function loginPasswords(
  values: Readonly<Record<DbLoginRole, string>>,
): Record<DbLoginRole, SecretValue> {
  return Object.fromEntries(
    DB_LOGIN_ROLES.map((role) => [role, new SecretValue(values[role])]),
  ) as Record<DbLoginRole, SecretValue>;
}
