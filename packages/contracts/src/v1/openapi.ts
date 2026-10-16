/**
 * OpenAPI 3.1 document for API v1, generated from the zod schemas using zod
 * v4's native JSON Schema (draft 2020-12) output — no extra dependencies.
 *
 * The committed copy lives in `packages/contracts/openapi/v1.json`; a unit test
 * fails when it drifts from this generator. Regenerate with
 * `pnpm --filter @starter/contracts run openapi:generate`.
 */
import { z } from 'zod';
import {
  AUTH_REALM,
  CONTRACT_VERSION,
  CreateJobRequestSchema,
  DEFAULT_SCOPES,
  HealthResponseSchema,
  IDEMPOTENCY_KEY_PATTERN,
  JobErrorSchema,
  JobIdSchema,
  JobListSchema,
  JobOptionsSchema,
  JobResultSchema,
  JobSchema,
  JobStatusSchema,
  JobSummarySchema,
  LIMITS,
  ProblemFieldErrorSchema,
  ProblemSchema,
  ProblemType,
  TermFrequencySchema,
} from './schemas.js';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };
export type JsonObject = { [key: string]: JsonValue | undefined };

const REF_PREFIX = '#/components/schemas/';

const requestComponents = {
  CreateJobRequest: CreateJobRequestSchema,
  JobOptions: JobOptionsSchema,
} as const;

const responseComponents = {
  Job: JobSchema,
  JobStatus: JobStatusSchema,
  JobResult: JobResultSchema,
  JobError: JobErrorSchema,
  TermFrequency: TermFrequencySchema,
  JobSummary: JobSummarySchema,
  JobList: JobListSchema,
  Problem: ProblemSchema,
  ProblemFieldError: ProblemFieldErrorSchema,
  HealthResponse: HealthResponseSchema,
} as const;

function stripSchemaHeader(schema: JsonObject): JsonObject {
  const { $schema: _schema, $id: _id, ...rest } = schema;
  return rest;
}

function componentsFor(
  components: Record<string, z.ZodType>,
  io: 'input' | 'output',
): Record<string, JsonObject> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(components)) registry.add(schema, { id });
  const generated = z.toJSONSchema(registry, {
    target: 'draft-2020-12',
    io,
    uri: (id) => `${REF_PREFIX}${id}`,
    // Non-strict (response) objects stay open for additive evolution; strict
    // request objects keep `additionalProperties: false`.
    override: (ctx) => {
      const def = ctx.zodSchema._zod.def;
      if (def.type === 'object' && def.catchall === undefined) {
        delete ctx.jsonSchema.additionalProperties;
      }
    },
  }) as { schemas: Record<string, JsonObject> };
  return Object.fromEntries(
    Object.entries(generated.schemas).map(([id, schema]) => [id, stripSchemaHeader(schema)]),
  );
}

function inlineSchema(schema: z.ZodType): JsonObject {
  const generated: unknown = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
  return stripSchemaHeader(generated as JsonObject);
}

const ref = (id: string): JsonObject => ({ $ref: `${REF_PREFIX}${id}` });

const EXAMPLE_CONTENT =
  'Cloud migration is a journey, not a single event. Teams move applications in waves, ' +
  'measure the outcome and keep improving.';

/**
 * Non-normative documentation examples embedded in the OpenAPI document. They are
 * typed against the schemas, and unit tests parse each one with its schema and check
 * that the example job matches the example request — so they cannot silently drift.
 */
