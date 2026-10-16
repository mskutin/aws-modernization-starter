import { DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DEFAULT_SCOPES } from '@starter/contracts';
import { DB_ROLES, type DbLoginRole } from '@starter/db';
import { prepareRoleDatabase, type PgEndpoint, type PreparedDatabase } from '@starter/db/testing';
import { DynamoDbJobStateStore, createDynamoDbClients, ensureJobsTable } from '@starter/job-state';
import { createLogger, type Logger } from '@starter/observability';
import {
  createTestDatabase,
  startTestIssuer,
  uniqueTableName,
  type PostgresEndpoint,
  type StartedTestIssuer,
} from '@starter/testing';
import pg from 'pg';
import { inject } from 'vitest';
import type { AuthDeps } from '../../src/auth/hooks.js';
import { RemoteJwksSource, type RemoteJwksOptions } from '../../src/auth/key-source.js';
import { TokenVerifier } from '../../src/auth/verifier.js';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
export const silentLogger = () => createLogger({ service: 'api-it', level: 'silent' });

export interface MigratedDatabase {
  /** starter_app: the identity the API runs as. */
  endpoint: PostgresEndpoint;
  /** Admin (superuser) of the test database: assertions on catalogs only, never the API. */
  admin: PostgresEndpoint;
  /** Every login role on this database (real passwords set by the bootstrap). */
  roles: Record<DbLoginRole, PgEndpoint>;
  /** Pool as starter_app. */
  pool: pg.Pool;
  prepared: PreparedDatabase;
  drop(): Promise<void>;
}

/**
 * A fresh database with the REAL role model: bootstrap as the admin, migrations as starter_migrator
 * (SET ROLE starter_owner). Tests then act as starter_app exactly like the API does.
 */
export async function migratedDatabase(): Promise<MigratedDatabase> {
  const { postgres } = inject('integrationInfra');
  const db = await createTestDatabase(postgres);
  const prepared = await prepareRoleDatabase(db.endpoint, { migrationsDir: MIGRATIONS_DIR });
  const endpoint = prepared.roles[DB_ROLES.app];
  const pool = new pg.Pool({ ...endpoint, max: 5 });
  return {
    endpoint,
    admin: db.endpoint,
    roles: prepared.roles,
    pool,
    prepared,
    drop: async () => {
      await pool.end();
      await db.drop();
    },
  };
}

export async function jobStateTable() {
  const { dynamodbEndpoint } = inject('integrationInfra');
  const clients = createDynamoDbClients({ region: 'ap-southeast-1', endpoint: dynamodbEndpoint });
  const tableName = uniqueTableName();
  await ensureJobsTable(clients.client, tableName);
  return {
    tableName,
    endpoint: dynamodbEndpoint,
    clients,
    store: new DynamoDbJobStateStore({ client: clients.doc, tableName }),
    drop: async () => {
      await clients.client.send(new DeleteTableCommand({ TableName: tableName }));
      clients.destroy();
    },
  };
}

export const IT_AUDIENCE = 'starter-jobs-api';

export interface IntegrationAuth {
  /** TEST-ONLY issuer serving discovery + JWKS over HTTP on 127.0.0.1. */
  issuer: StartedTestIssuer;
  /** The API's remote JWKS cache (real HTTP fetches to `issuer`). */
  keys: RemoteJwksSource;
  auth: AuthDeps;
  close(): Promise<void>;
}

/**
 * Real authentication for integration tests: the API verifies tokens against the issuer's JWKS
 * fetched over HTTP (discovery included). Rate limits default to generous values; tests that
 * exercise them pass their own.
 */
export async function integrationAuth(
  options: {
    rateLimit?: Partial<AuthDeps['rateLimit']>;
    jwks?: Partial<Pick<RemoteJwksOptions, 'cooldownMs' | 'maxAgeMs' | 'timeoutMs' | 'now'>>;
    allowedClientIds?: string[];
    logger?: Logger;
  } = {},
): Promise<IntegrationAuth> {
  const issuer = await startTestIssuer({ audience: IT_AUDIENCE });
  const keys = new RemoteJwksSource({
    issuer: issuer.issuer,
    allowInsecure: true, // http://127.0.0.1 test issuer; refused in production by the config
    algorithms: ['RS256', 'ES256'],
    logger: options.logger ?? silentLogger(),
    ...options.jwks,
  });
  const auth: AuthDeps = {
    verifier: new TokenVerifier({
      issuer: issuer.issuer,
      audience: IT_AUDIENCE,
      algorithms: ['RS256', 'ES256'],
      clockToleranceSeconds: 30,
      keys,
      ...(options.allowedClientIds ? { allowedClientIds: options.allowedClientIds } : {}),
    }),
    scopes: { ...DEFAULT_SCOPES },
    rateLimit: {
      windowSeconds: 60,
      readMax: 10_000,
      writeMax: 10_000,
      unauthenticatedMax: 10_000,
      ...options.rateLimit,
    },
  };
  return { issuer, keys, auth, close: () => issuer.close() };
}

/** Runs `fn` with a dedicated client (connect/end handled). */
export async function withClient<T>(
  endpoint: PgEndpoint,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client(endpoint);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Workflow: a pool as `starter_processor` — no table grant, EXECUTE on `load_job_document` only
 * — the identity the local simulator and the Lambdas load documents with.
 */
export async function processorPool(db: MigratedDatabase): Promise<{
  pool: pg.Pool;
  /** Credentials for a spawned server (`PROCESSOR_DB_USER` / `PROCESSOR_DB_PASSWORD`). */
  user: string;
  password: string;
  drop(): Promise<void>;
}> {
  const endpoint = db.roles[DB_ROLES.processor];
  const pool = new pg.Pool({ ...endpoint, max: 2 });
  return { pool, user: endpoint.user, password: endpoint.password, drop: () => pool.end() };
}
