/**
 * Health endpoints and the OpenAPI document (served from @starter/contracts).
 */
import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, HealthResponseSchema, REQUEST_ID_HEADER } from '@starter/contracts';
import { describeResponse, request } from '../support/api.js';

describe('health', () => {
  it('liveness: 200 {status: ok, draining: false}', async () => {
    const r = await request('GET', '/health/live');
    expect(r.status, describeResponse(r)).toBe(200);
    const body = HealthResponseSchema.parse(r.body);
    expect(body).toMatchObject({ status: 'ok', draining: false });
  });

  it('readiness: 200 only with every dependency check ok (PostgreSQL + DynamoDB)', async () => {
    const r = await request('GET', '/health/ready');
    expect(r.status, describeResponse(r)).toBe(200);
    const body = HealthResponseSchema.parse(r.body);
    expect(body.status).toBe('ok');
    expect(body.draining).toBe(false);
    expect(body.checks, 'readiness reports per-dependency checks').toBeDefined();
    const checks = body.checks ?? {};
    expect(Object.keys(checks).length).toBeGreaterThanOrEqual(2);
    expect(
      Object.values(checks).every((v) => v === 'ok'),
      JSON.stringify(checks),
    ).toBe(true);
    expect(Object.keys(checks).join(',')).toMatch(/postgres|database|db/i);
    expect(Object.keys(checks).join(',')).toMatch(/dynamo/i);
  });

  it('echoes a valid X-Request-Id and generates one otherwise', async () => {
    const mine = `it-${Date.now()}-abc`;
    const echoed = await request('GET', '/health/live', { headers: { [REQUEST_ID_HEADER]: mine } });
    expect(echoed.headers.get(REQUEST_ID_HEADER)).toBe(mine);
    const generated = await request('GET', '/health/live');
    expect(generated.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });
});

describe('openapi', () => {
  it('serves an OpenAPI 3.1 document describing the v1 routes', async () => {
    const r = await request('GET', '/openapi.json');
    expect(r.status, describeResponse(r)).toBe(200);
    const doc = r.body as {
      openapi: string;
      info: { version: string };
      paths: Record<string, Record<string, unknown>>;
    };
    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.info.version).toBe(CONTRACT_VERSION);
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/v1/jobs', '/v1/jobs/{jobId}', '/health/live', '/health/ready']),
    );
    expect(Object.keys(doc.paths['/v1/jobs'] ?? {})).toEqual(
      expect.arrayContaining(['get', 'post']),
    );
  });
});