export const OPENAPI_EXAMPLES = {
  createJobRequest: {
    title: 'Cloud migration notes',
    content: EXAMPLE_CONTENT,
    options: { topTerms: 5 },
  } satisfies z.input<typeof CreateJobRequestSchema>,
  acceptedJob: {
    jobId: '4194b63d-9c1e-4c8a-9f43-1a2b3c4d5e6f',
    title: 'Cloud migration notes',
    status: 'PENDING',
    contractVersion: CONTRACT_VERSION,
    options: { topTerms: 5 },
    contentLength: EXAMPLE_CONTENT.length,
    contentSha256: '4f142e45547de462b18b1033ddbca94c58b0b7ae4f6f01097b0e9a4dfdcc7814',
    createdAt: '2026-10-13T10:00:00.000Z',
    updatedAt: '2026-10-13T10:00:00.000Z',
    result: null,
    error: null,
  } satisfies z.output<typeof JobSchema>,
  validationProblem: {
    type: ProblemType.Validation,
    title: 'Bad Request',
    status: 400,
    detail: 'Request validation failed.',
    instance: '/v1/jobs',
    requestId: 'c1cb3243-5f2d-4c7e-9a1b-2b3c4d5e6f70',
    errors: [{ path: 'body.title', message: 'must not be empty' }],
  } satisfies z.output<typeof ProblemSchema>,
  unauthorizedProblem: {
    type: ProblemType.Unauthorized,
    title: 'Unauthorized',
    status: 401,
    detail: 'A valid bearer access token is required.',
    instance: '/v1/jobs',
    requestId: '0b6a1f8e-4f0e-4a43-9d55-3c2b1a0f9e8d',
  } satisfies z.output<typeof ProblemSchema>,
};

const problemResponse = (
  description: string,
  examples?: JsonObject,
  extraHeaders: JsonObject = {},
): JsonObject => ({
  description,
  headers: { 'X-Request-Id': { $ref: '#/components/headers/X-Request-Id' }, ...extraHeaders },
  content: {
    'application/problem+json': { schema: ref('Problem'), ...(examples ? { examples } : {}) },
  },
});

const headerRef = (name: string): JsonObject => ({ $ref: `#/components/headers/${name}` });
const RATE_LIMIT_HEADER_REFS: JsonObject = {
  'RateLimit-Limit': headerRef('RateLimit-Limit'),
  'RateLimit-Remaining': headerRef('RateLimit-Remaining'),
  'RateLimit-Reset': headerRef('RateLimit-Reset'),
};

/**
 * Security and the 401/403/429 responses shared by every `/v1` operation (contract 1.1.0).
 * `scope` is the default scope name; deployments may rename it (AUTH_SCOPE_READ/WRITE).
 */
function protectedOperation(scope: string): { security: JsonValue; responses: JsonObject } {
  return {
    security: [{ bearerAuth: [] }],
    responses: {
      '401': problemResponse(
        'Missing, malformed, expired or otherwise invalid bearer token (the response never says which check failed).',
        {
          unauthorized: { summary: 'No valid token', value: OPENAPI_EXAMPLES.unauthorizedProblem },
        },
        { 'WWW-Authenticate': headerRef('WWW-Authenticate'), ...RATE_LIMIT_HEADER_REFS },
      ),
      '403': problemResponse(
        `The token is valid but lacks the required scope (default \`${scope}\`).`,
        undefined,
        { 'WWW-Authenticate': headerRef('WWW-Authenticate') },
      ),
      '429': problemResponse(
        'Rate limit exhausted (per principal, or per client address for failed authentication).',
        undefined,
        { 'Retry-After': headerRef('Retry-After'), ...RATE_LIMIT_HEADER_REFS },
      ),
    },
  };
}

const jsonResponse = (
  description: string,
  schemaId: string,
  extraHeaders: JsonObject = {},
  examples?: JsonObject,
) => ({
  description,
  headers: { 'X-Request-Id': { $ref: '#/components/headers/X-Request-Id' }, ...extraHeaders },
  content: { 'application/json': { schema: ref(schemaId), ...(examples ? { examples } : {}) } },
});

