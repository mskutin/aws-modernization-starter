/**
 * Direct, read-only access to the API's backing stores for state assertions.
 * Each accessor is null when its store is not configured (tests then skip with the reason).
 */
import type pg from 'pg';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createPgPool } from '@starter/db';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  JobStateTable,
  idempotencyKey,
  jobStateKey,
  type WorkflowStatus,
} from '@starter/workflow-processing';
import { dynamoConfig, pgConfig } from './env.js';

export type Item = Record<string, unknown>;

const pgSettings = pgConfig();
const ddbSettings = dynamoConfig();

// CI sets REQUIRE_STORE_ASSERTIONS=1 so a missing store configuration fails the suite instead
// of silently skipping the direct state-layout assertions (like REQUIRE_CFN_GUARD for policies).
if (process.env.REQUIRE_STORE_ASSERTIONS === '1') {
  const missing = [pgSettings, ddbSettings].flatMap((s) => ('skip' in s ? [s.skip] : []));
  if (missing.length > 0) {
    throw new Error(`REQUIRE_STORE_ASSERTIONS=1 but: ${missing.join('; ')}`);
  }
}
export const pgSkipReason = 'skip' in pgSettings ? pgSettings.skip : null;
export const dynamoSkipReason = 'skip' in ddbSettings ? ddbSettings.skip : null;

let pool: pg.Pool | null = null;
/** Pool as the API's identity (starter_app), with the API's TLS and credential handling (@starter/db). */
export function pgPool(): pg.Pool {
  if ('skip' in pgSettings) throw new Error(pgSettings.skip);
  pool ??= createPgPool(
    pgSettings.config,
    { warn: () => undefined, debug: () => undefined },
    { applicationName: 'starter-tests-integration', max: 2, allowExitOnIdle: true },
  );
  return pool;
}

let doc: DynamoDBDocumentClient | null = null;
function ddb(): { client: DynamoDBDocumentClient; table: string } {
  if ('skip' in ddbSettings) throw new Error(ddbSettings.skip);
  doc ??= DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: ddbSettings.config.region,
      endpoint: ddbSettings.config.endpoint,
      // DynamoDB Local accepts any credentials; never real ones (endpoint is required above).
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'local',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
      },
      maxAttempts: 2,
    }),
  );
  return { client: doc, table: ddbSettings.config.tableName };
}

export async function closeStores(): Promise<void> {
  await pool?.end();
  pool = null;
  doc?.destroy();
  doc = null;
}

export async function getStateItem(jobId: string): Promise<Item | undefined> {
  const { client, table } = ddb();
  const r = await client.send(
    new GetCommand({ TableName: table, Key: jobStateKey(jobId), ConsistentRead: true }),
  );
  return r.Item;
}

export async function getIdempotencyItem(key: string): Promise<Item | undefined> {
  const { client, table } = ddb();
  const r = await client.send(
    new GetCommand({ TableName: table, Key: idempotencyKey(key), ConsistentRead: true }),
  );
  return r.Item;
}

/** Step audit trail items (sk begins with STEP#), in sort-key (time) order. */
export async function getStepItems(jobId: string): Promise<Item[]> {
  const { client, table } = ddb();
  const items: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await client.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :step)',
        ExpressionAttributeNames: {
          '#pk': JobStateTable.partitionKey,
          '#sk': JobStateTable.sortKey,
        },
        ExpressionAttributeValues: { ':pk': jobStateKey(jobId).pk, ':step': 'STEP#' },
        ConsistentRead: true,
        ExclusiveStartKey: start,
      }),
    );
    items.push(...(r.Items ?? []));
    start = r.LastEvaluatedKey;
  } while (start);
  return items;
}

/** gsi1 lookup: is `jobId` listed under STATUS#<status>? (GSIs are eventually consistent) */
export async function statusIndexContains(status: WorkflowStatus, jobId: string): Promise<boolean> {
  const { client, table } = ddb();
  const idx = JobStateTable.statusIndex;
  let start: Record<string, unknown> | undefined;
  do {
    const r = await client.send(
      new QueryCommand({
        TableName: table,
        IndexName: idx.name,
        KeyConditionExpression: '#pk = :pk',
        FilterExpression: '#jobId = :jobId',
        ExpressionAttributeNames: { '#pk': idx.partitionKey, '#jobId': 'jobId' },
        ExpressionAttributeValues: { ':pk': `STATUS#${status}`, ':jobId': jobId },
        ExclusiveStartKey: start,
      }),
    );
    if ((r.Items ?? []).length > 0) return true;
    start = r.LastEvaluatedKey;
  } while (start);
  return false;
}

/**
 * The PostgreSQL row for a job (system of record for job metadata), read as starter_app: every column
 * except `content`, which the API identity may not read.
 */
export async function getJobRow(jobId: string): Promise<Item | undefined> {
  const r = await pgPool().query(
    `SELECT id, owner_issuer, owner_subject, title, content_sha256, content_length, options,
            idempotency_key, request_fingerprint, contract_version, created_at
     FROM jobs WHERE id = $1`,
    [jobId],
  );
  return r.rows[0] as Item | undefined;
}

export async function countJobRowsForKey(key: string): Promise<number> {
  const r = await pgPool().query<{ n: string }>(
    'SELECT count(*)::text AS n FROM jobs WHERE idempotency_key = $1',
    [key],
  );
  return Number(r.rows[0]?.n ?? 0);
}
