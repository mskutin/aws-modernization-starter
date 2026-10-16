/**
 * PostgreSQL connection configuration (ADRs 0221/0222),
 * shared by the API, the database CLIs (migrate, db-bootstrap, retention) and the Lambdas
 * through `@starter/db`.
 *
 * | Variable           | Default       | Meaning                                                                     |
 * | ------------------ | ------------- | --------------------------------------------------------------------------- |
 * | `DB_HOST`          | —             | server host name (must match the certificate with `verify-full`)            |
 * | `DB_PORT`          | `5432`        |                                                                             |
 * | `DB_NAME`          | —             | database                                                                    |
 * | `DB_USER`          | —             | login role (`starter_app`, `starter_migrator`, ...)                         |
 * | `DB_AUTH`          | `password`    | `password` (not on `APP_RUNTIME=aws`), `iam` (RDS IAM token per connection) |
 * |                    |               | or `secrets-manager` (secret read per connection; bootstrap task only)      |
 * | `DB_PASSWORD`      | —             | with `password`: the password (exactly one of these two)                   |
 * | `DB_PASSWORD_FILE` | —             | with `password`: file re-read for every NEW connection (rotation)           |
 * | `DB_SECRET_ARN`    | —             | with `secrets-manager`: secret with `username`/`password` (RDS format)      |
 * | `DB_SSL`           | `verify-full` | `verify-full` (CA chain + host name) or `disable` (not on `APP_RUNTIME=aws`) |
 * | `DB_SSL_ROOT_CERT` | —             | PEM CA bundle, required with `verify-full`; the ONLY trusted CAs            |
 * | `DB_POOL_MAX`      | `10`          | pooled connections per process                                              |
 * | `AWS_REGION`       | —             | required with `iam` / `secrets-manager`                                     |
 * | `APP_RUNTIME`      | `aws`         | `aws`, `ci` or `local`; relaxations only outside `aws`                      |
 *
 * There is deliberately no `require`/`prefer` mode: they encrypt without verifying the server.
 * Credentials are wrapped in {@link SecretValue}, which never serialises.
 */
import { z } from 'zod';
import {
  LOCAL_ONLY_MESSAGE,
  allowsLocalRelaxations,
  appRuntime,
  type AppRuntime,
} from './runtime.js';
import {
  ConfigError,
  awsRegion,
  logLevel,
  nonEmpty,
  parseEnv,
  port,
  type Env,
  type LogLevel,
} from './shared.js';

export const DB_AUTH_MODES = ['password', 'iam', 'secrets-manager'] as const;
export type DbAuthMode = (typeof DB_AUTH_MODES)[number];
export const DB_SSL_MODES = ['disable', 'verify-full'] as const;
export type DbSslMode = (typeof DB_SSL_MODES)[number];

const REDACTED = '[REDACTED]';

/**
 * A credential that never serialises: `JSON.stringify`, `util.inspect`, template strings and
 * pino all render `[REDACTED]`. Call {@link SecretValue.reveal} only where the value is handed
 * to the driver.
 */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `SecretValue(${REDACTED})`;
  }
}

/** Lower-case unquoted PostgreSQL identifier: safe in SQL, IAM ARNs (`dbuser:<id>/<user>`) and logs. */
export const pgRoleName = z
  .string()
  .regex(
    /^[a-z_][a-z0-9_]{0,62}$/,
    'must be a lower-case PostgreSQL identifier ([a-z_][a-z0-9_]*, at most 63 characters)',
  );

const secretArn = z
  .string()
  .regex(
    /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/,
    'must be a Secrets Manager secret ARN',
  );

/** Plain object shape (no refinements), so other schemas can spread it. */
export const databaseEnvShape = {
  APP_RUNTIME: appRuntime,
  DB_HOST: nonEmpty,
  DB_PORT: port.default(5432),
  DB_NAME: nonEmpty,
  DB_USER: pgRoleName,
  DB_AUTH: z.enum(DB_AUTH_MODES).default('password'),
  DB_PASSWORD: z.string().min(1, 'must not be empty').optional(),
  DB_PASSWORD_FILE: z.string().trim().min(1, 'must not be empty').optional(),
  DB_SECRET_ARN: secretArn.optional(),
  DB_SSL: z
    .enum(DB_SSL_MODES, {
      error: () =>
        'must be "verify-full" (verifies the CA chain and host name) or "disable" (not on APP_RUNTIME=aws); ' +
        '"require"/"prefer" encrypt without verifying the server and are not accepted',
    })
    .default('verify-full'),
  DB_SSL_ROOT_CERT: z.string().trim().min(1, 'must not be empty').optional(),
  /** Optional extra: max pooled connections per process. */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** Needed for RDS IAM token signing and Secrets Manager; the API requires it anyway. */
  AWS_REGION: awsRegion.optional(),
};

