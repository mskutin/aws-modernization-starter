# Customizing the starter

What to change when you adopt the repository for your own project: names, components, the AWS
region, the landing-zone wiring and the CI configuration. Run the full gate after each step
(`pnpm format:check && pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm ci:check`).

## 1. Renaming the project

There is no single switch: the project name appears as an npm scope, as resource and tag prefixes,
and in a few fixed identifiers. Rename **before** your first deployment; renaming deployed resources,
tag keys or database roles later is a migration, not a search-and-replace.

| Identifier                                                                                                  | Where it is defined                                                                                                                                                    | Notes                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| npm scope `@starter/`                                                                                       | every `package.json` `name`, imports, `components.yaml` `package:` fields, `pnpm --filter` commands in scripts and docs                                                | after renaming run `pnpm install` (updates the lockfile) and `pnpm ci:generate` (regenerates `.gitlab/ci/generated/components.yml`) |
| Root package name `aws-modernization-starter`                                                               | `package.json`, the `Project` tag in `infra/environments/*.ts`                                                                                                         | the `Project` tag also filters the AWS Budgets                                                                                      |
| Resource prefix (`starter-dev`, …)                                                                          | `resourcePrefix` in `infra/environments/<env>.ts` (validated: lowercase, 3–21 characters)                                                                              | prefixes stack, log-group and resource names per environment                                                                        |
| CDK bootstrap qualifier `starter`                                                                           | `cdkBootstrapQualifier` in `infra/environments/<env>.ts`; `-c qualifier` / `AWS_INTEGRATION_CDK_QUALIFIER` for the mini-stack                                          | must match the bootstrap stack approved for each account                                                                            |
| Tag keys `starter:ephemeral`, `starter:run-id`, `starter:expires-at`, `starter:experiment`                  | `infra/lib/tagging.ts`                                                                                                                                                 | also used by the sweeper, the cleanup verifier and the sandbox scripts under `tests/aws-integration/` and `tools/aws-sandbox`       |
| Database roles `starter_owner`, `starter_migrator`, `starter_app`, `starter_processor`, `starter_retention` | `packages/db` (bootstrap) and the SQL migrations in `apps/api/migrations/`                                                                                             | applied migrations are immutable; on an existing database add a new migration instead                                               |
| Environment variable prefix `STARTER_`                                                                      | CI variables (`.gitlab-ci.yml`, `.gitlab/ci/`), local compose (`local/compose/`), emulator scripts, CDK overrides (`STARTER_ACCOUNT_ID_<ENV>`, `STARTER_REGION_<ENV>`) | the gate-integrity and secrets-binding checks match these names; update `tools/ci` together with the YAML                           |
| OIDC audience and client ids (`starter-jobs-api`, `starter-web-local`, …)                                   | `infra/environments/*.ts` (`auth`), local compose, the test IdP                                                                                                        | replace with your identity provider's registrations                                                                                 |
| Local names (`starter-app` compose project, `localhost/starter-app/*` images)                               | `local/compose/`                                                                                                                                                       | local only                                                                                                                          |
| Container image name `starter/api`                                                                          | `components.yaml` (`build.artifact.image`)                                                                                                                             | the published image path in your registry                                                                                           |
| Placeholders (`starter-placeholder-*`, `*.starter.example.com`, account `000000000000`)                     | `infra/environments/placeholders.ts` and the environment files                                                                                                         | replaced by real values in step 4, not renamed                                                                                      |

A practical order: rename the npm scope and run `pnpm install`, rebuild and run the gate; then the
infrastructure prefixes and tags, and check `pnpm --filter @starter/infra test` (the snapshot and
assertion tests show every changed name); then the CI variable prefix together with `tools/ci`;
finally the local and documentation names.

## 2. Adding a component

Components are declared once in `components.yaml`; CI jobs, impact rules and the gate wiring are
generated from it.

1. Create the workspace package (`apps/…`, `functions/…`, `packages/…`) with the standard scripts
   `build`, `typecheck`, `test` and `test:unit` (Vitest), `"type": "module"`, extending
   `../../tsconfig.base.json`.
