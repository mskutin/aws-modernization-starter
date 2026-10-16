/**
 * Suite configuration from environment variables (same names locally and in CI).
 *
 *   API_BASE_URL        API under test (default http://127.0.0.1:8080)
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSL[, DB_SSL_ROOT_CERT], APP_RUNTIME
 *                       PostgreSQL used by that API, as the API's own identity (starter_app), parsed
 *                       by @starter/db exactly like the API does (verify-full TLS locally) —
 *                       enables direct row assertions
 *   DYNAMODB_ENDPOINT, JOBS_TABLE_NAME, AWS_REGION
 *                       DynamoDB (Local) used by that API — enables state-item assertions
 *   IT_JOB_DEADLINE_MS  max time for a job to reach a terminal status (default 30000)
 *   IT_READY_DEADLINE_MS max time to wait for /health/ready in global setup (default 60000)
 *
 * In GitLab CI the stores are `services:` containers reachable by hostname (e.g. DB_HOST=postgres,
 * DYNAMODB_ENDPOINT=http://dynamodb-local:8000); locally `eval "$(local/compose/bin/env.sh)"`.
 */
import { loadDbConfig, type DatabaseConfig } from '@starter/db';

export interface DynamoConfig {
  endpoint: string | undefined;
  region: string;
  tableName: string;
}

const positive = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
};

export const config = {
  apiBaseUrl: process.env.API_BASE_URL ?? 'http://127.0.0.1:8080',
  jobDeadlineMs: positive('IT_JOB_DEADLINE_MS', 30_000),
  readyDeadlineMs: positive('IT_READY_DEADLINE_MS', 60_000),
};

/**
 * PostgreSQL settings, or a skip reason when not configured. A configured but invalid environment
 * (e.g. DB_SSL=disable outside APP_RUNTIME=local|ci) throws: it must never silently skip.
 */
export function pgConfig(): { config: DatabaseConfig } | { skip: string } {
  const { DB_HOST, DB_NAME, DB_USER } = process.env;
  if (!DB_HOST || !DB_NAME || !DB_USER) {
    return { skip: 'DB_HOST/DB_NAME/DB_USER not set — direct PostgreSQL assertions disabled' };
  }
  return { config: loadDbConfig(process.env) };
}

/** DynamoDB settings, or a skip reason when not configured. */
export function dynamoConfig(): { config: DynamoConfig } | { skip: string } {
  const { JOBS_TABLE_NAME, DYNAMODB_ENDPOINT, AWS_REGION } = process.env;
  if (!JOBS_TABLE_NAME) {
    return { skip: 'JOBS_TABLE_NAME not set — direct DynamoDB assertions disabled' };
  }
  if (!DYNAMODB_ENDPOINT) {
    // This suite targets local/CI stores only; refuse to read a real AWS table by accident.
    return { skip: 'DYNAMODB_ENDPOINT not set — direct DynamoDB assertions disabled (local only)' };
  }
  return {
    config: {
      endpoint: DYNAMODB_ENDPOINT,
      region: AWS_REGION ?? 'ap-southeast-1',
      tableName: JOBS_TABLE_NAME,
    },
  };
}
