/**
 * Integration-test infrastructure: PostgreSQL 17 and DynamoDB Local.
 *
 * Endpoints come from environment variables when set (GitLab CI jobs use
 * `services:` and have no container socket), otherwise Testcontainers starts
 * them locally (Docker or rootless Podman via DOCKER_HOST).
 *
 *   TEST_DB_HOST, TEST_DB_PORT (5432), TEST_DB_USER (postgres),
 *   TEST_DB_PASSWORD (postgres), TEST_DB_NAME (postgres)   — admin connection
 *   TEST_DYNAMODB_ENDPOINT                                  — e.g. http://dynamodb-local:8000
 *   TEST_POSTGRES_IMAGE / TEST_DYNAMODB_IMAGE               — container image overrides
 *
 * Each suite gets its own database (`createTestDatabase`) and table name, so
 * suites never share state even on a shared CI service.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * Default images: the same tag-and-digest pins as the CI services (IMG_POSTGRES / IMG_DYNAMODB in
 * .gitlab/ci/images.yml) and the local compose stack; a test keeps them in step.
 */
export const DEFAULT_POSTGRES_IMAGE =
  'docker.io/library/postgres:17.11@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3';
export const DEFAULT_DYNAMODB_IMAGE =
  'docker.io/amazon/dynamodb-local:3.3.1@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab';

export interface PostgresEndpoint {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface StartedEndpoint<T> {
  endpoint: T;
  source: 'env' | 'container';
  stop(): Promise<void>;
}

type Env = Record<string, string | undefined>;

const suffix = () => randomBytes(4).toString('hex');

export function postgresFromEnv(env: Env = process.env): PostgresEndpoint | undefined {
  if (!env.TEST_DB_HOST) return undefined;
  const port = Number(env.TEST_DB_PORT ?? '5432');
  if (!Number.isInteger(port) || port <= 0) throw new Error('TEST_DB_PORT must be a port number');
  return {
    host: env.TEST_DB_HOST,
    port,
    user: env.TEST_DB_USER ?? 'postgres',
    password: env.TEST_DB_PASSWORD ?? 'postgres',
    database: env.TEST_DB_NAME ?? 'postgres',
  };
}

export function dynamoDbFromEnv(env: Env = process.env): string | undefined {
  const endpoint = env.TEST_DYNAMODB_ENDPOINT;
  if (!endpoint) return undefined;
  if (!/^https?:\/\//.test(endpoint))
    throw new Error('TEST_DYNAMODB_ENDPOINT must be an http(s) URL');
  return endpoint;
}

async function testcontainers() {
  try {
    return await import('testcontainers');
  } catch (error) {
    throw new Error(
      'No TEST_DB_HOST / TEST_DYNAMODB_ENDPOINT set and Testcontainers could not be loaded. ' +
        'Set the env vars (CI services) or provide a container runtime (DOCKER_HOST).',
      { cause: error },
    );
  }
}

export async function startPostgres(
  env: Env = process.env,
): Promise<StartedEndpoint<PostgresEndpoint>> {
  const fromEnv = postgresFromEnv(env);
  if (fromEnv) return { endpoint: fromEnv, source: 'env', stop: async () => {} };

  const { GenericContainer, Wait } = await testcontainers();
  const password = `pw_${suffix()}`;
  const container = await new GenericContainer(env.TEST_POSTGRES_IMAGE ?? DEFAULT_POSTGRES_IMAGE)
    .withName(`starter-test-postgres-${suffix()}`)
    .withLabels({
      'starter.project': 'aws-modernization-starter',
      'starter.purpose': 'integration-test',
    })
    .withEnvironment({
      POSTGRES_PASSWORD: password,
      POSTGRES_USER: 'postgres',
      POSTGRES_DB: 'postgres',
    })
    .withExposedPorts(5432)
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(120_000)
    .start();
  return {
    endpoint: {
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: 'postgres',
      password,
      database: 'postgres',
    },
    source: 'container',
    stop: async () => {
      await container.stop();
    },
  };
}

export async function startDynamoDbLocal(env: Env = process.env): Promise<StartedEndpoint<string>> {
  const fromEnv = dynamoDbFromEnv(env);
  if (fromEnv) return { endpoint: fromEnv, source: 'env', stop: async () => {} };

  const { GenericContainer, Wait } = await testcontainers();
  const container = await new GenericContainer(env.TEST_DYNAMODB_IMAGE ?? DEFAULT_DYNAMODB_IMAGE)
    .withName(`starter-test-dynamodb-${suffix()}`)
    .withLabels({
      'starter.project': 'aws-modernization-starter',
      'starter.purpose': 'integration-test',
    })
    .withCommand(['-jar', 'DynamoDBLocal.jar', '-inMemory', '-sharedDb'])
    .withExposedPorts(8000)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(120_000)
    .start();
  return {
    endpoint: `http://${container.getHost()}:${container.getMappedPort(8000)}`,
    source: 'container',
    stop: async () => {
      await container.stop();
    },
  };
}

/** Creates an isolated database on the admin endpoint; `drop()` removes it. */
export async function createTestDatabase(
  admin: PostgresEndpoint,
  prefix = 'starter_test',
): Promise<{ endpoint: PostgresEndpoint; drop(): Promise<void> }> {
  const name = `${prefix}_${suffix()}`.toLowerCase();
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`invalid database name ${name}`);
  const client = new pg.Client(admin);
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
  return {
    endpoint: { ...admin, database: name },
    drop: async () => {
      const dropper = new pg.Client(admin);
      await dropper.connect();
      try {
        await dropper.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}

/** Unique DynamoDB table name for one suite. */
export function uniqueTableName(prefix = 'starter-test-jobs'): string {
  return `${prefix}-${suffix()}`;
}
