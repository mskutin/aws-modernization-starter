import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION,
  CreateJobRequestSchema,
  JobSchema,
  OPENAPI_EXAMPLES,
  ProblemSchema,
  buildOpenApiDocument,
} from '../src/index.js';

const committedPath = new URL('../openapi/v1.json', import.meta.url);

/** Walks a parsed JSON document without `any`; undefined when a segment is missing. */
const at = (node: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      current !== null && typeof current === 'object'
        ? (current as Record<string, unknown>)[key]
        : undefined,
    node,
  );

describe('OpenAPI examples', () => {
  it('are valid instances of their schemas', () => {
    expect(CreateJobRequestSchema.safeParse(OPENAPI_EXAMPLES.createJobRequest).success).toBe(true);
    expect(JobSchema.safeParse(OPENAPI_EXAMPLES.acceptedJob).success).toBe(true);
    expect(ProblemSchema.safeParse(OPENAPI_EXAMPLES.validationProblem).success).toBe(true);
    expect(ProblemSchema.safeParse(OPENAPI_EXAMPLES.unauthorizedProblem).success).toBe(true);
  });

  it('describe the same document in request and response', () => {
    const { title, content, options } = OPENAPI_EXAMPLES.createJobRequest;
    expect(OPENAPI_EXAMPLES.acceptedJob).toMatchObject({
      title,
      options,
      contractVersion: CONTRACT_VERSION,
      contentLength: content.length,
      contentSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    });
  });

  it('are referenced from the createJob operation', () => {
    const post = at(buildOpenApiDocument(), 'paths', '/v1/jobs', 'post');
    expect(
      at(post, 'requestBody', 'content', 'application/json', 'examples', 'document', 'value'),
    ).toEqual(OPENAPI_EXAMPLES.createJobRequest);
    expect(
      at(post, 'responses', '202', 'content', 'application/json', 'examples', 'accepted', 'value'),
    ).toEqual(OPENAPI_EXAMPLES.acceptedJob);
    expect(
      at(post, 'responses', '400', 'content', 'application/problem+json', 'examples', 'validation'),
    ).toMatchObject({ value: OPENAPI_EXAMPLES.validationProblem });
  });
});

describe('OpenAPI document', () => {
  const generated = buildOpenApiDocument();

  it('matches the committed openapi/v1.json (run `pnpm --filter @starter/contracts run openapi:generate` if this fails)', () => {
    const committed: unknown = JSON.parse(readFileSync(committedPath, 'utf8'));
    expect(generated).toEqual(committed);
  });

  it('is an OpenAPI 3.1 document versioned with the contract', () => {
    expect(generated.openapi).toBe('3.1.0');
    expect(generated.info).toMatchObject({ version: CONTRACT_VERSION });
  });

  it('resolves every $ref to a declared component', () => {
    const json = JSON.stringify(generated);
    const refs = [...json.matchAll(/"\$ref":"#\/components\/(schemas|headers)\/([^"]+)"/g)];
    expect(refs.length).toBeGreaterThan(10);
    const components = generated.components as Record<string, Record<string, unknown>>;
    for (const [, kind, name] of refs) {
      expect(components[kind!]?.[name!], `${kind}/${name}`).toBeDefined();
    }
  });

  it('documents every route in the API runtime contract', () => {
    expect(Object.keys(generated.paths as object).sort()).toEqual([
      '/health/live',
      '/health/ready',
      '/openapi.json',
      '/v1/jobs',
      '/v1/jobs/{jobId}',
    ]);
  });

  it('requires bearer authentication on every /v1 operation and on nothing else', () => {
    const paths = generated.paths as Record<string, Record<string, Record<string, unknown>>>;
    const operations = Object.entries(paths).flatMap(([path, item]) =>
      Object.entries(item).map(([method, op]) => ({ path, method, op })),
    );
    expect(operations.length).toBe(6);
    for (const { path, method, op } of operations) {
      const label = `${method.toUpperCase()} ${path}`;
      if (path.startsWith('/v1/')) {
        expect(op.security, label).toEqual([{ bearerAuth: [] }]);
        const responses = op.responses as Record<string, Record<string, unknown>>;
        for (const status of ['401', '403', '429']) {
          expect(responses[status], `${label} documents ${status}`).toBeDefined();
        }
        expect(at(responses, '401', 'headers', 'WWW-Authenticate')).toBeDefined();
        expect(at(responses, '403', 'headers', 'WWW-Authenticate')).toBeDefined();
        expect(at(responses, '429', 'headers', 'Retry-After')).toBeDefined();
        expect(at(responses, '429', 'headers', 'RateLimit-Reset')).toBeDefined();
      } else {
        expect(op.security, `${label} stays public`).toBeUndefined();
      }
    }
    expect(generated.security, 'no global security requirement').toBeUndefined();
    expect(at(generated, 'components', 'securitySchemes', 'bearerAuth')).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('keeps request bodies strict and responses open for additive evolution', () => {
    const schemas = (generated.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    expect(schemas.CreateJobRequest?.additionalProperties).toBe(false);
    expect(schemas.Job?.additionalProperties).toBeUndefined();
    expect(schemas.CreateJobRequest?.required).toEqual(['title', 'content']);
  });
});
