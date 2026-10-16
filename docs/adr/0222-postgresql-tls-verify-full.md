# ADR 0222 — PostgreSQL TLS: verify-full against a vendored RDS CA bundle, exclusive trust

- Status: Accepted. Validated once against RDS in a disposable sandbox deployment.
- Related: ADR 0221

## Context

`DB_SSL=require` mapped to `rejectUnauthorized: false`: encrypted, but any certificate was accepted,
so a man-in-the-middle on the database path saw credentials and documents. Locally the
database had no TLS at all.

## Decision

1. **Two modes only:**
   - `verify-full` (default): chain verified against `DB_SSL_ROOT_CERT`, host name verified against
     the SANs.
   - `disable`: accepted only when `APP_RUNTIME` is `local` or `ci`.

   `require`, `prefer` and `verify-ca` are rejected with an explanation. Synth rules require
   `DB_SSL=verify-full` wherever `DB_HOST` is set.

2. **Exclusive trust.** The bundle in `DB_SSL_ROOT_CERT` is passed as Node's `ca`, which replaces the
   built-in store; `NODE_EXTRA_CA_CERTS` cannot widen it (tested in a child process). `pg` sets
   SNI/`servername` to `DB_HOST` (IP SANs for addresses), and Node's `checkServerIdentity` rejects
   mismatches. TLS 1.2 is the minimum.
3. **Bundle validation at start-up.** `loadCaBundle` reads the bundle when the pool is created, so
   start-up fails fast if any of these hold:
   - the file is missing;
   - it has no certificate, or a corrupt one;
   - it contains a non-CA certificate;
   - it contains a private key.

   Errors name the path, never the content.

4. **Vendored Amazon RDS global bundle** in `packages/db/certs/rds-global-bundle.pem`.
   - 111 root CAs, including `Amazon RDS ap-southeast-1 Root CA RSA2048 G1`, which the instance uses.
   - The README records the source URL, the retrieval date and the SHA-256; a unit test checks the
     SHA-256 and the presence of that root.
   - The API image copies it to `/app/certs/rds-global-bundle.pem`, and every task sets
     `DB_SSL_ROOT_CERT` to that path.
   - Lambda bundles copy it next to the bundle, and `iamConnection` takes their path.
5. **Tests that run in CI.**
   - CI jobs have no container socket, so they cannot start a TLS PostgreSQL with fresh keys. They use
     a TLS endpoint the test controls instead: a TLS-terminating PostgreSQL proxy (`@starter/testing`,
     SSLRequest → `S` → TLS → plain backend) in front of the PostgreSQL service.
   - Certificates are generated with `openssl` at test time; no key is committed.
   - Right CA and host connect. A wrong CA fails (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`), and so do a host
     name mismatch, for DNS and IP SANs (`ERR_TLS_CERT_ALTNAME_INVALID`), and plain TCP.
   - Locally, the `containers` project repeats the checks against PostgreSQL's own TLS stack (ssl=on,
     hostssl-only `pg_hba`, `pg_stat_ssl`).
6. **Local compose speaks TLS only.**
   - `bin/dev-up.sh` generates a throw-away CA and a server certificate for
     `postgres`/`localhost`/`127.0.0.1` into the per-user state directory, outside the repository
     (`${STARTER_LOCAL_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/starter-app/compose}/postgres-tls/`,
     `docs/development.md` §4.1). The CA key is discarded after signing.
   - PostgreSQL runs with `ssl=on`, and a hostssl-only `pg_hba.conf` is selected with `-c hba_file`,
     so existing volumes get it too.
   - Every client uses `verify-full`.

## Consequences

- Disabling verification (mutation check) fails 3 TLS integration tests and 1 unit test.
- A CA rotation on RDS requires a new image with the updated bundle _before_ the instance's CA
  changes. The bundle already contains the RSA4096 and ECC384 roots for ap-southeast-1.
- The RDS chain on a real endpoint (intermediate sent by the server, root in the bundle) is
  untested. Verify it on the first AWS run: `SELECT ssl, version FROM pg_stat_ssl` as `starter_app`.