type DatabaseEnvInput = {
  APP_RUNTIME: AppRuntime;
  DB_AUTH: DbAuthMode;
  DB_PASSWORD?: string | undefined;
  DB_PASSWORD_FILE?: string | undefined;
  DB_SECRET_ARN?: string | undefined;
  DB_SSL: DbSslMode;
  DB_SSL_ROOT_CERT?: string | undefined;
  AWS_REGION?: string | undefined;
};

function checkDatabaseEnv(
  env: DatabaseEnvInput,
  ctx: z.RefinementCtx,
  allowSecretsManager: boolean,
): void {
  const issue = (variable: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [variable], message });
  const strict = !allowsLocalRelaxations(env.APP_RUNTIME);

  // TLS -----------------------------------------------------------------------------------------
  if (env.DB_SSL === 'disable' && strict) {
    issue('DB_SSL', `"disable" ${LOCAL_ONLY_MESSAGE}; on AWS use "verify-full"`);
  }
  if (env.DB_SSL === 'verify-full' && !env.DB_SSL_ROOT_CERT) {
    issue('DB_SSL_ROOT_CERT', 'is required when DB_SSL=verify-full (PEM CA bundle path)');
  }
  if (env.DB_SSL === 'disable' && env.DB_SSL_ROOT_CERT) {
    issue('DB_SSL_ROOT_CERT', 'is only used with DB_SSL=verify-full');
  }

  // Credentials ---------------------------------------------------------------------------------
  const forbid = (variable: 'DB_PASSWORD' | 'DB_PASSWORD_FILE' | 'DB_SECRET_ARN') => {
    if (env[variable]) issue(variable, `must not be set when DB_AUTH=${env.DB_AUTH}`);
  };
  switch (env.DB_AUTH) {
    case 'password':
      if (strict) {
        issue(
          'DB_AUTH',
          `"password" ${LOCAL_ONLY_MESSAGE}; on AWS use "iam" (no long-lived database passwords in tasks or Lambdas)`,
        );
      }
      if (!env.DB_PASSWORD && !env.DB_PASSWORD_FILE) {
        issue('DB_PASSWORD', 'is required when DB_AUTH=password (or set DB_PASSWORD_FILE)');
      }
      if (env.DB_PASSWORD && env.DB_PASSWORD_FILE) {
        issue('DB_PASSWORD_FILE', 'must not be combined with DB_PASSWORD (set exactly one)');
      }
      forbid('DB_SECRET_ARN');
      break;
    case 'iam':
    case 'secrets-manager':
      if (env.DB_AUTH === 'secrets-manager' && !allowSecretsManager) {
        issue(
          'DB_AUTH',
          '"secrets-manager" is reserved for the one-off database bootstrap (dist/db-bootstrap.js); runtime identities use "iam"',
        );
      }
      forbid('DB_PASSWORD');
      forbid('DB_PASSWORD_FILE');
      if (env.DB_AUTH === 'iam') forbid('DB_SECRET_ARN');
      if (env.DB_AUTH === 'secrets-manager' && !env.DB_SECRET_ARN) {
        issue('DB_SECRET_ARN', 'is required when DB_AUTH=secrets-manager');
      }
      if (env.DB_SSL !== 'verify-full') {
        issue('DB_SSL', `must be "verify-full" when DB_AUTH=${env.DB_AUTH}`);
      }
      if (!env.AWS_REGION) {
        issue('AWS_REGION', `is required when DB_AUTH=${env.DB_AUTH}`);
      }
      break;
  }
}

/**
 * Cross-field rules of the DB_* contract for runtime identities (API, migrator, retention job,
 * Lambdas): `secrets-manager` is refused. Reusable from composed schemas.
 */
