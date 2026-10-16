# ADR 0610 — Black-box security suite: one suite, two paths, self-started or external

- Status: Accepted
- Related: ADR 0600,
  `docs/testing.md` §4

## Context

The P0 controls (authentication, ownership, scoped idempotency, rate limits, leakage) must be
**proved**: a test passes only when the control rejects the attack, and the same rules must hold
directly against the API and through the web-facing proxy. The existing integration suite tests
behaviour, not hostile input. CI jobs have no container socket, the local compose stack is shared
with other work, and the test IdP and other components were still being built.

## Decision

1. **One package, `@starter/tests-security`, parameterised by target.** Every suite runs once per
   target: `direct` (the API) and `proxy` (the web tier). Assertions are black-box HTTP only.
   Tokens come through one contract, the test IdP's `POST /test/token` (claims + `MintOptions`),
   so every negative case of `@starter/testing/auth` works in both modes.
2. **Self-started mode (`SECTEST_MODE=self`) for CI and proofs.** The suite starts what it tests,
   on the stores CI already provides: the BUILT API as separate processes per configuration.
   - `TRUST_PROXY_HOPS=0` direct;
   - `TRUST_PROXY_HOPS=2` behind two `X-Forwarded-For`-appending proxies (the CloudFront → ALB
     chain of the CDK app);
   - a low-limit pair for exhaustion tests;
   - an own-issuer API for JWKS outage tests;
   - an API whose real Step Functions SDK client talks to a capturing fake through
     `AWS_ENDPOINT_URL_SFN`.

   Tests never share mutable state: there are dedicated processes for rate limits and IdP outages,
   and a unique principal per suite and run.

3. **External mode (`SECTEST_MODE=external`) for running stacks**, such as compose via `test-all.sh`
   (the real nginx), and later a deployed sandbox. Store assertions run where store endpoints are
   given.
4. **Canaries.** Each canary is a title, a whole sentence and a non-term token, lower case
   and containing separators, so derived terms can never match one. They are written to
   `canaries.json` for the artifact scanner. Assertions report redacted findings only, so JUnit
   reports stay publishable.
5. **Gates are explicit.**
   - Checks that depend on other work (workflow spec 2.0.0) skip, with the reason in the
     test name.
   - Absent stores also skip.
   - `SECTEST_REQUIRE_ALL=1` turns every skip into a failure (set in CI).
6. **Mutation runs as evidence.** The suite is run by hand against:
   - the API without authentication;
   - builds with the owner predicate removed;
   - builds without principal-scoped idempotency keys;
   - misconfigurations: XFF trust, no client allow-list.

   Each must fail the checks it targets (`docs/testing.md` §4).

## Consequences

- One CI job, `integration:tests-security` (generated from `components.yaml`), proves the controls
  on every relevant MR without a container socket. `security:artifact-scan` and
  `security:image-config:api` add leakage and image-config checks over artifacts.
- The proxy in self mode is a simulation of forwarding semantics, not of CloudFront, the WAF or the
  ALB. Edge behaviour stays an AWS sandbox item.
- External mode needs a raised `RATE_LIMIT_UNAUTHENTICATED_MAX`, because the negative matrix fails
  authentication about 60 times per target from one address. Limit exhaustion is therefore proven
  in self mode only.
- Six API processes take about 70 s per run including the JWKS outage test, which waits for the
  API's fixed 30 s refetch cooldown. JWKS cache parameters are not configurable by environment, so
  the max-age expiry of a rotated-out key is covered by the API's unit tests, not
  black-box.

## Amendment: audit trail, disconnects, start-up refusal

- A seventh API process (`gated`) uses its own fake Step Functions, which can hold
  `StartExecution`. A `POST /v1/jobs` is then caught after the job row exists and before the
  response, so the suite can prove that a client that goes away still yields exactly one
  audit event, outcome `aborted`. The disconnect is a half-close: the client sends FIN and waits for
  the API's FIN, which proves the API has seen the disconnect while its handler is still held. No
  timing assumption is involved.
- "Exactly one audit event" is decided by a sentinel request sent after every response arrived:
  one process logs in order, so once the sentinel's event is in the log a duplicate would be too.
- Start-up refusal is tested on the built server with an environment that is valid
  for `APP_RUNTIME=aws` except for the setting under test, asserting the exact list of refused
  variables. These environments point nothing at AWS.
- With workflow spec 2.0.0 on `main`, CI runs the suite with `SECTEST_REQUIRE_ALL=1`: a check that
  cannot run fails instead of skipping.
