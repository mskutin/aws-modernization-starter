# ADR 0210 — OIDC/JWT bearer authentication of the API, JWKS caching and key rotation

- Status: Accepted (tested locally and, with a test issuer, in a disposable sandbox deployment; **not validated against an organization IdP**)
- Supersedes: the "out of scope" decision of ADR 0005 (items 1 and 3 there; see ADRs 0211–0213)

## Context

The API was anonymous. The organization IdP is an OpenID Connect provider we cannot run or test
here. The API must accept only access tokens that the trusted issuer signed for it, survive IdP
outages and key rotation, and never become a fetch amplifier against the IdP. Local development and
CI must run without paid services.

## Decision

1. **Library.** `jose` 6.2.12 (panva; MIT, no dependencies, no install scripts) for JWS verification
   and JWK handling. No home-grown cryptography.
2. **Mandatory checks** (`apps/api/src/auth/verifier.ts`), all before any handler or body parsing
   (Fastify `onRequest` in the `/v1` plugin, so an anonymous 512 KiB POST gets 401, not 413):
   - `Authorization: Bearer <JWS compact>`, at most 8 KiB;
   - `alg` in an **asymmetric allow-list** (`AUTH_ALGORITHMS`, default `RS256,ES256`), checked
     before any key lookup. `none` and `HS*` are impossible three times over: the config schema
     refuses them, the verifier refuses to be constructed with them, and the JWKS resolver drops
     symmetric (`oct`) and private keys;
   - signature against the issuer JWKS, key selected by `kid`; several keys matching a token
     without `kid` → rejected (OIDC Core 10.1). Header-supplied keys (`jwk`, `jku`, `x5u`, `x5c`)
     are never used or fetched; an unknown `crit` parameter is rejected;
   - exact `iss` (string comparison, no normalisation) and `aud` (string or array member);
     `exp`, `iat` and `sub` required; `exp`/`nbf`/`iat` with `AUTH_CLOCK_TOLERANCE_SECONDS`
     (default 30, max 120). **Maximum token age**: a token is accepted until
     min(`exp`, `iat` + `AUTH_MAX_TOKEN_AGE_SECONDS`), default **3600 s** (60–86400; CDK
     `auth.maxTokenAgeSeconds`), and an `iat` in the future beyond the tolerance is rejected. A
     misconfigured IdP lifetime or a long-lived token minted with a stolen key is thereby bounded
     by the API itself; set the maximum ≥ the IdP's access-token lifetime;
   - `typ`, when present, must be `at+jwt` or `JWT`. **ID-token confusion** is closed three ways:
     the API audience must differ from the SPA client id (validated by the API config against
     `AUTH_ALLOWED_CLIENT_IDS` and by the CDK schema against `auth.spaClientId`), a `nonce` claim
     (ID-token marker) is rejected, and the `azp`/`client_id` allow-list
     (`AUTH_ALLOWED_CLIENT_IDS`; CDK sets the SPA client) rejects tokens of other clients. The
     allow-list is how the API learns the SPA client id, so with `APP_RUNTIME=aws` it is
     **required**: the audience ≠ client check therefore always runs on AWS, also
     outside CDK. Only `local`/`ci` may leave it empty (any client of the trusted test issuer);
   - `sub` a non-empty string, ≤ 255 characters, no control characters.
3. **Answers.** Every failure is the same 401 `urn:starter:problem:unauthorized` with
   `WWW-Authenticate: Bearer realm="starter-api"` (+ `error="invalid_token"` when a token was
   presented); the reason code goes to the audit log only (ADR 0211). Valid token without the
   operation's scope (`jobs:read` for GET, `jobs:write` for POST; `scope` string or `scp`) → 403
   `forbidden` with `error="insufficient_scope", scope="…"`.
