# ADR 0213 — SPA sign-in (code + PKCE, in-memory tokens), runtime configuration and the test IdP

- Status: Accepted (implemented and tested locally; not validated against an organization IdP)

## Context

The SPA must keep working for signed-in users, with one build deployed to every stage, without
storing tokens where an XSS can harvest them, and local development and CI need an identity
provider that costs nothing and is reproducible.

## Decision

### SPA (`apps/web/src/auth`)

1. **Hand-rolled OIDC client** (~250 lines) instead of `oidc-client-ts`: the flow is small, has no
   dependency to review, and keeps full control over storage (the library's default user store is
   `sessionStorage`).
2. **Authorization code + PKCE (S256 only)** with `state`, `nonce` and RFC 9207 `iss` checks;
   discovery must report the configured issuer exactly; endpoints must be https (http only when
   the issuer itself is a loopback test IdP).
3. **Storage.** Access token and session in **memory only**; no refresh token is requested or
   stored. `sessionStorage` holds only the pending sign-in (verifier, state, nonce, return route)
   across the redirect, consumed once by the callback (a replayed callback is rejected).
4. **ID token** claims are checked (`iss`, `aud` ∋ client id, `nonce`, `exp`); its signature is not
   verified because it comes straight from the token endpoint over TLS (OIDC Core 3.1.3.7 step 6).
   The API never accepts it (different audience, `nonce` marker — ADR 0210).
5. **Return target**: only same-document hash routes matching `#/[A-Za-z0-9/_.~-]*` (no `//`).
6. **Behaviour**: sign-in page while signed out (no API calls); `Authorization: Bearer` on every API
   call; 401 or token expiry → sign-in page with the route preserved; 403 and 429 get explicit
   messages (`Retry-After` shown); sign-out ends the IdP session via `end_session_endpoint`
   without putting tokens in the URL. A page reload loses the session (by design); the IdP session
   makes the next sign-in a redirect bounce.
7. **Runtime configuration** `/config.json` = `{ auth: { issuer, clientId, scope } }` (no secrets):
   - AWS: answered at the edge by the default behaviour's viewer-request **CloudFront Function**
     generated from the environment config (nothing to upload, cannot drift from the stack);
   - local compose: the nginx web tier renders it from `SPA_AUTH_*`;
   - Vite dev/preview: middleware from `SPA_AUTH_*` (defaults: the local test IdP).
     It is never part of `dist/`, so a deployment can never ship a development configuration; a
     missing file shows "Sign-in is not configured" instead of guessing an IdP.
8. **CSP** adds exactly the issuer origin to `connect-src` (discovery + token endpoint), nothing
   else, never `unsafe-*`. IdPs whose token endpoint lives on another origin (e.g. Amazon Cognito
   hosted UI) need that origin added deliberately.

### Test identity provider (`tools/test-idp`, `@starter/testing/auth`)

1. **In-process issuer** (`@starter/testing/auth`, TEST ONLY): real RS256/ES256 keys in memory; `mint`,
   `mintWith`, `rotate`; `NEGATIVE_TOKEN_CASES` (expired, not yet valid, wrong iss/aud, missing
   aud/sub, foreign key, unknown kid, tampered signature/payload, `alg: none`, HS256 signed with the
   public key, wrong `typ`, embedded `jwk`, `jku`/`x5u`/`x5c` headers, unknown `crit`, SPA ID
   token, `nonce` marker), `INSUFFICIENT_SCOPE`, `OTHER_CLIENT`; `startTestIssuer` serves discovery
   and JWKS over HTTP with request counters and an outage switch.
2. **Server** (`@starter/tool-test-idp`): node:http, one public client, users alice/bob/mallory,
   discovery, JWKS, `/authorize` (code + PKCE S256 only, exact redirect URIs, state + nonce
   required), `/token` (single-use 60 s codes, PKCE checked in constant time), `/logout`, CORS only
   for the registered SPA origins, sign-in page with a TEST ONLY banner, escaped output, strict CSP,
   no framing. `POST /test/token` (claims + negative-case options) and `POST /test/rotate` exist only
   with `TEST_IDP_ENABLE_TEST_ENDPOINTS=true`. **Refuses to start unless `APP_RUNTIME` is `local`
   or `ci`.** Container: pinned build image, distroless non-root runtime, self-contained bundle,
   no runtime value baked in. Never deployed by CDK.
3. **No Keycloak**: a full IdP would cost ~1 GB RAM on the shared Podman VM and minutes of start-up
   for no additional protocol coverage the tests need.

## Consequences

- Same code paths locally, in CI and on AWS; only `/config.json` differs.
- Verified with unit tests (OIDC client incl. every callback rejection, RFC 7636 vector) and
  Playwright in Chromium through the real test IdP (sign-in, deep link restored, per-user isolation,
  sign-out, no tokens in Web Storage). An organization IdP must be validated in an AWS sandbox run.
