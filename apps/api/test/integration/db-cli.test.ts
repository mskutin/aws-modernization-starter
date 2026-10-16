/**
 * The database CLIs as real processes (dist/db-bootstrap.js, dist/migrate.js, dist/retention.js)
 * against a real PostgreSQL. Canary credentials are pushed through success and failure paths;
 * stdout/stderr must never contain a password.
 * Requires `pnpm --filter @starter/api build` first.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DB_LOGIN_ROLES } from '@starter/db';
import { createTestDatabase, type PostgresEndpoint } from '@starter/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MIGRATIONS_DIR, withClient } from './helpers.js';

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
const stamp = Date.now().toString(36);
/** Valid SCRAM-compatible canary passwords, one per login role. */
const ROLE_CANARIES = Object.fromEntries(
  DB_LOGIN_ROLES.map((role) => [role, `canary-${role}-${stamp}-Zq9`]),
) as Record<(typeof DB_LOGIN_ROLES)[number], string>;
const WRONG_ADMIN_CANARY = `canary-wrong-admin-${stamp}-Xk2`;

function run(script: string, env: Record<string, string>, args: string[] = []) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [`${DIST}${script}`, ...args], {
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, output }));
  });
}

const dbEnv = (endpoint: PostgresEndpoint): Record<string, string> => ({
  APP_RUNTIME: 'ci',
  LOG_LEVEL: 'debug',
  DB_HOST: endpoint.host,
  DB_PORT: String(endpoint.port),
  DB_NAME: endpoint.database,
  DB_SSL: 'disable',
});

const bootstrapEnv = (endpoint: PostgresEndpoint, adminPassword: string) => ({
  ...dbEnv(endpoint),
  DB_USER: endpoint.user,
  DB_PASSWORD: adminPassword,
  DB_BOOTSTRAP_LOGIN_AUTH: 'password',
  DB_BOOTSTRAP_MIGRATOR_PASSWORD: ROLE_CANARIES.starter_migrator,
  DB_BOOTSTRAP_APP_PASSWORD: ROLE_CANARIES.starter_app,
  DB_BOOTSTRAP_PROCESSOR_PASSWORD: ROLE_CANARIES.starter_processor,
  DB_BOOTSTRAP_RETENTION_PASSWORD: ROLE_CANARIES.starter_retention,
});

function expectNoCanary(output: string) {
  for (const canary of [...Object.values(ROLE_CANARIES), WRONG_ADMIN_CANARY]) {
    expect(output).not.toContain(canary);
  }
  expect(output).not.toMatch(/SCRAM-SHA-256\$/); // not even the verifiers
}

describe('database CLIs (dist/*.js) never print credentials', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    for (const script of ['db-bootstrap.js', 'migrate.js', 'retention.js']) {
      if (!existsSync(`${DIST}${script}`)) throw new Error(`dist/${script} missing — build first`);
    }
    db = await createTestDatabase(inject('integrationInfra').postgres);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('db-bootstrap with a wrong admin password: exit 1, no credential in the output', async () => {
    const result = await run('db-bootstrap.js', bootstrapEnv(db.endpoint, WRONG_ADMIN_CANARY));
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/password authentication failed/);
    expectNoCanary(result.output);
  });

  it('db-bootstrap succeeds, reports changes and role state, and prints no credential', async () => {
    const result = await run('db-bootstrap.js', bootstrapEnv(db.endpoint, db.endpoint.password));
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('database bootstrap complete');
    expect(result.output).toContain('SCRAM-SHA-256 passwords set');
    expectNoCanary(result.output);
    expect(result.output).not.toContain(db.endpoint.password);
  });

  it('migrate as starter_migrator: applies, then a wrong password fails without leaking it', async () => {
    const ok = await run(
      'migrate.js',
      {
        ...dbEnv(db.endpoint),
        DB_USER: 'starter_migrator',
        DB_PASSWORD: ROLE_CANARIES.starter_migrator,
        MIGRATIONS_DIR,
      },
      ['up'],
    );
    expect(ok.code, ok.output).toBe(0);
    expect(ok.output).toContain('migrations complete');
    expectNoCanary(ok.output);

    const wrong = await run(
      'migrate.js',
      {
        ...dbEnv(db.endpoint),
        DB_USER: 'starter_migrator',
        DB_PASSWORD: WRONG_ADMIN_CANARY,
        MIGRATIONS_DIR,
      },
      ['up'],
    );
    expect(wrong.code).toBe(1);
    // JSON log line: the quotes around the user name are escaped.
    expect(wrong.output).toMatch(/password authentication failed for user \\"starter_migrator\\"/);
    expectNoCanary(wrong.output);
  });

  it('migrate as starter_app is refused: the API identity cannot change the schema', async () => {
    const result = await run(
      'migrate.js',
      {
        ...dbEnv(db.endpoint),
        DB_USER: 'starter_app',
        DB_PASSWORD: ROLE_CANARIES.starter_app,
        MIGRATIONS_DIR,
      },
      ['up'],
    );
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/cannot SET ROLE starter_owner/);
    expectNoCanary(result.output);
  });

  it('retention: disabled by default without touching the database; dry-run as starter_retention', async () => {
    // Disabled: even an unreachable database is fine, nothing is read.
    const disabled = await run('retention.js', {
      ...dbEnv({ ...db.endpoint, port: 1 }),
      DB_USER: 'starter_retention',
      DB_PASSWORD: ROLE_CANARIES.starter_retention,
    });
    expect(disabled.code).toBe(0);
    expect(disabled.output).toMatch(/retention is disabled: no approved retention policy/);
    expectNoCanary(disabled.output);

    const dryRun = await run('retention.js', {
      ...dbEnv(db.endpoint),
      DB_USER: 'starter_retention',
      DB_PASSWORD: ROLE_CANARIES.starter_retention,
      RETENTION_MODE: 'dry-run',
      RETENTION_CONTENT_DAYS: '90',
    });
    expect(dryRun.code, dryRun.output).toBe(0);
    expect(dryRun.output).toMatch(/retention dry run: no data was changed/);
    expectNoCanary(dryRun.output);

    const apply = await run('retention.js', {
      ...dbEnv(db.endpoint),
      DB_USER: 'starter_retention',
      DB_PASSWORD: ROLE_CANARIES.starter_retention,
      RETENTION_MODE: 'apply',
      RETENTION_CONTENT_DAYS: '90',
    });
    expect(apply.code).toBe(1);
    expect(apply.output).toContain('RETENTION_APPROVAL_REF: is required when RETENTION_MODE=apply');
  });

  it('the API identity is refused as a retention runner too (no UPDATE on jobs)', async () => {
    const result = await run('retention.js', {
      ...dbEnv(db.endpoint),
      DB_USER: 'starter_app',
      DB_PASSWORD: ROLE_CANARIES.starter_app,
      RETENTION_MODE: 'apply',
      RETENTION_CONTENT_DAYS: '1',
      RETENTION_APPROVAL_REF: 'RET-TEST-002',
    });
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/permission denied/);
    expectNoCanary(result.output);
    // Nothing was purged by the failed attempt.
    const purged = await withClient(
      db.endpoint,
      async (c) =>
        (
          await c.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM jobs WHERE content_purged_at IS NOT NULL',
          )
        ).rows[0]?.n,
    );
    expect(purged).toBe(0);
  });
});
