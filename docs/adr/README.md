# Architecture Decision Records

Lightweight ADRs (context → decision → consequences). Number ranges group decisions by area:

| Range     | Area                                |
| --------- | ----------------------------------- |
| 0001–0099 | Cross-cutting                       |
| 0100–0199 | Local container runtime and runners |
| 0200–0299 | Application                         |
| 0300–0399 | AWS CDK infrastructure              |
| 0400–0499 | CI/CD & supply chain                |
| 0500–0599 | Policy / security / FinOps          |
| 0600–0699 | Testing / quality                   |

Status values: `Proposed`, `Accepted`, `Superseded by NNNN`. ADR 0005 is superseded by 0210–0213.

Note: always check a new host port against the browser "bad ports" list
(<https://fetch.spec.whatwg.org/#port-blocking>).

## Index

| ADR                                                                   | Decision                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [0001](0001-pnpm-workspaces-without-build-orchestrator.md)            | pnpm workspaces without a build orchestration framework                               |
| [0002](0002-supply-chain-release-age-gate.md)                         | Minimum release age for npm dependencies                                              |
| [0005](0005-end-user-authentication-out-of-scope.md)                  | End-user authentication and authorization are out of scope (deployment blocker)       |
| [0101](0101-rootless-podman-ssh-socket-forwarding.md)                 | Run local containers on rootless Podman via an SSH-forwarded API socket               |
| [0110](0110-protected-runners-and-network-isolation.md)               | Protected and signing runners on their own networks; managers off the job network     |
| [0111](0111-runner-scoped-secrets-and-key-custody.md)                 | Secrets are bound to protected jobs (runner-scoped files), not to protected refs      |
| [0200](0200-contracts-zod-native-openapi.md)                          | API contracts in zod v4 with natively generated OpenAPI 3.1                           |
| [0201](0201-local-workflow-simulator.md)                              | In-process local workflow simulator instead of Step Functions Local                   |
| [0202](0202-idempotency-model.md)                                     | Layered idempotency for job submission and workflow steps                             |
| [0203](0203-plain-sql-migrations.md)                                  | Plain `pg` with versioned SQL migrations (no ORM)                                     |
| [0210](0210-oidc-jwt-validation-and-key-rotation.md)                  | OIDC/JWT bearer authentication of the API, JWKS caching and key rotation              |
| [0211](0211-ownership-authorization-idempotency-scoping-and-audit.md) | Ownership-scoped authorization, principal-scoped idempotency, pagination and audit    |
| [0212](0212-application-rate-limiting.md)                             | Application-level rate limiting (per principal, per client for failed authentication) |
| [0213](0213-spa-sign-in-runtime-config-and-test-idp.md)               | SPA sign-in (code + PKCE, in-memory tokens), runtime configuration and the test IdP   |
| [0220](0220-database-identities-and-bootstrap.md)                     | Least-privilege database identities, a separate bootstrap and owner-run migrations    |
| [0221](0221-rds-iam-authentication-rotation-and-task-lifecycle.md)    | RDS IAM authentication for runtime identities; rotation and ECS task lifecycle        |
| [0222](0222-postgresql-tls-verify-full.md)                            | PostgreSQL TLS: verify-full against a vendored RDS CA bundle, exclusive trust         |
| [0223](0223-data-retention.md)                                        | Data retention: redaction job disabled until an approved policy exists                |
| [0230](0230-claim-check-minimal-execution-input.md)                   | Claim check: minimal workflow input, documents loaded from PostgreSQL                 |
| [0231](0231-stale-job-reconciler.md)                                  | Bounded stale-job reconciler                                                          |
| [0232](0232-mini-stack-test-document-source.md)                       | The integration mini-stack reads synthetic documents from a test table                |
| [0233](0233-dynamodb-audit-retention-disabled-by-default.md)          | DynamoDB audit-record retention: implemented, disabled by default                     |
| [0300](0300-cdk-app-structure.md)                                     | CDK app structure: one Stage per environment, config-driven, strong references        |
| [0301](0301-landing-zone-foundation-imports.md)                       | Landing-zone foundation resources are imported, never created (sandbox is opt-in)     |
| [0302](0302-same-origin-api-via-cloudfront-vpc-origin.md)             | Same-origin API through a CloudFront VPC origin to an internal ALB                    |
| [0303](0303-cdk-nag-v3-policy-hook.md)                                | cdk-nag 3 as CDK validation plugins; specific, audited acknowledgments                |
| [0401](0401-ci-impact-analysis-generated-rules.md)                    | Impact analysis via generated `rules:changes` (no Nx/Turbo, no child pipelines)       |
| [0402](0402-rootless-buildah-container-builds.md)                     | Rootless Buildah in non-privileged jobs; OCI archive as the artifact                  |
| [0403](0403-mandatory-gate-and-truthful-reporting.md)                 | Mandatory gate with success markers; "not configured" is never green                  |
| [0404](0404-advisory-ai-review-pr-agent.md)                           | Advisory AI review with PR-Agent                                                      |
| [0410](0410-gate-integrity-maintainer-only-policy-project.md)         | Gate integrity: a Maintainer-only policy project via `ci_config_path`                 |
| [0411](0411-protected-release-chain-sign-and-verify.md)               | Release chain on protected runners; Cosign sign and independent verification          |
| [0412](0412-scheduled-pipelines.md)                                   | Scheduled pipelines: rescan, stale resources, drift, sweep                            |
| [0501](0501-policy-as-code-engines.md)                                | Policy-as-code engines: cdk-nag pack + CloudFormation Guard                           |
| [0502](0502-finops-gate-and-drift.md)                                 | Offline FinOps gate and opt-in drift detection                                        |
| [0510](0510-governed-suppression-register.md)                         | Governed suppression register for in-code policy acknowledgements                     |
| [0511](0511-synth-time-runtime-settings-rules.md)                     | Synth-time rules for deployed runtime settings, per-stage permissions boundaries      |
| [0600](0600-test-layering-local-simulation-vs-real-aws.md)            | Test layering: local workflow simulation plus an ephemeral real-AWS mini-stack        |
| [0601](0601-rootless-podman-local-containers-and-testcontainers.md)   | Rootless Podman for local containers; Testcontainers without Ryuk                     |
| [0602](0602-emulator-integration-layer.md)                            | Emulator integration layer: socket-less MiniStack, shared guard, governed gaps        |
| [0610](0610-black-box-security-suite.md)                              | Black-box security suite: one suite, two paths, self-started or external              |
