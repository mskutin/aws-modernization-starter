/**
 * Global setup of the security suite.
 *
 * SECTEST_MODE=self (`test:integration`, CI `integration:tests-security`): starts everything the
 * suite needs and nothing else.
 *   - PostgreSQL + DynamoDB Local: CI services (TEST_DB_* / TEST_DYNAMODB_ENDPOINT) or
 *     Testcontainers on rootless Podman; a fresh database and table per run.
 *   - Two TEST-ONLY issuers (`@starter/testing/auth`): the main one, and one reserved for JWKS
 *     rotation/outage tests; a control server exposes the test IdP contract for both.
 *   - The built API (`apps/api/dist/server.js`) as seven processes, all on the same stores:
 *       direct     TRUST_PROXY_HOPS=0, reached directly                  → target "direct"
 *       edge       TRUST_PROXY_HOPS=2, behind two XFF-appending proxies   → target "proxy"
 *                  (the CloudFront → ALB chain the CDK app configures)
 *       rl-direct / rl-edge   the same pair with low rate limits (rate-limit suite only)
 *       jwks       its own issuer, for rotation and IdP-outage tests
 *       sfn        WORKFLOW_MODE=stepfunctions against a capturing fake (execution input)
 *       gated      the same against its own fake that can hold StartExecution (client-disconnect
 *                  audit), with AUTH_MAX_TOKEN_AGE_SECONDS=600 (configured token age)
 * SECTEST_MODE=external (`test:security`): API_BASE_URL and/or WEB_BASE_URL, tokens from the test
 *   IdP (TEST_IDP_URL); store assertions when DB_* / DYNAMODB_ENDPOINT are set, or against the
 *   real DynamoDB of a deployed environment with SECTEST_DYNAMODB_AWS=true + JOBS_TABLE_NAME (the
 *   default credential chain, e.g. the operator's pinned AWS_PROFILE; read-only Scan). Files named
 *   in SECTEST_KNOWN_SECRET_FILES hold secrets that must never appear in responses or logs.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  createTestDatabase,
  startDynamoDbLocal,
  startPostgres,
  uniqueTableName,
  type PostgresEndpoint,
} from '@starter/testing';
import { startTestIssuer, type StartedTestIssuer } from '@starter/testing/auth';
import { WORKFLOW_SPEC_VERSION } from '@starter/workflow-processing';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import type { SecTestContext, Target } from '../context.js';
import { apiDist, apiDistIfPresent, runNode, startApi, type StartedApi } from './api-process.js';
import { startControl } from './control.js';
import { startFakeStepFunctions } from './fake-sfn.js';
import { harnessMutations } from './mutations.js';
import { repoRoot } from './paths.js';
import { startProxy, type StartedProxy } from './proxy.js';

export const AUDIENCE = 'starter-jobs-api';
export const SPA_CLIENT_ID = 'starter-web-local';
export const ALLOWED_ORIGIN = 'https://app.sectest.example';
export const RATE_LIMITS = { unauthenticatedMax: 5, readMax: 6, writeMax: 3, windowSeconds: 3600 };
/** The API's default AUTH_MAX_TOKEN_AGE_SECONDS (`@starter/config`), left unset on the main targets. */
export const DEFAULT_MAX_TOKEN_AGE_SECONDS = 3600;
/** AUTH_MAX_TOKEN_AGE_SECONDS of the `gated` API: proves a configured value is honoured. */
export const GATED_MAX_TOKEN_AGE_SECONDS = 600;
const STATE_MACHINE_ARN =
  'arn:aws:states:ap-southeast-1:000000000000:stateMachine:sectest-capture-only';

type Teardown = () => Promise<void>;

/** Mutation runs (harness/mutations.ts): misconfigurations that specific tests must catch. */
const MUTATIONS = harnessMutations();

