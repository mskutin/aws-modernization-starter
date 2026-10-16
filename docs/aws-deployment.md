# Deploying to AWS (optional)

Nothing in this repository deploys to AWS on its own. CI has no AWS credentials unless you mount
them on a protected runner and opt in ([ci-cd.md](ci-cd.md) §7), and every path on this page starts
only when an operator runs it. Read [limitations.md](limitations.md) first.

There are three ways to put the reference on AWS:

| Path                                                        | What is deployed                                                                                     | Who runs it                     | Purpose                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| [Integration mini-stack](#integration-mini-stack-lifecycle) | the workflow only: state machine, Lambdas, job-state table, an ephemeral KMS key                     | an operator (or opt-in CI jobs) | run the workflow tests against real Step Functions, Lambda and DynamoDB |
| [Sandbox profile](#full-sandbox-lifecycle)                  | the whole application in a self-contained `Sandbox` stage (own VPC, keys, log bucket, a test issuer) | an operator                     | functional validation on an ordinary, dedicated AWS account             |
| [Governed stages](#governed-stages-devstagingprod)          | `dev`, `staging`, `prod` into an existing landing zone                                               | your deployment process         | the real target; needs your landing-zone values and approvals           |

The two lifecycle paths were exercised once in a disposable personal sandbox account. That is
evidence of functional behaviour on ordinary AWS, not of compliance with any landing zone or control
set, and the governed stages have never been deployed.

## Prerequisites

| What                        | Needed for              | Notes                                                                                                                                                                                                                                                                         |
| --------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A **dedicated** AWS account | mini-stack, sandbox     | an account you own and may change, with no production workloads; the scripts refuse any other account than the one you name                                                                                                                                                   |
| Expected-account file       | mini-stack, sandbox     | `${SANDBOX_HOME:-~/.config/starter-aws-sandbox}/expected-account` (mode 0600, 12 digits), or `AWS_INTEGRATION_EXPECTED_ACCOUNT` for the mini-stack                                                                                                                            |
| AWS CLI v2                  | sandbox (and the guard) | the exact version the account guard pins (`tools/aws-preflight/README.md`)                                                                                                                                                                                                    |
| IAM Identity Center profile | sandbox                 | the scripts use the profile name `starter-sandbox-developer`; no static keys, no `[default]` profile, no `AWS_*` credential variables                                                                                                                                         |
| Workspace build             | all                     | `pnpm install --frozen-lockfile && pnpm build`; `pnpm` on `PATH` (Lambda bundling)                                                                                                                                                                                            |
| `skopeo`, `cosign`, `curl`  | sandbox                 | image copy to ECR and verification of a CI-published image; rootless Podman for the local image build fallback                                                                                                                                                                |
| Adopted sandbox exceptions  | sandbox                 | the sandbox relaxations ship as an example register (`policies/exceptions/examples/sandbox/`) that nothing loads; adopt the entries you accept as dated project entries before `up.sh`, or the sandbox synth fails ([policy-as-code.md](policy-as-code.md#adopting-an-entry)) |
| Read-only preflight         | recommended             | `tools/aws-preflight` inventories the account read-only before the first deployment                                                                                                                                                                                           |

The account guard (`tools/aws-preflight/scripts/sandbox-guard.sh`) runs an STS identity check
immediately before every mutating command and refuses (before any AWS call) on an account,
principal or region mismatch, a CI environment, static credentials or endpoint overrides.

## Region

The default region is `ap-southeast-1`. Any region of the commercial `aws` partition can be
configured; precedence, highest first:

| Component                                  | Region source                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| CDK application stages                     | `-c region.<env>=…` > `-c region=…` > `STARTER_REGION_<ENV>` > the committed environment config > default          |
| Integration mini-stack app                 | `-c region=…` > default (the lifecycle scripts pass it)                                                            |
| Mini-stack lifecycle scripts               | `AWS_INTEGRATION_REGION` (default `ap-southeast-1`); `AWS_REGION` must equal it, or the scripts refuse with exit 4 |
| Sandbox lifecycle scripts                  | `SANDBOX_REGION` (default `ap-southeast-1`); a resumed run must use the region it was deployed in                  |
| `tools/aws-preflight`, `tools/aws-sandbox` | `--region` (default `ap-southeast-1`)                                                                              |

The CDK apps never read the ambient `AWS_REGION`/`AWS_DEFAULT_REGION`, so a shell setting cannot
redirect a deployment. Region-specific data must exist for the region you choose, otherwise the
tooling refuses it rather than using another region's values:

- **Prices:** cost estimates need `tools/finops/pricing/<region>.yaml` (and
  `tools/aws-sandbox/pricing/supplement.<region>.json` for the sandbox tool). Only
  `ap-southeast-1` is committed.
- **CloudFront origin-facing prefix list:** its id differs per region. Only the `ap-southeast-1` id
  is committed (`infra/lib/region.ts`); for another region pass it explicitly (sandbox:
  `SBX_ORIGIN_PREFIX_LIST_ID`, whose script default is the `ap-southeast-1` id).
- Certificates for CloudFront and the CLOUDFRONT-scope WAF stay in `us-east-1` regardless of the
  workload region.

## Costs

Every figure in this repository is an **estimate** from a dated, manually maintained list-price
snapshot and stated usage assumptions: not live prices, not a quote, not a bill forecast, no free
tier or discounts. AWS Budgets alerts but does not cap spend. Estimate before you deploy and check
your bill afterwards:

```bash
pnpm --filter '@starter/tool-aws-sandbox...' build
node tools/aws-sandbox/dist/bin.js estimate --phase 1 --out estimate-mini-stack.json   # integration mini-stack
node tools/aws-sandbox/dist/bin.js estimate --phase 2 --out estimate-sandbox.json      # full sandbox profile
```

(`--phase 1` is the integration mini-stack, `--phase 2` the full sandbox stage.) The sandbox profile
runs a NAT gateway, an RDS instance, an ALB, a Fargate task, KMS keys and CloudFront for as long as it
is up; tear it down as soon as the checks finish. Details: [finops.md](finops.md) and
[tools/aws-sandbox/README.md](../tools/aws-sandbox/README.md).

## Integration mini-stack lifecycle

`IntegrationWorkflowStack` (`infra/bin/integration.ts`) deploys the same workflow constructs as the
application, isolated per run (`starter-it-<runId>`), with an ephemeral KMS key, sweeper tags and a
TEST ONLY table of synthetic documents instead of RDS (ADR 0232).

```bash
export AWS_INTEGRATION_ENABLED=true AWS_REGION=ap-southeast-1     # plus credentials for the dedicated account
export AWS_INTEGRATION_EXPECTED_ACCOUNT=<12 digits>               # or the expected-account file
tests/aws-integration/scripts/lifecycle.sh                        # deploy -> test -> destroy + verify
```

Step by step: `deploy.sh`, `run.sh`, `cleanup.sh` in the same directory. Nothing touches AWS unless
`AWS_INTEGRATION_ENABLED=true`, an expected account is configured and the region matches; every
`cdk` call carries `-c account=<expected>`, and outside CI each mutation runs through the account
guard. `run.sh` sets `AWS_INTEGRATION_REQUIRED=true`, so a test that would skip fails instead.
Behaviour, exit codes and environment variables: [testing.md](testing.md) §5.

In GitLab CI the same lifecycle exists as opt-in jobs (`aws:integration:deploy` is manual and needs a
green `policy:infra`), created
only on protected refs with `AWS_JOBS_ENABLED=true` and credentials mounted on a protected runner.

## Full sandbox lifecycle

`tests/aws-integration/sandbox/` deploys the `Sandbox-*` stages (synthesized with `-c envs=sandbox`
and the self-contained sandbox foundation), runs the live checks (SPA, health, origin protection,
smoke, security suite, rate limits, browser E2E, in-VPC database TLS and privilege probes, leak
scans, Step Functions executions), exercises an ECS circuit-breaker rollback, then tears everything
down and verifies the account.

```bash
pnpm build
pnpm --filter @starter/tests-e2e run test:aws-auth-offline   # offline preflight of the sign-in routing
bash tests/aws-integration/sandbox/all.sh                    # bootstrap if absent -> up -> test -> rollback -> down -> verify
```

`all.sh` runs the teardown from an `EXIT` trap, so a failure, Ctrl-C or SIGTERM still tears down.
One run at a time per account (fixed stack names). Runbook, environment variables, timings, what
each check proves and the operator permission set it was designed for:
[tests/aws-integration/sandbox/README.md](../tests/aws-integration/sandbox/README.md).

The sandbox profile relaxes a few controls for cost and teardown (it creates its own VPC, keys and
log bucket, and uses a test issuer instead of an organization IdP). The relaxations ship as an
example register scoped to the `sandbox` environment; they apply only after you adopt them as dated,
expiring project entries, and none of them applies to `dev`, `staging` or `prod`.

## Teardown and verification

Both lifecycles tear down from a trap and then **verify** rather than assume:

- The mini-stack cleanup (`cleanup.sh`) runs `cdk destroy`, falls back to `DeleteStack` by run-id
  tag, and writes `cleanup-status.json`. Only `clean` exits 0; leaked resources, errors, an
  unverifiable key state or a resource sweep that was not permitted each have their own exit code.
  The run's KMS key is scheduled for deletion (7-day window) by design and listed as pending, not as
  a leak.
- The sandbox teardown (`down.sh`) acts only on stacks and resources of the run (by name and tag),
  then `verify.sh` runs a read-only sweep (`tools/aws-sandbox verify-clean --strict`) against a
  baseline taken before the first deployment. Categories the operator role cannot list are reported
  as **unverifiable** (exit 5), never as clean: read the printed evidence before you call the
  account clean.
- `bootstrap.sh --destroy` removes the CDK bootstrap stack only if this experiment created it.
- A scheduled sweeper (`tests/aws-integration/dist/sweeper.js`) can delete expired, tagged
  mini-stacks; it is a dry run unless `--apply` is given.

Export the evidence you want to keep **before** the sandbox teardown: it deletes the log groups.
Keep raw run directories private; they contain account identifiers and per-run secrets.

## Governed stages (dev/staging/prod)

The `dev`, `staging` and `prod` stages import a landing zone and contain placeholders. Before a
first deployment you must replace the placeholder values, bootstrap each account with the qualifier
and permissions boundary your platform team approves, and confirm the network, key-policy, logging
and identity prerequisites: [landing-zone-adaptation.md](landing-zone-adaptation.md). Deployment
order and rollback per component: [architecture.md](architecture.md) §7. Deploy jobs that take
`-c apiImageDigest=sha256:…` and `requireImageDigest=true` are a pattern described there; the
pipeline in this repository does not deploy the governed stages.
