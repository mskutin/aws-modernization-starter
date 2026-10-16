/**
 * Fastify wiring of authentication, rate limiting and scope checks for the `/v1` routes
 * (ADR 0210, 0212). Registered inside the `/v1` plugin, so it applies to every `/v1` route
 * AND to the `/v1` not-found handler (anonymous callers learn nothing, not even 404 vs 405).
 *
 * One `onRequest` hook, i.e. before the body is read or validated:
 *   1. verify the bearer token (503 if the issuer keys are unavailable);
 *   2. failure → count against the client address (IPv6 /64); 429 once that budget is spent,
 *      else 401 with the RFC 6750 challenge. Valid tokens are never throttled by address, so
 *      users behind a shared NAT are not locked out by someone else's failures;
 *   3. success → count against the principal (read: GET/HEAD, write: everything else);
 *      429 when exhausted; RateLimit-* headers on every response;
 *   4. 403 when the token lacks the operation's scope.
 *
 * `onSend` and `onResponse` hooks in the same context write exactly one audit event per `/v1`
 * request, also when the client disconnects before the response finished
 * (audit.ts).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  forbiddenProblem,
  rateLimitHeaders,
  serviceUnavailableProblem,
  tooManyRequestsProblem,
  unauthorizedProblem,
} from '../problem.js';
import { auditReplySending, emitAudit, openAudit } from './audit.js';
import { AuthUnavailableError } from './key-source.js';
import type { Principal } from './principal.js';
import { FixedWindowRateLimiter, clientAddressKey } from './rate-limit.js';
import type { VerificationResult } from './verifier.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the `/v1` authentication hook; null outside `/v1`. */
    principal: Principal | null;
  }
}

export interface AuthDeps {
  verifier: { verifyAuthorizationHeader(header: string | undefined): Promise<VerificationResult> };
  scopes: { read: string; write: string };
  rateLimit: {
    windowSeconds: number;
    readMax: number;
    writeMax: number;
    unauthenticatedMax: number;
  };
  /** Epoch milliseconds (tests). */
  now?: () => number;
  /** Distinct keys tracked per limiter and window (tests). */
  maxTrackedKeys?: number;
}

const isReadMethod = (method: string) => method === 'GET' || method === 'HEAD';

export function registerAuthentication(app: FastifyInstance, deps: AuthDeps): void {
  const limiter = (max: number) =>
    new FixedWindowRateLimiter({
      windowMs: deps.rateLimit.windowSeconds * 1000,
      max,
      ...(deps.maxTrackedKeys ? { maxKeys: deps.maxTrackedKeys } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  const failedAuth = limiter(deps.rateLimit.unauthenticatedMax);
  const reads = limiter(deps.rateLimit.readMax);
  const writes = limiter(deps.rateLimit.writeMax);

  const checkOverflow = (request: FastifyRequest, bucket: string, l: FixedWindowRateLimiter) => {
    if (l.takeOverflowNotice()) {
      request.log.warn({ rateLimit: bucket }, 'rate-limit key table full: using the shared bucket');
    }
  };

  app.decorateRequest('principal', null);
  app.decorateRequest('audit', null);

  app.addHook('onRequest', async (request, reply) => {
    const audit = openAudit(request, reply);
    const deny = (reason: string) => Object.assign(audit, { denied: { reason } });

    let result: VerificationResult;
    try {
      result = await deps.verifier.verifyAuthorizationHeader(request.headers.authorization);
    } catch (error) {
      if (error instanceof AuthUnavailableError) {
        deny('keys_unavailable');
        request.log.warn('issuer keys unavailable: answering 503');
        throw serviceUnavailableProblem(
          'A backing service is temporarily unavailable. Please retry.',
        );
      }
      throw error;
    }

    if (!result.ok) {
      const decision = failedAuth.consume(clientAddressKey(request.ip));
      checkOverflow(request, 'unauthenticated', failedAuth);
      if (!decision.allowed) {
        deny(`rate_limited:${result.reason}`);
        request.log.warn({ rateLimit: 'unauthenticated' }, 'rate limit exceeded');
        throw tooManyRequestsProblem(decision);
      }
      deny(result.reason);
      throw unauthorizedProblem(result.tokenPresented, rateLimitHeaders(decision));
    }

    const { principal } = result;
    request.principal = principal;
    const read = isReadMethod(request.method);
    const bucket = read ? reads : writes;
    const decision = bucket.consume(principal.key);
    checkOverflow(request, read ? 'read' : 'write', bucket);
    reply.headers(rateLimitHeaders(decision));
    if (!decision.allowed) {
      deny('rate_limited');
      request.log.warn(
        { rateLimit: read ? 'read' : 'write', principal: principal.id },
        'rate limit exceeded',
      );
      throw tooManyRequestsProblem(decision);
    }

    const required = read ? deps.scopes.read : deps.scopes.write;
    if (!principal.scopes.has(required)) {
      deny('insufficient_scope');
      throw forbiddenProblem(required);
    }
  });

  // One audit event per /v1 request, whatever the outcome, even if the client is gone
  // by the time the handler settles (`onResponse` never runs then).
  app.addHook('onSend', async (request, reply, payload) => {
    auditReplySending(request, reply);
    return payload;
  });
  app.addHook('onResponse', async (request, reply) => {
    emitAudit(request, reply);
  });
}

/** The caller of a `/v1` route. Fails closed (401) if the hook did not run. */
export function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) throw unauthorizedProblem(false);
  return request.principal;
}
