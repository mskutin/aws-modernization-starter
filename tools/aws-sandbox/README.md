# @starter/tool-aws-sandbox — live sandbox FinOps, inventory and teardown verification

Operator-run for a live validation in a dedicated sandbox account (region `--region`, default `ap-southeast-1`); CI runs only the offline tests.

> This experiment validates functional behaviour on ordinary AWS. It does not demonstrate
> compliance with any organizational control set. Cost figures are **estimates** from dated list-price snapshots and stated
> assumptions — **not live prices**, not a quote, not a bill forecast. AWS Budgets is not a hard
> cap; cost control is the runtime limit, this estimate, the inventory and an immediate teardown.

| Command        | AWS access                    | What it does                                                                                       |
| -------------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `estimate`     | none (offline)                | Sandbox cost estimate per hour, per lifetime, maximum runtime under the stop rule, residual        |
| `inventory`    | read-only, after the guard    | Experiment inventory of one run: stacks, resources, creation times, hourly cost, runtime, teardown |
| `verify-clean` | read-only, after the guard    | Sweep of every service the experiment uses; classifies what is left; **never deletes anything**    |
| `reconcile`    | none (billed figures by hand) | Estimated vs billed after the billing lag; never claims zero spend                                 |
| `render`       | none                          | Markdown from a JSON report (e.g. `resource-inventory.md`)                                         |
| `schema`       | none                          | Prints / writes the JSON Schemas of every report (`schema/*.schema.json`)                          |
| `iam-policy`   | none                          | Prints the read-only IAM actions this tool needs                                                   |

Build first: `pnpm --filter @starter/tool-aws-sandbox... build` (it reads the price snapshot through
`@starter/tool-finops`). The CLI is `node tools/aws-sandbox/dist/bin.js <command>`.

## Usage

```bash
RUN=sbx-1a2b3c                                               # sandbox run id (--phase 2); mini-stack runs: it-<6 hex> (--phase 1)
EVID=reports/sandbox-evidence/$RUN                         # sanitized evidence (reports/ is git-ignored)
RUN_DIR=${SANDBOX_HOME:-$HOME/.config/starter-aws-sandbox}/runs/$RUN   # local run directory (never committed)

# Offline estimate (planned topology, or --synth from `-c envs=sandbox`)
node tools/aws-sandbox/dist/bin.js estimate --phase 2 [--hours 6] [--synth infra/cdk.out] \
  [--spent <attributable USD so far>] [--account-level-usd 0] --out $EVID/estimate.json --markdown $EVID/estimate.md

# Baseline BEFORE the first deploy (everything it finds is pre-existing -> not-owned later)
node tools/aws-sandbox/dist/bin.js verify-clean --run-id $RUN --out $EVID/baseline.json

# While the run is up (read-only; guard first). The inventory also records the KMS key ids,
# secret ARNs and log group names that verify-clean needs once the stacks are gone.
node tools/aws-sandbox/dist/bin.js inventory --run-id $RUN --out $RUN_DIR/inventory.json \
  --markdown $EVID/resource-inventory.md [--synth infra/cdk.out]

# After teardown (read-only; guard first). Add --include-bootstrap when the CDK toolkit is removed too.
node tools/aws-sandbox/dist/bin.js verify-clean --run-id $RUN --inventory $RUN_DIR/inventory.json \
  --baseline $EVID/baseline.json --out $EVID/verify-clean.json --markdown $EVID/verify-clean.md

# Cost reconciliation after the billing lag (figures typed in by the finance / account owner)
node tools/aws-sandbox/dist/bin.js reconcile --template --run-id $RUN --out $RUN_DIR/billed.json
node tools/aws-sandbox/dist/bin.js reconcile --estimate $EVID/estimate.json --billed $RUN_DIR/billed.json \
  --out $EVID/reconciliation.json --markdown $EVID/reconciliation.md
```

