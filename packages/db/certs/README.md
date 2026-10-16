# Vendored Amazon RDS CA bundle

`rds-global-bundle.pem` is the **Amazon RDS global certificate bundle**: the public root CA
certificates RDS uses to sign database server certificates in every commercial AWS Region. With
`DB_SSL=verify-full`, `@starter/db` trusts **only** the certificates in `DB_SSL_ROOT_CERT` (Node's `ca`
option replaces the built-in store) and verifies the server host name (ADR 0222).

| Field          | Value                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| Source URL     | https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem                                    |
| Retrieved      | 2026-10-13T19:43Z, over HTTPS with `curl`                                                            |
| SHA-256        | `fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c`                                   |
| Size           | 169984 bytes                                                                                         |
| Content        | 111 self-signed root CA certificates (no intermediates, no private key)                              |
| Relevant roots | `Amazon RDS ap-southeast-1 Root CA RSA2048 G1` (the CA the CDK instance uses), RSA4096 G1, ECC384 G1 |
| Expiry         | earliest 2061-05-18, latest 2126-08-05                                                               |

`packages/db/test/unit/tls.test.ts` checks the SHA-256 above, parses every certificate and
asserts the `ap-southeast-1` RSA2048 G1 root is present, so an unreviewed edit fails the tests.

## Where it is used

| Consumer                          | Path at runtime                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| API image (and its one-off tasks) | `/app/certs/rds-global-bundle.pem` (`COPY` in `apps/api/Dockerfile`); `DB_SSL_ROOT_CERT` points at it |
| Lambda bundles                    | copied next to each bundle at build time; `DB_SSL_ROOT_CERT` points at the copy                       |
| Node code in the workspace        | `rdsCaBundlePath()` from `@starter/db`                                                                |

## Updating

1. Download the bundle again from the source URL above (HTTPS) into an empty directory.
2. Inspect it: only `BEGIN/END CERTIFICATE` blocks, every block a CA certificate.
3. Replace the file, update the table above (date, SHA-256, size, count) and run
   `pnpm --filter @starter/db test`.

Validated against RDS only once, in a disposable sandbox deployment (`verify-full` with IAM
authentication; `tests/aws-integration/sandbox/`). The bundle choice follows the AWS documentation ("Using SSL/TLS to encrypt a connection to a DB instance").
