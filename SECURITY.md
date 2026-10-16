# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**, using the private vulnerability reporting
feature of the platform that hosts this repository (for example a confidential issue or a private
security advisory). Do not open a public issue, merge request or discussion for a security problem.

Include, where you can:

- the affected file, component or CI job and the commit you tested;
- the steps to reproduce, and what an attacker gains;
- whether the issue affects only the reference configuration in this repository or also the
  application code an adopter would reuse.

Do not include real credentials, personal data or data from systems you do not own. Reports are
acknowledged on a best-effort basis; this is a reference implementation maintained without a
support agreement.

## Supported versions

Only the latest state of the `main` branch is supported. Fixes are made on `main`; there are no
maintained release branches.

## Scope

In scope: the application code (`apps/`, `functions/`, `packages/`, `workflows/`), the CDK
infrastructure (`infra/`), the policy packs (`policies/`), the CI definition (`.gitlab-ci.yml`,
`.gitlab/`) and the tools and scripts in this repository.

Out of scope:

- vulnerabilities in third-party images or packages themselves (report them upstream; see
  [THIRD_PARTY.md](THIRD_PARTY.md)), unless this repository uses them in an unsafe way;
- the **TEST ONLY** identity provider (`tools/test-idp`) being usable to mint tokens — that is its
  purpose; it refuses to start outside `APP_RUNTIME=local|ci` and must never be deployed;
- findings that depend on placeholder values in `infra/environments/` being used unchanged in a
  real environment.

The policy rules in this repository are a **proposed baseline**, not a certified control set. The
security model and its known limits are described in [docs/security.md](docs/security.md) and
[docs/limitations.md](docs/limitations.md).
