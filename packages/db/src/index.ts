/**
 * `@starter/db` — PostgreSQL access for the API, the database CLIs and the Lambdas
 * (ADRs 0220–0223).
 *
 * Contract surface: `loadDbConfig(env)`, `describeDbConfig(config)`, `createPgPool(config, logger)`.
 */
export {
  SecretValue,
  describeDbConfig,
  loadDatabaseBootstrapConfig,
  loadDatabaseConfig,
  loadDbConfig,
  loadDbIdentityConfig,
  loadRetentionConfig,
  type DatabaseAuth,
  type DatabaseBootstrapConfig,
  type DatabaseCliConfig,
  type DatabaseConfig,
  type DatabaseTls,
  type RetentionConfig,
  type RetentionPolicy,
} from '@starter/config';
export {
  BOOTSTRAP_SQL,
  BootstrapError,
  DEFAULT_CONNECTION_LIMITS,
  bootstrapDatabaseRoles,
  loginPasswords,
  type BootstrapOptions,
  type BootstrapResult,
  type LoginAuthMode,
  type MembershipState,
  type RoleState,
} from './bootstrap.js';
export {
  DatabaseCredentialError,
  passwordProvider,
  rdsIamToken,
  secretsManagerSecretString,
  type IamTokenGenerator,
  type PasswordProvider,
  type PasswordProviderOptions,
  type SecretStringFetcher,
} from './credentials.js';
export {
  SQLSTATE,
  classifyDbError,
  isAuthenticationFailure,
  isPermissionDenied,
  isTransientDbError,
  quoteIdent,
  quoteLiteral,
  sqlState,
  type DbErrorClass,
} from './errors.js';
export {
  MigrationError,
  assumeOwnerRole,
  checksumOf,
  loadMigrations,
  migrate,
  migrationStatus,
  plan,
  type Migration,
  type MigrationLogger,
  type MigrationPlan,
  type MigrationRunOptions,
} from './migrations.js';
export {
  DEFAULT_MAX_LIFETIME_SECONDS,
  createPgClient,
  createPgPool,
  pgClientConfig,
  type DbLogger,
  type PgConnectionOptions,
  type PgPoolOptions,
} from './pool.js';
export * from './roles.js';
export {
  PasswordPolicyError,
  SCRAM_ITERATIONS,
  assertScramCompatiblePassword,
  generatePassword,
  scramSha256Keys,
  scramSha256Verifier,
} from './scram.js';
export {
  DatabaseTlsError,
  RDS_CA_BUNDLE_FILENAME,
  loadCaBundle,
  pgTlsOptions,
  rdsCaBundlePath,
  type CaBundle,
} from './tls.js';
