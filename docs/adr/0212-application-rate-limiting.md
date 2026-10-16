# ADR 0212 — Application-level rate limiting (per principal, per client for failed authentication)

- Status: Accepted (implemented and tested locally; per-task semantics documented)

## Context

Every accepted submission starts a Step Functions execution and two Lambda invocations. Dev has no
WAF; staging/prod import a platform-managed web ACL whose content is unknown. The API needs its own limits as
defence in depth, without locking out whole organizations that share a few egress IP addresses.

## Decision

1. **In-repo limiter** (`apps/api/src/auth/rate-limit.ts`, ~100 lines) instead of
   `@fastify/rate-limit` 11.x: the required semantics — a principal key known only after
   authentication, separate read/write budgets, counting only _failed_ authentications per client,
   IETF `RateLimit-*` headers on every `/v1` response, a hard memory bound — would need three plugin
   instances plus custom hooks and four transitive dependencies. A small, fully tested module is
   simpler to review.
2. **Fixed windows aligned to the wall clock** (`RATE_LIMIT_WINDOW_SECONDS`, default 60): the whole
   table is dropped at each window boundary, so memory is bounded by the keys of one window. At most
   50 000 distinct keys are tracked per limiter and window; further keys share one overflow bucket
   (fails towards throttling, never towards unbounded memory; logged once per window).
3. **Budgets** (`onRequest`, after authentication, before the scope check and the body):
   - authenticated: per principal (`sha256(iss|sub)`), `RATE_LIMIT_READ_MAX` (120) for GET/HEAD and
     `RATE_LIMIT_WRITE_MAX` (20) for every other method;
   - failed authentication: per client address — IPv4 as is (also IPv4-mapped), IPv6 by /64 —
     `RATE_LIMIT_UNAUTHENTICATED_MAX` (30). **Only failures count**, and a valid token is never
     throttled by address, so users behind a shared NAT are not locked out by someone else's
     expired tokens.
   - 429 `urn:starter:problem:too-many-requests` + `Retry-After` + `RateLimit-Limit/Remaining/Reset`;
     rejected requests count too (no reward for hammering).
4. **Client address.** `TRUST_PROXY_HOPS` (default 0) = number of trusted proxies in front of the
   task; Fastify 5.12.5 deliberately fails closed for a bare number, so the API passes an explicit
   hop-count function: the client is the n-th `X-Forwarded-For` entry from the right; client-supplied
   (left-most) entries are ignored. CDK sets **2** (CloudFront VPC origin → ALB; the task security
   group admits only the ALB — the precondition for trusting hops). Local nginx: 1. **Local caveat:**
   compose also publishes the API port for direct tests; there a direct client can spoof
   `X-Forwarded-For`, which only changes the key of the failed-authentication budget (local only).
5. **Per-task semantics.** Counters live in each task's memory: with N tasks a client may get up to
   N × the limit, and counters reset on deploys and Spot replacements. The **WAF rate-based rule on
   the CloudFront distribution remains the primary edge control** (required in staging/prod by the
   CDK schema; dev has no WAF — documented). A shared store (ElastiCache/DynamoDB) was rejected:
   new infrastructure and a new failure mode for a defence-in-depth control.
6. Limits may be raised for test suites (compose and CI use 5000/2000/2000), never disabled.

## Consequences

- Floods by one principal stop at the write limit before anything is stored or started (tested);
  other principals are unaffected; rotating `X-Forwarded-For` does not reset the failed-auth budget
  on the direct or the proxied path (tested with real nginx).
- Organizations must size the per-task limits and the WAF rule together; documented in
  docs/landing-zone-adaptation.md.
