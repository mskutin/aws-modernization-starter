# @starter/tool-test-idp — TEST ONLY OpenID Connect provider

A deliberately small OpenID Connect provider for local development, CI and the AWS sandbox
operator host: authorization code + PKCE (S256) for the SPA, a JWKS for the API, three test users
(`alice`, `bob`, `mallory`) and, when enabled, `POST /test/token` and `POST /test/rotate` for the
test suites. It refuses to start unless `APP_RUNTIME` is `local` or `ci`, and it is never deployed.
Never use it with real users or data.

Configuration: see the header of [`src/config.ts`](src/config.ts) (`APP_RUNTIME`, `TEST_IDP_*`).
Local use with compose and CI: [`docs/development.md`](../../docs/development.md).

## AWS sandbox: static issuer, local minting

The sandbox has no hosted identity provider. Tokens carry real ES256 signatures and the deployed
API verifies them against a public JWKS over HTTPS, but nothing on AWS can mint a token:

| Where                                          | What                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sandbox-TestIssuer` (S3 + CloudFront, public) | Exactly two public files: `/.well-known/openid-configuration` and `/jwks.json`, written by `sandbox-issuer export`. No `/authorize`, `/token` or `/test/*` on AWS.                                                                                                              |
| `Sandbox-Api`                                  | `AUTH_ISSUER=https://<issuer domain>`, `AUTH_JWKS_URI=https://<issuer domain>/jwks.json`, `AUTH_AUDIENCE=starter-jobs-api-sandbox`, `AUTH_ALLOWED_CLIENT_IDS=starter-web-sandbox`, `AUTH_ALGORITHMS=ES256` (unchanged verifier: exact `iss`/`aud`, `iat`/`exp`, `kid` in JWKS). |
| `Sandbox-Frontend` `/config.json`              | `{"auth":{"issuer":"https://<issuer domain>","clientId":"starter-web-sandbox","scope":"openid jobs:read jobs:write"}}` (public values only).                                                                                                                                    |
| Operator host, `127.0.0.1:9400`                | This IdP with the run's private key (`TEST_IDP_SIGNING_KEY_FILE`) and `TEST_IDP_ISSUER=https://<issuer domain>`: `/test/token` for smoke and the security suite; `/authorize`, `/token`, `/logout` for browser E2E through Playwright routing.                                  |

### Key file rules (`TEST_IDP_SIGNING_KEY_FILE`)

- A private EC P-256 JWK (ES256). The IdP signs with it instead of an in-memory RS256 key; `kid` is
  the RFC 7638 thumbprint of the public key, so it is the same in the export and in every token.
- Refused unless it is a regular file (not a symlink), mode exactly `0600`, owned by the current
  user, at most 16 KiB, a consistent P-256 private key, and outside any git work tree and this
  repository. `keygen` enforces the same location rule, creates the file `0600` and never
  overwrites.
- A key-file IdP must listen on loopback (`TEST_IDP_HOST` = `127.0.0.1`, `::1` or `localhost`):
  tokens signed with a published key are never mintable off-host. It also answers only requests
  whose `Host` is `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` (else `421`), and
  `POST /test/*` only with `content-type: application/json` (else `415`), so a DNS-rebinding page
  in the operator's browser cannot mint tokens.
- `POST /test/rotate` answers `409 rotation_unavailable` (the published JWKS is a static file).
  To rotate, generate a new key, export and upload again (see "Revoking the key" below).
- `TEST_IDP_ISSUER` and `export --issuer` are normalised by the same function to an origin
  (lower-case host, no default port, no trailing slash), so both always carry the same `issuer`.
- Location: `${SANDBOX_HOME:-$HOME/.config/starter-aws-sandbox}/runs/<runId>/issuer-key.jwk` (run
  directory mode 0700). Never committed, never uploaded, never put into SPA assets.

### Commands

```bash
# Once per checkout (the CLI and the server run from dist/).
pnpm --filter "@starter/tool-test-idp..." build

RUN_ID=sbx-0a1b2c                                      # the lifecycle run id
RUN_DIR="${SANDBOX_HOME:-$HOME/.config/starter-aws-sandbox}/runs/$RUN_ID"
install -d -m 0700 "$RUN_DIR"

# 1. Per-run key (stdout: {"kid":…,"alg":"ES256","out":…}; never key material).
node tools/test-idp/dist/sandbox-issuer.js keygen --out "$RUN_DIR/issuer-key.jwk"

# 2. After Sandbox-TestIssuer is deployed: its IssuerUrl output, an https origin without a path.
ISSUER="https://<issuer distribution domain>"
node tools/test-idp/dist/sandbox-issuer.js export \
  --issuer "$ISSUER" --key "$RUN_DIR/issuer-key.jwk" --out "$RUN_DIR/issuer-docs"
#    writes <out>/openid-configuration → s3 key .well-known/openid-configuration
#           <out>/jwks.json            → s3 key jwks.json          (both application/json)
#    stdout lists {file, key, contentType} for each; the JWKS holds only kty/crv/x/y/kid/alg/use.

# 3. Upload (operator only, through the account guard), e.g.:
#    guarded "upload issuer documents" -- aws s3 cp "$RUN_DIR/issuer-docs/openid-configuration" \
#      "s3://$ISSUER_BUCKET/.well-known/openid-configuration" \
#      --content-type application/json --cache-control no-cache
#    guarded "upload issuer documents" -- aws s3 cp "$RUN_DIR/issuer-docs/jwks.json" \
#      "s3://$ISSUER_BUCKET/jwks.json" --content-type application/json --cache-control no-cache

# 4. The local IdP (foreground, or background with its pid recorded in the run directory).
SPA="https://<frontend distribution domain>"
APP_RUNTIME=local \
TEST_IDP_HOST=127.0.0.1 TEST_IDP_PORT=9400 \
TEST_IDP_ISSUER="$ISSUER" \
TEST_IDP_SIGNING_KEY_FILE="$RUN_DIR/issuer-key.jwk" \
TEST_IDP_AUDIENCE=starter-jobs-api-sandbox \
TEST_IDP_CLIENT_ID=starter-web-sandbox \
TEST_IDP_REDIRECT_URIS="$SPA/" \
TEST_IDP_ENABLE_TEST_ENDPOINTS=true \
  node tools/test-idp/dist/server.js
#    start-up log: {"signingKey":{"source":"file","alg":"ES256","kid":"…"}, …} — the kid must equal
#    the keygen kid and the one served at "$ISSUER/jwks.json".

# 5. Live checks mint through the local IdP (tokens are never printed):
BASE_URL="$SPA" TEST_IDP_URL=http://127.0.0.1:9400 node tests/smoke/dist/cli.js
# (the ALB answers only CloudFront: the API is reached through the frontend distribution)
SECTEST_MODE=external WEB_BASE_URL="$SPA" TEST_IDP_URL=http://127.0.0.1:9400 \
  AUTH_AUDIENCE=starter-jobs-api-sandbox pnpm --filter @starter/tests-security test:security
E2E_AUTH_MODE=aws-test-issuer E2E_ISSUER="$ISSUER" E2E_IDP_URL=http://127.0.0.1:9400 \
  WEB_BASE_URL="$SPA" pnpm --filter @starter/tests-e2e test:e2e

# 6. Teardown: stop the IdP, delete the key (the issuer stack is destroyed with the run).
rm -f "$RUN_DIR/issuer-key.jwk"
```

`POST /test/token` defaults `client_id` to `TEST_IDP_CLIENT_ID` (so the API's client allow-list
accepts it like a code-flow token), `aud` to `TEST_IDP_AUDIENCE`, `scope` to `jobs:read jobs:write`
and the lifetime to `TEST_IDP_TOKEN_TTL_SECONDS` (600 s); every negative-case option of
`@starter/testing/auth` (`MintOptions`) works with the key file too.

### Browser E2E: Playwright routing

The SPA's real discovery request goes to the issuer distribution; its `authorization_endpoint`,
`token_endpoint` and `end_session_endpoint` point at the issuer too, where nothing answers on AWS.
[`tests/e2e/support/aws-auth.ts`](../../tests/e2e/support/aws-auth.ts) routes exactly
`${E2E_ISSUER}/authorize`, `/token` and `/logout` of each browser context to the local IdP (in the
Playwright Node process) and fulfils the browser with the IdP's response:

```ts
import { installAwsTestIssuerRoutesFromEnv } from '../support/aws-auth.js';
await installAwsTestIssuerRoutesFromEnv(context); // no-op unless E2E_AUTH_MODE=aws-test-issuer
```

Install it on every context, including ones a spec creates with `browser.newContext()`. The sign-in
page is shown at `https://<issuer>/authorize` and posts to a relative `/authorize`, so the form
submission is routed as well; its `302` to the SPA, the SPA itself, `/config.json`, discovery, JWKS
and the API all go over the network. The browser never contacts `127.0.0.1` (no mixed content, no
Private Network Access preflight).

Offline self-test of this routing before a billed run (Chromium, `openssl`, no AWS, no internet):
`pnpm build && pnpm --filter @starter/tests-e2e run test:aws-auth-offline` (see
[`tests/e2e/support/aws-auth.offline.ts`](../../tests/e2e/support/aws-auth.offline.ts)).

### Threat notes

- **No public minting.** Only the two public documents are on AWS. Minting (`/test/token`) and
  sign-in exist only on the operator's loopback interface, enforced for key-file mode (listen
  address, `Host` check, JSON-only test endpoints).
- **The private key never leaves the host.** `export` writes only public members and asserts that no
  `d`/`p`/`q`/`dp`/`dq`/`qi`/`oth`/`k` member is present; the SPA receives only issuer, client id and
  scope. The key file is 0600, outside the repository, and deleted at teardown.
- **Residual risk:** any process running as the operator's user can read the key and mint tokens
  the sandbox API accepts until the key is revoked (synthetic data only, short-lived stack).
- **Revoking the key.** The API keeps the last JWKS it fetched successfully in memory
  (`apps/api/src/auth/key-source.ts`). It refreshes it in the background after 10 min, and at most
  once per 30 s when a token names an unknown `kid`. When a refresh FAILS it keeps the old keys for
  up to 24 h. A failed refresh includes: distribution deleted, object missing, `{"keys":[]}` (a set
  without usable keys counts as a failure), or a network error. Therefore:
  - Destroying `Sandbox-TestIssuer`, or deleting or emptying `jwks.json`, does **not** revoke the
    key while the API tasks keep running.
  - Revocation is one of:
    - remove the issuer (destroy `Sandbox-TestIssuer`, or delete `jwks.json`) AND restart or
      redeploy the API tasks. A new task has no cached keys, so every `/v1` call then gets `503`.
      `down` removes the API together with the run;
    - publish a JWKS that holds only a NEW key (`keygen` + `export` + upload + invalidation). The
      next successful refresh drops the old `kid`. That refresh is triggered by the first request
      after the cached set is 10 min old, or at once by a token that names the new key;
    - wait out the cache: 24 h after the issuer became unreachable.
- **CloudFront caching:** upload with `cache-control: no-cache` (or invalidate) so a re-export is
  visible to the API's next refresh.
- **Discovery CORS:** the browser reads `/.well-known/openid-configuration` cross-origin, so the
  issuer distribution must send `Access-Control-Allow-Origin` (`*` is fine for these public files);
  without it the SPA reports that the identity provider is not reachable.