export function refineDatabaseEnv(env: DatabaseEnvInput, ctx: z.RefinementCtx): void {
  checkDatabaseEnv(env, ctx, false);
}

/** Same rules for the one-off bootstrap, which alone may read the master secret at runtime. */
export function refineBootstrapDatabaseEnv(env: DatabaseEnvInput, ctx: z.RefinementCtx): void {
  checkDatabaseEnv(env, ctx, true);
}

/** Variables the cross-field rules read. */
const DATABASE_RULE_INPUTS = [
  'APP_RUNTIME',
  'DB_AUTH',
  'DB_PASSWORD',
  'DB_PASSWORD_FILE',
  'DB_SECRET_ARN',
  'DB_SSL',
  'DB_SSL_ROOT_CERT',
  'AWS_REGION',
];

/**
 * Lets a refinement run even when unrelated variables are missing or invalid (so one start-up
 * reports every problem), but only once the variables it reads parsed cleanly.
 */
export function whenParsed(extra: readonly string[] = []) {
  const inputs = new Set([...DATABASE_RULE_INPUTS, ...extra]);
  return {
    when: (payload: { issues: readonly { path?: readonly PropertyKey[] }[] }) =>
      !payload.issues.some((issue) => inputs.has(String(issue.path?.[0]))),
  };
}

/** DB_* only (+ APP_RUNTIME, AWS_REGION). */
export const DatabaseEnvSchema = z
  .object(databaseEnvShape)
  .superRefine(refineDatabaseEnv, whenParsed());

export type DatabaseAuth =
  | { mode: 'password'; source: 'env'; password: SecretValue }
  | { mode: 'password'; source: 'file'; passwordFile: string }
  | { mode: 'iam'; region: string }
  | { mode: 'secrets-manager'; region: string; secretArn: string };

export type DatabaseTls = { mode: 'disable' } | { mode: 'verify-full'; rootCertPath: string };

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  auth: DatabaseAuth;
  ssl: DatabaseTls;
  poolMax: number;
}

type DatabaseEnv = z.output<typeof DatabaseEnvSchema>;

/** Maps validated DB_* variables (from any schema that spreads `databaseEnvShape`). */
export function toDatabaseConfig(e: DatabaseEnv): DatabaseConfig {
  let auth: DatabaseAuth;
  if (e.DB_AUTH === 'iam') {
    auth = { mode: 'iam', region: e.AWS_REGION ?? '' };
  } else if (e.DB_AUTH === 'secrets-manager') {
    auth = {
      mode: 'secrets-manager',
      region: e.AWS_REGION ?? '',
      secretArn: e.DB_SECRET_ARN ?? '',
    };
  } else if (e.DB_PASSWORD_FILE) {
    auth = { mode: 'password', source: 'file', passwordFile: e.DB_PASSWORD_FILE };
  } else {
    auth = { mode: 'password', source: 'env', password: new SecretValue(e.DB_PASSWORD ?? '') };
  }
  return {
    host: e.DB_HOST,
    port: e.DB_PORT,
    database: e.DB_NAME,
    user: e.DB_USER,
    auth,
    ssl:
      e.DB_SSL === 'verify-full'
        ? { mode: 'verify-full', rootCertPath: e.DB_SSL_ROOT_CERT ?? '' }
        : { mode: 'disable' },
    poolMax: e.DB_POOL_MAX,
  };
}

/** `DatabaseConfig` from the environment (contract name; also re-exported by `@starter/db`). */
export function loadDbConfig(env: Env = process.env): DatabaseConfig {
  return toDatabaseConfig(parseEnv('database', DatabaseEnvSchema, env));
}

/** Loggable view (contract `describeDbConfig`): never a password, token or file content. */
export function describeDbConfig(config: DatabaseConfig): Record<string, unknown> {
  const { auth, ssl } = config;
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    auth: auth.mode,
    ...(auth.mode === 'password' ? { passwordSource: auth.source } : {}),
    ...(auth.mode === 'iam' || auth.mode === 'secrets-manager' ? { region: auth.region } : {}),
    ...(auth.mode === 'secrets-manager' ? { secretArn: auth.secretArn } : {}),
    ssl: ssl.mode,
    ...(ssl.mode === 'verify-full' ? { sslRootCert: ssl.rootCertPath } : {}),
    poolMax: config.poolMax,
  };
}

