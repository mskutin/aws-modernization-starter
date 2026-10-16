# Policy as code (`@starter/policies`)

> **Disclaimer — proposed baseline only.** Every rule below is a _proposed_
> security and operations baseline for this reference implementation. None of
> them is an approved control of any organization or regulator, and passing
> them does not mean a workload is compliant with any policy. Each project must
> review, adapt and formally approve the rule set (and its severities) with its
> security and compliance owners before relying on it.

## Engines

| Layer                                          | Where                                           | What it sees                                           | Fails on                                                                                        |
| ---------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `BaselineChecks` (cdk-nag 3 pack)              | `cdk synth` (CDK validation plugin)             | synthesized template of every stack + construct paths  | `error` violations (critical/high/medium). `low` → warning                                      |
| CloudFormation Guard 3.2.1                     | CI job over `infra/cdk.out/**/*.template.json`  | the templates exactly as they will be deployed         | blocking (critical/high/medium) findings not waived by a governed exception                     |
| AwsSolutions (cdk-nag)                         | `cdk synth` (`infra/lib/policy-hook.ts`)        | CDK app                                                | error-level findings not acknowledged through the suppression register                          |
| Suppression audit (`BaselineSuppressionAudit`) | `cdk synth` (registered by `applyPolicyChecks`) | every acknowledgement in the construct tree            | any acknowledgement not backed by an active register entry or exception (`fatal`, BASE-SUP-001) |
| `check-exceptions --templates`                 | CI `policy:infra` over `infra/cdk.out`          | `cdk_nag.rules_to_suppress` metadata of every template | ungoverned, out-of-scope, wrong-environment or over-broad (IAM5 actions) suppressions           |

Why this combination, and why not OPA: [ADR 0501](adr/0501-policy-as-code-engines.md).

Rules are implemented **once** in TypeScript (`policies/src/rules/*.ts`, pure
functions over CloudFormation JSON); the cdk-nag pack evaluates them against
the rendered template, so Aspect-applied tags and escape-hatch overrides count.
Guard re-implements the same IDs in `policies/guard/rules/*.guard`. A parity
test requires both engines to agree for every fixture and on real
CDK-synthesized templates.

Severity → behaviour: `critical`, `high`, `medium` are **blocking** (cdk-nag
error, Guard CI failure); `low` is **advisory** (cdk-nag warning; Guard
reports it and fails only with `--fail-on-advisory`).

Environment-scoped rules use the resource's `Environment` tag (Guard and
cdk-nag); cdk-nag falls back to the `environment` option when a resource has
no valid tag.

## Rule catalogue

Every rule has a passing and a failing fixture in
`policies/test/fixtures/cases.ts`; the diagnostic below is asserted by the
TypeScript and cdk-nag tests, and the Guard tests assert that the failing
fixture reports the same rule on the same logical ID with a message starting
with the rule ID. Full descriptions, rationale and remediation: `pnpm -C
policies run catalogue --format json` or the rule sources.

