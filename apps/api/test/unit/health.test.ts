import { HealthResponseSchema } from '@starter/contracts';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './fakes.js';

describe('health probes', () => {
  it('reports live and ready when dependencies answer', async () => {
    const h = await buildTestApp();
    const live = await h.app.inject({ url: '/health/live' });
    const ready = await h.app.inject({ url: '/health/ready' });
    expect(live.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(live.json())).toEqual({ status: 'ok', draining: false });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: 'ok',
      draining: false,
      checks: { postgres: 'ok', dynamodb: 'ok' },
    });
    await h.app.close();
  });

  it('is not ready (503) when PostgreSQL is down, but stays live', async () => {
    const h = await buildTestApp();
    h.jobs.failNext(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const ready = await h.app.inject({ url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({
      status: 'unavailable',
      draining: false,
      checks: { postgres: 'fail', dynamodb: 'ok' },
    });
    expect((await h.app.inject({ url: '/health/live' })).statusCode).toBe(200);
    expect(h.lines.some((l) => l.msg === 'readiness check failed' && l.check === 'postgres')).toBe(
      true,
    );
    await h.app.close();
  });

  it('fails a check that does not answer within the readiness timeout', async () => {
    const h = await buildTestApp({
      healthChecks: [{ name: 'dynamodb', check: () => new Promise(() => {}) }],
    });
    const ready = await h.app.inject({ url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ checks: { dynamodb: 'fail' } });
    await h.app.close();
  });

  it('flips liveness and readiness to 503 while draining', async () => {
    const h = await buildTestApp();
    h.lifecycle.beginDrain();
    const ready = await h.app.inject({ url: '/health/ready' });
    const live = await h.app.inject({ url: '/health/live' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'unavailable', draining: true });
    expect(live.statusCode).toBe(503);
    await h.app.close();
  });
});
