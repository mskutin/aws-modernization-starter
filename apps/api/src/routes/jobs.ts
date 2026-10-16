import {
  CreateJobRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  IdempotencyKeySchema,
  JobPathParamsSchema,
  ListJobsQuerySchema,
  toProblemFieldErrors,
} from '@starter/contracts';
import type { FastifyInstance } from 'fastify';
import { recordAudit } from '../auth/audit.js';
import { requirePrincipal } from '../auth/hooks.js';
import { notFoundProblem, validationProblem } from '../problem.js';
import type { JobService } from '../services/job-service.js';

function idempotencyHeader(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const parsed = IdempotencyKeySchema.safeParse(Array.isArray(raw) ? raw.join(',') : raw);
  if (!parsed.success) {
    throw validationProblem([
      { path: 'header.Idempotency-Key', message: parsed.error.issues[0]?.message ?? 'invalid' },
    ]);
  }
  return parsed.data;
}

/**
 * Job routes. Registered inside the `/v1` plugin (prefix `/v1`) behind the authentication
 * hook; every handler acts for `requirePrincipal(request)` only.
 */
export function registerJobRoutes(app: FastifyInstance, service: JobService): void {
  app.post('/jobs', async (request, reply) => {
    const principal = requirePrincipal(request);
    const key = idempotencyHeader(request.headers[IDEMPOTENCY_KEY_HEADER]);
    const body = CreateJobRequestSchema.safeParse(request.body);
    if (!body.success) throw validationProblem(toProblemFieldErrors(body.error, 'body'));

    const { job, replayed } = await service.create(principal, body.data, key, request.log, (id) =>
      recordAudit(request, { jobIds: [id] }),
    );
    recordAudit(request, { jobIds: [job.jobId], replayed });
    reply.header('location', `/v1/jobs/${job.jobId}`); // nosemgrep: nodejs_scan.javascript-redirect-rule-express_open_redirect2 -- Location of the created job: a relative same-origin path whose id is server-generated (JobService.newId); no user-controlled redirect target
    if (replayed) reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
    return reply.code(replayed ? 200 : 202).send(job);
  });

  app.get('/jobs/:jobId', async (request) => {
    const principal = requirePrincipal(request);
    const params = JobPathParamsSchema.safeParse(request.params);
    if (!params.success) throw validationProblem(toProblemFieldErrors(params.error, 'path'));
    // Who asked for which job — also when it does not exist or belongs to someone else.
    recordAudit(request, { jobIds: [params.data.jobId] });
    const job = await service.get(principal, params.data.jobId);
    // Same answer for "does not exist" and "belongs to someone else": no existence oracle.
    if (!job) throw notFoundProblem(`Job ${params.data.jobId} does not exist.`);
    return job;
  });

  app.get('/jobs', async (request) => {
    const principal = requirePrincipal(request);
    const query = ListJobsQuerySchema.safeParse(request.query);
    if (!query.success) throw validationProblem(toProblemFieldErrors(query.error, 'query'));
    const page = await service.list(principal, query.data.limit, query.data.cursor);
    recordAudit(request, { jobIds: page.items.map((j) => j.jobId), count: page.items.length });
    return page;
  });
}