| ID             | Rule                                                             | Severity | Engines         | Scope        | Expected diagnostic (failing fixture)                                                                                                    |
| -------------- | ---------------------------------------------------------------- | -------- | --------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| BASE-S3-001    | S3 buckets block all public access                               | high     | cdk-nag + guard | all          | `Bucket` `Properties/PublicAccessBlockConfiguration/BlockPublicPolicy`: BlockPublicPolicy must be true                                   |
| BASE-S3-002    | Bucket policies never allow anonymous principals                 | critical | cdk-nag + guard | all          | `BucketPolicy` `Properties/PolicyDocument/Statement/0/Principal`: wildcard principal                                                     |
| BASE-S3-003    | Bucket policies deny non-TLS requests                            | high     | cdk-nag + guard | all          | `BucketPolicy` `Properties/PolicyDocument/Statement`: aws:SecureTransport=false                                                          |
| BASE-CF-001    | S3 origins use Origin Access Control                             | high     | cdk-nag + guard | all          | `Distribution` `Properties/DistributionConfig/Origins/0/OriginAccessControlId`: no OriginAccessControlId                                 |
| BASE-CF-002    | Viewer TLS uses a modern security policy                         | high     | cdk-nag + guard | all          | `Distribution` `Properties/DistributionConfig/ViewerCertificate`: must use a custom ACM certificate                                      |
| BASE-CF-003    | Viewers are forced onto HTTPS                                    | high     | cdk-nag + guard | all          | `Distribution` `Properties/DistributionConfig/CacheBehaviors/0/ViewerProtocolPolicy`: ViewerProtocolPolicy is allow-all                  |
| BASE-CF-004    | Custom origins are reached over TLS 1.2                          | high     | cdk-nag + guard | all          | `Distribution` `Properties/DistributionConfig/Origins/1/CustomOriginConfig/OriginProtocolPolicy`: must be https-only                     |
| BASE-CF-005    | Distributions have access logging                                | medium   | cdk-nag + guard | all          | `Distribution` `Properties/DistributionConfig/Logging`: No standard logging bucket                                                       |
| BASE-CF-006    | Security response headers are applied                            | medium   | cdk-nag + guard | all          | `Distribution` `Properties/DistributionConfig/DefaultCacheBehavior/ResponseHeadersPolicyId`: is not one of the security-headers policies |
| BASE-ECS-001   | Containers run as a non-root user                                | high     | cdk-nag + guard | all          | `TaskDef` `Properties/ContainerDefinitions/0/User`: runs as root (root)                                                                  |
| BASE-ECS-002   | Container root file systems are read-only                        | medium   | cdk-nag + guard | all          | `TaskDef` `Properties/ContainerDefinitions/0/ReadonlyRootFilesystem`: read-only root FS                                                  |
| BASE-ECS-003   | Containers are not privileged                                    | critical | cdk-nag + guard | all          | `TaskDef` `Properties/ContainerDefinitions/0/Privileged`: is privileged                                                                  |
| BASE-ECS-004   | Task definitions use awsvpc networking                           | medium   | cdk-nag + guard | all          | `TaskDef` `Properties/NetworkMode`: must be awsvpc                                                                                       |
| BASE-ECS-005   | Containers ship logs                                             | medium   | cdk-nag + guard | all          | `TaskDef` `Properties/ContainerDefinitions/0/LogConfiguration`: has no awslogs/awsfirelens LogConfiguration                              |
| BASE-ECS-006   | No credentials in plain-text container environment               | high     | cdk-nag + guard | all          | `TaskDef` `Properties/ContainerDefinitions/0/Environment/1/Name`: sets DB_PASSWORD as a plain environment variable                       |
| BASE-ECS-007   | ECS services do not assign public IPs                            | high     | cdk-nag + guard | all          | `Service` `Properties/NetworkConfiguration/AwsvpcConfiguration/AssignPublicIp`: assigns public IPs                                       |
| BASE-ECS-008   | Task definitions carry no local/CI relaxations                   | high     | cdk-nag + guard | all          | `TaskDef` `Properties/ContainerDefinitions/0/Environment/5/Value`: sets APP_RUNTIME to a value other than aws                            |
| BASE-ECS-009   | Task definitions authenticate to PostgreSQL with IAM             | high     | cdk-nag + guard | all          | `TaskDef` `Properties/ContainerDefinitions/0/Secrets/0/Name`: injects DB_PASSWORD from a secret; use DB_AUTH=iam instead                 |
| BASE-IAM-001   | No wildcard IAM actions                                          | high     | cdk-nag + guard | all          | `Policy` `Properties/PolicyDocument/Statement/0/Action`: wildcard action "s3:*"                                                          |
| BASE-IAM-002   | Resource "*" only for actions without resource-level permissions | high     | cdk-nag + guard | all          | `Policy` `Properties/PolicyDocument/Statement/0/Resource`: Action "dynamodb:GetItem" is granted on Resource "*"                          |
| BASE-IAM-003   | No administrator-equivalent permissions                          | critical | cdk-nag + guard | all          | `Role` `Properties/ManagedPolicyArns/0`: Attaches managed policy AdministratorAccess                                                     |
| BASE-IAM-004   | Roles carry the configured permissions boundary                  | medium   | cdk-nag         | all          | `Role` `Properties/PermissionsBoundary`: no permissions boundary                                                                         |
| BASE-IAM-005   | No IAM users or access keys                                      | high     | cdk-nag + guard | all          | `User` `Type`: creates long-lived IAM credentials                                                                                        |
| BASE-IAM-006   | Role trust policies never trust "*"                              | critical | cdk-nag + guard | all          | `Role` `Properties/AssumeRolePolicyDocument/Statement/0/Principal`: wildcard principal                                                   |
| BASE-LMB-001   | Lambda runtimes are on the allowlist                             | high     | cdk-nag + guard | all          | `Fn` `Properties/Runtime`: nodejs16.x is not on the allowlist                                                                            |
| BASE-LMB-002   | Lambda functions prefer arm64                                    | low      | cdk-nag + guard | all          | `Fn` `Properties/Architectures`: does not use arm64                                                                                      |
| BASE-LMB-003   | Lambda timeouts are explicit and bounded                         | medium   | cdk-nag + guard | all          | `Fn` `Properties/Timeout`: Timeout 900s exceeds 300s                                                                                     |
| BASE-LMB-004   | Lambda reserved concurrency is set                               | low      | cdk-nag + guard | all          | `Fn` `Properties/ReservedConcurrentExecutions`: Reserved concurrency is not set                                                          |
| BASE-LMB-005   | Lambda logs go to a managed log group                            | medium   | cdk-nag + guard | all          | `Fn` `Properties/LoggingConfig/LogGroup`: No explicit log group configured                                                               |
| BASE-LMB-006   | Lambda active tracing is enabled                                 | medium   | cdk-nag + guard | all          | `Fn` `Properties/TracingConfig/Mode`: Active tracing is not enabled                                                                      |
| BASE-LMB-007   | Lambda functions carry no local/CI relaxations                   | high     | cdk-nag + guard | all          | `Fn` `Properties/Environment/Variables/DB_SSL`: sets DB_SSL to a mode other than verify-full                                             |
| BASE-LMB-008   | Lambda functions authenticate to PostgreSQL with IAM             | high     | cdk-nag + guard | all          | `Fn` `Properties/Environment/Variables/DB_AUTH`: sets DB_AUTH to a mode other than iam                                                   |
| BASE-RDS-001   | RDS storage is encrypted                                         | high     | cdk-nag + guard | all          | `Db` `Properties/StorageEncrypted`: StorageEncrypted is not true                                                                         |
| BASE-RDS-002   | RDS instances are not publicly accessible                        | critical | cdk-nag + guard | all          | `Db` `Properties/PubliclyAccessible`: must be false                                                                                      |
| BASE-RDS-003   | RDS deletion protection in staging/prod                          | high     | cdk-nag + guard | staging/prod | `Db` `Properties/DeletionProtection`: DeletionProtection is not true                                                                     |
| BASE-RDS-004   | RDS automated backups in staging/prod                            | high     | cdk-nag + guard | staging/prod | `Db` `Properties/BackupRetentionPeriod`: BackupRetentionPeriod must be >= 7 (got 1)                                                      |
| BASE-RDS-005   | PostgreSQL connections require TLS                               | high     | cdk-nag + guard | all          | `Params` `Properties/Parameters/rds.force_ssl`: rds.force_ssl is 0; must be "1"                                                          |
| BASE-DDB-001   | DynamoDB tables are encrypted with a customer-managed KMS key    | high     | cdk-nag + guard | all          | `JobsTable` `Properties/SSESpecification/KMSMasterKeyId`: No customer-managed key                                                        |
| BASE-DDB-002   | DynamoDB point-in-time recovery is enabled                       | medium   | cdk-nag + guard | all          | `JobsTable` `Properties/PointInTimeRecoverySpecification`: PITR is not enabled                                                           |
| BASE-DDB-003   | DynamoDB deletion protection in prod                             | high     | cdk-nag + guard | prod         | `JobsTable` `Properties/DeletionProtectionEnabled`: Deletion protection is not enabled                                                   |
| BASE-LOG-001   | Log groups have a retention period                               | medium   | cdk-nag + guard | all          | `FnLogs` `Properties/RetentionInDays`: never expires                                                                                     |
| BASE-LOG-002   | Log groups are encrypted with KMS                                | medium   | cdk-nag + guard | all          | `FnLogs` `Properties/KmsKeyId`: not encrypted with a KMS key                                                                             |
| BASE-LOG-003   | State machines emit execution logs                               | medium   | cdk-nag + guard | all          | `Workflow` `Properties/LoggingConfiguration/Level`: Logging level is OFF                                                                 |
| BASE-TAG-001   | Required cost-allocation tags are present                        | medium   | cdk-nag + guard | all          | `Bucket` `Properties/Tags`: Required tag Owner is missing                                                                                |
| BASE-TAG-002   | Environment tag uses an allowed value                            | medium   | cdk-nag + guard | all          | `Bucket` `Properties/Tags`: Environment tag value production is not allowed                                                              |
| BASE-STATE-001 | Stateful resources are retained in staging/prod                  | high     | cdk-nag + guard | staging/prod | `JobsTable` `DeletionPolicy`: DeletionPolicy is Delete                                                                                   |
| BASE-KMS-001   | Symmetric KMS keys rotate                                        | medium   | cdk-nag + guard | all          | `DataKey` `Properties/EnableKeyRotation`: Key rotation is not enabled                                                                    |