AWS options of `inventory` and `verify-clean` (defaults in brackets): `--profile`
[`starter-sandbox-developer`], `--region` [`ap-southeast-1`; any other region only with committed
price data for it: `tools/finops/pricing/<region>.yaml` and `pricing/supplement.<region>.json`,
otherwise every command refuses it],
`--expected-account-file` [`${SANDBOX_HOME:-~/.config/starter-aws-sandbox}/expected-account`],
`--guard-cli` [`tools/aws-preflight/dist/guard-cli.js`], `--guard-log` [the run directory's
`guard.log` when that directory exists], `--aws-cli` [first `aws` on an absolute `PATH` entry],
`--timeout-seconds` [120 per call], `--guard-max-age-seconds` [0: a guard check before every AWS
call; a larger value is an operator opt-in recorded in the report as `guard.maxAgeSeconds`].

`verify-clean` also takes `--inventory <inventory.json>` (the run's inventory: its resource ids
become strong ownership evidence, the deleted stacks' final resource states are read, and weak
name-only matches created before the run's first stack are `not-owned` unless `--since` says
otherwise), `--baseline`, `--since`, `--include-bootstrap` and `--lenient`. Strict is the
default: billed retained residue (`retained-by-design`) fails the run; `--lenient` is the explicit
opt-out, and `--strict` is still accepted as a no-op.

