/**
 * Fastify application factory. Pure wiring: all I/O arrives through `deps`,
 * so unit tests use fakes and `server.ts` supplies real adapters.
 */
import cors from '@fastify/cors';
import {
  AUTHORIZATION_HEADER,
  ProblemType,
  RATE_LIMIT_HEADERS,
  REQUEST_ID_HEADER,
  WWW_AUTHENTICATE_HEADER,
  buildOpenApiDocument,
} from '@starter/contracts';
import type { JobStateStore } from '@starter/job-state';
import { requestIdFrom, type Logger } from '@starter/observability';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { registerAuthentication, type AuthDeps } from './auth/hooks.js';
import type { HealthCheck, Lifecycle } from './health.js';
import type { JobRecordRepository } from './persistence/job-repository.js';
import {
  PROBLEM_CONTENT_TYPE,
  ProblemError,
  internalProblem,
  isDependencyUnavailable,
  serviceUnavailableProblem,
} from './problem.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerJobRoutes } from './routes/jobs.js';
import { JobService } from './services/job-service.js';
import type { WorkflowPort } from './workflow/port.js';

export interface AppDeps {
  logger: Logger;
  jobs: JobRecordRepository;
  state: JobStateStore;
  workflow: WorkflowPort;
  healthChecks: readonly HealthCheck[];
  lifecycle: Lifecycle;
  corsAllowedOrigins: readonly string[];
  /** Bearer authentication, scopes and rate limits of `/v1` (no way to turn it off). */
  auth: AuthDeps;
  /** Proxy hops trusted for X-Forwarded-For (TRUST_PROXY_HOPS); 0 = use the socket address. */
  trustProxyHops?: number;
  clock?: () => Date;
  newId?: () => string;
  readinessTimeoutMs?: number;
}

/**
 * `request.ip` (key of the failed-authentication rate limit) with TRUST_PROXY_HOPS = n: the
 * socket peer and the n-1 right-most X-Forwarded-For entries are trusted proxies, so the
 * client is the n-th entry from the right; client-supplied (left-most) entries are ignored.
 * Fastify fails closed for a bare number, hence the explicit function. Precondition: the API is
 * reachable only through those proxies (ECS: the task security group admits only the ALB).
 */
export function trustProxyHops(hops: number): false | ((address: string, hop: number) => boolean) {
  if (!Number.isInteger(hops) || hops <= 0) return false;
  return (_address, hop) => hop < hops;
}

/** Comfortably above the largest valid request (40k chars, JSON-escaped). */
export const BODY_LIMIT_BYTES = 512 * 1024;

function fastifyErrorToProblem(error: FastifyError): ProblemError | undefined {
  switch (error.code) {
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new ProblemError(
        415,
        ProblemType.UnsupportedMediaType,
        'Unsupported Media Type',
        'Send the request body as application/json.',
      );
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new ProblemError(
        413,
        ProblemType.PayloadTooLarge,
        'Content Too Large',
        `The request body exceeds ${BODY_LIMIT_BYTES} bytes.`,
      );
    default:
      if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
        return new ProblemError(
          error.statusCode,
          ProblemType.Validation,
          'Bad Request',
          error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
            error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
            error instanceof SyntaxError
            ? 'The request body is not valid JSON.'
            : error.message,
        );
      }
      return undefined;
  }
}

export async function buildApp(deps: AppDeps) {
  // Upcast so route modules can use the default FastifyInstance type.
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({
    loggerInstance,
    genReqId: (req) => requestIdFrom(req.headers),
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    bodyLimit: BODY_LIMIT_BYTES,
    return503OnClosing: true,
    trustProxy: trustProxyHops(deps.trustProxyHops ?? 0),
  });

  // JSON only: drop Fastify's default text/plain parser so other types get 415.
  app.removeContentTypeParser('text/plain');

  const service = new JobService({
    jobs: deps.jobs,
    state: deps.state,
    workflow: deps.workflow,
    logger: deps.logger,
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.newId ? { newId: deps.newId } : {}),
  });
  const openApiDocument = buildOpenApiDocument();

  if (deps.corsAllowedOrigins.length > 0) {
    await app.register(cors, {
      origin: [...deps.corsAllowedOrigins],
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['content-type', 'idempotency-key', AUTHORIZATION_HEADER, REQUEST_ID_HEADER],
      exposedHeaders: [
        'location',
        REQUEST_ID_HEADER,
        'idempotent-replayed',
        'retry-after',
        WWW_AUTHENTICATE_HEADER,
        RATE_LIMIT_HEADERS.limit,
        RATE_LIMIT_HEADERS.remaining,
        RATE_LIMIT_HEADERS.reset,
      ],
      maxAge: 600,
    });
  }

  app.addHook('onSend', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    let problem: ProblemError;
    if (error instanceof ProblemError) {
      problem = error;
    } else if (fastifyErrorToProblem(error)) {
      problem = fastifyErrorToProblem(error) as ProblemError;
    } else if (isDependencyUnavailable(error)) {
      request.log.warn({ err: error }, 'dependency unavailable');
      problem = serviceUnavailableProblem(
        'A backing service is temporarily unavailable. Please retry.',
      );
    } else {
      request.log.error({ err: error }, 'unhandled error');
      problem = internalProblem();
    }
    for (const [name, value] of Object.entries(problem.headers)) reply.header(name, value);
    return reply
      .code(problem.status)
      .type(PROBLEM_CONTENT_TYPE)
      .send(problem.toProblem(request.url.split('?')[0] ?? request.url, request.id));
  });

  const routeNotFound = (request: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(404)
      .type(PROBLEM_CONTENT_TYPE)
      .send(
        new ProblemError(
          404,
          ProblemType.NotFound,
          'Not Found',
          `No route for ${request.method} ${request.url.split('?')[0]}.`,
        ).toProblem(request.url.split('?')[0] ?? request.url, request.id),
      );
  app.setNotFoundHandler(routeNotFound);

  registerHealthRoutes(app, {
    checks: deps.healthChecks,
    lifecycle: deps.lifecycle,
    timeoutMs: deps.readinessTimeoutMs ?? 2_000,
  });
  // Everything under /v1 - routes AND the /v1 not-found handler - runs behind the
  // authentication hook of this encapsulated plugin.
  await app.register(
    async (v1) => {
      registerAuthentication(v1, deps.auth);
      registerJobRoutes(v1, service);
      v1.setNotFoundHandler(routeNotFound);
    },
    { prefix: '/v1' },
  );
  app.get('/openapi.json', async (_request, reply) =>
    reply.header('cache-control', 'public, max-age=300').send(openApiDocument),
  );

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