2. Add one entry to `components.yaml`: `id`, `kind`, `path`, `package`, `owner`; for deployables a
   `deploy` block (stack, strategy, health checks, rollback); for a container image also
   `build.artifact` with `type: container-image`, `dockerfile` and `image`; for a Lambda bundled by
   CDK a `dependsOn` from `infra` (or a `workspace:` dependency) so infrastructure checks re-run
   when it changes.
3. Run `pnpm ci:generate` and commit `components.yaml` together with
   `.gitlab/ci/generated/components.yml`. `pnpm ci:check` fails while the generated file is stale.
4. Wire the CDK construct in `infra/` and add its tests; for a workflow step, change the spec in
   `workflows/processing/src/spec.ts` first ([contracts.md](contracts.md) §2).

The generated jobs include `test:<id>`, change rules with transitive dependencies, gate wiring and,
for container images, the full lint/build/scan/SBOM/provenance/publish chain (signing when enabled).
A path that `components.yaml` does not map fails the `impact` job: map new top-level files under
`nonComponent` or `global`. Details: [ci-cd.md](ci-cd.md) §2 and §6; an application-level walkthrough
for a new Lambda is in [development.md](development.md) §7.

## 3. Region

The default deployment region is `ap-southeast-1`; another region of the commercial `aws` partition
is selected with `-c region` / `-c region.<env>` / `STARTER_REGION_<ENV>` for the CDK stages and with
`AWS_INTEGRATION_REGION` or `SANDBOX_REGION` for the lifecycle scripts. Region-specific data — price
tables for cost estimates and the CloudFront origin-facing prefix list id — is committed only for
`ap-southeast-1`; the tooling refuses other regions until you add it. Precedence and the full list:
[aws-deployment.md](aws-deployment.md#region).

## 4. Landing-zone values

The `dev`, `staging` and `prod` stages import an existing landing zone. Replace the placeholders in
`infra/environments/<env>.ts` with your VPC, subnets, KMS keys, certificates, WAF, permissions
boundary, log bucket, identity provider and tags, and confirm the prerequisites with your platform
team: [landing-zone-adaptation.md](landing-zone-adaptation.md). The schema validates formats,
regions and AZ consistency at synth time.

## 5. Policies

The rule packs are a proposed baseline. Review every rule against your organization's controls,
adjust severities and thresholds, and record deviations as governed, expiring exceptions rather than
by editing a rule away: [policy-as-code.md](policy-as-code.md). Cost thresholds and approval signals are in
`tools/finops/thresholds.yaml` ([finops.md](finops.md)).

## 6. CI variables

No CI/CD variable is required. The optional ones, with their defaults and effects, are listed in
[ci-cd.md](ci-cd.md) §11:

| You want to…                                             | Set                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| run jobs on a tagged runner                              | `STARTER_RUNNER_TAG` (and the release, protected and signer tags for the opt-in roles)                  |
| sign and verify released images                          | `STARTER_RELEASE_SIGNING=true` plus the signer and protected runners with mounted keys                  |
| skip the image build on runners without rootless Buildah | `STARTER_CONTAINER_BUILD=false` (reported as a warning)                                                 |
| allow a lab registry over plain HTTP                     | `REGISTRY_TLS_VERIFY=false`                                                                             |
| drop the manual human-approval job                       | `REQUIRE_HUMAN_APPROVAL=false`                                                                          |
| enable the advisory AI review                            | `AI_REVIEW_ENABLED=true` plus the endpoint, model and token variables                                   |
| create the AWS jobs on protected refs                    | `AWS_JOBS_ENABLED=true` plus credentials mounted on the protected runner and `STARTER_ACCOUNT_ID_<ENV>` |
| run every job once                                       | `IMPACT_RUN_ALL=true`                                                                                   |
| protect the gate definition                              | the gate-integrity policy project ([ci-cd.md](ci-cd.md) §4a and §11)                                    |

Secrets are never CI/CD variables: signing keys and AWS credentials are files mounted by dedicated
runners ([security.md](security.md) §4).
