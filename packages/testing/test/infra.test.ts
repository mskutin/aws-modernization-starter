import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DYNAMODB_IMAGE,
  DEFAULT_POSTGRES_IMAGE,
  aCreateJobRequest,
  anExecutionInput,
  dynamoDbFromEnv,
  postgresFromEnv,
  startDynamoDbLocal,
  startPostgres,
  steppingClock,
  uniqueTableName,
} from '../src/index.js';
import { CreateJobRequestSchema } from '@starter/contracts';

describe('default container images', () => {
  it('are the digest-pinned CI service images', () => {
    const images = readFileSync(
      join(import.meta.dirname, '../../../.gitlab/ci/images.yml'),
      'utf8',
    );
    const pin = (name: string) => new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, 'm').exec(images)?.[1];
    expect(DEFAULT_POSTGRES_IMAGE).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(DEFAULT_DYNAMODB_IMAGE).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(DEFAULT_POSTGRES_IMAGE).toBe(pin('IMG_POSTGRES'));
    expect(DEFAULT_DYNAMODB_IMAGE).toBe(pin('IMG_DYNAMODB'));
  });
});

describe('endpoint discovery from env (CI services)', () => {
  it('uses TEST_DB_* with sensible defaults', () => {
    expect(postgresFromEnv({ TEST_DB_HOST: 'postgres' })).toEqual({
      host: 'postgres',
      port: 5432,
      user: 'postgres',
      password: 'postgres',
      database: 'postgres',
    });
    expect(postgresFromEnv({})).toBeUndefined();
  });

  it('rejects malformed values', () => {
    expect(() => postgresFromEnv({ TEST_DB_HOST: 'h', TEST_DB_PORT: 'x' })).toThrow(/TEST_DB_PORT/);
    expect(() => dynamoDbFromEnv({ TEST_DYNAMODB_ENDPOINT: 'dynamodb:8000' })).toThrow(
      /http\(s\) URL/,
    );
  });

  it('does not start containers when endpoints are provided', async () => {
    const pg = await startPostgres({ TEST_DB_HOST: 'db', TEST_DB_PORT: '6543' });
    const ddb = await startDynamoDbLocal({ TEST_DYNAMODB_ENDPOINT: 'http://ddb:8000' });
    expect(pg).toMatchObject({ source: 'env', endpoint: { host: 'db', port: 6543 } });
    expect(ddb).toMatchObject({ source: 'env', endpoint: 'http://ddb:8000' });
  });
});

describe('fixtures', () => {
  it('builds requests that satisfy the API contract', () => {
    expect(CreateJobRequestSchema.parse(aCreateJobRequest())).toEqual(aCreateJobRequest());
  });

  it('builds unique execution inputs', () => {
    expect(anExecutionInput().jobId).not.toBe(anExecutionInput().jobId);
  });

  it('provides a stepping clock and unique table names', () => {
    const clock = steppingClock('2026-01-01T00:00:00.000Z', 1000);
    expect(clock().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(clock().toISOString()).toBe('2026-01-01T00:00:01.000Z');
    expect(uniqueTableName()).not.toBe(uniqueTableName());
  });
});