async function waitReady(url: string): Promise<void> {
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(3_000) });
      if (res.status === 200) return;
    } catch {
      // not reachable yet
    }
    if (Date.now() > until) throw new Error(`${url}/health/ready did not answer 200 within 60 s`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function writeEvidence(dir: string, ctx: SecTestContext): void {
  // Secrets are never written; only where things ran.
  const { knownSecrets: _secrets, stores, ...rest } = ctx;
  writeFileSync(
    join(dir, 'context.json'),
    JSON.stringify(
      {
        ...rest,
        stores: {
          postgres: stores.postgres
            ? { host: stores.postgres.host, port: stores.postgres.port }
            : null,
          dynamodb: stores.dynamodb ?? null,
        },
      },
      null,
      2,
    ),
  );
}

type BaseContext = Pick<
  SecTestContext,
  'runId' | 'evidenceDir' | 'workflowSpecVersion' | 'requireAll'
>;

async function external(base: BaseContext): Promise<SecTestContext> {
  const env = process.env;
  const targets: Target[] = [];
  if (env['API_BASE_URL']) {
    targets.push({
      name: 'direct',
      baseUrl: env['API_BASE_URL'].replace(/\/$/, ''),
      description: `API ${env['API_BASE_URL']}`,
    });
  }
  if (env['WEB_BASE_URL']) {
    targets.push({
      name: 'proxy',
      baseUrl: env['WEB_BASE_URL'].replace(/\/$/, ''),
      description: `web proxy ${env['WEB_BASE_URL']}`,
    });
  }
  const idp = env['TEST_IDP_URL']?.replace(/\/$/, '');
  if (targets.length === 0 || !idp) {
    throw new Error(
      'SECTEST_MODE=external needs API_BASE_URL and/or WEB_BASE_URL and TEST_IDP_URL (the test IdP with TEST_IDP_ENABLE_TEST_ENDPOINTS=true)',
    );
  }
  await Promise.all(targets.map((t) => waitReady(t.baseUrl)));
  const discovery = (await (
    await fetch(`${idp}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5_000) })
  ).json()) as { issuer?: string };
  const pgReady =
    env['DB_HOST'] && env['DB_NAME'] && env['DB_USER'] && env['DB_PASSWORD'] !== undefined;
  const realDynamo = env['SECTEST_DYNAMODB_AWS'] === 'true';
  const secretFiles = (env['SECTEST_KNOWN_SECRET_FILES'] ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => readFileSync(f, 'utf8').trim());
  return {
    ...base,
    mode: 'external',
    targets,
    tokenEndpoint: `${idp}/test/token`,
    rotateEndpoint: `${idp}/test/rotate`,
    issuer: discovery.issuer ?? idp,
    audience: env['AUTH_AUDIENCE'] ?? AUDIENCE,
    allowedOrigin: env['SECTEST_ALLOWED_ORIGIN'] || undefined,
    rateLimit: undefined,
    jwks: undefined,
    stepFunctions: undefined,
    gated: undefined,
    maxTokenAgeSeconds: Number(
      env['SECTEST_MAX_TOKEN_AGE_SECONDS'] ?? DEFAULT_MAX_TOKEN_AGE_SECONDS,
    ),
    stores: {
      postgres: pgReady
        ? {
            host: env['DB_HOST'] ?? '',
            port: Number(env['DB_PORT'] ?? 5432),
            database: env['DB_NAME'] ?? '',
            user: env['DB_USER'] ?? '',
            password: env['DB_PASSWORD'] ?? '',
          }
        : undefined,
      dynamodb:
        env['JOBS_TABLE_NAME'] && (env['DYNAMODB_ENDPOINT'] || realDynamo)
          ? {
              ...(env['DYNAMODB_ENDPOINT'] ? { endpoint: env['DYNAMODB_ENDPOINT'] } : {}),
              region: env['AWS_REGION'] ?? 'ap-southeast-1',
              tableName: env['JOBS_TABLE_NAME'],
            }
          : undefined,
    },
    logFiles: (env['SECTEST_LOG_FILES'] ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean),
    knownSecrets: [env['DB_PASSWORD'], ...secretFiles].filter(
      (s): s is string => typeof s === 'string' && s.length >= 6,
    ),
  };
}

async function ensureApiRole(admin: PostgresEndpoint): Promise<void> {
  const client = new pg.Client(admin);
  await client.connect();
  try {
    // Migrations grant column privileges to the API role starter_app. Where the
    // database bootstrap has not created it (bare test server), create it NOLOGIN.
    await client.query(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'starter_app') THEN
          CREATE ROLE starter_app NOLOGIN;
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$`);
  } finally {
    await client.end();
  }
}

const DB_ENV_BASE = {
  DB_SSL: 'disable',
  DB_AUTH: 'password',
  LOG_LEVEL: 'debug',
  APP_RUNTIME: 'ci',
  NODE_ENV: 'production',
};

/**
 * Prepares the run's database the way CI does (ADR 0220): when the build ships the
 * role bootstrap (`dist/db-bootstrap.js`), roles get per-run passwords, migrations run as
 * starter_migrator and the API connects as starter_app (least privilege). Older builds migrate as the
 * admin and the API connects as the admin.
 */
async function prepareDatabase(
  admin: PostgresEndpoint,
  evidenceDir: string,
): Promise<{ env: Record<string, string>; secrets: string[] }> {
  const at = {
    DB_HOST: admin.host,
    DB_PORT: String(admin.port),
    DB_NAME: admin.database,
    ...DB_ENV_BASE,
  };
  const bootstrap = apiDistIfPresent('db-bootstrap.js');
  if (!bootstrap) {
    await ensureApiRole(admin);
    const env = { ...at, DB_USER: admin.user, DB_PASSWORD: admin.password };
    await runNode(apiDist('migrate.js'), ['up'], env, join(evidenceDir, 'migrate.log'));
    return { env, secrets: [admin.password] };
  }
  const pw = () => `sectest-${randomBytes(18).toString('base64url')}`;
  const passwords = { MIGRATOR: pw(), APP: pw(), PROCESSOR: pw(), RETENTION: pw() };
  await runNode(
    bootstrap,
    [],
    {
      ...at,
      DB_USER: admin.user,
      DB_PASSWORD: admin.password,
      DB_BOOTSTRAP_LOGIN_AUTH: 'password',
      ...Object.fromEntries(
        Object.entries(passwords).map(([role, value]) => [`DB_BOOTSTRAP_${role}_PASSWORD`, value]),
      ),
    },
    join(evidenceDir, 'db-bootstrap.log'),
  );
  await runNode(
    apiDist('migrate.js'),
    ['up'],
    { ...at, DB_USER: 'starter_migrator', DB_PASSWORD: passwords.MIGRATOR },
    join(evidenceDir, 'migrate.log'),
  );
  return {
    // The local workflow simulator inside the API reads documents as starter_processor
    // (load_job_document only; ADR 0230): PROCESSOR_DB_* next to the API's own DB_*.
    env: {
      ...at,
      DB_USER: 'starter_app',
      DB_PASSWORD: passwords.APP,
      PROCESSOR_DB_PASSWORD: passwords.PROCESSOR,
    },
    secrets: [admin.password, ...Object.values(passwords)],
  };
}

export default async function setup(project: TestProject): Promise<Teardown> {
  const runId = (process.env['SECTEST_RUN_ID'] ?? randomBytes(4).toString('hex')).toLowerCase();
  const evidenceDir = join(repoRoot(), 'reports', 'security', runId);
  mkdirSync(evidenceDir, { recursive: true });
  const base: BaseContext = {
    runId,
    evidenceDir,
    workflowSpecVersion: WORKFLOW_SPEC_VERSION,
    requireAll: process.env['SECTEST_REQUIRE_ALL'] === '1',
  };

  if (process.env['SECTEST_MODE'] === 'external') {
    const ctx = await external(base);
    writeEvidence(evidenceDir, ctx);
    project.provide('sectest', ctx);
    return async () => {};
  }

  const teardowns: Teardown[] = [];
  const teardown = async () => {
    for (const t of teardowns.reverse()) await t().catch(() => undefined);
  };
  try {
    // ── stores ──────────────────────────────────────────────────────────────────────────
    const [pgServer, ddb] = await Promise.all([startPostgres(), startDynamoDbLocal()]);
    teardowns.push(
      () => pgServer.stop(),
      () => ddb.stop(),
    );
    const db = await createTestDatabase(pgServer.endpoint, 'starter_sectest');
    teardowns.push(() => db.drop());
    const tableName = uniqueTableName('starter-sectest-jobs');
    const region = 'ap-southeast-1';
    // Registered before the APIs, so it runs after they stopped (teardowns run in reverse).
    teardowns.push(async () => {
      const client = new DynamoDBClient({
        region,
        endpoint: ddb.endpoint,
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      });
      await client.send(new DeleteTableCommand({ TableName: tableName })).catch(() => undefined);
      client.destroy();
    });
    const dbEnv = await prepareDatabase(db.endpoint, evidenceDir);
    const roleSecrets = dbEnv.secrets;

    // ── issuers, control server, fake Step Functions ─────────────────────────────────────
    const [issuer, jwksIssuer, sfn, gatedSfn] = await Promise.all([
      startTestIssuer({ audience: AUDIENCE }),
      startTestIssuer({ audience: AUDIENCE }),
      startFakeStepFunctions(),
      startFakeStepFunctions(),
    ]);
    teardowns.push(
      () => issuer.close(),
      () => jwksIssuer.close(),
      () => sfn.close(),
      () => gatedSfn.close(),
    );
    const control = await startControl({ '': issuer, '/jwks': jwksIssuer });
    teardowns.push(() => control.close());

    // ── API processes ─────────────────────────────────────────────────────────────────────
    const apiEnv = (i: StartedTestIssuer, extra: Record<string, string>) => ({
      ...dbEnv.env,
      JOBS_TABLE_NAME: tableName,
      DYNAMODB_ENDPOINT: ddb.endpoint,
      AWS_REGION: region,
      AWS_ACCESS_KEY_ID: 'local',
      AWS_SECRET_ACCESS_KEY: 'local',
      AWS_EC2_METADATA_DISABLED: 'true',
      WORKFLOW_MODE: 'local',
      CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      SHUTDOWN_TIMEOUT_MS: '5000',
      AUTH_ISSUER: i.issuer,
      AUTH_AUDIENCE: AUDIENCE,
      AUTH_ALLOW_INSECURE_ISSUER: 'true',
      AUTH_ALLOWED_CLIENT_IDS: MUTATIONS.has('no-client-allowlist') ? '' : SPA_CLIENT_ID,
      RATE_LIMIT_WINDOW_SECONDS: '60',
      RATE_LIMIT_READ_MAX: '100000',
      RATE_LIMIT_WRITE_MAX: '100000',
      RATE_LIMIT_UNAUTHENTICATED_MAX: '100000',
      TRUST_PROXY_HOPS: MUTATIONS.has('trust-xff') ? '10' : '0',
      ...extra,
      ...(MUTATIONS.has('long-token-age') ? { AUTH_MAX_TOKEN_AGE_SECONDS: '86400' } : {}),
    });
    const limited = {
      RATE_LIMIT_WINDOW_SECONDS: String(RATE_LIMITS.windowSeconds),
      RATE_LIMIT_READ_MAX: String(RATE_LIMITS.readMax),
      RATE_LIMIT_WRITE_MAX: String(RATE_LIMITS.writeMax),
      RATE_LIMIT_UNAUTHENTICATED_MAX: String(RATE_LIMITS.unauthenticatedMax),
    };
    // The first API creates the DynamoDB table (DYNAMODB_ENDPOINT set); start it alone.
    const direct = await startApi('direct', apiEnv(issuer, {}), evidenceDir);
    const apis: StartedApi[] = [direct];
    teardowns.push(() => Promise.all(apis.map((a) => a.stop())).then(() => undefined));
    const [edge, rlDirect, rlEdge, jwks, sfnApi, gatedApi] = await Promise.all([
      startApi('edge', apiEnv(issuer, { TRUST_PROXY_HOPS: '2' }), evidenceDir),
      startApi('rl-direct', apiEnv(issuer, limited), evidenceDir),
      startApi('rl-edge', apiEnv(issuer, { ...limited, TRUST_PROXY_HOPS: '2' }), evidenceDir),
      startApi('jwks', apiEnv(jwksIssuer, {}), evidenceDir),
      startApi(
        'sfn',
        apiEnv(issuer, {
          WORKFLOW_MODE: 'stepfunctions',
          STATE_MACHINE_ARN,
          AWS_ENDPOINT_URL_SFN: sfn.url,
        }),
        evidenceDir,
      ),
      startApi(
        'gated',
        apiEnv(issuer, {
          WORKFLOW_MODE: 'stepfunctions',
          STATE_MACHINE_ARN,
          AWS_ENDPOINT_URL_SFN: gatedSfn.url,
          AUTH_MAX_TOKEN_AGE_SECONDS: String(GATED_MAX_TOKEN_AGE_SECONDS),
        }),
        evidenceDir,
      ),
    ]);
    apis.push(edge, rlDirect, rlEdge, jwks, sfnApi, gatedApi);

    // ── CloudFront → ALB stand-ins (each appends X-Forwarded-For) ─────────────────────────
    const chain = async (name: string, api: StartedApi): Promise<StartedProxy> => {
      const alb = await startProxy(`${name}-alb`, api.url);
      const cf = await startProxy(`${name}-cloudfront`, alb.url);
      teardowns.push(
        () => cf.close(),
        () => alb.close(),
      );
      return cf;
    };
    const [edgeProxy, rlProxy] = await Promise.all([chain('edge', edge), chain('rl', rlEdge)]);

    const ctx: SecTestContext = {
      ...base,
      mode: 'self',
      targets: [
        { name: 'direct', baseUrl: direct.url, description: 'API directly (TRUST_PROXY_HOPS=0)' },
        {
          name: 'proxy',
          baseUrl: edgeProxy.url,
          description: 'API behind two XFF-appending proxies (TRUST_PROXY_HOPS=2)',
        },
      ],
      tokenEndpoint: `${control.url}/test/token`,
      rotateEndpoint: `${control.url}/test/rotate`,
      issuer: issuer.issuer,
      audience: AUDIENCE,
      allowedOrigin: ALLOWED_ORIGIN,
      rateLimit: {
        targets: [
          { name: 'direct', baseUrl: rlDirect.url, description: 'rate-limited API directly' },
          {
            name: 'proxy',
            baseUrl: rlProxy.url,
            description: 'rate-limited API behind the proxies',
          },
        ],
        ...RATE_LIMITS,
      },
      jwks: {
        target: { name: 'direct', baseUrl: jwks.url, description: 'API with its own issuer' },
        tokenEndpoint: `${control.url}/jwks/test/token`,
        rotateEndpoint: `${control.url}/jwks/test/rotate`,
        outageEndpoint: `${control.url}/jwks/test/outage`,
      },
      stepFunctions: {
        target: {
          name: 'direct',
          baseUrl: sfnApi.url,
          description: 'API with a fake Step Functions',
        },
        capturesUrl: sfn.capturesUrl,
      },
      gated: {
        target: {
          name: 'direct',
          baseUrl: gatedApi.url,
          description: 'API whose workflow start can be held',
        },
        controlUrl: gatedSfn.controlUrl,
        logFile: gatedApi.logFile,
        maxTokenAgeSeconds: GATED_MAX_TOKEN_AGE_SECONDS,
      },
      maxTokenAgeSeconds: DEFAULT_MAX_TOKEN_AGE_SECONDS,
      stores: {
        postgres: { ...db.endpoint },
        dynamodb: { endpoint: ddb.endpoint, region, tableName },
      },
      logFiles: apis.map((a) => a.logFile),
      knownSecrets: roleSecrets.filter((secret) => secret.length >= 6),
    };
    writeEvidence(evidenceDir, ctx);
    project.provide('sectest', ctx);
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
