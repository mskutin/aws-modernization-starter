# Contributing

Thanks for considering a contribution. This repository is a reference implementation: changes are
welcome when they keep it correct, honest about what it proves, and easy to adopt.

## Proposing a change

1. **Open an issue first** for anything larger than a small fix (a new component, a policy rule, a
   change to the CI gate or to a public contract), so the approach can be agreed before you write
   code.
2. **Fork, branch, and open a merge request** against `main`. Keep the diff focused on one change;
   do not mix refactoring with behaviour changes.
3. **Describe what you verified** in the merge request: which commands ran, and which environment
   they ran in (unit tests, the local stack, the MiniStack emulator, or a real AWS account).
4. Security issues are **not** reported through issues or merge requests: see
   [SECURITY.md](SECURITY.md).

A Developer Certificate of Origin (DCO) sign-off is not required. By submitting a contribution you
agree that it is licensed under the repository's [MIT License](LICENSE).

## Working agreement

The rules every change follows (contracts first, tests with every change, never weakening a gate,
honesty about environments, no secrets, no cloud side effects) are in [AGENTS.md](AGENTS.md).
Interface contracts are described in [docs/contracts.md](docs/contracts.md), and the steps for
adding a component, an API endpoint, a policy rule or a database migration are in
[docs/customization.md](docs/customization.md) and [docs/development.md](docs/development.md).

## Running the gate locally

Prerequisites: macOS or Linux, Node.js 24 (`.node-version`; `pnpm install` refuses another major)
and pnpm 12 (`packageManager` in `package.json`; without a global pnpm, prefix commands with
`npm exec --yes pnpm@12.11.2 --`). See
[docs/getting-started.md](docs/getting-started.md).

```bash
pnpm install --frozen-lockfile
pnpm format:check && pnpm lint && pnpm build && pnpm typecheck && pnpm test
pnpm ci:check   # generated CI rules up to date + supply-chain lint
```

Build before `typecheck` and `test`: workspace packages resolve each other through their `dist/`
output. The Guard-backed policy tests need the pinned CloudFormation Guard binary
(`pnpm -C policies run guard:install`); without it they skip, while CI requires it.

If you change something the local stack or the integration suites cover, also run them
([docs/testing.md](docs/testing.md)). GitLab CI re-runs every mandatory check on your merge request;
the local Git hooks (Lefthook) are a convenience, not enforcement.

## Dependencies

- Pin exact versions (no `^` or `~`).
- New packages must have been published at least 3 days ago (`minimumReleaseAge` in
  `pnpm-workspace.yaml`).
- A package that needs an install script must be added to `allowBuilds` and explained in the merge
  request.
- Container images are pinned by tag and digest in `.gitlab/ci/images.yml` or the Dockerfile
  (`docs/security.md` §2). Note any new third-party component in [THIRD_PARTY.md](THIRD_PARTY.md).

## Commit messages

Use a short, imperative subject line that says what changes, followed by an optional body that says
why. Do not include credentials, account identifiers, internal host names or personal data in
commits, code, fixtures or logs.
