/**
 * API contract v1 — the single source of truth for request/response shapes.
 *
 * Compatibility rules (see docs/development.md "Contract versioning"):
 *  - Additive, optional changes to responses are non-breaking (minor bump).
 *  - Removing/renaming fields, tightening request validation or adding a
 *    required request field is breaking and requires a new major (`v2`) module
 *    served under a new path prefix (`/v2`), while `v1` keeps working.
 *
 * Request schemas are strict (unknown fields are rejected) so client mistakes
 * surface early; response schemas are open (unknown fields are stripped by the
 * parser) so clients tolerate additive server changes.
 */
import { z } from 'zod';

/**
 * 1.1.0: bearer authentication on `/v1/*`, caller-scoped jobs and idempotency keys,
 * rate limits; new problem types `unauthorized`, `forbidden`, `too-many-requests`. Additive for
 * the contract shapes; clients must now send `Authorization: Bearer <access token>`.
 * Problem types are URNs of the form `urn:starter:problem:<code>` (the public release's first
 * published namespace; no earlier namespace is supported).
 */
export const CONTRACT_VERSION = '1.1.0' as const;
export const CONTRACT_MAJOR = 1 as const;

export const JOB_STATUSES = ['PENDING', 'VALIDATING', 'PROCESSING', 'SUCCEEDED', 'FAILED'] as const;
export const TERMINAL_JOB_STATUSES = ['SUCCEEDED', 'FAILED'] as const;

export const LIMITS = {
  titleMaxLength: 200,
  /**
   * Upper bound on characters. Chosen so that even a worst-case payload (every
   * character JSON-escaped as `\u00XX`, 6 bytes) keeps the Step Functions
   * execution input below its 256 KiB quota. Business rules in `@starter/domain`
   * apply a tighter UTF-8 byte limit.
   */
  contentMaxLength: 40_000,
  topTermsMin: 1,
  topTermsMax: 25,
  topTermsDefault: 10,
  listLimitMin: 1,
  listLimitMax: 100,
  listLimitDefault: 20,
  cursorMaxLength: 512,
} as const;

/** `Idempotency-Key` header: 8–128 URL-safe characters (a UUID fits). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed';
export const REQUEST_ID_HEADER = 'x-request-id';
export const AUTHORIZATION_HEADER = 'authorization';
export const WWW_AUTHENTICATE_HEADER = 'www-authenticate';
export const RETRY_AFTER_HEADER = 'retry-after';
/** Rate-limit response headers (draft-ietf-httpapi-ratelimit-headers, separate-field form). */
export const RATE_LIMIT_HEADERS = {
  limit: 'ratelimit-limit',
  remaining: 'ratelimit-remaining',
  reset: 'ratelimit-reset',
} as const;
/** `WWW-Authenticate` realm of the API (RFC 6750). */
export const AUTH_REALM = 'starter-api';
/** Default OAuth scopes (deployments may rename them: AUTH_SCOPE_READ / AUTH_SCOPE_WRITE). */
export const DEFAULT_SCOPES = { read: 'jobs:read', write: 'jobs:write' } as const;

export const JobIdSchema = z.uuid().describe('Server-assigned job identifier (UUID).');

export const IdempotencyKeySchema = z
  .string()
  .regex(IDEMPOTENCY_KEY_PATTERN, 'must be 8-128 characters of A-Z, a-z, 0-9, "_" or "-"')
  .describe(
    'Client-chosen key that makes POST /v1/jobs safe to retry. Reusing a key with a different body is rejected.',
  );

export const JobStatusSchema = z
  .enum(JOB_STATUSES)
  .describe(
    'Lifecycle status. PENDING → VALIDATING → PROCESSING → SUCCEEDED, or → FAILED from any non-terminal status.',
  );

export const JobOptionsSchema = z.strictObject({
  topTerms: z
    .int()
    .min(LIMITS.topTermsMin)
    .max(LIMITS.topTermsMax)
    .default(LIMITS.topTermsDefault)
    .describe('How many most-frequent terms (stop words excluded) to report.'),
});

export const CreateJobRequestSchema = z.strictObject({
  title: z
    .string()
    .trim()
    .min(1, 'must not be empty')
    .max(LIMITS.titleMaxLength)
    .describe('Human-readable document title (trimmed).'),
  content: z
    .string()
    .min(1, 'must not be empty')
    .max(LIMITS.contentMaxLength)
    .regex(/\S/, 'must contain non-whitespace characters')
    .describe('Plain-text document to analyse.'),
  options: JobOptionsSchema.default({ topTerms: LIMITS.topTermsDefault }),
});

export const TermFrequencySchema = z.object({
  term: z.string(),
  count: z.int().min(1),
});

