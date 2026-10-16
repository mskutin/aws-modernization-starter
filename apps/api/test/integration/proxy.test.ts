/**
 * "The same rules apply through the web-facing proxy and directly against the API":
 * the identical assertion set runs against
 *   - direct : an API instance with TRUST_PROXY_HOPS=0, and
 *   - nginx  : the REAL web-tier config (local/compose/nginx/default.conf.template, the pinned
 *              nginx-unprivileged image of local compose — the CloudFront stand-in) in front of
 *              an API instance with TRUST_PROXY_HOPS=1.
 * Both instances share PostgreSQL, DynamoDB Local and the issuer (JWKS over HTTP).
 *
 * Needs a container runtime (Testcontainers on rootless Podman locally). In CI the integration
 * jobs use GitLab services and have no container socket, so this file is skipped there with that
 * reason; CI exercises the vite-preview proxy in the E2E job instead.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { JobListSchema, JobSchema, ProblemSchema, ProblemType } from '@starter/contracts';
import { aCreateJobRequestInput, bearer } from '@starter/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp, type App } from '../../src/app.js';
import { createLifecycle } from '../../src/health.js';
import { PgJobRepository } from '../../src/persistence/job-repository.js';
import { LocalWorkflowSimulator } from '../../src/workflow/local-simulator.js';
import { PgDocumentSource } from '@starter/documents';
import {
  integrationAuth,
  jobStateTable,
  migratedDatabase,
  processorPool,
  silentLogger,
  type IntegrationAuth,
} from './helpers.js';

const NGINX_IMAGE =
  'docker.io/nginxinc/nginx-unprivileged:1.30.5-alpine@sha256:56b8272e43a0525f67aed68d1e0794a712d10e3e45a563e118e9a77c817e6f86';
const TEMPLATE = fileURLToPath(
  new URL('../../../../local/compose/nginx/default.conf.template', import.meta.url),
);
const containers = inject('integrationInfra').sources.postgres === 'container';

interface Target {
  name: 'direct' | 'nginx';
  base: string;
}

interface Result {
  status: number;
  headers: Headers;
  text: string;
  body: unknown;
}

async function call(
  target: Target,
  method: string,
  path: string,
  opts: { authorization?: string; json?: unknown; headers?: Record<string, string> } = {},
): Promise<Result> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.authorization) headers.authorization = opts.authorization;
  if (opts.json !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${target.base}${path}`, {
    method,
    headers,
    body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: response.status, headers: response.headers, text, body };
}

function expectProblem(r: Result, status: number, type: string) {
  expect(r.status, r.text).toBe(status);
  const problem = ProblemSchema.parse(r.body);
  expect(problem.type).toBe(type);
  return problem;
}

type StartedNginx = { base: string; stop(): Promise<void> };

async function startNginx(upstreamPort: number, issuer: string): Promise<StartedNginx> {
  const { GenericContainer, Wait } = await import('testcontainers');
  const container = await new GenericContainer(NGINX_IMAGE)
    .withName(`starter-test-nginx-${randomUUID().slice(0, 8)}`)
    .withLabels({
      'starter.project': 'aws-modernization-starter',
      'starter.purpose': 'integration-test',
    })
    .withCopyFilesToContainer([
      { source: TEMPLATE, target: '/etc/nginx/templates/default.conf.template' },
    ])
    .withEnvironment({
      NGINX_ENTRYPOINT_LOCAL_RESOLVERS: '1',
      API_UPSTREAM: `http://host.containers.internal:${upstreamPort}`,
      SPA_AUTH_ISSUER: issuer,
      SPA_AUTH_CLIENT_ID: 'starter-web-local',
      SPA_AUTH_SCOPE: 'openid jobs:read jobs:write',
    })
    .withExposedPorts(8080)
    .withWaitStrategy(Wait.forHttp('/__nginx/health', 8080))
    .withStartupTimeout(120_000)
    .start();
  return {
    base: `http://${container.getHost()}:${container.getMappedPort(8080)}`,
    stop: async () => {
      await container.stop();
    },
  };
}

describe.skipIf(!containers)(
  `same rules directly and through the nginx web tier${containers ? '' : ' [SKIPPED: no container runtime (CI services mode)]'}`,
  () => {
    let db: Awaited<ReturnType<typeof migratedDatabase>>;
    let table: Awaited<ReturnType<typeof jobStateTable>>;
    let processor: Awaited<ReturnType<typeof processorPool>>;
    let simulator: LocalWorkflowSimulator;
    let open: IntegrationAuth;
    let strict: IntegrationAuth;
    const apps: App[] = [];
    const nginxes: StartedNginx[] = [];
    const targets: Record<'generous' | 'limited', Target[]> = { generous: [], limited: [] };

    async function api(identity: IntegrationAuth, hops: number): Promise<number> {
      const jobs = new PgJobRepository(db.pool);
      const app = await buildApp({
        logger: silentLogger(),
        jobs,
        state: table.store,
        workflow: simulator,
        lifecycle: createLifecycle(),
        auth: identity.auth,
        trustProxyHops: hops,
        corsAllowedOrigins: [],
        healthChecks: [],
      });
      // 0.0.0.0: the nginx container reaches the host through host.containers.internal.
      await app.listen({ host: hops > 0 ? '0.0.0.0' : '127.0.0.1', port: 0 });
      apps.push(app);
      return (app.server.address() as AddressInfo).port;
    }

    beforeAll(async () => {
      [db, table, open, strict] = await Promise.all([
        migratedDatabase(),
        jobStateTable(),
        integrationAuth(),
        integrationAuth({ rateLimit: { readMax: 4, writeMax: 10, unauthenticatedMax: 2 } }),
      ]);
      processor = await processorPool(db);
      simulator = new LocalWorkflowSimulator({
        store: table.store,
        documents: new PgDocumentSource(processor.pool),
        logger: silentLogger(),
        timeScale: 0.01,
      });
      for (const [kind, identity] of [
        ['generous', open],
        ['limited', strict],
      ] as const) {
        const direct = await api(identity, 0);
        const behindProxy = await api(identity, 1);
        const nginx = await startNginx(behindProxy, identity.issuer.issuer);
        nginxes.push(nginx);
        targets[kind].push(
          { name: 'direct', base: `http://127.0.0.1:${direct}` },
          { name: 'nginx', base: nginx.base },
        );
      }
    });

    afterAll(async () => {
      await Promise.allSettled(nginxes.map((n) => n.stop()));
      await Promise.allSettled(apps.map((a) => a.close()));
      await simulator?.drain(5_000);
      await processor?.drop();
      await Promise.allSettled([db?.drop(), table?.drop(), open?.close(), strict?.close()]);
    });

    const generous = () => targets.generous;
    const tokenFor = (sub: string) => open.issuer.mint({ sub });

    describe.each(['direct', 'nginx'] as const)('%s', (name) => {
      const target = () => generous().find((t) => t.name === name) as Target;

      it.each([
        ['POST', '/v1/jobs'],
        ['GET', '/v1/jobs'],
        ['GET', `/v1/jobs/${randomUUID()}`],
        ['GET', '/v1/unknown'],
      ])('anonymous %s %s → 401 with the Bearer challenge', async (method, path) => {
        const r = await call(
          target(),
          method,
          path,
          method === 'POST' ? { json: aCreateJobRequestInput() } : {},
        );
        expectProblem(r, 401, ProblemType.Unauthorized);
        expect(r.headers.get('www-authenticate')).toBe('Bearer realm="starter-api"');
      });

      it('an anonymous 512 KiB POST → 401 (authentication before the body)', async () => {
        const r = await call(target(), 'POST', '/v1/jobs', {
          json: { title: 'big', content: 'x'.repeat(512 * 1024) },
        });
        expectProblem(r, 401, ProblemType.Unauthorized);
      });

      it.each([
        ['expired', { expiresInSeconds: -600 }],
        ['wrong audience', { audience: 'another-api' }],
        ['wrong issuer', { issuer: 'https://evil.example' }],
        ['tampered signature', { tamperSignature: true }],
        ['alg none', { algNone: true }],
        ['HS256 with the public key', { hs256WithPublicKey: true }],
        ['foreign key', { foreignKey: true }],
        ['ID token', { audience: 'starter-web-local', nonce: 'n', typ: 'JWT' }],
      ])('%s token → 401 invalid_token', async (_n, options) => {
        const token = await open.issuer.mintWith(options);
        const r = await call(target(), 'GET', '/v1/jobs', { authorization: bearer(token) });
        expectProblem(r, 401, ProblemType.Unauthorized);
        expect(r.headers.get('www-authenticate')).toContain('error="invalid_token"');
      });

      it('a token without the API scope → 403 insufficient_scope', async () => {
        const token = await open.issuer.mintWith({ scope: 'profile' });
        const r = await call(target(), 'GET', '/v1/jobs', { authorization: bearer(token) });
        expectProblem(r, 403, ProblemType.Forbidden);
        expect(r.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
      });

      it("another principal's job: 404 like a missing one; never listed; owner sees it", async () => {
        const alice = bearer(await tokenFor(`${name}-alice`));
        const bob = bearer(await tokenFor(`${name}-bob`));
        const created = await call(target(), 'POST', '/v1/jobs', {
          authorization: alice,
          json: aCreateJobRequestInput({ title: `Proxy ${name} ${randomUUID()}` }),
        });
        expect(created.status).toBe(202);
        expect(created.headers.get('cache-control')).toBe('no-store');
        expect(created.headers.get('ratelimit-limit')).toBeTruthy();
        const { jobId, title } = JobSchema.parse(created.body);
        const foreign = await call(target(), 'GET', `/v1/jobs/${jobId}`, { authorization: bob });
        const missing = await call(target(), 'GET', `/v1/jobs/${randomUUID()}`, {
          authorization: bob,
        });
        const a = expectProblem(foreign, 404, ProblemType.NotFound);
        const b = expectProblem(missing, 404, ProblemType.NotFound);
        expect({ ...a, detail: '', instance: '', requestId: '' }).toEqual({
          ...b,
          detail: '',
          instance: '',
          requestId: '',
        });
        expect(foreign.text).not.toContain(title);
        const listed = JobListSchema.parse(
          (await call(target(), 'GET', '/v1/jobs?limit=100', { authorization: bob })).body,
        );
        expect(listed.items.map((i) => i.jobId)).not.toContain(jobId);
        const own = await call(target(), 'GET', `/v1/jobs/${jobId}`, { authorization: alice });
        expect(own.status).toBe(200);
        expect(own.headers.get('cache-control')).toBe('no-store');
      });

      it('the same Idempotency-Key from two principals creates two jobs', async () => {
        const key = `proxy-${randomUUID()}`;
        const body = aCreateJobRequestInput({ title: `Key ${key}` });
        const headers = { 'idempotency-key': key };
        const a = await call(target(), 'POST', '/v1/jobs', {
          authorization: bearer(await tokenFor(`${name}-k1`)),
          json: body,
          headers,
        });
        const b = await call(target(), 'POST', '/v1/jobs', {
          authorization: bearer(await tokenFor(`${name}-k2`)),
          json: body,
          headers,
        });
        expect([a.status, b.status]).toEqual([202, 202]);
        expect(b.headers.get('idempotent-replayed')).toBeNull();
        expect(JobSchema.parse(b.body).jobId).not.toBe(JobSchema.parse(a.body).jobId);
      });
    });

    describe.each(['direct', 'nginx'] as const)('rate limits (%s)', (name) => {
      const target = () => targets.limited.find((t) => t.name === name) as Target;

      it('request N+1 of a principal → 429 with Retry-After; others unaffected', async () => {
        const token = bearer(await strict.issuer.mint({ sub: `${name}-reader-${randomUUID()}` }));
        for (let i = 0; i < 4; i += 1) {
          expect((await call(target(), 'GET', '/v1/jobs', { authorization: token })).status).toBe(
            200,
          );
        }
        const limited = await call(target(), 'GET', '/v1/jobs', { authorization: token });
        expectProblem(limited, 429, ProblemType.TooManyRequests);
        expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
        const other = bearer(await strict.issuer.mint({ sub: `${name}-other-${randomUUID()}` }));
        expect((await call(target(), 'GET', '/v1/jobs', { authorization: other })).status).toBe(
          200,
        );
      });

      it('rotating X-Forwarded-For does not reset the failed-authentication budget', async () => {
        const statuses: number[] = [];
        for (let i = 0; i < 5; i += 1) {
          const r = await call(target(), 'GET', '/v1/jobs', {
            headers: { 'x-forwarded-for': `203.0.113.${i}, 198.51.100.${i}` },
          });
          statuses.push(r.status);
        }
        expect(statuses).toEqual([401, 401, 429, 429, 429]);
        // ...while a valid token from the same client still works.
        const token = bearer(await strict.issuer.mint({ sub: `${name}-valid-${randomUUID()}` }));
        expect((await call(target(), 'GET', '/v1/jobs', { authorization: token })).status).toBe(
          200,
        );
      });
    });

    it('nginx serves the SPA runtime configuration from its environment', async () => {
      const nginx = generous().find((t) => t.name === 'nginx') as Target;
      const r = await call(nginx, 'GET', '/config.json');
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.body).toEqual({
        auth: {
          issuer: open.issuer.issuer,
          clientId: 'starter-web-local',
          scope: 'openid jobs:read jobs:write',
        },
      });
    });
  },
);
