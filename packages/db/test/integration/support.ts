import { randomBytes } from 'node:crypto';
import { createTestDatabase, type PostgresEndpoint } from '@starter/testing';
import pg from 'pg';
import { inject } from 'vitest';
import { quoteIdent, quoteLiteral } from '../../src/errors.js';
import { scramSha256Verifier } from '../../src/scram.js';

export const adminEndpoint = (): PostgresEndpoint => inject('postgresInfra').postgres;

export async function withClient<T>(
  endpoint: pg.ClientConfig,
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

/** A throw-away LOGIN role with CONNECT on `database`; `drop()` removes it. */
export async function temporaryRole(database: PostgresEndpoint, password: string) {
  const name = `starter_dbtest_${randomBytes(4).toString('hex')}`;
  await withClient(database, async (c) => {
    await c.query(
      `CREATE ROLE ${quoteIdent(name)} LOGIN PASSWORD ${quoteLiteral(scramSha256Verifier(password))}`,
    );
    await c.query(
      `GRANT CONNECT ON DATABASE ${quoteIdent(database.database)} TO ${quoteIdent(name)}`,
    );
  });
  return {
    name,
    setPassword: (next: string) =>
      withClient(database, (c) =>
        c.query(
          `ALTER ROLE ${quoteIdent(name)} PASSWORD ${quoteLiteral(scramSha256Verifier(next))}`,
        ),
      ),
    drop: () =>
      withClient(adminEndpoint(), async (c) => {
        await c.query(`DROP OWNED BY ${quoteIdent(name)} CASCADE`).catch(() => undefined);
        await c.query(`DROP ROLE IF EXISTS ${quoteIdent(name)}`);
      }),
  };
}

export { createTestDatabase };
