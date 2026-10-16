/**
 * Authentication, rate-limit and proxy-trust settings of the API
 * (ADR 0210/0212).
 *
 * There is deliberately NO switch that disables authentication. The only relaxation is
 * `AUTH_ALLOW_INSECURE_ISSUER=true` (plain-http issuer/JWKS for the local test IdP), accepted
 * only when `APP_RUNTIME` is `local` or `ci`. It is keyed on APP_RUNTIME (default `aws`), not
 * NODE_ENV: the image, local compose and CI all run NODE_ENV=production.
 */
import { z } from 'zod';
import { LOCAL_ONLY_MESSAGE, allowsLocalRelaxations, appRuntime } from './runtime.js';
import { nonEmpty } from './shared.js';

/**
 * Asymmetric JWS algorithms the API can be configured to accept. `none` and every HMAC
 * (`HS*`) algorithm are absent on purpose: a shared-secret algorithm would let anyone who
 * knows the issuer's PUBLIC key mint tokens (algorithm confusion).
 */
export const ASYMMETRIC_JWS_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;
export type AsymmetricJwsAlgorithm = (typeof ASYMMETRIC_JWS_ALGORITHMS)[number];

/** OAuth 2.0 scope-token characters (RFC 6749 §3.3: %x21 / %x23-5B / %x5D-7E). */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/;
const scopeToken = z.string().regex(SCOPE_TOKEN, 'must be a single OAuth scope token');

const boolean = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'], { error: 'must be "true" or "false"' })
    .default(fallback)
    .transform((v) => v === 'true');

const intIn = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

/** Absolute http(s) URL without credentials, query or fragment (OIDC issuer identifier rules). */
const issuerLikeUrl = nonEmpty.superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be an absolute URL' });
    return;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    ctx.addIssue({ code: 'custom', message: 'must be an https URL' });
  }
  if (url.username || url.password || url.search || url.hash) {
    ctx.addIssue({
      code: 'custom',
      message: 'must not contain credentials, a query string or a fragment',
    });
  }
});

const ALGORITHM_LIST_MESSAGE = `must be a comma-separated list of ${ASYMMETRIC_JWS_ALGORITHMS.join(', ')} (none and HS* are never accepted)`;

/** Fields merged into the API environment schema (`ApiEnvSchema`). */
export const AuthEnvShape = {
  /** Exact expected `iss`; also the base for OIDC discovery. Compared as an exact string. */
  AUTH_ISSUER: issuerLikeUrl,
  /**
   * Exact expected `aud` (string, or a member of the `aud` array). Must identify the API: it
   * may not be one of AUTH_ALLOWED_CLIENT_IDS (an SPA client id would admit its ID tokens).
   */
  AUTH_AUDIENCE: nonEmpty.pipe(z.string().max(512)),
  /**
   * Allow-list of OAuth clients (`azp` or `client_id` claim) whose access tokens the API
   * accepts, e.g. the SPA client id. Required with APP_RUNTIME=aws; empty (any
   * client of the trusted issuer) is accepted only for local/CI runtimes.
   */
  AUTH_ALLOWED_CLIENT_IDS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().max(512))),
  /** Optional override of the discovered `jwks_uri`. */
  AUTH_JWKS_URI: issuerLikeUrl.optional(),
  AUTH_ALGORITHMS: z
    .string()
    .default('RS256,ES256')
    .transform((value) =>
      value
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(z.enum(ASYMMETRIC_JWS_ALGORITHMS, { error: ALGORITHM_LIST_MESSAGE }))
        .min(1, ALGORITHM_LIST_MESSAGE),
    ),
  AUTH_CLOCK_TOLERANCE_SECONDS: intIn(0, 120, 30),
  /**
   * Maximum age of an access token after its `iat`: tokens are accepted until
   * min(exp, iat + max age); `iat` is required and may not lie in the future beyond the skew.
   */
  AUTH_MAX_TOKEN_AGE_SECONDS: intIn(60, 86_400, 3_600),
  AUTH_SCOPE_READ: scopeToken.default('jobs:read'),
  AUTH_SCOPE_WRITE: scopeToken.default('jobs:write'),
  /** Local/CI only: accept an http issuer/JWKS URL. Rejected when APP_RUNTIME=aws (default). */
  AUTH_ALLOW_INSECURE_ISSUER: boolean('false'),
  /** `aws` (default) | `ci` | `local` (packages/config/src/runtime.ts). */
  APP_RUNTIME: appRuntime,
  RATE_LIMIT_WINDOW_SECONDS: intIn(1, 3_600, 60),
  RATE_LIMIT_READ_MAX: intIn(1, 1_000_000, 120),
  RATE_LIMIT_WRITE_MAX: intIn(1, 1_000_000, 20),
  RATE_LIMIT_UNAUTHENTICATED_MAX: intIn(1, 1_000_000, 30),
  /** Proxy hops trusted for X-Forwarded-For (local nginx: 1; CloudFront -> ALB: 2). */
  TRUST_PROXY_HOPS: intIn(0, 10, 0),
} as const;

type AuthEnvFields = z.output<z.ZodObject<typeof AuthEnvShape>>;