export const DatabaseCliEnvSchema = z
  .object({
    ...databaseEnvShape,
    LOG_LEVEL: logLevel,
    APP_VERSION: z.string().max(128).default('unknown'),
    APP_ENVIRONMENT: z.string().max(64).optional(),
  })
  .superRefine(refineDatabaseEnv, whenParsed());

export interface DatabaseCliConfig {
  db: DatabaseConfig;
  runtime: AppRuntime;
  logLevel: LogLevel;
  appVersion: string;
  environment: string;
}

/** For the database CLIs (migrate, db-bootstrap, retention): DB_* plus LOG_LEVEL / APP_*. */
export function loadDatabaseConfig(env: Env = process.env): DatabaseCliConfig {
  const e = parseEnv('database', DatabaseCliEnvSchema, env);
  return {
    db: toDatabaseConfig(e),
    runtime: e.APP_RUNTIME,
    logLevel: e.LOG_LEVEL,
    appVersion: e.APP_VERSION,
    environment: e.APP_ENVIRONMENT ?? 'unknown',
  };
}

// ---------------------------------------------------------------------------------------------
// Second identity on the same database (e.g. the local simulator's starter_processor pool)

const IDENTITY_VARIABLES = ['DB_USER', 'DB_AUTH', 'DB_PASSWORD', 'DB_PASSWORD_FILE', 'DB_POOL_MAX'];

/**
 * Connection settings for another login role on the database `base` points at: host, port,
 * database, TLS and region come from `base`; `<prefix>DB_USER`, `<prefix>DB_AUTH` (default: the
 * base mode), `<prefix>DB_PASSWORD` / `<prefix>DB_PASSWORD_FILE` and `<prefix>DB_POOL_MAX` from
 * `env`. Same validation as `loadDbConfig`; errors name the prefixed variables.
 */
