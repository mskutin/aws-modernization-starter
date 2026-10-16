import type { FastifyInstance } from 'fastify';
import { readiness, type HealthCheck, type Lifecycle } from '../health.js';

export function registerHealthRoutes(
  app: FastifyInstance,
  opts: { checks: readonly HealthCheck[]; lifecycle: Lifecycle; timeoutMs: number },
): void {
  // Probes are frequent; keep them out of the request log.
  app.get('/health/live', { logLevel: 'silent' }, async (_request, reply) => {
    const draining = opts.lifecycle.isDraining();
    return reply
      .code(draining ? 503 : 200)
      .send({ status: draining ? 'unavailable' : 'ok', draining });
  });

  app.get('/health/ready', { logLevel: 'silent' }, async (_request, reply) => {
    const result = await readiness(opts.checks, opts.lifecycle, opts.timeoutMs);
    // Request logging is silenced for probes, but failures must stay visible.
    for (const failure of result.failures) {
      app.log.warn({ check: failure.name, err: failure.error }, 'readiness check failed');
    }
    return reply.code(result.ok ? 200 : 503).send(result.body);
  });
}
