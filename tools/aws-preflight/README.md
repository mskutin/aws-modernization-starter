# @starter/tool-aws-preflight — read-only AWS sandbox discovery

A small CLI for an "AWS sandbox preflight" before a first deployment. It runs a fixed set of read-only AWS CLI v2
calls against **one explicitly identified sandbox member account**, after an identity gate, and
writes sanitized, committable evidence. The tool itself can only issue the allowlisted `get-*`,
`list-*` and `describe-*` calls below; that guarantee depends on the AWS CLI binary and its
configuration, which the tool pins and checks before it starts any `aws` process (see
[Trust assumptions](#trust-assumptions)).

Running this tool creates nothing; it only reads metadata, and only after a human runs it with their own SSO session. It never runs in CI.

Two **execution profiles** ([Execution profiles](#execution-profiles)): `strict` (the default, for a
governed account) and `personal-sandbox` (an ordinary, dedicated
sandbox account whose owner authorizes their own, possibly administrator-equivalent, permission
set). The package also holds the **mutation guard** for a live validation
([Mutation guard](#mutation-guard)): `dist/guard-cli.js check` and
[`scripts/sandbox-guard.sh`](scripts/sandbox-guard.sh), which verify the account with one
`sts get-caller-identity` before every mutating command that other scripts run. The guard itself
mutates nothing.

## Safety model

### What the tool enforces

- **One static allowlist** ([`src/probes.ts`](src/probes.ts)): 79 probe definitions, 53 AWS CLI
  operations, 52 IAM actions, 19 services. Each definition has an id, a discovery area (`area`: `org-iam`, `network-edge`,
  `quotas-services`, `finops` or `identity`), the AWS CLI
  service and operation, the exact IAM action, the allowed regions (the workload region `--region`,
  default `ap-southeast-1`, and `us-east-1`), fixed arguments, a response bound and a sanitizing projection. Only validated
  values are interpolated (account, qualifier, VPC ID, KMS alias, boundary policy ARN, engine
  version, the caller's role and policy names, budget names read back from `describe-budgets`),
  always as `--option=<value>`, and no value may start with `-`.
- **Rules checked at module load and again at the exec boundary** ([`src/policy.ts`](src/policy.ts)):
  the operation matches `^(get|list|describe)-[a-z0-9-]+$`; the IAM action uses a Get/List/Describe
  verb and matches the operation name; the service is one of 19 allowed CLI services; nothing on
  the denylist (below); regions are a subset of the two allowed regions. One reviewed exception to
  the verb rule: AWS Budgets authorizes `DescribeBudgets` and `DescribeNotificationsForBudget` with
  `budgets:ViewBudget` (access level Read, [Service Authorization Reference][sar-budgets]).
- **One exec boundary** ([`src/executor.ts`](src/executor.ts)), the only module that starts
  processes (enforced by `test/static.test.ts`). It accepts a probe **id**, rebuilds the argv from
  the frozen definition and checks the final argv against a **separately maintained list** of
  `service operation iamAction` triples ([`src/boundary.ts`](src/boundary.ts)): a probe added to
  the registry but not to that list is refused. Only the option tokens of the probe's own
  arguments, its bound flag and the standard flags are accepted, each in the form the probe uses;
  prefixes that the CLI's argument parser would expand (`--no-verify`, `--deb`, `--endpoint`,
  `--query`, `--cli-input`, `--profile=`, ...) and short options are refused; and exactly one each
  of
  `--profile <p> --region <r> --output json --no-cli-pager --cli-connect-timeout 10 --cli-read-timeout 30`
  must be present. Discovery probes are refused until the identity gate has passed.
- **`execFile`, never a shell**; stdin closed; a wall-clock timeout per call (`--call-timeout`,
  default 150 s) after which the child is killed with SIGKILL; strictly sequential calls. The AWS
  CLI retries in standard mode (3 attempts); the tool adds at most one retry, for throttling only.
  Expired credentials are never retried.
- **Child environment built from scratch**: only `HOME`, `PATH`, `LANG`, `LC_*`, `TZ` and, when
  set, `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` (either case) and `AWS_CA_BUNDLE` are passed through
  (recorded by name only), plus fixed `AWS_PAGER=""`, `AWS_CLI_AUTO_PROMPT=off`,
  `AWS_RETRY_MODE=standard`, `AWS_MAX_ATTEMPTS=3`, `AWS_EC2_METADATA_DISABLED=true`,
  `AWS_CLI_ERROR_FORMAT=legacy` (pins the error text the classifier parses),
  `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true` and `PYTHONNOUSERSITE=1`. `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`,
  `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_CONTAINER_*`, `AWS_ENDPOINT_URL*`,
  `AWS_CONFIG_FILE`, `AWS_DATA_PATH` and `PYTHONPATH` never reach the CLI; the profile must
  therefore live in `$HOME/.aws/config`.
- **No AWS SDK**, and the tool never reads, stores or passes credentials: the AWS CLI resolves the
  SSO profile itself.
- **Denylist** (asserted absent by tests, `DENIED_OPERATIONS`): `secretsmanager get-secret-value`,
  any `ssm` call with `--with-decryption`, `ssm get-parameters-by-path`, `kms get-key-policy`,
  `kms decrypt`, `ec2 get-password-data`, `ec2 get-console-output`, `ecr get-login-password`,
  `ecr get-authorization-token`, `sts get-session-token`/`get-federation-token`/`assume-role*`,
  `lambda get-function`, `cloudformation get-template`, `iam get-account-authorization-details`,
  `iam get-credential-report`, `logs get-log-events`/`filter-log-events`, any `s3`/`s3api`, any
  `ce` (billed per request), `configure export-credentials`,
  `budgets describe-subscribers-for-notification`, `budgets describe-budget-performance-history`,
  and more. `a.cdk.bootstrap-version` passes `--no-with-decryption` explicitly (the API default);
  the bootstrap version parameter is a plain `String`.
- **Fail closed before the first AWS call** (exit 2): `CI` or `GITLAB_CI` set; a required argument
  missing or invalid; a malformed `--region` or one outside the `aws` partition; both human statements given; `HOME`
  unset; the AWS CLI configuration refused (next section); the raw output directory inside a git
  work tree, writable by others, or not private; the AWS CLI missing, v1, not 2.35.11, or its file
  or directory writable by group or others.

### Trust assumptions

The AWS CLI child gets `HOME`, so it loads `$HOME/.aws`. Command aliases (`~/.aws/cli/alias`,
including `!` shell aliases), service models (`~/.aws/models`, `data_path`), plugins
(`[plugins]`), endpoint overrides (`endpoint_url`, `[services ...]`), `credential_process`,
assume-role chains and `cli_history` can each replace, extend, redirect or record an allowlisted
call after every check in this tool has passed, and even `aws --version` loads plugins. Before
**any** `aws` process, the tool therefore checks the configuration offline
([`src/awsconfig.ts`](src/awsconfig.ts), parsed like aws-cli 2.35.11's `RawConfigParser`, values
never printed) and refuses (exit 2) when:

- `~/.aws/cli/alias` or `~/.aws/models` exists;
- `~/.aws/config` has a `[plugins]`, `[services ...]` or `[DEFAULT]` section, or anywhere sets
  `data_path`, `endpoint_url`, `ca_bundle`, `credential_process`, `credential_source`, `role_arn`,
  `source_profile` or `web_identity_token_file` (also as nested keys), or enables `cli_history`;
- the selected profile, its `[sso-session ...]` or `[default]` has any key other than
  `sso_session`, `sso_start_url`, `sso_region`, `sso_account_id`, `sso_role_name`,
  `sso_registration_scopes`, `region` and `output`;
- `~/.aws/credentials` has a section for the selected profile;
- the profile's `sso_account_id` is not `--expected-account` ("ACCOUNT MISMATCH (offline)"), or
  `--expected-role-pattern` cannot match `AWSReservedSSO_<sso_role_name>_<16 hex>`;
- the file cannot be parsed the way the CLI parses it (duplicate sections or keys, unusual quoted
  section headers).

The CLI also gets `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true`. What the tool still trusts:

- the AWS CLI binary itself: exactly **2.35.11** (other versions are refused), recorded in the
  evidence with its real path and SHA-256, refused when it or its directory is writable by group or
  others. Use the pinned Nix revision below;
- the SSO token and role-credential caches (`~/.aws/sso/cache`, `~/.aws/cli/cache`), the operating
  system, Python and Node.js;
- the network path: `HTTPS_PROXY` and `AWS_CA_BUNDLE` are passed through. A TLS-intercepting proxy
  sees every request, including the SSO bearer token the CLI exchanges for role credentials.

**The read-only guarantee.** With a `verified-read-only` identity, AWS itself refuses any write.
With an `attested` identity it rests on a human statement, and with `write-capable-accepted` it
rests **entirely on this tool**: the allowlist, the exec boundary and the configuration refusals
above. Nothing on the AWS side then stops a write if the CLI or its environment were subverted.

### What it can still see

- Account metadata: VPC and subnet CIDRs, route targets, names (the evidence keeps only the
  project's own names, see [Sanitization](#sanitization)), tag keys, quotas, budget limits, the CDK
  bootstrap parameters, and the documents of the caller's own inline and customer managed policies
  (used for the assessment; only derived facts reach the evidence). The **raw** responses (private
  directory) contain everything the APIs returned, including ARNs, account IDs, the caller's
  session name, the management account's e-mail address (`DescribeOrganization`), budget spend and
  those policy documents; treat that directory as sensitive.
- `budgets:ViewBudget` also authorizes `DescribeSubscribersForNotification` (subscriber e-mail
  addresses), `DescribeBudgetPerformanceHistory` (historical spend) and
  `DescribeBudgetNotificationsForAccount`. IAM cannot separate them; only this tool's allowlist
  (and its denylist) keeps them from being called. An identity that holds `ViewBudget` can call
  them with any other client.
- Every call is an ordinary, signed AWS API request made by the operator's role session. CloudTrail
  records them as read-only management events ([read and write events][ct-mgmt]; Event history keeps
  [90 days of management events][ct-history] per Region and trails log management events by
  default). They count against API rate limits and may be noticed by the account's security
  monitoring: tell the account owner before running.
- Besides the probes, the AWS CLI's own SSO credential provider talks to IAM Identity Center to
  obtain role credentials for the profile (and may refresh the SSO token), and caches them under
  `~/.aws/sso/cache` and `~/.aws/cli/cache` for the session duration. Run `aws sso logout` after the
  run; it deletes both.
- `organizations list-parents` / `list-policies-for-target` only work from the management account
  or a delegated administrator; from a sandbox member account `access-denied` is the expected
  result (recorded as UNKNOWN visibility, not absence).

## Identity gate

Runs first, in this order; any failure stops the run and **no evidence file is written**.

1. `sts get-caller-identity` — `Account` must equal `--expected-account` (else exit **3**
   "ACCOUNT MISMATCH — STOP", after exactly this one call, and its response is not even written to
   the raw directory). The principal must be an assumed role (root, IAM user or federated user:
   exit **4**) whose name matches `--expected-role-pattern` (an anchored glob such as
   `AWSReservedSSO_<PermissionSet>_*`; `*` (at most 4) and `?` are the only wildcards, `.`, `+`
   and `@` are literal, at least 3 literal characters; exit **4** otherwise).
2. The caller's own role: `iam get-role` (the role path `/aws-reserved/sso.amazonaws.com/` decides
   `roleKind`), `list-attached-role-policies`, `list-role-policies`, then the document of every
   inline policy (`get-role-policy`) and of the default version of every attached customer managed
   policy (`get-policy`, `get-policy-version`), at most 10 each. The gate computes a level:

   | Level                    | When                                                                                                                                                                                                                                    | Runs with                                                                                        |
   | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
   | `verified-read-only`     | every AWS managed policy is metadata-only (`AWSBudgetsReadOnlyAccess`, `ServiceQuotasReadOnlyAccess`) and every inline / customer managed policy allows only literal actions of the allowlist (Deny statements and conditions are fine) | nothing else                                                                                     |
   | `read-only-data-capable` | `job-function/ViewOnlyAccess`, `SecurityAudit`, `AWSOrganizationsReadOnlyAccess`, or a policy that allows reads outside the allowlist (`s3:GetObject`, `ec2:Describe*`, `NotResource`)                                                  | `--attest-read-only` or `--accept-write-capable`                                                 |
   | `unverified`             | a policy list or document could not be read (AccessDenied, truncated, more than 10, unparseable)                                                                                                                                        | `--attest-read-only`; `--accept-write-capable` only when every policy list and document was read |
   | `write-capable`          | `ReadOnlyAccess` (reads data; `sqs:ReceiveMessage` changes queue state), `PowerUserAccess`, any other AWS managed policy (not reviewed), or a policy that allows anything that is not a read                                            | `--accept-write-capable` only                                                                    |
   | hard stop                | `AdministratorAccess` (and `AdministratorAccess-*`), `IAMFullAccess`, `AWSOrganizationsFullAccess`, or an inline / customer managed policy that allows `*`, `iam:*` or `organizations:*` on every resource                              | never: exit **5**, no override                                                                   |

   Without the statement a level needs, the gate stops with exit **5**. The evidence records
   `readOnlyAssessment` (`verified-read-only`, `attested` or `write-capable-accepted`), the
   `computedLevel`, the attached policy names with their category, and for each policy document
   its SHA-256 (canonical JSON), statement counts and the names of non-allowlisted actions — never
   the document itself. Privilege-escalation paths other than the hard-stop patterns (for example
   `iam:PutRolePolicy` on some roles) count as `write-capable`, not as a hard stop.

   - `--attest-read-only "<permission set + who checked it>"` and
     `--accept-write-capable "<who, when, why>"` are **human statements**: a person writes them
     after checking the permission set in IAM Identity Center (or deciding to accept a write-capable
     one); no tool or script may write or invent them. They are mutually exclusive (exit 2), recorded
     verbatim (the caller's session name, if present, becomes `<session>`), and refused (exit 2)
     when they contain an e-mail address (also `%40`-encoded), an account ID (also as
     `1111-2222-3333`), a phone number or key material.
   - `--accept-write-capable` is refused (exit 5) when the policy lists or documents could not all
     be read, because an administrator-equivalent policy can then not be ruled out.

3. `organizations describe-organization` (us-east-1): management account == caller → exit **7**
   ("management"); `AWSOrganizationsNotInUseException` → exit **7** ("not-in-org"); AccessDenied →
   organization status `unknown`, the run continues, and the evidence states it at the top
   (`gate.organization`): membership and "not the management account" are then **not evidenced**;
   any other failure → exit **7** (fail closed).

Expired or invalid credentials or SSO session at any point: exit **6** with
`aws sso login --profile <p>`. After discovery, `sts get-caller-identity` runs once more; a
different account (exit **3**) or a different principal — another role or another session name —
(exit **4**) discards the run, and no evidence is written.

## Execution profiles

`--execution-profile strict|personal-sandbox` (default `strict`).

- **`strict`** is the behavior described above, byte for byte (`test/strict-regression.test.ts`
  compares strict runs with golden outputs recorded before the switch existed). It is meant for a
  governed account: an administrator-equivalent identity is a hard stop (exit 5, no override),
  and the evidence is schema 4.
- **`personal-sandbox`** is for an ordinary, **dedicated** sandbox account that the account owner
  controls (a live validation). It validates functional behavior on ordinary AWS; it says
  nothing about compliance with the controls of any organization. It
  requires, and refuses with exit 2 before any AWS process otherwise:
  - the exact account: `--expected-account <12 digits>` or `--expected-account-file <file>` (a
    regular file, not a symbolic link, owned by the operator, mode 0600 or stricter, exactly 12
    digits; the content is never printed), not both;
  - an explicit `--profile` other than `default`, still subject to every
    [configuration refusal](#trust-assumptions) and the offline `sso_account_id` comparison;
  - one `--region` (default `ap-southeast-1`; any `aws`-partition region);
  - an environment without static keys (`AWS_ACCESS_KEY_ID`, the secret access key, session token
    or security token variables), `AWS_DEFAULT_PROFILE`, an `AWS_PROFILE` other than `--profile`,
    an `AWS_REGION` / `AWS_DEFAULT_REGION` other than `--region`, or a variable that selects another
    credential source, configuration file, endpoint or service model (`AWS_ROLE_ARN`,
    `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_CONTAINER_*`, `AWS_CONFIG_FILE`,
    `AWS_SHARED_CREDENTIALS_FILE`, `AWS_ENDPOINT_URL*`, `AWS_DATA_PATH`, `PYTHONPATH`). The
    discovery child never receives these anyway; the refusal keeps the operator's shell consistent
    with what the guard checks;
  - `--owner-authorization "<text>"`: a **human statement written and entered by the account
    owner** (who, when, why, naming the permission set and this sandbox only). No tool or script may
    write, invent or paraphrase it. It is recorded verbatim (session name masked) and refused when
    it contains an e-mail address, an account ID, a phone number, key material,
    a line break, or `<` / `>` (a template placeholder is not a statement);
  - neither `--attest-read-only` nor `--accept-write-capable` (they belong to `strict`);
  - no identity a command could fall back to if it lost `AWS_PROFILE`: no
    `[default]` or `[profile default]` section in `~/.aws/config`, no `~/.aws/credentials` with any
    section or key (an empty or comment-only file is fine), and no `profile` key in
    `~/.cdk.json`, `cdk.json` of the working directory or the project's `infra/cdk.json` (the CDK
    CLI prefers it over `AWS_PROFILE`). Checked after the configuration refusals, before any
    process.

  The identity gate then runs steps 1 and 3 unchanged (account, assumed role matching
  `--expected-role-pattern`, organization member and not the management account). Step 2 computes
  the same level but **accepts every level**, administrator-equivalent included: the evidence
  records `computedLevel` (`administrator-equivalent` for what `strict` hard-stops),
  `readOnlyAssessment: personal-sandbox-accepted` (or `verified-read-only` when it is),
  `accepted: personal-sandbox`, the principal ARN (account `********NNNN`, session `<session>`),
  the owner authorization and the administrator-equivalence reasons. Discovery then uses **the same
  allowlist, exec boundary, discovery latch and configuration refusals**; no probe is added or
  changed. With such an identity nothing on the AWS side keeps the run read-only: the guarantee
  rests entirely on this tool, the pinned CLI and the refused configuration.

  Names of the sandbox stage's stacks and the `Name` tags CDK derives from them (`Sandbox-*`) stay
  readable in personal-sandbox evidence (like `starter*` and `starter-it-*` in both profiles), so a
  pre-existing stack or VPC of the experiment is visible.

## Running it

Prerequisites:

- AWS CLI **2.35.11** from a pinned nixpkgs revision (the tool refuses any other version):
  `nix shell github:NixOS/nixpkgs/e8be7818e19ada32105a8af937a6a473b38167ca#awscli2`. On this
  nix-darwin workstation the plain `nix shell nixpkgs#awscli2` follows the flake registry and only
  happens to resolve to 2.35.11 today.
- A native IAM Identity Center profile in `~/.aws/config` with exactly this shape (values are
  placeholders), and nothing from the refusal list above anywhere in `~/.aws`:

  ```ini
  [profile <profile>]
  sso_session = <session-name>
  sso_account_id = <12-digit-sandbox-account>
  sso_role_name = <PermissionSet>
  region = ap-southeast-1
  output = json

  [sso-session <session-name>]
  sso_start_url = https://<directory>.awsapps.com/start
  sso_region = <identity-center-region>
  sso_registration_scopes = sso:account:access
  ```

  Permission-set names may contain `@` (for example `<org>@<PermissionSet>-<suffix>`); the role
  pattern is then `AWSReservedSSO_<org>@<PermissionSet>-<suffix>_*`. Use a profile name without
  digits (a name with digits is printed as `<profile>`).

- `aws sso login --profile <profile>`, a clean checkout of the reviewed commit
  (`git status --porcelain` empty), and the account owner informed.

```sh
PIN='github:NixOS/nixpkgs/e8be7818e19ada32105a8af937a6a473b38167ca#awscli2'

# The call plan and the IAM policy (no credentials, no AWS calls)
node tools/aws-preflight/src/cli.ts plan
node tools/aws-preflight/src/cli.ts plan --format json
node tools/aws-preflight/src/cli.ts plan --format iam-policy

# Identity gate only
nix shell "$PIN" -c node tools/aws-preflight/src/cli.ts identity \
  --profile <profile> --expected-account <12-digit-account> \
  --expected-role-pattern 'AWSReservedSSO_<PermissionSet>_*' --region ap-southeast-1

# Identity gate + discovery
nix shell "$PIN" -c node tools/aws-preflight/src/cli.ts discover \
  --profile <profile> --expected-account <12-digit-account> \
  --expected-role-pattern 'AWSReservedSSO_<PermissionSet>_*' --region ap-southeast-1 \
  [--vpc-id vpc-...] [--kms-key alias/...] [--boundary-policy-arn arn:aws:iam::<account>:policy/...] \
  [--qualifier starter] [--db-engine-version 17.9] \
  [--attest-read-only '<human statement>' | --accept-write-capable '<human decision>']

# Afterwards: delete the cached SSO token and role credentials
nix shell "$PIN" -c aws sso logout
```

Personal sandbox (dedicated account; the account owner types the authorization):

```sh
PIN='github:NixOS/nixpkgs/e8be7818e19ada32105a8af937a6a473b38167ca#awscli2'
SANDBOX_HOME="${SANDBOX_HOME:-$HOME/.config/starter-aws-sandbox}"   # expected-account (0600) lives here

nix shell "$PIN" -c node tools/aws-preflight/src/cli.ts identity \
  --execution-profile personal-sandbox \
  --profile <profile> --expected-account-file "$SANDBOX_HOME/expected-account" \
  --expected-role-pattern 'AWSReservedSSO_<PermissionSet>_*' --region ap-southeast-1 \
  --owner-authorization '<typed by the account owner>'

# After a human has reviewed the identity evidence: the same arguments with discover
nix shell "$PIN" -c node tools/aws-preflight/src/cli.ts discover \
  --execution-profile personal-sandbox \
  --profile <profile> --expected-account-file "$SANDBOX_HOME/expected-account" \
  --expected-role-pattern 'AWSReservedSSO_<PermissionSet>_*' --region ap-southeast-1 \
  --owner-authorization '<typed by the account owner>' [--qualifier starter]
```

The placeholders above are refused on purpose (`<` / `>`); the statement must be the owner's own.

| Option                                                        | Meaning                                                                                                                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--profile`, `--expected-account`, `--expected-role-pattern`  | required for `identity` and `discover`                                                                                                                                         |
| `--region`                                                    | the workload region, once: default `ap-southeast-1`, any `aws`-partition region (`us-east-1` is added for global endpoints only); `plan` prints the plan and IAM policy for it |
| `--aws-cli <path>`                                            | AWS CLI 2.35.11 executable (default: the first `aws` on an absolute `PATH` entry)                                                                                              |
| `--raw-dir <dir>`                                             | private raw output base (default `~/.local/state/starter-aws-preflight`)                                                                                                       |
| `--evidence-out <file>`                                       | sanitized evidence (default `reports/aws-preflight/<command>-<runId>.json`, gitignored)                                                                                        |
| `--qualifier`                                                 | CDK bootstrap qualifier (default `starter`); the CDK default `hnb659fds` is always probed too                                                                                  |
| `--vpc-id`, `--kms-key` (repeatable), `--boundary-policy-arn` | optional targets; probes that need them are recorded as `skipped` otherwise                                                                                                    |
| `--db-engine-version`                                         | PostgreSQL version to check (default `17.9`)                                                                                                                                   |
| `--attest-read-only`, `--accept-write-capable`                | human statements, see [Identity gate](#identity-gate); mutually exclusive                                                                                                      |
| `--call-timeout`                                              | wall-clock limit per call in seconds (default 150)                                                                                                                             |
| `--execution-profile`                                         | `strict` (default) or `personal-sandbox`, see [Execution profiles](#execution-profiles)                                                                                        |
| `--owner-authorization`                                       | personal-sandbox only, required: the account owner's statement                                                                                                                 |
| `--expected-account-file`                                     | personal-sandbox only: private file with the account, instead of `--expected-account`                                                                                          |

After the run: `aws sso logout` (deletes `~/.aws/sso/cache` tokens and the role credentials in
`~/.aws/cli/cache`); once the sanitized evidence is accepted, delete the raw run directory
(`rm -r ~/.local/state/starter-aws-preflight/<runId>`) or record in the change request why and until when it
is kept (at most until the validation is closed).

## Exit codes

| Code | Meaning                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Completed (individual probes may be `access-denied`, `not-found`, `error`, `timeout` or `skipped`)                                                                              |
| 1    | Aborted on an unexpected error (identity could not be established, identity re-check failed, internal error)                                                                    |
| 2    | Refused before any AWS call (usage, CI, region, both statements, AWS CLI configuration, offline account or role mismatch, raw directory, evidence file exists, AWS CLI version) |
| 3    | ACCOUNT MISMATCH — the profile does not resolve to `--expected-account`, at the start or the end (no evidence written)                                                          |
| 4    | Principal rejected: root, IAM user, federated user, a role not matching `--expected-role-pattern`, or a different principal at the end                                          |
| 5    | Privilege check failed: administrator-equivalent (no override), or the level needs a human statement that was not given or cannot apply                                         |
| 6    | Credentials or SSO session expired/invalid (`aws sso login --profile <p>`); partial evidence if mid-discovery                                                                   |
| 7    | Organization check failed: management account, not an organization member, or membership undeterminable                                                                         |
| 8    | The leak scanner refused the sanitized output; nothing was written                                                                                                              |
| 130  | Interrupted (SIGINT/SIGTERM); partial evidence marked incomplete                                                                                                                |

The same codes apply to `personal-sandbox`; its additional refusals (missing or invalid owner
authorization, `--profile default`, environment conflicts, expected-account file, strict statements
given) are exit 2, and exit 5 does not occur for an administrator-equivalent identity there.

## Outputs

- **Raw (private, never committed)**: `<raw-dir>/<runId>/`, one JSON file per call and attempt
  (`argv`, exit code, duration, stdout, stderr) plus `run.json`. Directory mode 0700, files 0600,
  owned by the current user, created exclusively. The tool refuses (exit 2) when the directory is
  inside a git work tree (also through a symbolic link) or the base is writable by group or others.
  Retention: delete it once the evidence is accepted, or record a retention note (above).
- **Sanitized evidence (committable)**: `--evidence-out`, formatted with explicit Prettier options
  equal to the repository's `.prettierrc.json` (no configuration file, `.editorconfig` or plugin is
  ever resolved, so nothing near a custom `--evidence-out` can run inside the tool; stable under
  `pnpm format:check`). `schemaVersion: 4` contains:
  - `gate`: `organization` (`member` | `unknown`), `readOnlyAssessment`, `computedLevel`,
    `roleKind` and `principalRecheck` — read these first;
  - `tool`: version, git commit (HEAD), `sourceSha256` (package.json and `src/*.ts` of the code that
    ran) and `gitDirty` (runtime files compared with the git index, without starting `git`; staged
    but uncommitted changes are not detected — the clean-checkout rule covers them);
  - `awsCli`: version, path and real path (home directory and user names masked) and SHA-256;
  - timestamps, regions, child-environment variable names, inputs (including the key names of the
    checked profile and sso-session), the identity section (account `********1234`, permission-set
    name, session name masked, the assessment with per-policy facts and reasons, the verbatim
    human statement if one was used, organization result, re-check), and per call: `id`, `area`,
    `region`, `iamAction`, the command rebuilt from the definition with masked values, `status`
    (`ok` | `access-denied` | `not-found` | `error` | `timeout` | `skipped`), error code,
    `truncated`, `attempts` and `data` (the sanitized projection), plus a summary of counts
    (`byStatus`, and `byArea` per discovery area).

  AWS error messages are never copied; only the error code is. `access-denied` means UNKNOWN
  visibility, not absence.

  **`schemaVersion: 5`** is written by `personal-sandbox` runs only (strict runs keep writing schema
  4, unchanged, so a schema-4 document is a strict run): schema 4 plus top-level
  `executionProfile: "personal-sandbox"`, `gate.accepted: "personal-sandbox"` (when the level is not
  `verified-read-only`), `readOnlyAssessment: personal-sandbox-accepted`, `computedLevel:
administrator-equivalent` (possible only here), `identity.executionProfile`,
  `identity.principalArn`, `identity.ownerAuthorization`, `identity.reasons.administratorEquivalent`,
  `inputs.ownerAuthorizationGiven`, `inputs.expectedAccountSource` (`argument` | `file`) and one
  more entry in `notes`.

  Schemas 2 (strict) and 3 (personal sandbox) were the previous revision: the same content with the
  discovery area coded as a single letter. This revision no longer writes them.

- Expired credentials mid-run stop the run (exit 6) and write partial evidence marked
  `"complete": false`; so does an interrupt (exit 130).

## Sanitization

Each probe has a projection ([`src/projections.ts`](src/projections.ts)): an allowlist of response
fields. Everything else is dropped — descriptions, policy documents (tag and EC2 declarative
policies are reduced to tag keys / attribute values; trust policies to a principal-type summary,
`trustPolicySummary`; the caller's own policies to derived facts), e-mail addresses, IP addresses,
endpoint policies, DNS entries, budget spend, subscriber lists, quota request case IDs and
requesters, log resource policies (count only), lock tokens and non-`Name` tag values. Kept strings
then pass the masking rules ([`src/sanitize.ts`](src/sanitize.ts)):

| Value                                                             | Becomes                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| the sandbox account ID                                            | `<sandbox-account>` (`********1234` in the identity section)                                                       |
| any other account ID (12 digits, also `1111-2222-3333` or spaced) | `<other-account-N>`, stable within a run                                                                           |
| ARNs                                                              | partition, service and region kept; account as above; resource IDs masked                                          |
| EC2/VPC resource IDs (`vpc-`, `subnet-`, `rtb-`, `nat-`, ...)     | `<vpc-1>`, `<subnet-3>`, ...: type prefix kept, per-run sequence number                                            |
| UUIDs (KMS keys, ACM certificates, WAF ACLs, stack IDs)           | `<uuid-N>`                                                                                                         |
| organization, OU, root and SCP IDs                                | `<org-N>`, `<ou-N>`, `<org-root-N>`, `<policy-N>`                                                                  |
| IAM unique IDs (`AROA...`), hosted zone IDs, account aliases      | `<iam-unique-id-N>`, `<hostedzone-N>`, `<account-alias-N>`                                                         |
| stack names (also in stack ARNs)                                  | kept: `CDKToolkit`, `starter-it-*`, `starter*`, `StackSet-AWSControlTower*`, `AWSAccelerator*`; others `<stack-N>` |
| `Name` tags and budget names                                      | kept: `starter-it-*`, `starter*`; others `<name-N>`, `<budget-N>`                                                  |
| KMS aliases (also in alias ARNs)                                  | kept: `alias/aws/*`, `alias/starter*`, `alias/starter*`; others `alias/<kms-alias-N>`                              |
| web ACL names (also in ARNs)                                      | always `<web-acl-N>`, with `fmsManaged` (Firewall Manager `FMManagedWebACL*`)                                      |
| log account-policy names                                          | `<log-policy-N>`                                                                                                   |
| customer domain names                                             | `<domain-N>.<tld>` (AWS-owned names such as `*.amazonaws.com` are kept)                                            |
| e-mail addresses (also `%40`-encoded), access key IDs             | `<email>`, `<access-key-id>`                                                                                       |
| the session name                                                  | `<session>`: as a substring when 6+ characters, as a whole identifier otherwise                                    |
| integers with exactly 12 digits                                   | the account token, or `<12-digit-number>`                                                                          |

AWS-managed public identifiers stay as they are: AZ IDs (`apse1-az1`), the CloudFront managed
prefix-list ID, AWS managed policy ARNs, quota codes (`L-...`), RDS CA identifiers, engine versions,
CloudFormation hook type names. The evidence command line is rebuilt from the probe definition with
the same masking (`<profile>`, `<account>`, `<budget-N>`, masked domains).

A final **leak scanner** ([`src/leak.ts`](src/leak.ts)) walks the evidence object and the
formatted text and refuses to write anything (exit 8) that still contains a 12-digit number (tool
digests — the git commit and SHA-256 values — are exempt from the digit rules only), a separated
account ID, the raw account ID or session name, an e-mail address (also `%40`-encoded), an
`AKIA`/`ASIA` key ID, `SecretAccessKey` / `SessionToken`, or a PEM header. **Console output** passes the same masking and scanner line by line (before the gate:
12-digit numbers, separated account IDs and e-mail addresses are masked); a line that still hits a
rule is replaced by `[line suppressed by the leak scanner: ...]`. A profile name that contains
digits is printed as `<profile>`. Raw responses are never printed.

## Mutation guard

The account guard of a personal-sandbox live validation.
Every mutating AWS command of a personal-sandbox run (CDK bootstrap/deploy/destroy, `aws` writes,
`ecs run-task`, image copies) goes through it. It runs **only** with
`--execution-profile personal-sandbox`: the strict profile never authorizes a mutation (exit 2),
and it refuses `CI` / `GITLAB_CI`.

```sh
pnpm --filter @starter/tool-aws-preflight build      # emits dist/ and dist/build-info.json

nix shell "$PIN" -c node tools/aws-preflight/dist/guard-cli.js check \
  --execution-profile personal-sandbox \
  --profile <profile> \
  --expected-account-file "$SANDBOX_HOME/expected-account" \
  --region ap-southeast-1 --label "cdk deploy Sandbox-Foundation" \
  --log "$SANDBOX_HOME/runs/<runId>/guard.log" \
  [--expected-role-pattern 'AWSReservedSSO_<PermissionSet>_*'] [--aws-cli <path>] [--call-timeout 60]
```

Each invocation, in this order (no process before step 4, no AWS request before step 5):

1. refuses `CI`/`GITLAB_CI`, any profile but `personal-sandbox`, a missing or unsafe `--label`
   (one line, at most 200 characters, no account IDs, e-mail addresses or key material: it is
   logged), a missing, blank or `default` `--profile`, a missing `--region` or one outside the `aws` partition, and
   the [environment conflicts](#execution-profiles) of personal-sandbox (the guarded command
   inherits that environment);
2. reads the expected account from the private file (same rules as `--expected-account-file`);
3. opens the log (`--log`, else `$SANDBOX_GUARD_LOG`) for appending: created 0600, never through a
   symbolic link, only a regular file of the operator without group or other permissions; refuses
   a `dist/` build that no longer matches `src/` (`dist/build-info.json`, exit 17);
4. applies the [configuration refusals](#trust-assumptions) to `~/.aws` (including the offline
   `sso_account_id` comparison: exit 3 before any process) and the personal-sandbox fallback
   refusals (no `[default]` profile, no `~/.aws/credentials` content, no CDK `profile` setting in
   `~/.cdk.json`, `./cdk.json` or `infra/cdk.json`: exit 15), then resolves the AWS CLI exactly like
   discovery: the first `aws` on an absolute `PATH` entry (or `--aws-cli`), **exactly 2.35.11**,
   not writable by group or others (`aws --version` is local);
5. calls `sts get-caller-identity` **once**, as the allowlisted `identity.caller` probe through the
   exec boundary (`execFile`, no shell, child environment built from scratch, explicit
   `--profile`/`--region`); expired credentials are not retried;
6. requires the expected account and an assumed-role principal (root, IAM user and federated user
   are refused), matching `--expected-role-pattern` when given;
7. writes one leak-scanned JSON line to the log, then to stdout, and exits 0.

```json
{
  "time": "2026-10-15T04:05:06.000Z",
  "result": "verified",
  "label": "cdk deploy Sandbox-Foundation",
  "account": "********1234",
  "principalArn": "arn:aws:sts::********1234:assumed-role/AWSReservedSSO_<PermissionSet>_<16 hex>/<session>",
  "principalType": "assumed-role",
  "region": "ap-southeast-1",
  "profile": "<profile>",
  "executionProfile": "personal-sandbox",
  "toolSourceSha256": "<sha256 of package.json and src/*.ts>"
}
```

A refusal prints `GUARD REFUSED (exit N, reason) — ...` on stderr, nothing on stdout, and, once the
log is open, appends `{"result":"refused","reason":...,"exitCode":N,...}` with whatever was
already known (observed and expected account masked).

| Code | Reason             | Meaning                                                                                                                                                                                                                       |
| ---- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | verified           | the command may run                                                                                                                                                                                                           |
| 1    | error              | internal error, or the line failed the leak scanner (change the label)                                                                                                                                                        |
| 2    | usage              | arguments, label, expected-account file, `CI`, or the strict profile                                                                                                                                                          |
| 3    | account-mismatch   | STS account (or the profile's `sso_account_id`, offline) is not the expected account                                                                                                                                          |
| 4    | principal-rejected | root, IAM user, federated user, or a role outside `--expected-role-pattern`                                                                                                                                                   |
| 6    | credentials        | SSO session expired or credentials invalid: `aws sso login --profile <p>`                                                                                                                                                     |
| 10   | region             | `--region` not allowed, or `AWS_REGION` / `AWS_DEFAULT_REGION` differ                                                                                                                                                         |
| 11   | no-profile         | `--profile` missing, blank or `default`, or not defined in `~/.aws/config`                                                                                                                                                    |
| 12   | environment        | static keys, `AWS_DEFAULT_PROFILE`, a different `AWS_PROFILE`, a credential/config/endpoint redirect                                                                                                                          |
| 13   | sts-failure        | `sts get-caller-identity` failed (network, throttling, timeout, unexpected output)                                                                                                                                            |
| 14   | aws-cli            | AWS CLI missing, not 2.35.11 (the message names the pinned `nix shell`), or writable by others                                                                                                                                |
| 15   | aws-config         | `~/.aws` holds aliases, models, plugins, endpoint or credential overrides, extra profile keys; or a fallback identity: `[default]`/`[profile default]`, `~/.aws/credentials` with any section or key, a CDK `profile` setting |
| 16   | log                | the log cannot be opened privately (symbolic link, shared mode, missing directory)                                                                                                                                            |
| 17   | stale-build        | `dist/` built from other sources than the current `src/`, or (shell helper) not built / no node                                                                                                                               |
| 130  | interrupted        | SIGINT/SIGTERM                                                                                                                                                                                                                |

**Shell helper** ([`scripts/sandbox-guard.sh`](scripts/sandbox-guard.sh), bash 3.2 or later,
works under `set -euo pipefail`):

```bash
export SANDBOX_PROFILE=<profile>                                  # required, never "default"
export SANDBOX_GUARD_LOG="$SANDBOX_HOME/runs/$RUN_ID/guard.log"   # required
export SANDBOX_ROLE_PATTERN='AWSReservedSSO_<PermissionSet>_*'    # optional
# optional: SANDBOX_REGION (default ap-southeast-1; any aws-partition region), SANDBOX_EXPECTED_ACCOUNT_FILE
#           (default ${SANDBOX_HOME:-$HOME/.config/starter-aws-sandbox}/expected-account)
source tools/aws-preflight/scripts/sandbox-guard.sh
sandbox_guard_init                       # env checks, pins the three variables, first STS check
sandbox_guard "<label>"                  # STS check now
guarded "<label>" -- <command> [args...] # sandbox_guard, then the command
```

- `sandbox_guard_init` refuses the same environment conflicts itself (no process), pins
  `AWS_PROFILE`, `AWS_REGION` and `AWS_DEFAULT_REGION`, keeps its selection in read-only shell
  variables, and runs a first check labelled `sandbox_guard_init`. A second call with the same
  selection only checks again; another selection is refused.
- `sandbox_guard` re-checks the environment and that the three variables still hold the pins, then
  runs `node dist/guard-cli.js check` (without `NODE_OPTIONS`). The JSON line goes to **stderr**,
  so the stdout of a guarded command stays clean. Any refusal **exits the script** with the
  guard's code; in an interactive shell the function returns the code instead.
- `guarded` accepts only an executable file or a command found on `PATH` (shell functions,
  builtins and aliases are refused, so nothing is ever `eval`'d), runs it with `exec` in a
  subshell with the pinned variables exported (also when the script un-exported them), and
  returns its exit code unchanged. Before the STS call it refuses (exit 2) a shell, command runner
  or environment rewriter as the command, judged by its name and by the name its symbolic links
  resolve to (`sh`, `bash`, `zsh`, `dash`, `ksh`, `mksh`, `fish`, `csh`, `tcsh`, `env`, `sudo`,
  `doas`, `su`, `xargs`, `timeout`, `gtimeout`, `nohup`, `nice`, `ionice`, `stdbuf`, `chrt`,
  `taskset`, `setsid`, `time`, `command`, `nix`, `coreutils`, `busybox`, `script`, `watch`,
  `flock`, `chroot`, `unshare`, `caffeinate`, `arch`, `deno`, `bun`, `osascript`), an interpreter
  given inline code (`python* -c`, `node -e`/`-p`/`--eval`, `perl -e`, `ruby -e`, `php`, `lua`;
  a script file stays allowed), and arguments that would make the logged check untrue:
  `--profile` or `--region` with another value than the pin (exit 12 / 10), `--endpoint-url`
  (exit 12), each also as an abbreviation of at least three characters (`--prof`, `--reg`,
  `--endp`: AWS CLI 2.35.11 parses options with argparse prefix matching), with or without `=`,
  and an `AWS_*=...` assignment (exit 12). This is a check against mistakes, not a sandbox: an
  executable copied under another name, or the program itself, can still do anything. Inside `$(...)` or a pipeline a refusal ends only that subshell: capture output with a plain assignment under `set -e` (`out="$(guarded ...)"`, which fails with the guard's code), never with `local out=$(...)` (which hides the status), and never pipe `guarded`.
- Run the whole script under the pinned CLI (`nix shell "$PIN" -c bash <script>`), so the guard
  and the guarded `aws` resolve the same binary from `PATH`.

**What the guard does and does not do.** It verifies, immediately before a command starts, which
account, principal, profile and region that command's credentials resolve to, and leaves an
auditable line per command. It is a client-side check run by the operator's own scripts, **not an
AWS-side control**:

- it does not see or limit what the command then does, and one check covers one command (a
  `cdk deploy` makes many API calls after it);
- a command run outside `guarded` / `sandbox_guard` is not checked; nothing in AWS enforces that
  scripts call it;
- a command that drops `AWS_PROFILE` finds no default profile, static keys or CDK profile setting
  to fall back to (they are refused), so it fails instead of using another identity, unless it
  brings its own credentials from outside `~/.aws` (its own environment, a container's files, a
  credential helper);
- the command re-resolves credentials itself (CDK through the AWS SDK for JavaScript): a change of
  `~/.aws` or of the SSO caches between the check and the command is not detected (no other AWS
  tooling may run during a run);
- it trusts the same things as discovery: the AWS CLI binary, the SSO caches, Node.js, the
  operating system, the network path, and that `dist/` was not modified after it was built
  (`build-info.json` detects a stale build, not tampering: rebuild from a clean checkout);
- the account it accepts is the dedicated sandbox; it says nothing about organizational controls.

## Probe coverage for a live validation

Checked against the allowlist for the personal-sandbox experiment (no probe added; read-only only):

| Needed before deploying                                                          | Probe(s)                                                                                        |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| CloudFront origin-facing managed prefix list ID (ap-southeast-1)                 | `b.ec2.cloudfront-prefix-list` (ID, max entries)                                                |
| Lambda account settings: concurrency limit and unreserved concurrency            | `c.lambda.account-settings` (`AccountLimit`), `c.quotas.lambda-concurrency-*`                   |
| VPC Block Public Access options and exclusions                                   | `b.ec2.vpc-bpa-options`, `b.ec2.vpc-bpa-exclusions`, `a.org.effective-ec2-declarative-policy`   |
| CDK bootstrap stacks `CDKToolkit` and `starter-cdk-toolkit`                      | `a.cfn.stacks` (both regions; both names kept), `a.cfn.cdk-toolkit-stack` (`CDKToolkit` detail) |
| `/cdk-bootstrap/<qualifier>/version` String parameters                           | `a.cdk.bootstrap-version` (`starter` and `hnb659fds`, both regions), `a.cdk.*-role`             |
| Quotas: VPCs, NAT gateways per AZ                                                | `c.quotas.vpc`                                                                                  |
| Quotas: Elastic IPs                                                              | `c.quotas.ec2-elastic-ips`, `b.ec2.account-attributes`                                          |
| Quotas: Application Load Balancers                                               | `c.quotas.elasticloadbalancing`, `b.elbv2.account-limits`                                       |
| Quotas: Fargate On-Demand vCPU                                                   | `c.quotas.fargate`                                                                              |
| CloudWatch Logs resource policies (10 per Region)                                | `c.logs.resource-policies` (count only)                                                         |
| RDS instances                                                                    | `c.rds.account-attributes` (used / max), `c.quotas.rds`                                         |
| CloudFront distributions                                                         | `c.quotas.cloudfront` (us-east-1)                                                               |
| Existing `Sandbox-*` / `starter-sbx*` / `starter-it-*` stacks, VPCs, KMS aliases | `a.cfn.stacks`, `b.ec2.vpcs` (`Name` tags), `c.kms.aliases`, `d.budgets.budgets`                |

`list-service-quotas` returns applied values only; a quota missing from the response is UNKNOWN
from this probe (if the AWS default is used instead, say so; never read it as zero). Resources whose names this allowlist cannot read
by design (S3 buckets: no `s3`/`s3api` call is allowed; log groups, ECR repositories, DynamoDB
tables, RDS instances, Lambda functions, state machines, CloudFront distributions, secrets) are
not probed here: the read-only `verify-clean` sweep of `tools/aws-sandbox`,
run once **before** the first deployment, is the pre-existence check for them. Adding them here
would change the strict allowlist.

## Probes

Generated from the allowlist (`node tools/aws-preflight/src/cli.ts plan --write`; a test fails when
this table or [`iam/discovery-readonly-policy.json`](iam/discovery-readonly-policy.json) drifts).
Every call also gets
`--profile <profile> --region <region> --output json --no-cli-pager --cli-connect-timeout 10 --cli-read-timeout 30`.
`--max-items` bounds CLI-paginated operations; single-page operations use the service page size
(`--limit`, `--max-results`) and the next page is never fetched; `truncated: true` in the evidence
means the bound was reached. Syntax verified with `aws <service> <operation> help` (aws-cli 2.35.11).

<!-- BEGIN GENERATED probe table: node tools/aws-preflight/src/cli.ts plan --write -->

| Probe                                    | Area            | AWS CLI command                                                                                                                                         | IAM action                                                                                                                                               | Regions                   | Purpose                                                                                                                                                                                      |
| ---------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity.caller`                        | identity        | `aws sts get-caller-identity`                                                                                                                           | `sts:GetCallerIdentity`                                                                                                                                  | ap-southeast-1            | Gate 1: caller account must equal --expected-account; principal must be an assumed role matching --expected-role-pattern. (identity gate)                                                    |
| `identity.role`                          | identity        | `aws iam get-role --role-name=<caller-role>`                                                                                                            | `iam:GetRole`                                                                                                                                            | ap-southeast-1            | Gate 2: the caller role itself (path, permissions boundary). (identity gate)                                                                                                                 |
| `identity.role-managed-policies`         | identity        | `aws iam list-attached-role-policies --role-name=<caller-role> --max-items 100`                                                                         | `iam:ListAttachedRolePolicies`                                                                                                                           | ap-southeast-1            | Gate 2: managed policies attached to the caller role. (identity gate)                                                                                                                        |
| `identity.role-inline-policies`          | identity        | `aws iam list-role-policies --role-name=<caller-role> --max-items 100`                                                                                  | `iam:ListRolePolicies`                                                                                                                                   | ap-southeast-1            | Gate 2: inline policy names of the caller role. (identity gate)                                                                                                                              |
| `identity.role-inline-policy`            | identity        | `aws iam get-role-policy --role-name=<caller-role> --policy-name=<inline-policy-name>`                                                                  | `iam:GetRolePolicy` on `arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*`                                                                            | ap-southeast-1            | Gate 2: each inline policy of the caller role (at most 10) is classified; the document stays in the private raw directory. (per inline policy of the caller role, at most 10; identity gate) |
| `identity.customer-policy`               | identity        | `aws iam get-policy --policy-arn=<customer-policy-arn>`                                                                                                 | `iam:GetPolicy`                                                                                                                                          | ap-southeast-1            | Gate 2: default version of each customer managed policy attached to the caller role (at most 10). (per attached customer managed policy, at most 10; identity gate)                          |
| `identity.customer-policy-version`       | identity        | `aws iam get-policy-version --policy-arn=<customer-policy-arn> --version-id=<default-version-id>`                                                       | `iam:GetPolicyVersion`                                                                                                                                   | ap-southeast-1            | Gate 2: that default version is classified; the document stays in the private raw directory. (per attached customer managed policy, at most 10; identity gate)                               |
| `identity.organization`                  | identity        | `aws organizations describe-organization`                                                                                                               | `organizations:DescribeOrganization`                                                                                                                     | us-east-1                 | Gate 3: the account must be an organization member and not the management account. (identity gate)                                                                                           |
| `identity.caller-recheck`                | identity        | `aws sts get-caller-identity`                                                                                                                           | `sts:GetCallerIdentity`                                                                                                                                  | ap-southeast-1            | After discovery: the profile still resolves to the same account and principal (else no evidence is written). (identity gate)                                                                 |
| `a.org.parents`                          | org-iam         | `aws organizations list-parents --child-id=<account> --max-items 10`                                                                                    | `organizations:ListParents`                                                                                                                              | us-east-1                 | Parent OU of the sandbox account (management or delegated-admin only: access-denied is expected).                                                                                            |
| `a.org.scps`                             | org-iam         | `aws organizations list-policies-for-target --target-id=<account> --filter SERVICE_CONTROL_POLICY --max-items 100`                                      | `organizations:ListPoliciesForTarget`                                                                                                                    | us-east-1                 | SCPs attached directly to the account (names only; management or delegated-admin only).                                                                                                      |
| `a.org.rcps`                             | org-iam         | `aws organizations list-policies-for-target --target-id=<account> --filter RESOURCE_CONTROL_POLICY --max-items 100`                                     | `organizations:ListPoliciesForTarget`                                                                                                                    | us-east-1                 | RCPs attached directly to the account (names only; management or delegated-admin only).                                                                                                      |
| `a.org.effective-tag-policy`             | org-iam         | `aws organizations describe-effective-policy --policy-type TAG_POLICY`                                                                                  | `organizations:DescribeEffectivePolicy`                                                                                                                  | us-east-1                 | Effective tag policy of the calling account: tag keys and enforced resource types only.                                                                                                      |
| `a.org.effective-ec2-declarative-policy` | org-iam         | `aws organizations describe-effective-policy --policy-type DECLARATIVE_POLICY_EC2`                                                                      | `organizations:DescribeEffectivePolicy`                                                                                                                  | us-east-1                 | Effective EC2 declarative policy (VPC BPA, IMDS, AMI settings): attribute = enum value pairs.                                                                                                |
| `a.iam.account-summary`                  | org-iam         | `aws iam get-account-summary`                                                                                                                           | `iam:GetAccountSummary`                                                                                                                                  | ap-southeast-1            | IAM entity counts and quotas.                                                                                                                                                                |
| `a.iam.account-aliases`                  | org-iam         | `aws iam list-account-aliases --max-items 10`                                                                                                           | `iam:ListAccountAliases`                                                                                                                                 | ap-southeast-1            | Whether an account alias is set (alias masked).                                                                                                                                              |
| `a.iam.boundary-policies`                | org-iam         | `aws iam list-policies --scope Local --policy-usage-filter PermissionsBoundary --only-attached --max-items 100`                                         | `iam:ListPolicies`                                                                                                                                       | ap-southeast-1            | Customer managed policies in use as permissions boundaries (metadata, no documents).                                                                                                         |
| `a.iam.boundary-policy`                  | org-iam         | `aws iam get-policy --policy-arn=<boundary-policy-arn>`                                                                                                 | `iam:GetPolicy`                                                                                                                                          | ap-southeast-1            | Metadata of the permissions boundary named by --boundary-policy-arn (no document). (only with --boundary-policy-arn)                                                                         |
| `a.cdk.deploy-role`                      | org-iam         | `aws iam get-role --role-name=cdk-<qualifier>-deploy-role-<account>-ap-southeast-1`                                                                     | `iam:GetRole`                                                                                                                                            | ap-southeast-1            | CDK bootstrap deploy role for each qualifier (trust policy reduced to a type summary). (per qualifier: --qualifier (default starter) and hnb659fds)                                          |
| `a.cdk.file-publishing-role`             | org-iam         | `aws iam get-role --role-name=cdk-<qualifier>-file-publishing-role-<account>-ap-southeast-1`                                                            | `iam:GetRole`                                                                                                                                            | ap-southeast-1            | CDK bootstrap file-asset publishing role for each qualifier (trust policy reduced to a type summary). (per qualifier: --qualifier (default starter) and hnb659fds)                           |
| `a.cdk.image-publishing-role`            | org-iam         | `aws iam get-role --role-name=cdk-<qualifier>-image-publishing-role-<account>-ap-southeast-1`                                                           | `iam:GetRole`                                                                                                                                            | ap-southeast-1            | CDK bootstrap image-asset publishing role for each qualifier (trust policy reduced to a type summary). (per qualifier: --qualifier (default starter) and hnb659fds)                          |
| `a.cdk.lookup-role`                      | org-iam         | `aws iam get-role --role-name=cdk-<qualifier>-lookup-role-<account>-ap-southeast-1`                                                                     | `iam:GetRole`                                                                                                                                            | ap-southeast-1            | CDK bootstrap context lookup role for each qualifier (trust policy reduced to a type summary). (per qualifier: --qualifier (default starter) and hnb659fds)                                  |
| `a.cdk.cfn-exec-role`                    | org-iam         | `aws iam get-role --role-name=cdk-<qualifier>-cfn-exec-role-<account>-ap-southeast-1`                                                                   | `iam:GetRole`                                                                                                                                            | ap-southeast-1            | CDK bootstrap CloudFormation execution role for each qualifier (trust policy reduced to a type summary). (per qualifier: --qualifier (default starter) and hnb659fds)                        |
| `a.cfn.cdk-toolkit-stack`                | org-iam         | `aws cloudformation describe-stacks --stack-name CDKToolkit --max-items 1`                                                                              | `cloudformation:DescribeStacks` on `arn:aws:cloudformation:ap-southeast-1:*:stack/CDKToolkit/*`, `arn:aws:cloudformation:us-east-1:*:stack/CDKToolkit/*` | ap-southeast-1, us-east-1 | CDK bootstrap stack: status, parameters (qualifier, trust, boundary) and outputs.                                                                                                            |
| `a.cfn.stacks`                           | org-iam         | `aws cloudformation list-stacks --stack-status-filter <active-stack-statuses> --max-items 200`                                                          | `cloudformation:ListStacks`                                                                                                                              | ap-southeast-1, us-east-1 | Existing (not deleted) stacks: status and drift status; names of unrelated workloads masked.                                                                                                 |
| `a.cfn.hook-types-public`                | org-iam         | `aws cloudformation list-types --visibility PUBLIC --type HOOK --filters Category=ACTIVATED --max-items 100`                                            | `cloudformation:ListTypes`                                                                                                                               | ap-southeast-1            | Activated public CloudFormation hooks, such as Control Tower proactive controls (type names only; ORG-06).                                                                                   |
| `a.cfn.hook-types-private`               | org-iam         | `aws cloudformation list-types --visibility PRIVATE --type HOOK --filters Category=ACTIVATED --max-items 100`                                           | `cloudformation:ListTypes`                                                                                                                               | ap-southeast-1            | Activated CloudFormation hooks usable in the account (type names only; ORG-06).                                                                                                              |
| `a.cdk.bootstrap-version`                | org-iam         | `aws ssm get-parameter --name=/cdk-bootstrap/<qualifier>/version --no-with-decryption`                                                                  | `ssm:GetParameter` on `arn:aws:ssm:ap-southeast-1:*:parameter/cdk-bootstrap/*`, `arn:aws:ssm:us-east-1:*:parameter/cdk-bootstrap/*`                      | ap-southeast-1, us-east-1 | CDK bootstrap version parameter per qualifier (plain String; never decrypted). (per qualifier: --qualifier (default starter) and hnb659fds)                                                  |
| `b.ec2.availability-zones`               | network-edge    | `aws ec2 describe-availability-zones`                                                                                                                   | `ec2:DescribeAvailabilityZones`                                                                                                                          | ap-southeast-1            | Availability zones and AZ IDs available to the account.                                                                                                                                      |
| `b.ec2.account-attributes`               | network-edge    | `aws ec2 describe-account-attributes`                                                                                                                   | `ec2:DescribeAccountAttributes`                                                                                                                          | ap-southeast-1            | EC2 account attributes (default VPC, Elastic IP limits).                                                                                                                                     |
| `b.ec2.vpcs`                             | network-edge    | `aws ec2 describe-vpcs --max-items 50`                                                                                                                  | `ec2:DescribeVpcs`                                                                                                                                       | ap-southeast-1            | VPCs: CIDRs, default VPC, block-public-access state (Name tags masked).                                                                                                                      |
| `b.ec2.subnets`                          | network-edge    | `aws ec2 describe-subnets [--filters Name=vpc-id,Values=<vpc-id>] --max-items 200`                                                                      | `ec2:DescribeSubnets`                                                                                                                                    | ap-southeast-1            | Subnets: AZ, CIDR, free addresses, public-IP mapping. (VPC filter only with --vpc-id)                                                                                                        |
| `b.ec2.route-tables`                     | network-edge    | `aws ec2 describe-route-tables [--filters Name=vpc-id,Values=<vpc-id>] --max-items 100`                                                                 | `ec2:DescribeRouteTables`                                                                                                                                | ap-southeast-1            | Route tables: associations and route targets (IGW, NAT, TGW, endpoints). (VPC filter only with --vpc-id)                                                                                     |
| `b.ec2.internet-gateways`                | network-edge    | `aws ec2 describe-internet-gateways [--filters Name=attachment.vpc-id,Values=<vpc-id>] --max-items 50`                                                  | `ec2:DescribeInternetGateways`                                                                                                                           | ap-southeast-1            | Internet gateways and their VPC attachments. (VPC filter only with --vpc-id)                                                                                                                 |
| `b.ec2.nat-gateways`                     | network-edge    | `aws ec2 describe-nat-gateways [--filter Name=vpc-id,Values=<vpc-id>] --max-items 50`                                                                   | `ec2:DescribeNatGateways`                                                                                                                                | ap-southeast-1            | NAT gateways: subnet, state, connectivity type (IP addresses dropped). (VPC filter only with --vpc-id)                                                                                       |
| `b.ec2.vpc-endpoints`                    | network-edge    | `aws ec2 describe-vpc-endpoints [--filters Name=vpc-id,Values=<vpc-id>] --max-items 100`                                                                | `ec2:DescribeVpcEndpoints`                                                                                                                               | ap-southeast-1            | VPC endpoints: service, type, private DNS (endpoint policies dropped). (VPC filter only with --vpc-id)                                                                                       |
| `b.ec2.cloudfront-prefix-list`           | network-edge    | `aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing --max-items 10`             | `ec2:DescribeManagedPrefixLists`                                                                                                                         | ap-southeast-1            | AWS-managed CloudFront origin-facing prefix list (ID and max entries for ALB rules).                                                                                                         |
| `b.ec2.vpc-bpa-options`                  | network-edge    | `aws ec2 describe-vpc-block-public-access-options`                                                                                                      | `ec2:DescribeVpcBlockPublicAccessOptions`                                                                                                                | ap-southeast-1            | VPC Block Public Access mode (would block the internet gateway and NAT egress).                                                                                                              |
| `b.ec2.vpc-bpa-exclusions`               | network-edge    | `aws ec2 describe-vpc-block-public-access-exclusions --max-results 100`                                                                                 | `ec2:DescribeVpcBlockPublicAccessExclusions`                                                                                                             | ap-southeast-1            | VPC Block Public Access exclusions.                                                                                                                                                          |
| `b.elbv2.account-limits`                 | network-edge    | `aws elbv2 describe-account-limits --max-items 100`                                                                                                     | `elasticloadbalancing:DescribeAccountLimits`                                                                                                             | ap-southeast-1            | Elastic Load Balancing account limits.                                                                                                                                                       |
| `b.route53.hosted-zones`                 | network-edge    | `aws route53 list-hosted-zones --max-items 100`                                                                                                         | `route53:ListHostedZones`                                                                                                                                | ap-southeast-1            | Hosted zones (global service): public or private, record count; names masked.                                                                                                                |
| `b.acm.certificates`                     | network-edge    | `aws acm list-certificates --includes keyTypes=RSA_1024,RSA_2048,RSA_3072,RSA_4096,EC_prime256v1,EC_secp384r1,EC_secp521r1 --max-items 100`             | `acm:ListCertificates`                                                                                                                                   | ap-southeast-1, us-east-1 | ACM certificates of every key type (us-east-1 for CloudFront); domains masked.                                                                                                               |
| `b.wafv2.web-acls-regional`              | network-edge    | `aws wafv2 list-web-acls --scope REGIONAL --limit 100`                                                                                                  | `wafv2:ListWebACLs`                                                                                                                                      | ap-southeast-1            | Regional web ACLs (ALB): names masked, Firewall Manager flag kept.                                                                                                                           |
| `b.wafv2.web-acls-cloudfront`            | network-edge    | `aws wafv2 list-web-acls --scope CLOUDFRONT --limit 100`                                                                                                | `wafv2:ListWebACLs`                                                                                                                                      | us-east-1                 | CloudFront web ACLs (us-east-1): names masked, Firewall Manager flag kept.                                                                                                                   |
| `c.lambda.account-settings`              | quotas-services | `aws lambda get-account-settings`                                                                                                                       | `lambda:GetAccountSettings`                                                                                                                              | ap-southeast-1            | Lambda concurrency and code-size limits and usage (the full sandbox stack needs an applied concurrency of 109 or more; the integration mini-stack none).                                     |
| `c.quotas.lambda`                        | quotas-services | `aws service-quotas list-service-quotas --service-code lambda --max-items 200`                                                                          | `servicequotas:ListServiceQuotas`                                                                                                                        | ap-southeast-1            | Applied service quotas for lambda.                                                                                                                                                           |
| `c.quotas.fargate`                       | quotas-services | `aws service-quotas list-service-quotas --service-code fargate --max-items 200`                                                                         | `servicequotas:ListServiceQuotas`                                                                                                                        | ap-southeast-1            | Applied service quotas for fargate.                                                                                                                                                          |
| `c.quotas.ecs`                           | quotas-services | `aws service-quotas list-service-quotas --service-code ecs --max-items 200`                                                                             | `servicequotas:ListServiceQuotas`                                                                                                                        | ap-southeast-1            | Applied service quotas for ecs.                                                                                                                                                              |
| `c.quotas.vpc`                           | quotas-services | `aws service-quotas list-service-quotas --service-code vpc --max-items 200`                                                                             | `servicequotas:ListServiceQuotas`                                                                                                                        | ap-southeast-1            | Applied service quotas for vpc.                                                                                                                                                              |
| `c.quotas.elasticloadbalancing`          | quotas-services | `aws service-quotas list-service-quotas --service-code elasticloadbalancing --max-items 200`                                                            | `servicequotas:ListServiceQuotas`                                                                                                                        | ap-southeast-1            | Applied service quotas for elasticloadbalancing.                                                                                                                                             |
| `c.quotas.states`                        | quotas-services | `aws service-quotas list-service-quotas --service-code states --max-items 200`                                                                          | `servicequotas:ListServiceQuotas`                                                                                                                        | ap-southeast-1            | Applied service quotas for states.                                                                                                                                                           |
| `c.quotas.dynamodb`                      | quotas-services | `aws service-quotas list-service-quotas --service-code dynamodb --max-items 200`                                                                        | `servicequotas:ListServiceQuotas`                                                                                                                        | ap-southeast-1            | Applied service quotas for dynamodb.                                                                                                                                                         |
| `c.quotas.kms`                           | quotas-services | `aws service-quotas list-service-quotas --service-code kms --max-items 200`                                                                             | `servicequotas:ListServiceQuotas`                                                                                                                        | ap-southeast-1            | Applied service quotas for kms.                                                                                                                                                              |
| `c.quotas.ecr`                           | quotas-services | `aws service-quotas list-service-quotas --service-code ecr --max-items 200`                                                                             | `servicequotas:ListServiceQuotas`                                                                                                                        | ap-southeast-1            | Applied service quotas for ecr.                                                                                                                                                              |
| `c.quotas.logs`                          | quotas-services | `aws service-quotas list-service-quotas --service-code logs --max-items 200`                                                                            | `servicequotas:ListServiceQuotas`                                                                                                                        | ap-southeast-1            | Applied service quotas for logs.                                                                                                                                                             |
| `c.quotas.cloudformation`                | quotas-services | `aws service-quotas list-service-quotas --service-code cloudformation --max-items 200`                                                                  | `servicequotas:ListServiceQuotas`                                                                                                                        | ap-southeast-1            | Applied service quotas for cloudformation.                                                                                                                                                   |
| `c.quotas.rds`                           | quotas-services | `aws service-quotas list-service-quotas --service-code rds --max-items 200`                                                                             | `servicequotas:ListServiceQuotas`                                                                                                                        | ap-southeast-1            | Applied service quotas for rds.                                                                                                                                                              |
| `c.quotas.cloudfront`                    | quotas-services | `aws service-quotas list-service-quotas --service-code cloudfront --max-items 200`                                                                      | `servicequotas:ListServiceQuotas`                                                                                                                        | us-east-1                 | Applied service quotas for cloudfront (global, us-east-1).                                                                                                                                   |
| `c.quotas.ec2-elastic-ips`               | quotas-services | `aws service-quotas get-service-quota --service-code ec2 --quota-code L-0263D0A3`                                                                       | `servicequotas:GetServiceQuota`                                                                                                                          | ap-southeast-1            | EC2-VPC Elastic IP quota (NAT gateways).                                                                                                                                                     |
| `c.quotas.lambda-concurrency-default`    | quotas-services | `aws service-quotas get-aws-default-service-quota --service-code lambda --quota-code L-B99A9384`                                                        | `servicequotas:GetAWSDefaultServiceQuota`                                                                                                                | ap-southeast-1            | AWS default of the Lambda concurrent-executions quota.                                                                                                                                       |
| `c.quotas.lambda-concurrency-requests`   | quotas-services | `aws service-quotas list-requested-service-quota-change-history-by-quota --service-code lambda --quota-code L-B99A9384 --max-items 20`                  | `servicequotas:ListRequestedServiceQuotaChangeHistoryByQuota`                                                                                            | ap-southeast-1            | Requested increases of the Lambda concurrent-executions quota: status, desired value and dates only.                                                                                         |
| `c.rds.engine-version`                   | quotas-services | `aws rds describe-db-engine-versions --engine postgres --engine-version=<db-engine-version> --max-items 10`                                             | `rds:DescribeDBEngineVersions`                                                                                                                           | ap-southeast-1            | The configured PostgreSQL version: availability, CA certificates, upgrade targets.                                                                                                           |
| `c.rds.engine-catalog`                   | quotas-services | `aws rds describe-db-engine-versions --engine postgres --max-items 300`                                                                                 | `rds:DescribeDBEngineVersions`                                                                                                                           | ap-southeast-1            | PostgreSQL versions offered in the region (version, family, status).                                                                                                                         |
| `c.rds.orderable.db-t4g-micro`           | quotas-services | `aws rds describe-orderable-db-instance-options --engine postgres --engine-version=<db-engine-version> --db-instance-class db.t4g.micro --max-items 50` | `rds:DescribeOrderableDBInstanceOptions`                                                                                                                 | ap-southeast-1            | Whether db.t4g.micro is orderable for the configured PostgreSQL version (AZs, Multi-AZ, storage).                                                                                            |
| `c.rds.orderable.db-t4g-small`           | quotas-services | `aws rds describe-orderable-db-instance-options --engine postgres --engine-version=<db-engine-version> --db-instance-class db.t4g.small --max-items 50` | `rds:DescribeOrderableDBInstanceOptions`                                                                                                                 | ap-southeast-1            | Whether db.t4g.small is orderable for the configured PostgreSQL version (AZs, Multi-AZ, storage).                                                                                            |
| `c.rds.certificates`                     | quotas-services | `aws rds describe-certificates --max-items 50`                                                                                                          | `rds:DescribeCertificates`                                                                                                                               | ap-southeast-1            | RDS CA certificates and the default for new instances (verify-full TLS).                                                                                                                     |
| `c.rds.account-attributes`               | quotas-services | `aws rds describe-account-attributes`                                                                                                                   | `rds:DescribeAccountAttributes`                                                                                                                          | ap-southeast-1            | RDS account quotas and usage.                                                                                                                                                                |
| `c.ecs.account-settings`                 | quotas-services | `aws ecs list-account-settings --effective-settings --max-items 100`                                                                                    | `ecs:ListAccountSettings`                                                                                                                                | ap-southeast-1            | Effective ECS account settings (ARN formats, Container Insights, Fargate settings).                                                                                                          |
| `c.ecr.registry`                         | quotas-services | `aws ecr describe-registry`                                                                                                                             | `ecr:DescribeRegistry`                                                                                                                                   | ap-southeast-1            | ECR registry replication configuration.                                                                                                                                                      |
| `c.ecr.scanning`                         | quotas-services | `aws ecr get-registry-scanning-configuration`                                                                                                           | `ecr:GetRegistryScanningConfiguration`                                                                                                                   | ap-southeast-1            | ECR registry scanning configuration (basic or enhanced).                                                                                                                                     |
| `c.dynamodb.limits`                      | quotas-services | `aws dynamodb describe-limits`                                                                                                                          | `dynamodb:DescribeLimits`                                                                                                                                | ap-southeast-1            | DynamoDB account and table capacity limits.                                                                                                                                                  |
| `c.cfn.account-limits`                   | quotas-services | `aws cloudformation describe-account-limits --max-items 50`                                                                                             | `cloudformation:DescribeAccountLimits`                                                                                                                   | ap-southeast-1            | CloudFormation account limits (stacks, outputs).                                                                                                                                             |
| `c.kms.aliases`                          | quotas-services | `aws kms list-aliases --max-items 200`                                                                                                                  | `kms:ListAliases`                                                                                                                                        | ap-southeast-1            | KMS aliases: AWS managed and project aliases by name, others masked; key IDs masked.                                                                                                         |
| `c.kms.key`                              | quotas-services | `aws kms describe-key --key-id=<kms-alias>`                                                                                                             | `kms:DescribeKey`                                                                                                                                        | ap-southeast-1            | Metadata of each operator-named key alias (--kms-key): state, spec, manager. No key policy. (per --kms-key)                                                                                  |
| `c.logs.subscription-filter-policies`    | quotas-services | `aws logs describe-account-policies --policy-type SUBSCRIPTION_FILTER_POLICY`                                                                           | `logs:DescribeAccountPolicies`                                                                                                                           | ap-southeast-1            | Account-level log subscription filter policies (scope only; names masked).                                                                                                                   |
| `c.logs.data-protection-policies`        | quotas-services | `aws logs describe-account-policies --policy-type DATA_PROTECTION_POLICY`                                                                               | `logs:DescribeAccountPolicies`                                                                                                                           | ap-southeast-1            | Account-level log data protection policies (scope only; names masked).                                                                                                                       |
| `c.logs.resource-policies`               | quotas-services | `aws logs describe-resource-policies --max-items 50`                                                                                                    | `logs:DescribeResourcePolicies`                                                                                                                          | ap-southeast-1            | Number of account-level CloudWatch Logs resource policies (count only; 10 per Region, not adjustable).                                                                                       |
| `d.budgets.budgets`                      | finops          | `aws budgets describe-budgets --account-id=<account> --max-items 100`                                                                                   | `budgets:ViewBudget`                                                                                                                                     | us-east-1                 | Budgets of this account: type, limit, period; names masked; actual and forecast spend dropped.                                                                                               |
| `d.budgets.notifications`                | finops          | `aws budgets describe-notifications-for-budget --account-id=<account> --budget-name=<budget-name> --max-items 10`                                       | `budgets:ViewBudget`                                                                                                                                     | us-east-1                 | Notification thresholds per budget (first 10 budgets). Subscribers are never read. (per budget, at most 10)                                                                                  |

`<active-stack-statuses>`: every stack status except `DELETE_COMPLETE` — `CREATE_IN_PROGRESS`, `CREATE_FAILED`, `CREATE_COMPLETE`, `ROLLBACK_IN_PROGRESS`, `ROLLBACK_FAILED`, `ROLLBACK_COMPLETE`, `DELETE_IN_PROGRESS`, `DELETE_FAILED`, `UPDATE_IN_PROGRESS`, `UPDATE_COMPLETE_CLEANUP_IN_PROGRESS`, `UPDATE_COMPLETE`, `UPDATE_FAILED`, `UPDATE_ROLLBACK_IN_PROGRESS`, `UPDATE_ROLLBACK_FAILED`, `UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS`, `UPDATE_ROLLBACK_COMPLETE`, `REVIEW_IN_PROGRESS`, `IMPORT_IN_PROGRESS`, `IMPORT_COMPLETE`, `IMPORT_ROLLBACK_IN_PROGRESS`, `IMPORT_ROLLBACK_FAILED`, `IMPORT_ROLLBACK_COMPLETE`.

<!-- END GENERATED probe table -->

## Recommended discovery permission set

Metadata-only access is enough; data access is not needed and should not be granted.

1. **Preferred: a dedicated permission set whose inline policy is the generated policy**
   [`iam/discovery-readonly-policy.json`](iam/discovery-readonly-policy.json) — exactly the
   allowlisted IAM actions, limited to `ap-southeast-1` and `us-east-1` with `aws:RequestedRegion`
   (for another workload region print it with `plan --format iam-policy --region <region>`).
   Actions that read documents or values are limited to the resources the probes read:
   `ssm:GetParameter` to `parameter/cdk-bootstrap/*`, `cloudformation:DescribeStacks` to
   `stack/CDKToolkit/*`, `iam:GetRolePolicy` to IAM Identity Center roles. The gate reads the
   inline policy (`iam:GetRolePolicy`) and reports `verified-read-only` without any statement.
   `AWSBudgetsReadOnlyAccess` and `ServiceQuotasReadOnlyAccess` may be attached as well; they are
   metadata-only (they can still read contact metadata: notification contacts, and the account's
   contact e-mail address through `organizations:DescribeAccount`).
2. **AWS managed alternative** — `job-function/ViewOnlyAccess` + `SecurityAudit` (+ the two
   metadata-only policies): `read-only-data-capable`, so the run needs `--attest-read-only`,
   written by a human who checked the permission set. These policies read more than metadata:
   `ViewOnlyAccess` (v46) allows `ecs:Describe*` (task definitions with their environment
   variables), `s3:ListBucket` (object key names), `sns:GetSubscriptionAttributes` (subscriber
   endpoints), `cloudtrail:LookupEvents` and `apigateway:GET` on API definitions and stages;
   `SecurityAudit` (v94) adds `lambda:GetFunctionConfiguration` (environment variables), `iam:Get*`
   (credential report, account authorization details), `cloudformation:GetTemplate`, `kms:Get*`
   (key policies), `rds:DownloadDBLogFilePortion` and `account:GetPrimaryEmail`. The tool never
   calls them; the identity could. `ViewOnlyAccess` alone lacks `iam:GetRole` and
   `organizations:DescribeOrganization`, which the gate needs.
3. **`ReadOnlyAccess` is not read-only in the sense needed here** (v190): it reads data
   (`s3:Get*`, `dynamodb:Scan`, `ssm:Get*`, `lambda:Get*`, `ec2:Get*` including
   `GetPasswordData`, `ecr:BatchGet*`, `states:GetExecutionHistory`), allows billed reads
   (`logs:StartQuery`, `ce:GetCostAndUsage`) and `sts:GetSessionToken`, and `sqs:Receive*`
   changes queue state (visibility timeout, receive count, dead-letter moves). The gate treats it
   as `write-capable`: it runs only with `--accept-write-capable`.
4. **A write-capable permission set** (for example a dedicated sandbox's developer set) runs only
   with `--accept-write-capable "<who, when, why>"`, written by the human who decided it. The
   evidence then says `write-capable-accepted` and lists the policies, and the read-only guarantee
   rests entirely on this tool (see [Trust assumptions](#trust-assumptions)).
5. **Never**: `AdministratorAccess` (any variant), `IAMFullAccess`, `AWSOrganizationsFullAccess`, or
   an inline / customer managed policy that allows `*`, `iam:*` or `organizations:*` on every
   resource: the gate stops (exit 5) and no statement overrides it.

The Service Authorization Reference also lists `aws-portal:ViewBilling` for the Budgets describe
operations; it is a legacy console permission and is not in the generated policy
(`AWSBudgetsReadOnlyAccess` grants it). If the budgets probes return `access-denied` in an account
that still uses legacy billing permissions, that is the likely reason.

Sources (checked 2026-10-14): [ReadOnlyAccess][amp-ro], [ViewOnlyAccess][amp-vo],
[SecurityAudit][amp-sa], [ServiceQuotasReadOnlyAccess][amp-sq],
[AWSBudgetsReadOnlyAccess][amp-bu], [AWSOrganizationsReadOnlyAccess][amp-org],
[AWS Budgets actions][sar-budgets].

## Development

```sh
npm exec --yes pnpm@12.11.2 -- --filter @starter/tool-aws-preflight run typecheck
npm exec --yes pnpm@12.11.2 -- --filter @starter/tool-aws-preflight run build   # dist/ for the guard
npm exec --yes pnpm@12.11.2 -- --filter @starter/tool-aws-preflight run test
node tools/aws-preflight/src/cli.ts plan --write   # after changing the allowlist
nix shell nixpkgs#shellcheck -c shellcheck tools/aws-preflight/scripts/sandbox-guard.sh
```

`build` compiles `src/` to `dist/` (`tsconfig.build.json`, `.ts` imports rewritten to `.js`) and
writes `dist/build-info.json` (the source digest the guard compares). Discovery keeps running from
`src/` with Node.js type stripping. `test/sandbox-guard.test.ts` runs the shell helper with
`/bin/bash` (3.2 on macOS); `SANDBOX_GUARD_TEST_BASH=<bash>` runs it with another bash.

Tests never touch AWS: the executor takes an injected process runner (a fake AWS CLI that records
argv and environment names), and the end-to-end tests run the CLI as a child process with a fake
`aws` executable on a temporary `PATH` and a temporary `HOME` holding the SSO profile. Adding a
probe means adding one entry to [`src/probes.ts`](src/probes.ts) with a projection **and** the
same `service operation iamAction` line to [`src/boundary.ts`](src/boundary.ts), verifying its
syntax with `aws <service> <operation> help` (2.35.11), and regenerating the table and policy; the
policy rules and tests then apply automatically.

[sar-budgets]: https://docs.aws.amazon.com/service-authorization/latest/reference/list_budgets.html
[ct-mgmt]: https://docs.aws.amazon.com/awscloudtrail/latest/userguide/logging-management-events-with-cloudtrail.html#read-write-events-mgmt
[ct-history]: https://docs.aws.amazon.com/awscloudtrail/latest/userguide/view-cloudtrail-events.html
[amp-ro]: https://docs.aws.amazon.com/aws-managed-policy/latest/reference/ReadOnlyAccess.html
[amp-vo]: https://docs.aws.amazon.com/aws-managed-policy/latest/reference/ViewOnlyAccess.html
[amp-sa]: https://docs.aws.amazon.com/aws-managed-policy/latest/reference/SecurityAudit.html
[amp-sq]: https://docs.aws.amazon.com/aws-managed-policy/latest/reference/ServiceQuotasReadOnlyAccess.html
[amp-bu]: https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AWSBudgetsReadOnlyAccess.html
[amp-org]: https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AWSOrganizationsReadOnlyAccess.html
