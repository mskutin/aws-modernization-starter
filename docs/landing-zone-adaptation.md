# Adapting the infrastructure to a real landing-zone foundation

> **The governed stages have never been deployed.** The reference was validated once with the
> self-contained sandbox profile in a disposable personal account, which exercises none of the
> landing-zone imports described here. Every account ID, VPC/subnet/route-table ID, KMS key
> ARN, certificate ARN, hosted zone, WAF ARN, permissions boundary and bucket
> name in `infra/environments/` is a **placeholder** (`000000000000`,
> `starter-placeholder-*`, `*.starter.example.com`). What _has_ been verified is
> listed in [§10](#10-assumed-vs-verified).

Accounts in a governed AWS environment come with a landing zone that the workload
team does not own: networking, central keys, DNS, logging, guardrail SCPs and a
mandatory IAM permissions boundary. This application therefore **imports**
those resources (`infra/constructs/foundation/`) and never creates them in
staging or prod — the config schema rejects `foundation.mode = sandbox` outside
dev. The opt-in `SandboxFoundation` (`-c foundationMode=sandbox`) creates a
minimal VPC, two CMKs and a log bucket for an isolated personal sandbox; it is
**not** a landing zone.

## 1. Inputs to obtain from the platform / cloud team

All inputs live in `infra/environments/<env>.ts` (`foundation`, `account`,
`cdkBootstrapQualifier`, `tags`). Replace `placeholderImportedFoundation(...)`
with literal values; synth validates formats, regions and AZ consistency.

| Config key                                                 | What it must be                                                                                                                                                                | How to verify (read-only)                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `account`                                                  | Workload account per environment (or `-c account.<env>=…` / `STARTER_ACCOUNT_ID_<ENV>`)                                                                                        | `aws sts get-caller-identity`                                                                                                |
| `region`                                                   | Deployment region, default `ap-southeast-1` (or `-c region` / `-c region.<env>=…` / `STARTER_REGION_<ENV>`); every regional value below must be in it                          | —                                                                                                                            |
| `foundation.vpc.vpcId`, `vpcCidrBlock`                     | Workload VPC                                                                                                                                                                   | `aws ec2 describe-vpcs --vpc-ids …`                                                                                          |
| `foundation.vpc.appSubnets[]`                              | Private "app" tier, one per AZ, with route table IDs; routes to AWS APIs via central egress or VPC endpoints                                                                   | `aws ec2 describe-subnets`, `describe-route-tables`                                                                          |
| `foundation.vpc.dataSubnets[]`                             | Isolated "data" tier in the **same AZs** (RDS subnet group); no internet route                                                                                                 | as above                                                                                                                     |
| `foundation.kms.dataKeyArn`                                | CMK for RDS, Secrets Manager, DynamoDB, ECR, Performance Insights                                                                                                              | `aws kms describe-key`, `get-key-policy`                                                                                     |
| `foundation.kms.logsKeyArn`                                | CMK for CloudWatch Logs                                                                                                                                                        | key policy must allow `logs.<region>.amazonaws.com` (see §3)                                                                 |
| `foundation.permissionsBoundaryPolicyArn`                  | Mandatory boundary for every IAM role the app creates                                                                                                                          | `aws iam get-policy-version`                                                                                                 |
| `foundation.logging.accessLogsBucketName`                  | Central bucket for S3 server access logs, ALB and CloudFront standard logs (see §5)                                                                                            | `aws s3api get-bucket-policy`, `get-bucket-ownership-controls`                                                               |
| `foundation.edge.albCertificateArn`                        | ACM certificate in the **workload region** (`region`) covering `apiOriginDomainName`                                                                                           | `aws acm describe-certificate --region <region>`                                                                             |
| `foundation.edge.apiOriginDomainName`                      | Name CloudFront presents to the internal ALB (SNI/Host)                                                                                                                        | —                                                                                                                            |
| `foundation.edge.cloudFrontCertificateArn`                 | ACM certificate in **us-east-1** for `webDomainName` (CloudFront requirement; schema-enforced)                                                                                 | `aws acm describe-certificate --region us-east-1`                                                                            |
| `foundation.edge.webDomainName`, `hostedZone`              | Public name of the SPA and (optionally) the public hosted zone for alias records                                                                                               | `aws route53 get-hosted-zone`                                                                                                |
| `foundation.edge.wafWebAclArn`                             | CLOUDFRONT-scope WAFv2 web ACL (us-east-1) owned by the security team — **required** in staging/prod                                                                           | `aws wafv2 get-web-acl --scope CLOUDFRONT --region us-east-1`                                                                |
| `foundation.edge.cloudFrontOriginFacingPrefixListId`       | Managed prefix list `com.amazonaws.global.cloudfront.origin-facing` in the workload region (`pl-31a34658` in ap-southeast-1: **verify**; no id is committed for other regions) | `aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing` |
| `foundation.mandatoryTags`                                 | Any landing-zone tags required by SCP/tag policy (merged with the six required tags)                                                                                           | AWS Organizations tag policy                                                                                                 |
| `cdkBootstrapQualifier`                                    | Qualifier of the CDK bootstrap stack approved for the account (§2)                                                                                                             | `aws ssm get-parameter --name /cdk-bootstrap/<qualifier>/version`                                                            |
| `tags.Owner`, `tags.CostCentre`, `tags.DataClassification` | Organization values (classification per its data classification policy)                                                                                                        | —                                                                                                                            |

### 1.1 Identity, database and concurrency inputs

| Config key / setting                                      | What it must be                                                                                                                                                                             | How to verify (read-only)                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `auth.issuer`                                             | The organization IdP's exact `iss` (https); the API discovers its JWKS from `/.well-known/openid-configuration` (or `auth.jwksUri`, https)                                                  | `curl https://<issuer>/.well-known/openid-configuration`             |
| `auth.audience`                                           | An audience that identifies **the API** — never the SPA client id (ID tokens would otherwise pass; ADR 0210)                                                                                | IdP app registration                                                 |
| `auth.spaClientId`, `auth.allowedClientIds`               | The SPA's public client id; the API accepts access tokens only from `allowedClientIds` (`azp`/`client_id`), which defaults to the SPA client id and must not contain the API audience       | IdP app registration                                                 |
| `auth.maxTokenAgeSeconds`, `auth.scopes`, `auth.spaScope` | Access-token lifetime within the maximum age (default 1 h; `iat` required); API scopes `jobs:read` / `jobs:write` (or the organization's names); the SPA requests `openid` plus both scopes | decoded test token                                                   |
| SPA client registration                                   | Public client, authorization code + PKCE S256, redirect `https://<webDomainName>/`; the SPA reads `/config.json` (served at the edge) and its CSP allows exactly the issuer origin          | IdP app registration                                                 |
| JWKS egress                                               | HTTPS from the app subnets to the IdP's JWKS host. Node's `fetch` ignores `HTTPS_PROXY`: use NAT/central egress or a VPC endpoint path, not only an HTTP proxy                              | test from a task in the app subnets                                  |
| RDS IAM authentication                                    | `iamAuthentication` enabled (set by CDK); the bootstrap task grants `rds_iam` to the login roles; `rds-db:connect` per `dbuser:<DbiResourceId>/<role>`                                      | `aws rds describe-db-instances` (`IAMDatabaseAuthenticationEnabled`) |
| RDS CA                                                    | The vendored Amazon RDS global bundle (`packages/db/certs/`, SHA-256 in its README) must contain the CA of the instance's certificate authority (`rds-ca-rsa2048-g1` default)               | `aws rds describe-db-instances` (`CACertificateIdentifier`)          |
| Lambda concurrency                                        | Reserved: validator + processor + reconciler (dev 4 + 4 + 1); the account quota must leave ≥ 10 unreserved, so ≥ 19 in dev                                                                  | `aws lambda get-account-settings`                                    |
| `database.connectionLimits`                               | `starter_processor` limit ≥ 2 × reserved concurrency + 2 (schema-enforced); sized against the instance class's `max_connections`                                                            | synth + `SHOW max_connections`                                       |

## 2. Accounts, CDK bootstrap and deployment identity

- Every stack uses `DefaultStackSynthesizer({ qualifier: cdkBootstrapQualifier })`
  (`starter` placeholder). Bootstrap each account/region once with the approved
  template, e.g.
  `cdk bootstrap aws://<acct>/<region> --qualifier starter --custom-permissions-boundary <boundary-name> --cloudformation-execution-policies <least-privilege-policy-arn> --trust <cicd-account>`.
  Platform teams often supply their own bootstrap template — use it and keep
  the qualifier in config.
- The CloudFormation execution role must be allowed to create the resource types
  in the synthesized templates and to call `kms:CreateGrant`/`kms:DescribeKey`
  on the imported data key (RDS, DynamoDB, ECR and Secrets Manager create grants).
- CI deploys from a pre-synthesized assembly; the deploy role is assumed via the
  bootstrap trust (no long-lived keys). Running the migration task additionally
  needs `ecs:RunTask`/`ecs:DescribeTasks` on the migration task definition and
  `iam:PassRole` for its task and execution roles. None of this has been exercised against a
  landing zone; the only deployment used the self-contained sandbox profile.

## 3. KMS

CDK cannot edit key policies of imported keys, so the landing-zone key owners must ensure:

| Key                       | Required key-policy capability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| data CMK                  | Delegates to IAM in the workload account (`arn:aws:iam::<acct>:root`), so the app's IAM policies (`kms:ViaService` scoped) take effect; allows grants for RDS/DynamoDB/ECR/Secrets Manager.                                                                                                                                                                                                                                                                                                                                                                                                       |
| data CMK — Step Functions | The state machine is encrypted with the data CMK. Its key policy must also allow **`delivery.logs.amazonaws.com`** `kms:Decrypt` (execution-log delivery; CDK adds this only to in-stack keys — the mini-stack — and silently skips imported keys). Principals that use executions need IAM + key access: callers of `StartExecution` `kms:GenerateDataKey` (granted to the API role, scoped by `kms:EncryptionContext:aws:states:stateMachineArn`); readers of `DescribeExecution`/`GetExecutionHistory` (operators, the AWS integration-test principal) `kms:Decrypt`. **Not verified on AWS.** |
| logs CMK                  | Allows `logs.<region>.amazonaws.com` `kms:Encrypt*/Decrypt*/ReEncrypt*/GenerateDataKey*/Describe*` with `kms:EncryptionContext:aws:logs:arn` = log groups of the account. Used by ECS, Lambda, Step Functions, RDS export and (sandbox) flow-log groups.                                                                                                                                                                                                                                                                                                                                          |

The app adds explicit IAM statements wherever CDK would otherwise rely on an
(ignored) key-policy grant — e.g. `kms:Decrypt` via Secrets Manager for the ECS
execution role, and DynamoDB-scoped key use for the handlers, API and state
machine. The alarm topic uses its **own** CMK because CloudWatch and AWS Budgets
need key-policy grants that cannot be added to imported keys.

## 4. Network, egress and the CloudFront VPC origin

- **Subnet tiers.** App subnets host the internal ALB, ECS tasks (API and the
  one-off migration task) and Lambda ENIs; data subnets host RDS only. Security groups allow nothing from CIDRs except the
  CloudFront origin-facing prefix list on the ALB (443).
- **Egress.** Tasks and Lambdas need HTTPS to: ECR API + DKR, S3 (image layers;
  gateway endpoint), CloudWatch Logs, Secrets Manager, KMS, STS, DynamoDB
  (gateway endpoint), Step Functions, X-Ray. In a landing zone this is typically central
  egress via a firewall or interface VPC endpoints owned by the landing zone —
  **confirm which**, and whether endpoint policies restrict these services.
  The sandbox creates one NAT gateway plus S3/DynamoDB gateway endpoints.
- **CloudFront → internal ALB** uses a CloudFront **VPC origin** (ADR 0302). To verify
  with the platform team before the first deployment:
  1. AWS documents that the VPC must have an **internet gateway attached** for VPC
     origins (traffic does not traverse it). Landing-zone workload VPCs may not have one.
  2. Whether the ALB security group should admit the managed prefix list (as
     implemented) or the `CloudFront-VPCOrigins-Service-SG` that CloudFront creates in
     the VPC; adjust `api-service.ts` if the latter is mandated. The prefix list
     counts ~55 entries against the security-group rule quota.
  3. The ALB certificate must cover `apiOriginDomainName`; CloudFront validates it.
     If VPC origins are not permitted, the documented fallback is an internet-facing
     ALB in landing-zone ingress subnets restricted to the same prefix list plus a secret
     origin header — a contained change in `SpaHosting`/`ApiService`.
- **Internal TLS.** TLS terminates at the ALB; ALB → task traffic is HTTP inside
  the app subnets. If organization policy requires end-to-end TLS, add a TLS listener in
  the container (or a sidecar) and switch the target group to HTTPS.

## 5. Logging and SIEM

- The foundation access-log bucket must accept: S3 server access logs
  (`logging.s3.amazonaws.com`, prefix `s3/`), ALB access logs (the regional ELB account, e.g.
  `114774131450` in ap-southeast-1, or the log-delivery service principal, prefix
  `alb/AWSLogs/<acct>/`, **SSE-S3 only**), and CloudFront standard logs
  (bucket ACLs enabled — ObjectWriter/BucketOwnerPreferred — prefix `cloudfront/`).
  `SandboxFoundation` shows the exact bucket policy. If the central bucket lives in
  a log-archive account, cross-account delivery must be granted there.
- CloudWatch log groups are created explicitly with retention + CMK (enforced by
  an aspect). Forwarding to the organization's SIEM (subscription filters / Firehose) is
  owned by the landing zone and **not implemented** here.
- CloudTrail, AWS Config, GuardDuty and Security Hub are assumed to be enabled
  organisation-wide by the landing zone and are not created by this app.

## 6. Identity and permissions boundaries

- Every role created by the app — ECS task/execution (API and DB migration task),
  Lambda, Step Functions, RDS enhanced monitoring, hosted-rotation (if enabled),
  sandbox flow logs — gets
  `foundation.permissionsBoundaryPolicyArn` via `PermissionsBoundary.of(stack)`.
  The boundary must permit the actions those roles need (see the IAM statements
  in the synthesized templates).
- No IAM users, access keys or AWS-managed policies on application roles (the RDS
  enhanced-monitoring service role is the single, acknowledged exception).
- SCPs commonly deny resource types or regions; the app uses only the configured region
  (default `ap-southeast-1`) plus global CloudFront (certificate and WAF in us-east-1 are
  imported, never created).

## 7. WAF, DNS and certificates

- The WAF web ACL is owned by the security team and only **associated** by ARN.
- Alias records for `webDomainName` are created only if `hostedZone` is given;
  otherwise DNS is managed by the central DNS team (point the name at the
  `DistributionDomainName` output).
- Certificates are imported by ARN; DNS validation/renewal is owned by whoever
  issued them.

## 8. Cost allocation and budgets

`CostGuardrails` creates an AWS Budget filtered on the `Project` and
`Environment` **cost allocation tags**. These tags (and `CostCentre`) must be
activated in the billing/payer account, which in a landing zone is managed centrally —
request activation, otherwise the budget sees no spend.

## 9. Data classification

Tags carry `DataClassification` (placeholder `Internal`). Confirm the
classification and sensitivity the organization intends to host against the
classification tier of the account before loading real data; prod disables Step Functions payload
logging by schema.

## 10. Assumed vs verified

| Item                                                                                                   | Status                                                            |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `cdk synth` of dev/staging/prod and the integration stack, offline, no credentials, no context lookups | **Verified** locally                                              |
| cdk-nag AwsSolutions: zero unacknowledged findings; acknowledgments 1:1 with findings                  | **Verified** by tests                                             |
| Templates pass CloudFormation Validate rules during synth                                              | **Verified** (`@aws-cdk/core:validateAgainstDefaultRules = true`) |
| Step Functions retry/timeout/catch equal the shared spec                                               | **Verified** by tests                                             |
| Lambda bundling without Docker (local esbuild)                                                         | **Verified** (fixture handlers)                                   |
| Real landing-zone IDs, key policies, bucket policies, boundary contents                                | **Assumed** — placeholders                                        |
| CloudFront VPC origin permitted in the landing-zone VPC (IGW prerequisite, SG model)                   | **Assumed** — verify (§4)                                         |
| CloudFront origin-facing prefix list id `pl-31a34658` in ap-southeast-1                                | **Assumed** — verify (§1)                                         |
| Egress path to AWS APIs from app subnets (endpoints vs firewall)                                       | **Assumed** — verify (§4)                                         |
| PostgreSQL `17.9` available in RDS ap-southeast-1 at deploy time                                       | **Assumed** (from the CDK 2.272 engine enum)                      |
| Any runtime behaviour in a landing zone (deploys, rollbacks, alarms, budgets, rotation)                | **Not verified** — the governed stages were never deployed        |
