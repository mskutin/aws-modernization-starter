# 0005 — End-user authentication and authorization are out of scope (deployment blocker)

- Status: **Superseded by [0210](0210-oidc-jwt-validation-and-key-rotation.md)–[0213](0213-spa-sign-in-runtime-config-and-test-idp.md)** The four
  conditions below are implemented and tested locally; validation against an organization IdP on
  AWS is still pending. Original status: Accepted (scope
  decision) — blocks any deployment that holds real data.
- Origin: independent architecture review

## Context

The reference API (`POST/GET /v1/jobs`) has no authentication, authorization or rate
limiting. `GET /v1/jobs` lists every job, `GET /v1/jobs/{id}` returns any job's analysis,
idempotency keys are global, and resources are tagged `DataClassification=Internal`.
Behind CloudFront this would be internet-reachable once deployed. Organizations authenticate
users through their own identity provider (e.g. a corporate IdP via OIDC), which this
sandbox cannot provide or test.

## Decision

End-user identity is **out of scope for this reference**, and the gap is treated as a
**deployment blocker**: no environment may receive real data until all of the following are
implemented and tested against the organization's IdP:

1. **Authentication** — OIDC/JWT validation in the API (issuer, audience, expiry, JWKS
   rotation), or an authenticating edge (ALB OIDC behind a CloudFront-signed origin header)
   with the API trusting only that path.
2. **Authorization and data scoping** — store the caller's subject on the job (expand
   migration); scope `GET /v1/jobs`, `GET /v1/jobs/{id}` and idempotency keys to the caller
   (or an organization-defined group); add 401/403 problem types to `@starter/contracts` (new minor
   version) and handle them in the SPA.
3. **Abuse controls** — WAF rate-based rules on the CloudFront distribution (the landing zone's WAF
   ACL is imported in staging/prod; dev has none), plus API-side limits as defence in depth.
4. **Audit** — log the authenticated subject with every state change (never the document).

## Consequences

- The reference demonstrates delivery, infrastructure and policy patterns, not an
  access-controlled service. `README.md`, `docs/limitations.md` and `docs/architecture.md`
  state this prominently.
- Raw failure causes are already hidden from clients (`publicJobError`); that
  does not compensate for the missing identity layer.
