# FinOps: cost-impact gate, destructive-change detection, budgets and drift

Packages: `@starter/tool-finops` (`tools/finops`) and `@starter/tool-drift`
(`tools/drift`). Design decision: [ADR 0502](adr/0502-finops-gate-and-drift.md).

> **Estimates, not prices.** Costs are computed offline from a manually
> maintained, dated price snapshot and an explicit usage-assumptions file. They
> are **not live AWS prices and not a bill forecast**: no free tiers, Savings
> Plans/RIs, enterprise or negotiated commercial terms, taxes, CPU credits, or
> unmodelled resources/data transfer. Use them to compare a change against its
> base, not to budget a programme.

## What the MR check does

```
base cdk.out (target branch) ─┐
                              ├─> template diff ─> destructive changes ─┐
head cdk.out (MR)            ─┘        │                                ├─> gate ─> exit 0/1
                                       └─> estimate(base), estimate(head)┘     + finops-report.{md,json}
```

1. **Template diff** (`src/diff.ts`): per stack (key = template path under
   `cdk.out`, e.g. `assembly-Prod/ProdData90A795AA.template.json`) and logical
   ID: added / removed / modified, with top-level property changes plus
   `DeletionPolicy` / `UpdateReplacePolicy`.
2. **Cost-relevant changes**: added/removed expensive types (RDS, NAT, ALB,
   CloudFront, ECS services, interface endpoints, DynamoDB) and changes of
   cost-driving properties — RDS `DBInstanceClass`, `AllocatedStorage`,
   `StorageType`/`Iops`, `MultiAZ`; ECS `DesiredCount`, capacity providers,
   task `Cpu`/`Memory`/`RuntimePlatform`; autoscaling min/max; CloudFront
   `PriceClass`; DynamoDB `BillingMode`/throughput/GSIs/PITR; Lambda
   `MemorySize`/`Architectures`; provisioned concurrency; log retention.
   They are listed even when the resource type is not priced.
3. **Destructive changes** (always require approval):

   | Kind                  | Trigger                                                                                                                                                                                                                                                                                                                                                      |
   | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `stateful-removed`    | a stateful resource (RDS instance/cluster, DynamoDB table/global table, S3 bucket, KMS key, log group, secret, ECR repository, EFS) disappears, or its type changes under the same logical ID. The report says whether `DeletionPolicy` deletes or orphans/snapshots it.                                                                                     |
   | `stateful-replaced`   | a replacement-forcing property changes, e.g. RDS `DBInstanceIdentifier`/`Engine`/`KmsKeyId`/`StorageEncrypted`/`DBSubnetGroupName`, DynamoDB `TableName`/`KeySchema`/`LocalSecondaryIndexes`, S3 `BucketName`/`ObjectLockEnabled`, KMS `KeySpec`/`KeyUsage`/`MultiRegion`/`Origin` (curated from the CloudFormation reference; see `REPLACEMENT_PROPERTIES`) |
   | `retention-weakened`  | `DeletionPolicy`/`UpdateReplacePolicy` goes from Retain/Snapshot to Delete/unset                                                                                                                                                                                                                                                                             |
   | `protection-disabled` | RDS `DeletionProtection` or DynamoDB `DeletionProtectionEnabled` goes from true to false/unset                                                                                                                                                                                                                                                               |

   Limitation: this is a static template comparison, not a CloudFormation
   change set. Replacements caused by properties outside the curated table,
   or by changes in nested/imported values, are not detected.

4. **Estimate** (`src/estimate.ts`): monthly cost per resource = price table ×
   usage assumptions, totals per environment (from the `Environment` tag, else
   the Stage assembly name).
5. **Gate** (`src/gate.ts`) and **reports** (`src/report.ts`).

## Estimator method

Price table: `tools/finops/pricing/ap-southeast-1.yaml` — `version
2026.10.13-1`, `capturedAt 2026-10-13`, transcribed from the public AWS Price
List bulk offer files (regional ap-southeast-1 offers and the global
CloudFront offer; each service records its offer publication date). Bump
`version` and `capturedAt` on every change.