/** Normalised scheme (`https:`, `http:`, …) of a URL string; undefined when it does not parse. */
export function schemeOf(value: string): string | undefined {
  try {
    return new URL(value).protocol;
  } catch {
    return undefined;
  }
}

/** Cross-field rules; call from the composing schema's `superRefine`. */
export function refineAuthEnv(env: AuthEnvFields, ctx: z.RefinementCtx): void {
  const relaxable = allowsLocalRelaxations(env.APP_RUNTIME);
  if (!relaxable && env.AUTH_ALLOW_INSECURE_ISSUER) {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_ALLOW_INSECURE_ISSUER'],
      message: `${LOCAL_ONLY_MESSAGE} (APP_RUNTIME=aws is the default)`,
    });
  }
  const insecureAllowed = relaxable && env.AUTH_ALLOW_INSECURE_ISSUER;
  for (const variable of ['AUTH_ISSUER', 'AUTH_JWKS_URI'] as const) {
    const value = env[variable];
    // Decide on the PARSED scheme: the WHATWG parser lower-cases `HTTP://` and drops
    // tabs/newlines inside the scheme, so a string prefix test can be bypassed.
    if (value && schemeOf(value) === 'http:' && !insecureAllowed) {
      ctx.addIssue({
        code: 'custom',
        path: [variable],
        message:
          'must be an https URL (http only with APP_RUNTIME=local|ci and AUTH_ALLOW_INSECURE_ISSUER=true)',
      });
    }
  }
  // The API only knows the SPA client id through this list, so on AWS the list is
  // mandatory and the audience-vs-client check below always runs (CDK sets the SPA client).
  if (!relaxable && env.AUTH_ALLOWED_CLIENT_IDS.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_ALLOWED_CLIENT_IDS'],
      message:
        'is required when APP_RUNTIME=aws: list the OAuth clients (e.g. the SPA client id) whose tokens the API accepts',
    });
  }
  if (env.AUTH_ALLOWED_CLIENT_IDS.includes(env.AUTH_AUDIENCE)) {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_AUDIENCE'],
      message:
        'must identify the API, not an OAuth client listed in AUTH_ALLOWED_CLIENT_IDS (ID-token confusion)',
    });
  }
}

export interface AuthConfig {
  issuer: string;
  audience: string;
  /** Explicit JWKS URL; undefined = OIDC discovery from the issuer. */
  jwksUri?: string | undefined;
  algorithms: AsymmetricJwsAlgorithm[];
  clockToleranceSeconds: number;
  /** Tokens older than this (after `iat`) are rejected even before `exp`. */
  maxTokenAgeSeconds: number;
  scopes: { read: string; write: string };
  /** `azp`/`client_id` allow-list; empty = any client. */
  allowedClientIds: string[];
  /** True only with APP_RUNTIME local/ci when explicitly enabled (test IdP over http). */
  allowInsecureIssuer: boolean;
}

export interface RateLimitConfig {
  windowSeconds: number;
  /** Per principal and window: GET /v1/*. */
  readMax: number;
  /** Per principal and window: POST /v1/jobs (every non-GET /v1 request). */
  writeMax: number;
  /** Per client IP (IPv6: /64) and window, counting requests that FAIL authentication. */
  unauthenticatedMax: number;
}

export function authConfig(e: AuthEnvFields): AuthConfig {
  return {
    issuer: e.AUTH_ISSUER,
    audience: e.AUTH_AUDIENCE,
    jwksUri: e.AUTH_JWKS_URI,
    algorithms: [...new Set(e.AUTH_ALGORITHMS)],
    clockToleranceSeconds: e.AUTH_CLOCK_TOLERANCE_SECONDS,
    maxTokenAgeSeconds: e.AUTH_MAX_TOKEN_AGE_SECONDS,
    scopes: { read: e.AUTH_SCOPE_READ, write: e.AUTH_SCOPE_WRITE },
    allowedClientIds: [...new Set(e.AUTH_ALLOWED_CLIENT_IDS)],
    allowInsecureIssuer: e.AUTH_ALLOW_INSECURE_ISSUER,
  };
}

export function rateLimitConfig(e: AuthEnvFields): RateLimitConfig {
  return {
    windowSeconds: e.RATE_LIMIT_WINDOW_SECONDS,
    readMax: e.RATE_LIMIT_READ_MAX,
    writeMax: e.RATE_LIMIT_WRITE_MAX,
    unauthenticatedMax: e.RATE_LIMIT_UNAUTHENTICATED_MAX,
  };
}

/** Loggable view (none of these values is secret, but keep the shape explicit). */
export function describeAuthConfig(auth: AuthConfig): Record<string, unknown> {
  return {
    issuer: auth.issuer,
    audience: auth.audience,
    jwksUri: auth.jwksUri ?? 'discovery',
    algorithms: auth.algorithms,
    clockToleranceSeconds: auth.clockToleranceSeconds,
    maxTokenAgeSeconds: auth.maxTokenAgeSeconds,
    scopes: auth.scopes,
    allowedClientIds: auth.allowedClientIds,
    allowInsecureIssuer: auth.allowInsecureIssuer,
  };
}