Estimate options: `--phase 1|2`, `--hours n` (repeatable; 2/4/8 always included), `--synth <cdk.out>`,
`--stack-prefix <p>` (cross-checks only), `--spent`, `--stop-usd` [13], `--budget-usd` [25],
`--margin-percent` [25], `--tax-rate-percent` [9], `--account-level-usd` [the planning estimate's high bound],
`--time-box-hours` [`--phase 1`: 4, `--phase 2`: 8], `--prices`, `--supplement`, `--region` [the
`--synth` assembly's region, else `ap-southeast-1`; a region without price data fails closed and
names the missing files — prices are never borrowed from another region]. `inventory` accepts the same
options for its runtime limits, plus `--teardown-command`.

### Exit codes

| Code | Meaning                                                                                                                                                |
| ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
|    0 | ok; `verify-clean`: clean (pending-deletion and flagged retained-by-design items may exist)                                                            |
|    1 | `verify-clean`: experiment resources or billed retained residue remain (retained residue passes only with `--lenient`); `reconcile`: stop rule reached |
|    2 | usage or input error                                                                                                                                   |
|    3 | refused: account guard refused or missing, `CI`/`GITLAB_CI` set, ambient credentials or another `AWS_PROFILE` in the environment                       |
|    4 | incomplete: a read failed, a listing was truncated, or a tagged resource type is not swept — no clean verdict                                          |
|    5 | `verify-clean`: clean-with-unverifiable — nothing found, but the role could not list every category; each one is named with its fallback evidence      |

A refused run still writes its `--out` report with `status: "guard-refused"`; it is never a clean
verdict.

## Safety model

- **Account guard first**: before EVERY AWS call (no caching unless the operator
  passes `--guard-max-age-seconds`), the tool runs
  `node tools/aws-preflight/dist/guard-cli.js check --execution-profile personal-sandbox --profile …
--expected-account-file … --region ap-southeast-1 --label "starter-aws-sandbox <command> <run> (read-only)"`.
  A non-zero exit, unparsable output or a record that does not match (profile, region, label,
  masked account `********NNNN`) stops the run before the next AWS call. The guard owns STS; this
  tool never calls STS itself. The guard receives the operator's real environment, so its own
  refusals (static keys, `AWS_CONFIG_FILE` and other redirects, `AWS_REGION`, another profile, `CI`)
  apply; this tool also refuses the same variables itself, by presence (even empty), before it
  starts anything.
- **Pinned AWS CLI**: before the first call (after the first guard check, because even
  `aws --version` loads `~/.aws`), the CLI must report the release the guard and the discovery tool
  were verified with, `2.35.11` (`tools/aws-preflight/src/probes.ts`; a test keeps both equal);
  otherwise the run is refused (exit 3) with the `nix shell …#awscli2` pin command.
- **Read-only allowlist** (`src/aws/allowlist.ts`): 60 `list-*` / `describe-*` / `get-*` operations,
  each with its IAM action and permitted options. Checked at module load and again at the exec
  boundary against independent denylists: no `ce` (Cost Explorer, billed per request), no `sts`, no
  `s3` high-level commands, no `get-secret-value`, `get-template`, `describe-task-definition`,
  `get-distribution-config`, log reads or data-plane reads; no `--endpoint-url`, `--debug`,
  `--query`, `--no-verify-ssl`, `--cli-input-*`, `--with-decryption`. There is **no mutating
  operation**, so the tool cannot delete anything even by mistake. One reviewed exception returns a
  value: `ssm get-parameters`, allowed only with `--names /cdk-bootstrap/starter/version` (checked at
  argument validation and again on the final argv); the value (a version number) is dropped.
- **Exec boundary** (`src/aws/executor.ts`, the only module that starts processes): `execFile`
  without a shell, fixed global options (`--profile`, `--region`, `--output json`, `--no-cli-pager`,
  timeouts), and an environment built from scratch (HOME, PATH, locale, proxies, `AWS_CA_BUNDLE`
  plus fixed `AWS_*` safety values — never credentials, `AWS_PROFILE` or config-file overrides).
- **Responses are projected, never kept**: each sweep reads a few fields and drops the rest; raw
  stdout is never written or logged (error messages are the first stderr line, masked). Two
  responses contain configuration that is deliberately discarded: `lambda list-functions`
  (environment variables) and `cloudfront list-distributions` (origin custom headers, i.e. the
  origin-verify value).
- **Sanitized evidence**: paths in reports are repository-relative or `~/…` (never the operator's
  home directory). Every string of every report, AWS error messages included, is masked:
  `********NNNN` for 12-digit account ids anywhere (UUID groups excepted, so key and stack ids stay
  usable), `assumed-role/<role>/<session>` and `user/<user>` for caller principals (the session name
  is usually the operator's user name or e-mail), `<email>` for e-mail addresses and
  `<ipv4-redacted>` for IPv4 addresses. Reports are validated against their schema and refused
  (exit 2, nothing written) if they contain anything shaped like an access key, private key, JWT,
  JWK private component, e-mail address or unmasked caller session — or the run's own secrets, read
  from the run directory for this check only: the `origin-verify` value and the issuer key's private
  component — or the home directory path. Canary tests prove origin custom-header values, Lambda
  environment variables, stack outputs/parameters, stack event reasons and RDS master user names
  never reach a report.

### Read-only operations

| Operation                                    | IAM action                                   | Purpose                                                                                                                                                                                |
| -------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resourcegroupstaggingapi get-resources`     | `tag:GetResources`                           | resources tagged with the run id / experiment (regional tag index)                                                                                                                     |
| `cloudformation describe-stacks`             | `cloudformation:DescribeStacks`              | stacks (incl. DELETE_FAILED), tags, creation time                                                                                                                                      |
| `cloudformation list-stacks`                 | `cloudformation:ListStacks`                  | deleted stacks of the inventoried run (90 days): their real stack ids for the deletion evidence                                                                                        |
| `cloudformation list-stack-resources`        | `cloudformation:ListStackResources`          | resources of an experiment stack (inventory), or the final resource states of a deleted one (verify-clean `--inventory`)                                                               |
| `cloudformation describe-stack-events`       | `cloudformation:DescribeStackEvents`         | resource creation timestamps (inventory; status reasons are dropped)                                                                                                                   |
| `ecs list-clusters`                          | `ecs:ListClusters`                           | ECS clusters                                                                                                                                                                           |
| `ecs describe-clusters`                      | `ecs:DescribeClusters`                       | cluster status and tags                                                                                                                                                                |
| `ecs list-services`                          | `ecs:ListServices`                           | services of an experiment cluster                                                                                                                                                      |
| `ecs describe-services`                      | `ecs:DescribeServices`                       | service status, desired/running count                                                                                                                                                  |
| `ecs list-tasks`                             | `ecs:ListTasks`                              | running tasks of an experiment cluster                                                                                                                                                 |
| `ecs list-task-definition-families`          | `ecs:ListTaskDefinitionFamilies`             | task definition families with ACTIVE revisions                                                                                                                                         |
| `ecs list-task-definitions`                  | `ecs:ListTaskDefinitions`                    | ACTIVE revisions of an experiment family                                                                                                                                               |
| `ec2 describe-vpcs`                          | `ec2:DescribeVpcs`                           | VPCs                                                                                                                                                                                   |
| `ec2 describe-subnets`                       | `ec2:DescribeSubnets`                        | subnets                                                                                                                                                                                |
| `ec2 describe-nat-gateways`                  | `ec2:DescribeNatGateways`                    | NAT gateways (hourly billed)                                                                                                                                                           |
| `ec2 describe-addresses`                     | `ec2:DescribeAddresses`                      | Elastic IPs (public IPv4, hourly billed)                                                                                                                                               |
| `ec2 describe-network-interfaces`            | `ec2:DescribeNetworkInterfaces`              | ENIs left in experiment VPCs                                                                                                                                                           |
| `ec2 describe-security-groups`               | `ec2:DescribeSecurityGroups`                 | security groups                                                                                                                                                                        |
| `ec2 describe-vpc-endpoints`                 | `ec2:DescribeVpcEndpoints`                   | VPC endpoints                                                                                                                                                                          |
| `ec2 describe-internet-gateways`             | `ec2:DescribeInternetGateways`               | internet gateways                                                                                                                                                                      |
| `elbv2 describe-load-balancers`              | `elasticloadbalancing:DescribeLoadBalancers` | load balancers (hourly billed)                                                                                                                                                         |
| `elbv2 describe-target-groups`               | `elasticloadbalancing:DescribeTargetGroups`  | target groups                                                                                                                                                                          |
| `elbv2 describe-tags`                        | `elasticloadbalancing:DescribeTags`          | load balancer and target group tags                                                                                                                                                    |
| `rds describe-db-instances`                  | `rds:DescribeDBInstances`                    | DB instances (hourly billed)                                                                                                                                                           |
| `rds describe-db-snapshots`                  | `rds:DescribeDBSnapshots`                    | manual and automated DB snapshots (billed storage)                                                                                                                                     |
| `rds describe-db-instance-automated-backups` | `rds:DescribeDBInstanceAutomatedBackups`     | retained automated backups (billed storage)                                                                                                                                            |
| `rds describe-db-parameter-groups`           | `rds:DescribeDBParameterGroups`              | DB parameter groups                                                                                                                                                                    |
| `rds describe-db-subnet-groups`              | `rds:DescribeDBSubnetGroups`                 | DB subnet groups                                                                                                                                                                       |
| `dynamodb list-tables`                       | `dynamodb:ListTables`                        | tables                                                                                                                                                                                 |
| `dynamodb describe-table`                    | `dynamodb:DescribeTable`                     | status and creation time of a matched table                                                                                                                                            |
| `dynamodb list-backups`                      | `dynamodb:ListBackups`                       | user and system backups                                                                                                                                                                |
| `lambda list-functions`                      | `lambda:ListFunctions`                       | functions — **projected**: only FunctionName, FunctionArn and LastModified are kept (configurations include environment variables)                                                     |
| `lambda list-layers`                         | `lambda:ListLayers`                          | layers                                                                                                                                                                                 |
| `stepfunctions list-state-machines`          | `states:ListStateMachines`                   | state machines                                                                                                                                                                         |
| `stepfunctions list-state-machine-versions`  | `states:ListStateMachineVersions`            | versions of a matched state machine                                                                                                                                                    |
| `stepfunctions list-state-machine-aliases`   | `states:ListStateMachineAliases`             | aliases of a matched state machine                                                                                                                                                     |
| `cloudfront list-distributions`              | `cloudfront:ListDistributions`               | distributions incl. disabled ones — **projected**: only Id, ARN, Status, Enabled, DomainName, Comment are kept (summaries include origin custom headers, i.e. the origin-verify value) |
| `cloudfront list-tags-for-resource`          | `cloudfront:ListTagsForResource`             | distribution tags                                                                                                                                                                      |
| `cloudfront list-origin-access-controls`     | `cloudfront:ListOriginAccessControls`        | origin access controls                                                                                                                                                                 |
| `cloudfront list-functions`                  | `cloudfront:ListFunctions`                   | CloudFront Functions (metadata only)                                                                                                                                                   |
| `cloudfront list-cache-policies`             | `cloudfront:ListCachePolicies`               | custom cache policies                                                                                                                                                                  |
| `cloudfront list-response-headers-policies`  | `cloudfront:ListResponseHeadersPolicies`     | custom response headers policies                                                                                                                                                       |
| `cloudfront list-origin-request-policies`    | `cloudfront:ListOriginRequestPolicies`       | custom origin request policies                                                                                                                                                         |
| `cloudfront list-vpc-origins`                | `cloudfront:ListVpcOrigins`                  | VPC origins                                                                                                                                                                            |
| `s3api list-buckets`                         | `s3:ListAllMyBuckets`                        | bucket names and creation dates (no object reads)                                                                                                                                      |
| `ecr describe-repositories`                  | `ecr:DescribeRepositories`                   | repositories                                                                                                                                                                           |
| `ecr describe-images`                        | `ecr:DescribeImages`                         | image count and size of a matched repository                                                                                                                                           |
| `logs describe-log-groups`                   | `logs:DescribeLogGroups`                     | log groups (names, stored bytes, retention; never log events)                                                                                                                          |
| `cloudwatch describe-alarms`                 | `cloudwatch:DescribeAlarms`                  | alarms (metric and composite)                                                                                                                                                          |
| `cloudwatch list-dashboards`                 | `cloudwatch:ListDashboards`                  | dashboards                                                                                                                                                                             |
| `kms list-keys`                              | `kms:ListKeys`                               | key ids                                                                                                                                                                                |
| `kms describe-key`                           | `kms:DescribeKey`                            | key state, manager, deletion date                                                                                                                                                      |
| `kms list-aliases`                           | `kms:ListAliases`                            | aliases                                                                                                                                                                                |
| `kms list-resource-tags`                     | `kms:ListResourceTags`                       | customer managed key tags                                                                                                                                                              |
| `secretsmanager list-secrets`                | `secretsmanager:ListSecrets`                 | secret metadata incl. scheduled deletions (never values)                                                                                                                               |
| `iam list-roles`                             | `iam:ListRoles`                              | roles created by the stacks (global)                                                                                                                                                   |
| `iam list-policies`                          | `iam:ListPolicies`                           | customer managed policies (global)                                                                                                                                                     |
| `sns list-topics`                            | `sns:ListTopics`                             | topics                                                                                                                                                                                 |
| `events list-rules`                          | `events:ListRules`                           | EventBridge rules (default bus)                                                                                                                                                        |
| `ssm get-parameters`                         | `ssm:GetParameters`                          | **reviewed exception, name pinned** to `/cdk-bootstrap/starter/version` (the role has no DescribeParameters); only Name, Version and LastModifiedDate are kept — the value is dropped  |

`inventory` uses only the three CloudFormation operations; `verify-clean` uses all of them except
`list-stack-resources` and `describe-stack-events`.

## verify-clean: ownership and classification

A resource is the experiment's when it carries `starter:run-id=<run>` or `starter:experiment=live-validation`
(also via the regional tag index), the CloudFormation stack tag of a `Sandbox-*`, `starter-sbx-*` or
`starter-it-*` stack, lives in an experiment VPC (or is the EIP of an experiment NAT gateway), or —
**weak evidence** — has a name segment starting with `starter-sbx`, `Sandbox-`/`sandbox-`,
`Sandbox<Stack>` or `starter-it-`. The CDK toolkit (`starter-cdk-toolkit`, `cdk-starter-*`,
`/cdk-bootstrap/starter/`) is reported separately unless `--include-bootstrap`.

| Class                | Meaning                                                                                                                                                             | Fails                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `remaining`          | still exists, including transitional states (`deleting`, `DELETE_FAILED`) and experiment resources of another run                                                   | yes                                |
| `pending-deletion`   | KMS key in `PendingDeletion` (deletion date), secret scheduled for deletion, DynamoDB system backup (35 days); residual cost reported (likely 0, worst case priced) | no                                 |
| `retained-by-design` | final RDS snapshot (`DeletionPolicy: Snapshot`), retained automated backups — none expected in the sandbox: billed residual reported                                | yes (default); no with `--lenient` |
| `not-owned`          | weak (name-only) match listed in `--baseline` or created before `--since`; reported, never deleted                                                                  | no                                 |

Tag-index cross-check: a tagged ARN that no service listing returned makes the run `incomplete`
when its type is not swept, or when it is tagged `starter:run-id=<this run>` (re-run once the index has
caught up with the deletion); for other experiment runs it is a warning. Deregistered (INACTIVE)
task-definition revisions are exempt: the ECS sweep lists every family with an ACTIVE revision.
DynamoDB tables are judged by their tag-index tags and the inventory as well as by name.

### Categories the role cannot list (probed with the sandbox Developer permission set)

The sandbox Developer permission set denies `kms:ListKeys`, `kms:ListResourceTags`, every Secrets
Manager action, `ssm:DescribeParameters` and every EventBridge Scheduler action. Each category
reports how far it could be proven (`coverage[].status`):

| Category        | With that role                | How                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KMS             | `fallback`                    | candidate keys from the tag index (`starter:run-id` / `starter:experiment`), the inventory's key ids, experiment aliases (`list-aliases` works) and the deleted stacks' resources; each read with `describe-key`: `PendingDeletion` → `pending-deletion`, `Enabled`/`Disabled` → `remaining`. Untagged, unaliased, uninventoried keys cannot be found |
| Secrets Manager | `unverifiable-with-this-role` | no read at all: the report lists the tag index result, the inventory's secret ARNs and CloudFormation's final status of each secret (`list-stacks` + `list-stack-resources` by stack id); a secret CloudFormation did not delete (`DELETE_SKIPPED`/`DELETE_FAILED`) is `remaining` (fail-safe)                                                        |
| SSM             | `ok`                          | the experiment creates no SSM parameter; the bootstrap version parameter is checked with the pinned `get-parameters`                                                                                                                                                                                                                                  |
| Scheduler       | `not-used-by-experiment`      | the reconciler runs on an EventBridge rule (swept); no `AWS::Scheduler::Schedule` exists in the CDK app (a test keeps this true). A tagged schedule would still show in the tag index and make the run `incomplete`                                                                                                                                   |

**Verdict:** `clean` (exit 0) only when every category is `ok` or `not-used-by-experiment`;
`not-clean` (exit 1) when anything remains; `incomplete` (exit 4) when a call failed without a
fallback; otherwise `clean-with-unverifiable` (exit 5), with `summary.unverifiable` naming each
`fallback` / `unverifiable-with-this-role` category and its evidence. `kms list-resource-tags`
denied alone does not lower the verdict: tags come from the tag index.

## Estimate model

- **Prices:** `tools/finops/pricing/ap-southeast-1.yaml` (snapshot `2026.10.13-1`, captured
  2026-10-13) plus `pricing/supplement.ap-southeast-1.json` (`2026.10.14-1`, captured 2026-10-14,
  transcribed from the public AWS Price List offer files, with offer versions and SKUs) for
  items the snapshot lacks. Every line item names its source and capture date. Neither is live pricing.
- **Topology:** the offline synth (`--synth`, read from the cloud-assembly manifests) or the planned
  resource list of each phase with every unfixed quantity marked
  `[ASSUMPTION]` (`src/model/topology.ts`). Fargate is always priced on-demand.
- **Usage:** one test cycle per hour of lifetime (`src/model/assumptions.ts`, ids `L1-*`, `L2-*`).
- **Billing rules:** ALB, LCU and NAT bill per started hour (one extra hour per lifetime); others
  are prorated.
- **Stop rule:** maximum hours `h` with
  `((oneTime + partialHourRounding + perHour × h) × (1 + margin) + accountLevel + residualWorst30d) × (1 + tax) ≤ stop − spent`;
  the effective limit is `min(h, time box)`. The account-level services (AWS Config, Security Hub,
  GuardDuty, …) are UNKNOWN for this account and default to the planning estimate's high bound.
- **KMS keys pending deletion:** not in the price snapshot. The repo quotes the KMS pricing page
  ("no charge for customer managed KMS keys that … are scheduled for deletion"); this tool cannot re-verify it offline, so the
  likely residual is 0 and the worst case prices the keys until their deletion date.

## Cost reconciliation

`reconcile --template` writes the input the **finance / account owner** fills in from the Billing
console (Bills or the Cost Explorer _console_, unblended, daily): account total for the period,
measured baseline per day, by-service figures, read time, teardown time. The tool **never calls the
Cost Explorer API** (`ce:*` requests are billed per request). Billing data
refreshes at least every 24 h and some charges arrive later, so the status is `PROVISIONAL` within
24 h of teardown and `INCONCLUSIVE` when the billed attributable spend is ~0 while the estimate is
not — **a zero or missing billed figure is never reported as zero spend**. Checkpoints: T+24 h,
T+48 h, T+8 d (KMS window + 24 h), invoice.

## Reports and schemas

JSON Schemas (draft 2020-12) of every report are in `schema/` (`inventory`, `verify-clean`,
`estimate`, `billed-input`, `reconciliation`); a test fails when they drift from `src/schemas.ts`
(regenerate: `pnpm --filter @starter/tool-aws-sandbox schema:write` after a build). Key fields:

- `inventory.json`: `account` (masked), `experimentResources` (KMS key ids/ARNs, secret ARNs, log
  group names for verify-clean `--inventory`), `stacks[].resources[]` (`logicalId`, `type`, `physicalId`,
  `createdAt` from the first `CREATE_IN_PROGRESS` event, `hourlyUsd`), `cost`
  (`resourcesUsdPerHour`, `otherUsdPerHour`, `totalUsdPerHour`, `estimatedSpendSoFarUsd`), `runtime`
  (`maxRuntimeHours`, `effectiveMaxRuntimeHours`, `teardownStartBy`, `allDeletedBy`), `teardown`
  (owner, command, verification command), `guard.checks`, `tool.awsCalls`.
- `verify-clean.json`: `status` (`clean` | `clean-with-unverifiable` | `not-clean` | `incomplete` |
  `guard-refused`), `summary` (incl. `unverifiable[]`), `findings[]` (`class`, `scope`,
  `resourceType`, `id`, `match`, `deletionDate`, `hourlyUsdIfLeft`, `residual*Usd`), `bootstrap[]`,
  `tagIndexOnly[]`, `coverage[]` (`status`, `denied`, `evidence`, `justification`),
  `deletionEvidence`, `inventory`, `since` / `sinceSource`.
- `estimate.json`: `priceBasis`, `topology`, `assumptions`, `lineItems`, `totals.byHours`,
  `accountLevel`, `residual`, `stopRule`.

## Limitations

- It reads only the one `--region` of the run; the regional tag index does not list global resources (CloudFront,
  IAM), which are swept through their own APIs. S3 object counts are not read (no data-plane calls).
- `createdAt` of Lambda functions and SSM parameters is not available from the list calls (their
  last-modified time is in the note); `--since` therefore does not mark them `not-owned`.
- DynamoDB on-demand backup storage is not in the price snapshot (reported, not priced).
- Account-id masking covers any 12-digit run except the last group of a UUID (key and stack ids);
  an identifier that happens to contain 12 consecutive digits elsewhere is shown masked.
- With the sandbox Developer role, KMS and Secrets Manager cannot be proven clean (exit 5 at best);
  a role with `kms:ListKeys` and `secretsmanager:ListSecrets` turns both categories into exhaustive
  listings.
- Offline checks are not AWS drift detection, and an estimate is not a bill.