| Resource                                                                           | Formula (730 h/month)                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWS::RDS::DBInstance` (PostgreSQL)                                                | class hourly (Single-AZ or Multi-AZ column) × 730 + `AllocatedStorage` × storage GB-month (×2 for Multi-AZ). Backups assumed within the free allocation; Aurora not modelled                                                                          |
| `AWS::ECS::Service` (Fargate)                                                      | tasks × (vCPU × vCPU-h + GB × GB-h, arm64/x86 from the task definition) × 730; tasks = `DesiredCount`, else autoscaling `MinCapacity`, else 1; `FARGATE_SPOT` weight share × `fargate.spotDiscountPercent` assumption (Spot is not in the price list) |
| `AWS::EC2::NatGateway`                                                             | hourly × 730 + `natGateway.dataProcessedGbPerMonth` × per-GB                                                                                                                                                                                          |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` (ALB)                                  | (hourly + `alb.averageLcu` × LCU-h) × 730                                                                                                                                                                                                             |
| `AWS::EC2::VPCEndpoint` (Interface)                                                | subnets × hourly per AZ × 730 + data processed                                                                                                                                                                                                        |
| `AWS::CloudFront::Distribution`                                                    | `cloudfront.dataTransferOutGbPerMonth` × AP first-10-TB rate + HTTPS requests                                                                                                                                                                         |
| `AWS::DynamoDB::Table`                                                             | on-demand: RRU + WRU × (1 + GSIs) per million; provisioned: (RCU, WCU incl. GSIs) × hourly × 730; + storage GB and PITR GB                                                                                                                            |
| `AWS::DynamoDB::GlobalTable`                                                       | table model × replicas (approximation)                                                                                                                                                                                                                |
| `AWS::Lambda::Function`                                                            | requests + invocations × duration × memory GB × GB-s (arm64/x86)                                                                                                                                                                                      |
| `AWS::Lambda::Alias` / `Version`                                                   | provisioned concurrency × memory GB × 730 h × 3600 × PC rate                                                                                                                                                                                          |
| `AWS::StepFunctions::StateMachine`                                                 | standard: executions × transitions / 1000 × rate; express: requests + GB-s                                                                                                                                                                            |
| `AWS::Logs::LogGroup`                                                              | ingest GB × rate + (ingest × compression ratio × retention days / 30) × storage rate                                                                                                                                                                  |
| `AWS::CloudWatch::Alarm`                                                           | metrics per alarm × standard alarm rate                                                                                                                                                                                                               |
| `AWS::KMS::Key`, `AWS::SecretsManager::Secret`, `AWS::S3::Bucket`, `AWS::EC2::EIP` | flat monthly / per-GB                                                                                                                                                                                                                                 |

Free or negligible types (IAM, security groups, listeners, target groups,
OAC, response-headers policies, budgets, …) are ignored; any other type is
listed under **Not priced** in the report (e.g. ECR storage, CloudWatch
dashboards, CloudFront Functions) — nothing is silently dropped.

Usage assumptions: `tools/finops/assumptions/usage.yaml` (`version
2026-10-13`). `defaults` apply everywhere; `environments.<env>` deep-merges
over them. Every value is a guess to be challenged in review and replaced by
measured data (CUR, Cost Explorer, CloudWatch) once the service runs.

Run the gate against your own synth to see the per-environment estimate; the largest items in
`prod` are the Multi-AZ RDS instance, Step Functions state transitions at the assumed execution
volume and the Fargate tasks.

## Thresholds and approval

`tools/finops/thresholds.yaml` (zod-validated):

| Setting                                                  | Default                                                        | Meaning                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `approval.monthlyIncreaseUsd` / `monthlyIncreasePercent` | 50 USD / 20 %                                                  | per-environment estimated increase that requires approval (either condition)              |
| `approval.perEnvironment`                                | dev 100/50 %, prod 25/10 %                                     | overrides                                                                                 |
| `approval.destructiveChangesRequireApproval`             | `true`                                                         | schema literal — cannot be disabled                                                       |
| `approval.newResourceTypesRequiringApproval`             | NAT gateway, RDS instance/cluster, load balancer, VPC endpoint | adding one always needs approval                                                          |
| `approvalSignals.mergeRequestLabel`                      | `finops-approved`                                              | read from `CI_MERGE_REQUEST_LABELS` (comma-separated, set by GitLab in MR pipelines)      |
| `approvalSignals.approvalVariable`                       | _not set_ (opt-in)                                             | when configured, `<VAR>=true` grants approval — only safe if Maintainers alone can set it |

The label is an **audit signal, not an authorization control**: anyone who can
label an MR can add it. On GitLab CE the enforced control is that only Maintainers
merge, after reviewing the FinOps report; approval rules / enforced CODEOWNERS are
Premium features. A protected variable does not reach feature-branch MR pipelines and
an unprotected one would approve every MR, so no variable is configured by default.

## CLI (for CI)

Use `pnpm -C tools/finops run <script> <args>` or `node
tools/finops/dist/bin.js` (built); `pnpm --filter` collapses exit codes to 1.