export const JobResultSchema = z.object({
  algorithmVersion: z.string().describe('Version of the deterministic analysis algorithm.'),
  wordCount: z.int().nonnegative(),
  uniqueWordCount: z.int().nonnegative(),
  sentenceCount: z.int().nonnegative(),
  paragraphCount: z.int().nonnegative(),
  characterCount: z.int().nonnegative().describe('Unicode code points after NFC normalisation.'),
  averageWordLength: z.number().nonnegative(),
  averageSentenceLength: z.number().nonnegative().describe('Words per sentence.'),
  lexicalDiversity: z.number().min(0).max(1).describe('Unique words / total words.'),
  readingTimeSeconds: z.int().nonnegative(),
  topTerms: z.array(TermFrequencySchema),
  checksumSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe('SHA-256 of the UTF-8 encoded content as submitted.'),
});

export const JobErrorSchema = z.object({
  name: z.string().describe('Machine-readable error name, e.g. JobValidationError.'),
  message: z.string(),
});

export const JobSchema = z.object({
  jobId: JobIdSchema,
  title: z.string(),
  status: JobStatusSchema,
  contractVersion: z.string(),
  options: z.object({ topTerms: z.int().min(LIMITS.topTermsMin).max(LIMITS.topTermsMax) }),
  contentLength: z.int().nonnegative().describe('Length of the submitted content in characters.'),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  result: JobResultSchema.nullable(),
  error: JobErrorSchema.nullable(),
});

export const JobSummarySchema = z.object({
  jobId: JobIdSchema,
  title: z.string(),
  status: JobStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const JobListSchema = z.object({
  items: z.array(JobSummarySchema),
  nextCursor: z
    .string()
    .nullable()
    .describe('Opaque cursor for the next page; null when there are no more results.'),
});

/** Runtime parser for `GET /v1/jobs` query strings (coerces strings). */
export const ListJobsQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(LIMITS.listLimitMin)
    .max(LIMITS.listLimitMax)
    .default(LIMITS.listLimitDefault),
  cursor: z.string().min(1).max(LIMITS.cursorMaxLength).optional(),
});

export const JobPathParamsSchema = z.strictObject({ jobId: JobIdSchema });

export const ProblemFieldErrorSchema = z.object({
  path: z.string().describe('Dot-separated location of the invalid value, e.g. body.title.'),
  message: z.string(),
});

/** RFC 9457 problem details (`application/problem+json`). */
export const ProblemSchema = z.object({
  type: z.string().describe('URI reference identifying the problem type.'),
  title: z.string(),
  status: z.int().min(100).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional().describe('Correlates with the X-Request-Id header and logs.'),
  errors: z.array(ProblemFieldErrorSchema).optional(),
});

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  draining: z.boolean(),
  checks: z.record(z.string(), z.enum(['ok', 'fail'])).optional(),
});

/** Stable problem `type` URIs. Non-dereferenceable URNs by design. */
export const ProblemType = {
  Validation: 'urn:starter:problem:validation-error',
  NotFound: 'urn:starter:problem:not-found',
  IdempotencyMismatch: 'urn:starter:problem:idempotency-key-reused',
  UnsupportedMediaType: 'urn:starter:problem:unsupported-media-type',
  PayloadTooLarge: 'urn:starter:problem:payload-too-large',
  ServiceUnavailable: 'urn:starter:problem:service-unavailable',
  Internal: 'urn:starter:problem:internal-error',
  /** 401: missing, malformed or invalid bearer token. Never says which check failed. */
  Unauthorized: 'urn:starter:problem:unauthorized',
  /** 403: valid token without the scope the operation requires. */
  Forbidden: 'urn:starter:problem:forbidden',
  /** 429: rate limit exhausted; see Retry-After and RateLimit-* headers. */
  TooManyRequests: 'urn:starter:problem:too-many-requests',
} as const;
export type ProblemTypeUri = (typeof ProblemType)[keyof typeof ProblemType];

export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobOptions = z.infer<typeof JobOptionsSchema>;
/** Parsed (output) request, after defaults/trimming are applied. */
export type CreateJobRequest = z.output<typeof CreateJobRequestSchema>;
/** What a client may send (defaults optional). */
export type CreateJobRequestInput = z.input<typeof CreateJobRequestSchema>;
export type TermFrequency = z.infer<typeof TermFrequencySchema>;
export type JobResult = z.infer<typeof JobResultSchema>;
export type JobError = z.infer<typeof JobErrorSchema>;
export type Job = z.infer<typeof JobSchema>;
export type JobSummary = z.infer<typeof JobSummarySchema>;
export type JobList = z.infer<typeof JobListSchema>;
export type ListJobsQuery = z.output<typeof ListJobsQuerySchema>;
export type Problem = z.infer<typeof ProblemSchema>;
export type ProblemFieldError = z.infer<typeof ProblemFieldErrorSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export function isTerminalJobStatus(status: JobStatus): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}

/** Converts zod issues into RFC 9457 `errors[]` entries, prefixed by location. */
export function toProblemFieldErrors(
  error: z.ZodError,
  location: 'body' | 'query' | 'path' | 'header',
): ProblemFieldError[] {
  return error.issues.map((issue) => ({
    path: [location, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }));
}