4. **Keys** (`RemoteJwksSource`, `apps/api/src/auth/key-source.ts`):
   - OIDC discovery from `AUTH_ISSUER` (the document's `issuer` must equal it exactly) or
     `AUTH_JWKS_URI`; `https:` for the issuer, discovery and JWKS — also a discovered `jwks_uri`.
     The rule is decided on the **parsed** scheme (`new URL(…).protocol`), never on a string
     prefix: `HTTP://`, `hTtP://` or a tab inside the scheme are refused like `http://`.
     It is enforced twice: by the config at start-up (`AUTH_ISSUER`, `AUTH_JWKS_URI`) and
     by the key source for every URL it fetches (the discovery URL at construction, the
     discovered `jwks_uri` before it is used);
   - fetch timeout 3 s, **no redirects**, response cap 256 KiB, at most 100 keys;
   - cache max-age 10 min (stale-while-revalidate: background refresh), so a key the IdP withdrew
     stops verifying within ~10 minutes of the IdP publishing that;
   - **one global cooldown of 30 s for every fetch attempt** — success or failure, any reason. An
     unknown `kid` triggers at most one refetch per cooldown; a flood of random `kid`s therefore
     causes at most one fetch per 30 s (tested with 200 concurrent tokens), and a failing IdP is
     not hammered either. Concurrent callers share the in-flight fetch;
   - **stale-while-error**: a failed refresh keeps the last good key set, for at most 24 h; keys
     cannot change while the IdP is unreachable;
   - no usable key (never loaded, or older than 24 h, or the refetch for an unknown `kid` failed)
     → **503** `service-unavailable` + `Retry-After`, not 401 (an outage must not send every SPA
     into a login loop);
   - keys are loaded lazily with a non-blocking warm-up at start-up: an IdP outage never blocks
     start-up, liveness or readiness. `/health/ready` keeps its contract (PostgreSQL + DynamoDB);
     the ALB checks liveness (deployment alarm unchanged). Operators alarm on the
     `issuer signing keys could not be fetched` log line / 503 rate.
5. **Rotation.** Publish-then-sign rotation works without coordination: the first token with the
   new `kid` triggers a refetch (cooldown permitting); a removed key stops verifying at the next
   refresh (unknown-`kid` refetch or max-age).
6. **No authentication switch.** There is no configuration that disables authentication. The only
   relaxation is `AUTH_ALLOW_INSECURE_ISSUER=true` (http issuer/JWKS for the local test IdP),
   accepted only with `APP_RUNTIME=local|ci` (runtime.ts) — never keyed on `NODE_ENV`, which
   is `production` in the image, compose and CI. CDK never sets either (rule BASE-ECS-008).

### Alternatives considered

- `jose.createRemoteJWKSet`: refetches on every request after a failed fetch (no failure
  cooldown) and drops the cached set when a refresh fails after max-age → rejected for the outage
  and amplification properties above; its local resolver (`createLocalJWKSet`) is used.
- ALB `authenticate-oidc`: session-cookie based, browser-only, and the ALB is internal behind a
  CloudFront VPC origin; the API serves bearer tokens to the SPA and other clients → rejected.
- API Gateway JWT authorizer: a new component and a new edge path → out of scope (no new
  architecture for this decision).

## Consequences

- An organization must register an API audience distinct from the SPA client, and the app subnets must
  reach the IdP's discovery/JWKS endpoints over HTTPS (NAT or egress proxy — Node's `fetch` does
  not use `HTTPS_PROXY` by default). Both are landing-zone platform inputs (docs/landing-zone-adaptation.md).
- Tokens are validated offline (no introspection): a revoked token stays usable until `exp`;
  short access-token lifetimes are the mitigation (IdP setting).
- Verified locally with a TEST-ONLY issuer (ADR 0213): unit tests, integration tests over HTTP with
  real PostgreSQL/DynamoDB Local, the built server process, and through the nginx web tier.
  Nothing here proves the behaviour of a specific organization IdP or of AWS networking.