```
starter-finops check --base <target-branch cdk.out> --head <MR cdk.out> [--out reports/finops]
starter-finops diff  ...   # same report, never gates
  [--region <region>] [--prices tools/finops/pricing/<region>.yaml] [--usage tools/finops/assumptions/usage.yaml]
  [--thresholds tools/finops/thresholds.yaml] [--quiet]
```

| Exit | Meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| 0    | no approval needed, or approval signal present                     |
| 1    | approval required and missing (`check` only)                       |
| 2    | usage/configuration error (no head templates, invalid YAML/schema) |

Outputs: `reports/finops/finops-report.md` (MR comment/artifact) and
`finops-report.json` (decision, per-environment deltas, per-resource cost
changes, diff, destructive changes, unpriced types, budget alignment, price
table and assumption versions). A missing or empty `--base` treats every
resource as new (first pipeline on a branch).

## Budgets

The `CostGuardrails` construct deploys one `AWS::Budgets::Budget` per
environment (monthly COST budget filtered on the `Project` and `Environment`
cost allocation tags; ACTUAL notifications at 50/80/100 % and FORECASTED at
100 %; limits dev 150, staging 400, prod 1500 USD in `infra/environments/*.ts`).

- The FinOps report includes an **advisory budget alignment** table: head
  estimate vs. the budget limit found in the head templates (warning at
  ≥ 80 %, over at > 100 %).
- `tools/finops/budgets/budgets.example.yaml` and
  `tools/finops/budgets/aws-cli/<env>.{budget,notifications}.json` are
  equivalent definitions for payer/management accounts that manage budgets
  outside the workload stack:

  ```sh
  aws budgets create-budget --account-id <payer-or-member-account> \
    --budget file://tools/finops/budgets/aws-cli/prod.budget.json \
    --notifications-with-subscribers file://tools/finops/budgets/aws-cli/prod.notifications.json
  ```

- Budgets only see tag-filtered spend after `Project`, `Environment` (and
  `CostCentre`) are **activated as cost allocation tags** in the payer
  account; until then a budget reports zero.

## Drift detection (`@starter/tool-drift`)

Drift can only be observed against deployed stacks. The tool runs
CloudFormation `DetectStackDrift` → polls `DescribeStackDriftDetectionStatus`
→ `DescribeStackResourceDrifts` (MODIFIED/DELETED, paginated) for every stack
of a stage (names read from the Stage assembly manifest in `cdk.out`, or
`--stacks`), sequentially.

Gating: it calls AWS **only** when explicitly opted in (`--execute` or
`DRIFT_DETECTION_ENABLED=true`) **and** credentials resolve through the
default provider chain (10 s timeout). Otherwise it writes:

```json
{
  "status": "not-configured",
  "executed": false,
  "reason": "...",
  "note": "Drift is only detected by CloudFormation DetectStackDrift against deployed stacks. Offline checks (cdk-nag, Guard, FinOps template diff) do not and cannot detect drift.",
  "stacks": []
}
```

```
starter-drift --stage prod [--cdk-out infra/cdk.out | --stacks a,b] [--region ap-southeast-1]
          [--execute] [--out reports/drift] [--timeout-seconds 600] [--poll-seconds 5]
```

| Exit | Status                                                                                    |
| ---- | ----------------------------------------------------------------------------------------- |
| 0    | `in-sync` — all stacks IN_SYNC                                                            |
| 1    | `drifted` — at least one stack DRIFTED (resources and property differences in the report) |
| 2    | `error` — usage error, API error (e.g. stack not deployed), detection failed or timed out |
| 3    | `not-configured` — no opt-in or no credentials; nothing was checked                       |

Outputs: `reports/drift/drift-report.{json,md}`. In CI run it as a scheduled
or manual job with a read-only role (`cloudformation:DetectStackDrift`,
`DescribeStackDriftDetectionStatus`, `DescribeStackResourceDrifts`, plus the
read permissions CloudFormation needs for each resource type) and treat exit 3
as "skipped", never as success.

## Limitations

- Prices are a snapshot; refresh them deliberately. Only `ap-southeast-1` has a price table; the
  region comes from the cloud assembly (or `--region`), and a region without
  `tools/finops/pricing/<region>.yaml` fails closed (exit 2), never priced with another region's data.
- Usage is assumed, not measured. CPU credits (T4g unlimited), backups beyond
  the free allocation, inter-AZ/internet transfer outside CloudFront/NAT,
  Performance Insights, enhanced monitoring, WAF and RDS log exports are not
  modelled.
- Destructive-change detection is a curated, static approximation of
  CloudFormation replacement semantics.
- Drift detection covers only resource types and properties CloudFormation
  supports for drift; it reports nothing without credentials and opt-in.