Engine notes:

- **BASE-IAM-004** is cdk-nag only: the boundary ARN is deployment
  configuration. `infra/lib/policy-options.ts` resolves it **per stage** (`permissionsBoundaryFor`):
  every role must carry exactly the boundary its stage's configuration attaches; a sandbox stage
  without a boundary is not applicable for its own roles only and does not turn the check off for
  the other stages of the same synth. Other apps can pass a fixed
  `permissionsBoundaryArn` (`'*'` = any boundary).
- **BASE-ECS-008/009, BASE-LMB-007/008** (ADR 0511) check the synthesized
  task definitions and functions for local/CI relaxations — `APP_RUNTIME` other than `aws`,
  `AUTH_ALLOW_INSECURE_ISSUER`, an `http:` `AUTH_ISSUER`/`AUTH_JWKS_URI` (literal strings),
  `DB_SSL` other than `verify-full` or missing next to `DB_HOST`, `DB_PASSWORD` anywhere — and
  for database credentials other than IAM authentication: `DB_AUTH` other than `iam` or missing
  next to `DB_HOST`, `DB_*SECRET*` variables, `DB_*` values injected from Secrets Manager. The
  only workload that may be exempted from BASE-ECS-009 is the one-off database bootstrap task
  (break-glass, master secret), by a governed exception on exactly its task definition (EXC-0005,
  a reference-design entry, see "Register entries").
  `infra/test/baseline-policies.test.ts` additionally traces every reference to each RDS master secret
  (in-stack `Ref`/`GetAtt` and cross-stack exports) and fails when anything other than the database
  itself and a task exempted from BASE-ECS-009 (with its roles) references it; it also fails on
  stale exceptions.