export function loadDbIdentityConfig(
  env: Env,
  prefix: string,
  base: DatabaseConfig,
): DatabaseConfig {
  if (!/^[A-Z][A-Z0-9_]*_$/.test(prefix)) {
    throw new Error(`identity prefix "${prefix}" must look like PROCESSOR_`);
  }
  const value = (name: string) => env[`${prefix}${name}`];
  const synthetic: Env = {
    APP_RUNTIME: env.APP_RUNTIME,
    AWS_REGION:
      base.auth.mode === 'iam' || base.auth.mode === 'secrets-manager'
        ? base.auth.region
        : env.AWS_REGION,
    DB_HOST: base.host,
    DB_PORT: String(base.port),
    DB_NAME: base.database,
    DB_SSL: base.ssl.mode,
    DB_SSL_ROOT_CERT: base.ssl.mode === 'verify-full' ? base.ssl.rootCertPath : undefined,
    DB_USER: value('DB_USER'),
    DB_AUTH: value('DB_AUTH') ?? (base.auth.mode === 'password' ? 'password' : 'iam'),
    DB_PASSWORD: value('DB_PASSWORD'),
    DB_PASSWORD_FILE: value('DB_PASSWORD_FILE'),
    DB_POOL_MAX: value('DB_POOL_MAX') ?? String(base.poolMax),
  };
  try {
    return loadDbConfig(synthetic);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new ConfigError(
      `database identity (${prefix}*)`,
      error.issues.map((i) => ({
        variable: IDENTITY_VARIABLES.includes(i.variable) ? `${prefix}${i.variable}` : i.variable,
        message: i.message,
      })),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Bootstrap CLI (dist/db-bootstrap.js, ADR 0220)

/** Env-name stem per login role (`DB_BOOTSTRAP_<STEM>_PASSWORD`, `..._CONNECTION_LIMIT`). */
export const DB_BOOTSTRAP_ROLE_STEMS = {
  starter_migrator: 'MIGRATOR',
  starter_app: 'APP',
  starter_processor: 'PROCESSOR',
  starter_retention: 'RETENTION',
} as const;
export type BootstrapLoginRole = keyof typeof DB_BOOTSTRAP_ROLE_STEMS;
const BOOTSTRAP_ROLES = Object.keys(DB_BOOTSTRAP_ROLE_STEMS) as BootstrapLoginRole[];

const connectionLimit = z.coerce.number().int().min(1).max(10_000);
const roleSecret = z.string().min(1, 'must not be empty').optional();

export const DatabaseBootstrapEnvSchema = z
  .object({
    ...databaseEnvShape,
    LOG_LEVEL: logLevel,
    APP_VERSION: z.string().max(128).default('unknown'),
    APP_ENVIRONMENT: z.string().max(64).optional(),
    /** How the login roles authenticate: `iam` (RDS) or `password` (not on APP_RUNTIME=aws). */
    DB_BOOTSTRAP_LOGIN_AUTH: z.enum(['iam', 'password']),
    DB_BOOTSTRAP_MIGRATOR_PASSWORD: roleSecret,
    DB_BOOTSTRAP_APP_PASSWORD: roleSecret,
    DB_BOOTSTRAP_PROCESSOR_PASSWORD: roleSecret,
    DB_BOOTSTRAP_RETENTION_PASSWORD: roleSecret,
    DB_BOOTSTRAP_MIGRATOR_CONNECTION_LIMIT: connectionLimit.optional(),
    DB_BOOTSTRAP_APP_CONNECTION_LIMIT: connectionLimit.optional(),
    DB_BOOTSTRAP_PROCESSOR_CONNECTION_LIMIT: connectionLimit.optional(),
    DB_BOOTSTRAP_RETENTION_CONNECTION_LIMIT: connectionLimit.optional(),
  })
  .superRefine(
    (env, ctx) => {
      refineBootstrapDatabaseEnv(env, ctx);
      const issue = (variable: string, message: string) =>
        ctx.addIssue({ code: 'custom', path: [variable], message });
      const password = (role: BootstrapLoginRole) =>
        env[`DB_BOOTSTRAP_${DB_BOOTSTRAP_ROLE_STEMS[role]}_PASSWORD`];
      if (env.DB_BOOTSTRAP_LOGIN_AUTH === 'password') {
        if (!allowsLocalRelaxations(env.APP_RUNTIME)) {
          issue('DB_BOOTSTRAP_LOGIN_AUTH', `"password" ${LOCAL_ONLY_MESSAGE}; on AWS use "iam"`);
        }
        for (const role of BOOTSTRAP_ROLES) {
          if (!password(role)) {
            issue(
              `DB_BOOTSTRAP_${DB_BOOTSTRAP_ROLE_STEMS[role]}_PASSWORD`,
              'is required when DB_BOOTSTRAP_LOGIN_AUTH=password',
            );
          }
        }
      } else {
        for (const role of BOOTSTRAP_ROLES) {
          if (password(role)) {
            issue(
              `DB_BOOTSTRAP_${DB_BOOTSTRAP_ROLE_STEMS[role]}_PASSWORD`,
              'must not be set when DB_BOOTSTRAP_LOGIN_AUTH=iam',
            );
          }
        }
      }
    },
    whenParsed([
      'DB_BOOTSTRAP_LOGIN_AUTH',
      ...Object.values(DB_BOOTSTRAP_ROLE_STEMS).map((stem) => `DB_BOOTSTRAP_${stem}_PASSWORD`),
    ]),
  );

export interface DatabaseBootstrapConfig extends DatabaseCliConfig {
  loginAuth: 'iam' | 'password';
  /** Present (one per login role) only with `password`. */
  passwords?: Record<BootstrapLoginRole, SecretValue>;
  connectionLimits: Partial<Record<BootstrapLoginRole, number>>;
}

export function loadDatabaseBootstrapConfig(env: Env = process.env): DatabaseBootstrapConfig {
  const e = parseEnv('database bootstrap', DatabaseBootstrapEnvSchema, env);
  const connectionLimits: Partial<Record<BootstrapLoginRole, number>> = {};
  for (const role of BOOTSTRAP_ROLES) {
    const limit = e[`DB_BOOTSTRAP_${DB_BOOTSTRAP_ROLE_STEMS[role]}_CONNECTION_LIMIT`];
    if (limit !== undefined) connectionLimits[role] = limit;
  }
  return {
    db: toDatabaseConfig(e),
    runtime: e.APP_RUNTIME,
    logLevel: e.LOG_LEVEL,
    appVersion: e.APP_VERSION,
    environment: e.APP_ENVIRONMENT ?? 'unknown',
    loginAuth: e.DB_BOOTSTRAP_LOGIN_AUTH,
    ...(e.DB_BOOTSTRAP_LOGIN_AUTH === 'password'
      ? {
          passwords: Object.fromEntries(
            BOOTSTRAP_ROLES.map((role) => [
              role,
              new SecretValue(e[`DB_BOOTSTRAP_${DB_BOOTSTRAP_ROLE_STEMS[role]}_PASSWORD`] ?? ''),
            ]),
          ) as Record<BootstrapLoginRole, SecretValue>,
        }
      : {}),
    connectionLimits,
  };
}

// ---------------------------------------------------------------------------------------------
// Retention job (dist/retention.js, ADR 0223)

export const RETENTION_MODES = ['disabled', 'dry-run', 'apply'] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];

export const RetentionEnvSchema = z
  .object({
    ...databaseEnvShape,
    LOG_LEVEL: logLevel,
    APP_VERSION: z.string().max(128).default('unknown'),
    APP_ENVIRONMENT: z.string().max(64).optional(),
    /** `disabled` (default: no approved policy) | `dry-run` (count only) | `apply` (purge). */
    RETENTION_MODE: z.enum(RETENTION_MODES).default('disabled'),
    /** Purge title + content of jobs created more than this many days ago. */
    RETENTION_CONTENT_DAYS: z.coerce.number().int().min(1).max(3650).optional(),
    /** Reference of the APPROVED retention policy (ticket/record id); required for `apply`. */
    RETENTION_APPROVAL_REF: z.string().trim().min(3).max(200).optional(),
    RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
    RETENTION_MAX_BATCHES: z.coerce.number().int().min(1).max(1000).default(50),
  })
  .superRefine(
    (env, ctx) => {
      refineDatabaseEnv(env, ctx);
      if (env.RETENTION_MODE !== 'disabled' && env.RETENTION_CONTENT_DAYS === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['RETENTION_CONTENT_DAYS'],
          message: `is required when RETENTION_MODE=${env.RETENTION_MODE}`,
        });
      }
      if (env.RETENTION_MODE === 'apply' && !env.RETENTION_APPROVAL_REF) {
        ctx.addIssue({
          code: 'custom',
          path: ['RETENTION_APPROVAL_REF'],
          message:
            'is required when RETENTION_MODE=apply (reference of the approved retention policy)',
        });
      }
    },
    whenParsed(['RETENTION_MODE', 'RETENTION_CONTENT_DAYS', 'RETENTION_APPROVAL_REF']),
  );

