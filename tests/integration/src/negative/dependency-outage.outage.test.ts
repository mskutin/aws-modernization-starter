/**
 * LOCAL ONLY — dependency outage semantics. Stops the PostgreSQL / DynamoDB Local containers of the
 * compose stack and proves:
 *   - readiness flips to 503 (with the failing check named) while liveness stays 200,
 *   - writes fail fast with 503 problem+json instead of hanging or half-creating jobs,
 *   - the API recovers by itself once the dependency is back (no restart needed).
 * Skipped with a reason unless LOCAL_CONTAINER_CONTROL=true and DOCKER_HOST is a unix socket.
 * The containers are always restarted in afterAll, even when assertions fail.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { HealthResponseSchema, ProblemType } from '@starter/contracts';
import {
  describeResponse,
  expectJobResponse,
  expectProblem,
  request,
  submitJob,
  waitForTerminal,
} from '../support/api.js';
import {
  containerControl,
  isRunning,
  startContainer,
  stopContainer,
} from '../support/containers.js';
import { validDocument } from '../support/fixtures.js';
import { pollUntil } from '../support/poll.js';

const control = containerControl();
const skipReason = 'skip' in control ? control.skip : null;
const socket = 'socketPath' in control ? control.socketPath : '';

const deps = [
  {
    name: 'PostgreSQL',
    container: process.env.IT_POSTGRES_CONTAINER ?? 'starter-app-postgres',
    check: /postgres|database|db/i,
  },
  {
    name: 'DynamoDB',
    container: process.env.IT_DYNAMODB_CONTAINER ?? 'starter-app-dynamodb',
    check: /dynamo/i,
  },
];

async function readiness() {
  const r = await request('GET', '/health/ready');
  return { status: r.status, body: HealthResponseSchema.parse(r.body), raw: r };
}

async function waitReady(expected: 200 | 503, deadlineMs: number) {
  return pollUntil(
    `/health/ready to return ${expected}`,
    async () => {
      const r = await readiness().catch(() => undefined);
      return r && r.status === expected ? r : undefined;
    },
    { deadlineMs, initialDelayMs: 200, maxDelayMs: 2_000 },
  );
}

describe.skipIf(skipReason)(
  `dependency outage${skipReason ? ` [SKIPPED: ${skipReason}]` : ''}`,
  () => {
    afterAll(async () => {
      for (const d of deps) {
        if (!(await isRunning(socket, d.container))) await startContainer(socket, d.container);
      }
      await waitReady(200, 120_000);
    });

    for (const dep of deps) {
      it(`${dep.name} down → ready 503 naming the check, live 200, writes 503; then recovers`, async () => {
        expect((await readiness()).status, 'precondition: API ready').toBe(200);

        await stopContainer(socket, dep.container);
        try {
          const down = await waitReady(503, 30_000);
          expect(down.body.status).toBe('unavailable');
          expect(down.body.draining).toBe(false);
          const failing = Object.entries(down.body.checks ?? {}).filter(([, v]) => v === 'fail');
          expect(failing.map(([k]) => k).join(','), JSON.stringify(down.body)).toMatch(dep.check);

          const live = await request('GET', '/health/live');
          expect(
            live.status,
            `liveness must not depend on ${dep.name}: ${describeResponse(live)}`,
          ).toBe(200);

          const t0 = Date.now();
          const write = await submitJob(validDocument(`outage-${dep.name}`));
          expect(Date.now() - t0, 'write must fail fast, not hang').toBeLessThan(15_000);
          expectProblem(write, 503, ProblemType.ServiceUnavailable);
        } finally {
          await startContainer(socket, dep.container);
        }

        await waitReady(200, 90_000);
        const created = expectJobResponse(await submitJob(validDocument(`recovered-${dep.name}`)));
        const { job } = await waitForTerminal(created.jobId);
        expect(job.status).toBe('SUCCEEDED');
      });
    }
  },
);