- **BASE-ECS-008, client allow-list**: a container that verifies tokens (`AUTH_ISSUER`
  or `AUTH_AUDIENCE` in its environment) must set `AUTH_ALLOWED_CLIENT_IDS` with at least one
  non-blank comma-separated entry. An empty list accepts the tokens of every OAuth client of the
  issuer (a local/CI relaxation) and the API refuses to start without it when `APP_RUNTIME=aws`, so
  the synth fails before a deployment would crash-loop. A value CloudFormation resolves at deploy
  time (an intrinsic, or ECS `Secrets[]` from SSM) cannot be evaluated and is accepted. Containers
  without token verification (migrations, bootstrap, retention) are out of scope; in the
  synthesized templates only the API task definitions are in scope, and they pass.
- **BASE-IAM-002** allowlist (`RESOURCE_WILDCARD_ALLOWED_ACTIONS`): X-Ray,
  `ecr:GetAuthorizationToken`, vended-log-delivery `logs:*Delivery*` actions,
  `cloudwatch:PutMetricData` and the Lambda VPC ENI actions CDK renders on
  `Resource: "*"`. Each entry carries a justification; adding one requires
  review and an update in both engines (a test enforces the sync).
- **BASE-IAM-006** is **fail closed (an allowlist)** in both engines. In
  an `Allow` trust statement, `Principal` must be a map of `AWS`, `Service`, `Federated` and/or
  `CanonicalUser`. Every value (scalar or list element) must be one of these shapes:
  - a literal string without `*` or `?`;
  - `Ref` to `AWS::AccountId`, `AWS::Partition`, `AWS::Region` or `AWS::URLSuffix`. A `Ref` to a
    resource is accepted only for `AWS::IAM::OIDCProvider` and `AWS::IAM::SAMLProvider`, whose
    `Ref` is the provider ARN;
  - `Fn::GetAtt` of the `Arn` attribute of an `AWS::IAM::Role` or `AWS::IAM::User` in the same
    template. The list form `[logicalId, "Arn"]` and the dotted string `"logicalId.Arn"` (YAML
    `!GetAtt` short form) are both accepted;
  - `Fn::Join` whose first part is a literal `arn:…` (or `arn` with a `:` delimiter). Its other
    parts may only be literals without wildcards or such `Ref`/`Fn::GetAtt`;
  - string-form `Fn::Sub` starting with a literal `arn:`, with no wildcard and no `${…}` other
    than the four pseudo parameters above.

  Resource types are a positive allowlist. Custom resources (`Custom::*`,
  `AWS::CloudFormation::CustomResource`), third-party registry types (e.g. `Acme::Util::Echo`,
  `::MODULE`) and every other AWS type fail: their values are not IAM principal ARNs and may be
  set by a provider. So does `Ref` to an IAM role, which returns its name. Everything else is a
  finding, not a skip. That covers
  `Fn::If` at the statement, `Principal` or value level, `Fn::Select`, `Fn::Split`,
  `Fn::ImportValue`, `Fn::Sub` with a variable map, `Ref` to a parameter, nested lists, an
  `AssumeRolePolicyDocument` without a literal `Statement`, a non-literal `Effect` and any
  `NotPrincipal` (in `Allow` or `Deny`). `Deny` statements may use `"*"` because they only
  restrict. The synthesized templates use only two accepted shapes: literal `Service`
  principals (`ecs-tasks`, `lambda`, `states`, `monitoring.rds`, `vpc-flow-logs`) and, in the
  integration stack, CDK's operator-role ARN: an `Fn::Join` of `"arn:"`, `Ref AWS::Partition`,
  `":iam::"`, `Ref AWS::AccountId` and `":role/…"`. A legitimate shape outside the
  allowlist needs a governed exception, not a rule change. An allowlist is used rather than a
  denylist because a denylist lets unrecognised intrinsics through (`Fn::Select`, `Fn::Split` or a
  nested `Fn::Sub "*"` wildcard would pass). The Guard rule compares intrinsic maps by shape only,
  because comparing a map with `"*"` is a Guard error. The allowlist lives in `policies/src/rules/principals.ts`. In Guard, it is
  one block copied between `BEGIN/END shared principal allowlist` markers in `iam.guard` and
  `s3.guard`, because Guard has no includes. A test fails if the copies differ. The engines
  also agree on CloudFormation-invalid shapes, such as a list-valued `Ref`, `Fn::GetAtt`
  attribute or `Fn::Sub` template: both reject them. Known false positives, each needing a
  governed exception: regional service principals built with `Fn::Join`/`Fn::Sub` (e.g.
  `logs.${AWS::Region}.amazonaws.com`) and cross-stack `Fn::ImportValue` ARNs. CDK synth emits
  neither in this repository.