export type RetentionPolicy =
  | { mode: 'disabled' }
  | { mode: 'dry-run'; contentDays: number; batchSize: number; maxBatches: number }
  | {
      mode: 'apply';
      contentDays: number;
      approvalRef: string;
      batchSize: number;
      maxBatches: number;
    };

export interface RetentionConfig extends DatabaseCliConfig {
  policy: RetentionPolicy;
}

export function loadRetentionConfig(env: Env = process.env): RetentionConfig {
  const e = parseEnv('retention', RetentionEnvSchema, env);
  const common = { batchSize: e.RETENTION_BATCH_SIZE, maxBatches: e.RETENTION_MAX_BATCHES };
  const policy: RetentionPolicy =
    e.RETENTION_MODE === 'disabled'
      ? { mode: 'disabled' }
      : e.RETENTION_MODE === 'dry-run'
        ? { mode: 'dry-run', contentDays: e.RETENTION_CONTENT_DAYS ?? 0, ...common }
        : {
            mode: 'apply',
            contentDays: e.RETENTION_CONTENT_DAYS ?? 0,
            approvalRef: e.RETENTION_APPROVAL_REF ?? '',
            ...common,
          };
  return {
    db: toDatabaseConfig(e),
    runtime: e.APP_RUNTIME,
    logLevel: e.LOG_LEVEL,
    appVersion: e.APP_VERSION,
    environment: e.APP_ENVIRONMENT ?? 'unknown',
    policy,
  };
}
