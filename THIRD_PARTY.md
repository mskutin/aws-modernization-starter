# Third-party components

This repository is licensed under the MIT License (see [LICENSE](LICENSE)). It does not
redistribute container images or tool binaries: CI jobs, the local stack and the optional scripts
**reference** them by version and digest and pull them from their upstream registries at run time.
The only third-party file committed to the repository is the Amazon RDS CA bundle (below).

License identifiers are the ones published by each upstream project for the referenced version, to
the best of our knowledge. Container images also contain operating-system packages under their own
licenses. Verify the licenses yourself before you redistribute an image or a binary.

## Container images and tools

Pins live in `.gitlab/ci/images.yml` (CI), `local/compose/compose.yaml` (local stack), the
Dockerfiles (`apps/api/Dockerfile`, `tools/test-idp/Dockerfile`), the Testcontainers defaults
(`packages/testing`) and the scripts named in the table. Every image the repository references is
pinned by tag and digest. The runner-registration example in `docs/ci-cd.md` only sets the runner's
fallback image; every job names its own pinned image.

| Component                                                                      | Version (pinned)                              | Used for                                                                                   | License                                                                                                                                    |
| ------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js (`docker.io/library/node`)                                             | 24.21.0 (`-trixie`, `-trixie-slim`)           | CI jobs; build stage of the API and test-IdP images                                        | Node.js: MIT; Debian packages: various                                                                                                     |
| Distroless Node.js (`gcr.io/distroless/nodejs24-debian13`)                     | `nonroot` (digest-pinned)                     | runtime stage of the API and test-IdP images                                               | distroless project: Apache-2.0; Debian packages: various                                                                                   |
| nginx (`docker.io/nginxinc/nginx-unprivileged`)                                | 1.30.5-alpine                                 | local web tier; API proxy integration test                                                 | nginx: BSD-2-Clause; Alpine packages: various                                                                                              |
| PostgreSQL (`docker.io/library/postgres`)                                      | 17.11 (CI, compose, Testcontainers default)   | CI services, local stack, Testcontainers (`packages/testing`)                              | PostgreSQL License; Debian packages: various                                                                                               |
| DynamoDB Local (`docker.io/amazon/dynamodb-local`)                             | 3.3.1                                         | CI services, local stack, Testcontainers                                                   | **Proprietary**: AWS DynamoDB Local license agreement (not open source; review its terms before use)                                       |
| MiniStack (`docker.io/ministackorg/ministack`)                                 | 1.5.26                                        | AWS emulator service of `integration:ministack:*`; local emulator runs                     | MIT                                                                                                                                        |
| AWS Lambda Node.js base image (`public.ecr.aws/lambda/nodejs`)                 | Node.js 24 (digest-pinned)                    | only the opt-in local emulator socket mode (`tests/aws-integration/emulator/_emulator.sh`) | AWS-provided image: Amazon Linux packages and Lambda runtime components under their own licenses                                           |
| curl (`docker.io/curlimages/curl`)                                             | 8.22.0                                        | local DynamoDB table initialisation                                                        | curl license (MIT-style); Alpine packages: various                                                                                         |
| Buildah (`quay.io/buildah/stable`)                                             | v1.43.4                                       | rootless container builds in CI                                                            | Apache-2.0                                                                                                                                 |
| Skopeo (`quay.io/skopeo/stable`)                                               | v1.22.3                                       | image publication in CI; sandbox image copy                                                | Apache-2.0                                                                                                                                 |
| Trivy (`docker.io/aquasec/trivy`)                                              | 0.74.0                                        | dependency and image vulnerability scans                                                   | Apache-2.0                                                                                                                                 |
| Syft (`docker.io/anchore/syft`)                                                | v1.52.0                                       | SBOM generation                                                                            | Apache-2.0                                                                                                                                 |
| Cosign (`gcr.io/projectsigstore/cosign`)                                       | v3.1.3                                        | opt-in image signing and verification                                                      | Apache-2.0                                                                                                                                 |
| hadolint (`docker.io/hadolint/hadolint`)                                       | v2.15.1-alpine                                | Dockerfile lint (tool only; nothing is linked into this project)                           | GPL-3.0                                                                                                                                    |
| gitleaks (`docker.io/zricethezav/gitleaks`)                                    | v8.30.1                                       | secret scanning                                                                            | MIT                                                                                                                                        |
| GitLab SAST Semgrep analyzer (`registry.gitlab.com/security-products/semgrep`) | 6.26.1 (Semgrep 1.174.0, `sast-rules` 2.10.1) | static analysis                                                                            | Semgrep engine: LGPL-2.1; the bundled rules and the analyzer wrapper under their upstream licenses                                         |
| Playwright (`mcr.microsoft.com/playwright`)                                    | v1.63.0-noble                                 | browser end-to-end tests                                                                   | Playwright: Apache-2.0; Ubuntu packages and browsers: various                                                                              |
| PR-Agent (`docker.io/pragent/pr-agent`)                                        | 0.46.0                                        | optional advisory AI review, **off by default** (no job unless enabled)                    | MIT for 0.46.0 (upstream relicensed AGPL-3.0 → Apache-2.0 on 2026-05-20 → MIT on 2026-07-09); re-check the license when you change the pin |
| CloudFormation Guard (binary)                                                  | 3.2.1                                         | policy checks; downloaded and SHA-256-verified by `policies/scripts/install-cfn-guard.sh`  | Apache-2.0                                                                                                                                 |
| Alpine Linux                                                                   | base of the `-alpine` variants above          | —                                                                                          | Alpine packages: various (e.g. musl MIT, BusyBox GPL-2.0)                                                                                  |

Tools you install yourself (not pinned by this repository, except where a script checks the
version): Podman, GitLab Runner, the AWS CLI v2 (the sandbox guard requires a specific version; see
`tools/aws-preflight/README.md`) and the AWS CDK CLI from the lockfile.

## Vendored file: Amazon RDS CA bundle

`packages/db/certs/rds-global-bundle.pem` is the Amazon RDS global certificate bundle: public root
CA certificates, committed unmodified so that database connections can verify the server
certificate offline (`DB_SSL=verify-full`).

| Field     | Value                                                               |
| --------- | ------------------------------------------------------------------- |
| Source    | <https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem> |
| Retrieved | 2026-10-13 (over HTTPS)                                             |
| SHA-256   | `fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c`  |
| Publisher | Amazon Web Services                                                 |

Provenance, contents and the update procedure: [packages/db/certs/README.md](packages/db/certs/README.md).
A unit test checks the SHA-256.

## npm dependencies

npm packages are installed from the registry at the versions in `pnpm-lock.yaml`; none are
vendored. The `licenses` CI job checks every dependency against
`.gitlab/security/license-policy.yaml`. Summary of `pnpm licenses list --recursive` for the
committed lockfile:

- **Runtime and build dependencies** (`dependencies` of the workspace packages): permissive only —
  MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, 0BSD and Unlicense.
- **Development-only dependencies** add MIT-0 and CC0-1.0, plus two that are not permissive
  software licenses:
  - `lightningcss` (and its platform package): **MPL-2.0**, file-level copyleft, pulled in by the
    Vite build tooling and used unmodified;
  - `caniuse-lite`: **CC-BY-4.0**, browser-support data used by the build tooling.

Nothing under GPL, AGPL, LGPL, SSPL or BUSL is an npm dependency (the policy denies them). Rerun
`pnpm licenses list --recursive` after changing the lockfile; the CI job does this on every
pipeline.