- **BASE-S3-002** uses the same fail-closed principal allowlist as BASE-IAM-006 for `Allow`
  statements in bucket policies. `Principal: "*"` and `{"AWS": "*"}` fail even with a condition
  such as `aws:SourceArn`. Scoped service access uses a service principal (CloudFront OAC:
  `cloudfront.amazonaws.com` + `AWS:SourceArn`). Intrinsic-only `"*"` forms, the bypass shapes above,
  `NotPrincipal` in an `Allow`, non-literal statements or `Effect`, parameter `Ref`s, and
  `Ref`/`Fn::GetAtt` to a type outside the allowlist fail. `Deny` statements are not checked. That covers
  the TLS denies with `"*"` and `Deny` + `NotPrincipal`. The synthesized `Allow` principals take
  two forms. Every environment has the literal CloudFront service principal. The sandbox also has
  `Fn::GetAtt` `Arn` of CDK's auto-delete-objects provider role, which is an `AWS::IAM::Role` and
  not the `Custom::S3AutoDeleteObjects` resource.

- **BASE-S3-003** checks bucket _policies_; a bucket with no policy at all is
  caught by AwsSolutions-S10 at synth time.
- **BASE-CF-005** accepts standard logging (bucket) or a standard-logging-v2
  `AWS::Logs::DeliverySource` of type `ACCESS_LOGS` anywhere in the template.
- **BASE-CF-002**: dev may use the default CloudFront certificate; staging and
  prod must use an ACM certificate with `TLSv1.2_2021` or newer.
- Lambda runtime allowlist and timeout bound are configurable for cdk-nag
  (`lambda.allowedRuntimes`, `lambda.maxTimeoutSeconds`); the Guard copy uses
  the defaults (`nodejs24.x, nodejs22.x, python3.13, python3.14, java21,
provided.al2023`; 300 s).

## Using the pack (CDK)

```ts
import { applyBaselinePolicies } from '@starter/policies';

// After all stages/stacks are constructed (acknowledgements attach to the
// CfnResources that exist at call time; later resources get none = fail-closed).
applyBaselinePolicies(app, {
  // optional: permissionsBoundaryArn: 'arn:aws:iam::111122223333:policy/boundary',
  // optional: environment: 'dev'   (fallback when a resource has no Environment tag)
});
app.synth();
```

`applyBaselinePolicies` loads and validates `policies/exceptions/exceptions.yaml`
(malformed → throws), attaches each active exception as a targeted
`Validations.of(resource).acknowledge()` (also for `AwsSolutions-*` IDs),
records it in the template as `Metadata.cdk_nag.rules_to_suppress` with an
`[EXC-NNNN]` reason, and registers the pack. Expired exceptions are not
applied and are reported as **BASE-EXC-001** errors. Use `register: false` when
another hook registers the returned `pack` (as `infra/lib/policy-hook.ts`
`applyPolicyChecks` does). Low-level: `new BaselineChecks(app, props)` with
`Validations.of(app).addPlugins(pack)`, or `pack.validateScope(app)` after
`app.synth()` in tests.

## Register entries: reference, project, example

Both registers (`exceptions.yaml`, `suppressions.yaml`) hold three kinds of entry:

| Kind                        | Where                                                                          | Dates / approver                                                                                                      | Applies                                  | `check-exceptions`                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `status: reference`         | the shipped registers (EXC-0005 and the reference SUP entries), pinned in code | none (rejected); never expires                                                                                        | wherever the reference code needs it     | passes only when pinned (else `UNPINNED_REFERENCE_ENTRY`); never needs an approval digest |
| project entry (no `status`) | your additions to the same files                                               | `createdAt`/`expiresAt` (≤ 180 days) or `createdAt`/`reviewedAt`/`reviewBy` (≤ 180 days); approver for critical rules | until it expires / its review is overdue | fails when malformed, expired or (with `--approvals`) unapproved                          |
| `status: example`           | `policies/exceptions/examples/sandbox/` (loaded by nothing)                    | none (rejected)                                                                                                       | never                                    | `EXAMPLE_NOT_ADOPTED` error wherever an example is loaded                                 |

A **reference** entry is part of the starter's code: the deviation of its own reference design,
with exact scope, an owner role and a justification of at least 40 characters, never scoped to the
sandbox. Changing or widening one is a code change reviewed in an MR (with the optional gate
integrity, `policies/` is also a gate-defining path). A fresh project therefore passes `policy:infra` (`check-exceptions` and Guard) for dev,
staging, prod and the mini-stack at any date with no approvals configured, while any new waiver
still needs a register entry.

**Reference entries are pinned.** Only the shipped reference entries exist:
`policies/src/exceptions/reference-pins.ts` lists each one's id and the SHA-256 of its exact
content (the digest `approval-digests` prints). A `status: reference` entry that is not listed, or
whose content differs (a wider resource, another environment, any edit), fails with
`UNPINNED_REFERENCE_ENTRY` at synth and in `check-exceptions`, and never waives anything, Guard
findings included. A reference exception also names exact resources: no `**`, and wildcards only
in the first (stage) segment. Adding or widening a reference waiver therefore means changing policy
source code. Do not do that for your own deviations: add them as dated project entries (below),
which expire, need an approver for critical rules and can be approved by digest.

### Adding a project exception

Add an entry without `status`, with your dates, owner, ticket and
(for critical rules) approver, in an MR. If CI enforces approvals (`STARTER_EXCEPTION_APPROVALS`),
record its digest outside the MR (`pnpm -C policies run approval-digests`). Renew it before it
expires. The format is below ("Exceptions process", "Suppression register").

### Adopting an entry

The live-validation sandbox (`-c envs=sandbox`) ships its cost/teardown relaxations only as
the example register (EXC-0400..0405, SUP-0400..0428). Its synth fails until you adopt the entries
you accept: copy them into `policies/exceptions/exceptions.yaml` / `suppressions.yaml`, remove
`status: example` and set your dates (keep the window short) as for any project entry. The default
pipeline does not synthesize the sandbox. Tests that build the Sandbox stage adopt the example in
memory (`infra/test/policy-registers.ts`); nothing else does.

## Exceptions process

`policies/exceptions/exceptions.yaml` (schema: `policies/src/exceptions/exceptions.ts`, zod):

```yaml
schemaVersion: 1
exceptions:
  - id: EXC-0001 # unique, never reused
    ruleId: BASE-CF-002 # or AwsSolutions-XXX, optionally with a cdk-nag "[finding]" suffix
    resource: 'Staging/Frontend/**' # glob on the CDK construct path (aws:cdk:path) or an exact logical ID
    environments: [staging]
    justification: Staging has no custom domain yet; synthetic test data only.
    owner: platform-team
    approver: security-lead # mandatory for critical rules
    ticket: TKT-123
    createdAt: '2026-10-01'
    expiresAt: '2026-12-31' # inclusive; at most 180 days after createdAt
```

Rules enforced by `check-exceptions`, the Guard job and `applyBaselinePolicies`:
schema-valid (strict keys), unique IDs, known baseline rule IDs, `createdAt` not in
the future, validity window ≤ 180 days, approver present for critical rules,
**not expired** (error) and expiring within 14 days (warning). Glob semantics:
`*` matches within one path segment, `**` across segments.

Process: open an MR that adds the entry → security owner reviews and approves
→ merge. Renewal = new MR that extends `expiresAt` (and re-justifies).
Removing the underlying finding = delete the entry (`infra/test/baseline-policies.test.ts`
fails on an active exception that no longer waives a finding). `check-exceptions
--templates infra/cdk.out` additionally fails on `cdk_nag` suppressions in the
templates that do not cite an active exception or register entry for the same rule,
lie outside its resource scope or environment (see the next section).

## Suppression register (governed in-code acknowledgements)

In-code acknowledgements need the same governance as exceptions: an owner, an exact scope and a
review date. There are two governed mechanisms and no other:

| Mechanism                                              | Waives                                                                                                       | Where it is applied                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Governed exception (`exceptions.yaml`, `EXC-NNNN`)     | BASE-\* findings (and, if ever needed, AwsSolutions findings) by path glob                                   | `applyBaselinePolicies` (synth), Guard (CI); project entries expire after ≤ 180 days                |
| Suppression register (`suppressions.yaml`, `SUP-NNNN`) | cdk-nag AwsSolutions findings, CDK annotations, CloudFormation Validate codes acknowledged in construct code | `acknowledgeRule` / `acknowledgeAnnotation` / `acknowledgeCfnValidate` (`infra/lib/policy-hook.ts`) |

### Entry format

```yaml
schemaVersion: 1
suppressions:
  - id: SUP-0002 # unique, never reused
    ruleId:
      AwsSolutions-IAM5[Resource::*] # cdk-nag rule id incl. the finding where the rule reports one;
      # or Annotation::@aws-cdk/<module>:<id>, CloudFormation-Validate::<code>
    construct: ApiService # class whose code calls acknowledge*()
    resources:
      [TaskDefinition/ExecutionRole/DefaultPolicy/Resource] # paths RELATIVE to that construct of exactly
      # the resources that carry the finding ("*" within a segment; no "**")
    environments: [dev, staging, prod] # enforced when the stage is Dev/Staging/Prod
    allowedActions:
      [ecr:GetAuthorizationToken] # IAM5[Resource::*] only (mandatory): actions allowed on Resource "*",
      # each in the BASE-IAM-002 allowlist
    justification: >- # >= 40 chars: why acceptable, what mitigates it
      ...
    compensatingControls: [BASE-IAM-002 ...] # optional
    owner: security-team # accountable role; `approver` optional
    ticket: TKT-16 # optional
    createdAt: '2026-10-13' # UTC dates
    reviewedAt: '2026-10-13'
    reviewBy: '2027-04-11' # <= 180 days after reviewedAt (reference entries: `status: reference`, no dates)
```

Entry id ranges: identity SUP-0100–0199, database SUP-0200–0299, workflow SUP-0300–0399,
security testing and cross-cutting SUP-0018–0099, live-validation sandbox SUP-0400–0499 (example
register).

### What is enforced, and where

| Check                                                                                                                             | Enforced by                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| An acknowledgement matches exactly one active entry (rule, owning class, resource, environment)                                   | `acknowledge*()` throws `UngovernedSuppressionError` while the construct is built (synth and tests)                    |
| It is attached only to the resources the entry names — never to a construct subtree                                               | `acknowledge*()`; `BaselineSuppressionAudit` (synth); `infra/test/acknowledgments.test.ts`                             |
| `reviewBy` has not passed; schema, unique ids/scopes, review interval ≤ 180 days, IAM5 actions ⊆ the BASE-IAM-002 allowlist       | `checkSuppressions` (synth, `check-exceptions`)                                                                        |
| Nothing bypasses the register (e.g. a direct `Validations.of(x).acknowledge()`)                                                   | `BaselineSuppressionAudit` at synth: severity `fatal`, which CDK never lets an acknowledgement suppress (BASE-SUP-001) |
| Every template suppression cites an active entry, is in its scope and environment, and every action on `Resource: "*"` is allowed | `check-exceptions --templates infra/cdk.out` (default `--audit-scope all`; CI `policy:infra`)                          |
| 1:1 raw findings ↔ acknowledgements on the exact resource; no stale entries; no unused IAM5 actions                               | `infra/test/acknowledgments.test.ts` over every deployable variant (incl. sandbox and mini-stack)                      |

BASE-\* rules can never be acknowledged in code. Uncited CloudFormation Validate acknowledgements are
aws-cdk-lib's own (e.g. `F3002` on VPC flow logs); the audits inventory them as `framework` and do not
fail on them.

### Adding, renewing, removing

1. Call `acknowledgeRule(construct, ruleId, note)` as before. Without an entry it throws with a
   ready-to-fill entry (owning class and the resources under the construct).
2. Add the entry in the same MR, with only the resources that carry the finding, the environments
   where it occurs, and for `AwsSolutions-IAM5[Resource::*]` the exact actions.
3. `pnpm --filter @starter/infra test` (acknowledgments, policy hook) and, after synth,
   `pnpm -C policies run check-exceptions --templates infra/cdk.out`.
4. Renewal: a new MR that re-justifies and moves `reviewedAt`/`reviewBy`. Removing the acknowledgement
   means removing the entry (the stale-entry test fails otherwise).

An entry in the MR is not an approval: without recorded approvals the Maintainer's merge is the
approval, and an MR can edit `policies/exceptions/**` and the checker itself. `approver` must name
a real person when it is used; it is never filled in by automation.