export function buildOpenApiDocument(): JsonObject {
  const read = protectedOperation(DEFAULT_SCOPES.read);
  const write = protectedOperation(DEFAULT_SCOPES.write);
  const schemas = {
    ...componentsFor(responseComponents, 'output'),
    ...componentsFor(requestComponents, 'input'),
  };
  const sortedSchemas = Object.fromEntries(
    Object.keys(schemas)
      .sort()
      .map((key) => [key, schemas[key]]),
  );

  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'AWS Modernization Starter — Document Analysis Jobs API',
      version: CONTRACT_VERSION,
      description:
        'Submit plain-text documents for asynchronous analysis and poll for results. ' +
        'Every /v1 operation requires an OAuth 2.0 bearer access token (JWT) from the trusted ' +
        'OpenID Connect issuer; callers only ever see their own jobs. ' +
        'Errors use RFC 9457 problem details (application/problem+json).',
    },
    servers: [{ url: '/', description: 'Same origin (CloudFront routes /v1/* to the API).' }],
    tags: [
      { name: 'jobs', description: 'Document-analysis jobs.' },
      { name: 'health', description: 'Liveness and readiness probes.' },
      { name: 'meta', description: 'API description.' },
    ],
    paths: {
      '/v1/jobs': {
        post: {
          operationId: 'createJob',
          tags: ['jobs'],
          summary: 'Submit a document-analysis job',
          description:
            'Validates the request, persists the job (owned by the calling principal) and starts the ' +
            'processing workflow. Retries by the same principal with the same Idempotency-Key (or, ' +
            'without the header, an identical body) return the original job with ' +
            '`Idempotent-Replayed: true` instead of creating a duplicate. Keys are scoped to the ' +
            `principal: other callers never see each other's jobs. Requires scope \`${DEFAULT_SCOPES.write}\`.`,
          security: write.security,
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: false,
              schema: { type: 'string', pattern: IDEMPOTENCY_KEY_PATTERN.source },
              description:
                'Optional client-chosen key, scoped to the calling principal. Without it the server derives one from a SHA-256 hash of the canonical request body.',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: ref('CreateJobRequest'),
                examples: {
                  document: {
                    summary: 'A short document (passes the ≥ 10 words business rule)',
                    value: OPENAPI_EXAMPLES.createJobRequest,
                  },
                },
              },
            },
          },
          responses: {
            '202': jsonResponse(
              'Job accepted for asynchronous processing.',
              'Job',
              {
                Location: {
                  description: 'URL of the created job resource.',
                  schema: { type: 'string' },
                },
                ...RATE_LIMIT_HEADER_REFS,
              },
              {
                accepted: {
                  summary: 'Newly created job, workflow not started yet',
                  value: OPENAPI_EXAMPLES.acceptedJob,
                },
              },
            ),
            '200': jsonResponse('Idempotent replay: the previously created job.', 'Job', {
              'Idempotent-Replayed': { $ref: '#/components/headers/Idempotent-Replayed' },
              Location: {
                description: 'URL of the job resource.',
                schema: { type: 'string' },
              },
              ...RATE_LIMIT_HEADER_REFS,
            }),
            '400': problemResponse('Request failed schema validation.', {
              validation: {
                summary: 'Empty title',
                value: OPENAPI_EXAMPLES.validationProblem,
              },
            }),
            ...write.responses,
            '413': problemResponse('Request body exceeds the size limit.'),
            '415': problemResponse('Content-Type is not application/json.'),
            '422': problemResponse('Idempotency-Key was reused with a different request body.'),
            '503': problemResponse(
              'A dependency (database, state store, workflow service or the identity provider keys) is unavailable; retry with the same Idempotency-Key.',
            ),
            default: problemResponse('Unexpected error.'),
          },
        },
        get: {
          operationId: 'listJobs',
          tags: ['jobs'],
          summary: "List the caller's jobs, newest first",
          description: `Only jobs owned by the calling principal are listed. Keyset pagination (\`limit\` ${LIMITS.listLimitMin}-${LIMITS.listLimitMax}). Requires scope \`${DEFAULT_SCOPES.read}\`.`,
          security: read.security,
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: {
                type: 'integer',
                minimum: LIMITS.listLimitMin,
                maximum: LIMITS.listLimitMax,
                default: LIMITS.listLimitDefault,
              },
            },
            {
              name: 'cursor',
              in: 'query',
              required: false,
              schema: { type: 'string', minLength: 1, maxLength: LIMITS.cursorMaxLength },
              description: 'Opaque `nextCursor` value from a previous page.',
            },
          ],
          responses: {
            '200': jsonResponse('A page of jobs.', 'JobList', RATE_LIMIT_HEADER_REFS),
            '400': problemResponse('Invalid query parameters or cursor.'),
            ...read.responses,
            '503': problemResponse('A dependency is unavailable.'),
            default: problemResponse('Unexpected error.'),
          },
        },
      },
      '/v1/jobs/{jobId}': {
        get: {
          operationId: 'getJob',
          tags: ['jobs'],
          summary: 'Get a job with its current status, results or error',
          description: `Answers 404 both for unknown ids and for jobs owned by another principal (no existence oracle). Requires scope \`${DEFAULT_SCOPES.read}\`.`,
          security: read.security,
          parameters: [
            { name: 'jobId', in: 'path', required: true, schema: inlineSchema(JobIdSchema) },
          ],
          responses: {
            '200': jsonResponse('The job.', 'Job', RATE_LIMIT_HEADER_REFS),
            '400': problemResponse('jobId is not a UUID.'),
            ...read.responses,
            '404': problemResponse('No job with this id owned by the caller.'),
            '503': problemResponse('A dependency is unavailable.'),
            default: problemResponse('Unexpected error.'),
          },
        },
      },
      '/health/live': {
        get: {
          operationId: 'getLiveness',
          tags: ['health'],
          summary: 'Liveness probe (200 unless shutting down)',
          responses: {
            '200': {
              description: 'Alive.',
              content: { 'application/json': { schema: ref('HealthResponse') } },
            },
            '503': {
              description: 'Shutting down.',
              content: { 'application/json': { schema: ref('HealthResponse') } },
            },
          },
        },
      },
      '/health/ready': {
        get: {
          operationId: 'getReadiness',
          tags: ['health'],
          summary: 'Readiness probe (200 only when PostgreSQL and DynamoDB are reachable)',
          responses: {
            '200': {
              description: 'Ready.',
              content: { 'application/json': { schema: ref('HealthResponse') } },
            },
            '503': {
              description: 'Not ready or draining.',
              content: { 'application/json': { schema: ref('HealthResponse') } },
            },
          },
        },
      },
      '/openapi.json': {
        get: {
          operationId: 'getOpenApiDocument',
          tags: ['meta'],
          summary: 'This OpenAPI 3.1 document',
          responses: {
            '200': { description: 'OpenAPI document.', content: { 'application/json': {} } },
          },
        },
      },
    },
    components: {
      schemas: sortedSchemas,
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'OAuth 2.0 access token (JWT) issued by the configured OpenID Connect issuer. The API ' +
            'verifies the signature against the issuer JWKS (asymmetric algorithms only) and ' +
            'enforces iss, aud, exp/nbf and the operation scope ' +
            `(default \`${DEFAULT_SCOPES.read}\` for GET, \`${DEFAULT_SCOPES.write}\` for POST).`,
        },
      },
      headers: {
        'X-Request-Id': {
          description:
            'Request correlation id (echoed from the request when valid, otherwise generated).',
          schema: { type: 'string' },
        },
        'Idempotent-Replayed': {
          description: 'Present (value "true") when the response replays an earlier request.',
          schema: { type: 'string', enum: ['true'] },
        },
        'WWW-Authenticate': {
          description: `RFC 6750 challenge, e.g. \`Bearer realm="${AUTH_REALM}", error="invalid_token"\` (401) or \`Bearer realm="${AUTH_REALM}", error="insufficient_scope", scope="${DEFAULT_SCOPES.read}"\` (403).`,
          schema: { type: 'string' },
        },
        'Retry-After': {
          description: 'Seconds until the rate-limit window resets.',
          schema: { type: 'integer', minimum: 1 },
        },
        'RateLimit-Limit': {
          description: 'Requests allowed in the current window for this caller.',
          schema: { type: 'integer', minimum: 1 },
        },
        'RateLimit-Remaining': {
          description: 'Requests left in the current window.',
          schema: { type: 'integer', minimum: 0 },
        },
        'RateLimit-Reset': {
          description: 'Seconds until the current window resets.',
          schema: { type: 'integer', minimum: 1 },
        },
      },
    },
  };
}