**Approvals outside the MR.** `check-exceptions --approvals <file>` fails
(`UNAPPROVED_ENTRY`) on every project exception or register entry (not reference-design entries)
whose exact content has no recorded
approval: the file lists `{ id, sha256, approvedBy, approvedAt }`, where `sha256` is the digest of
the entry's canonical JSON as printed by `pnpm -C policies run approval-digests`. A new entry, or
any edit to one (a later expiry, a wider resource), needs a new approval. This is only a control if the approvals file comes from
where the MR cannot write — the Maintainer-only gate project (`ci_config_path`) or a protected file
variable. CI passes it when the file variable `STARTER_EXCEPTION_APPROVALS` is set
(`.gitlab/ci/infra.yml`); otherwise it is not enforced in CI.

```yaml
# approvals.yaml (kept outside the repository)
schemaVersion: 1
approvals:
  - id: EXC-0100 # a project entry; reference-design entries never take approvals
    sha256: <64 hex characters from approval-digests>
    approvedBy: security-lead
    approvedAt: '2026-10-14'
```

`check-exceptions --templates` reports the inventory of every template suppression and which
register entry backs it. It warns about reference entries that the default synth does not use:
some belong only to the sandbox variant (no platform-managed WAF or custom domain), which the
default pipeline does not build.

## Adding a rule

1. Pick the next ID in the domain (`BASE-<DOMAIN>-NNN`) and add the rule object
   (title, description, rationale, severity, engines, resource types,
   remediation, `evaluate`) to `policies/src/rules/<domain>.ts`.
2. Add a case to `policies/test/fixtures/cases.ts`: a passing fixture, a
   failing fixture, the expected diagnostic (`logicalId`, `path`, message
   substring) and variants for edge cases (environment scoping, N/A cases).
3. If the rule runs in Guard, implement `rule BASE_<DOMAIN>_NNN` in the
   matching `policies/guard/rules/<file>.guard` with a custom message that
   starts with the rule ID (e.g. `<<BASE-S3-001: ...>>`). Guard pitfall: a
   clause over an **empty** filter result is skipped, so assert presence with
   `some X[*].Key == 'K'` first.
4. `pnpm -C policies run guard:gen-tests` regenerates
   `policies/guard/rules/tests/*_tests.yaml` (never edit them by hand).
5. `pnpm -C policies test` (TS + cdk-nag + Guard + parity) and
   `pnpm -C policies run guard:test` must pass. Update this catalogue.

## CLI and CI enforcement

Run package scripts with `pnpm -C policies run <script> <args>` (or the
built bin `node policies/dist/cli/bin.js`): `pnpm --filter` collapses every
non-zero exit code to 1.

| Command                                                                                                                                       | Purpose                                                                                                                                        | Outputs                                                                    | Exit codes                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `guard:install`                                                                                                                               | install pinned cfn-guard 3.2.1 into `policies/.tools/` (SHA-256 verified)                                                                      | binary                                                                     | 0 / 1 checksum / 2 platform                                                           |
| `check-exceptions [--templates <cdk.out>] [--audit-scope all\|baseline] [--suppressions f] [--approvals f] [--today YYYY-MM-DD] [--report f]` | validate the exceptions and the suppression register; audit every template suppression (default scope `all`; `baseline` = legacy BASE-\* only) | stdout, optional JSON (issues + suppression inventory)                     | 0 ok, 1 invalid/expired/ungoverned/out of scope, 2 usage                              |
| `guard:validate [--dir infra/cdk.out] [--out reports/policies] [--fail-on-advisory]`                                                          | Guard over all `*.template.json` (recursive, Stage assemblies) + exceptions                                                                    | `guard-results.json`, `guard-junit.xml`, `guard.sarif`, `guard-summary.md` | 0 pass, 1 blocking findings or exception errors, 2 usage (no templates, no cfn-guard) |
| `guard:test [--out reports/policies]`                                                                                                         | `cfn-guard test` for every rule file                                                                                                           | `guard-test-junit.xml`                                                     | 0 / 1                                                                                 |
| `test` (= `policies:test`)                                                                                                                    | vitest: rules, cdk-nag, exceptions, CLI, Guard parity                                                                                          | —                                                                          | 0 / 1                                                                                 |
| `catalogue [--format md\|json]`                                                                                                               | print the catalogue                                                                                                                            | stdout                                                                     | 0                                                                                     |

Guard binary resolution: `$CFN_GUARD_BIN` → `policies/.tools/cfn-guard` →
`cfn-guard` on `PATH`. Set `REQUIRE_CFN_GUARD=1` in CI so the vitest Guard
suites fail instead of skipping when the binary is missing. Reports are
written under `reports/` (git-ignored).
