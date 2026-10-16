# AGENTS.md — working agreement

The working agreement for anyone who changes this repository, whether a person or an automated
tool. Keep it short, true and executable: if a command here stops working, fix this file in the same
merge request. How to propose a change: [CONTRIBUTING.md](CONTRIBUTING.md).

## Ground rules

1. **Contracts first.** Public surfaces are described in [docs/contracts.md](docs/contracts.md) and
   defined in code (`@starter/contracts`, `workflows/processing/src/spec.ts`). Change the contract
   (and its version) before the implementation; never fork a contract locally.
2. **Small, focused diffs.** No refactoring outside the task, no parallel architectures.
3. **Tests with every change**, next to the code. No tests that cannot fail, no fixed sleeps, no
   internet access in unit or integration tests. Never delete a test to get green.
4. **Never weaken a gate** (lint, types, tests, policies, scanners, release age) to get green. Use a
   documented, expiring project exception in the governed registers instead (the shipped
   `status: reference` entries of the reference design are undated; see `docs/policy-as-code.md`).
5. **Honesty about environments.** The local workflow is a simulation, DynamoDB Local is not
   DynamoDB, MiniStack is an emulator, and offline checks are not drift detection. Say which one ran;
   claim an AWS result only with evidence from a real AWS run.
6. **No secrets** in code, fixtures, logs, CI output or commit messages. Never ask anyone to paste
   credentials.
7. **No cloud side effects** unless a human explicitly asks: never run `cdk deploy`, `cdk destroy`,
   `cdk bootstrap`, the sweeper with `--apply`, the sandbox or mini-stack lifecycle scripts, or
   anything else that creates or deletes AWS resources on your own initiative.

## Toolchain

- Node.js 24 (`.node-version`; `pnpm install` refuses another major); pnpm 12 (`packageManager` in
  `package.json`). Without a global pnpm (no corepack needed): `npm exec --yes pnpm@12.11.2 -- <args>`.
- TypeScript strict (`noUncheckedIndexedAccess`), ES modules, no `any`.
- New npm dependencies: exact versions, published at least 3 days ago (`minimumReleaseAge`);
  install scripts only for packages listed in `allowBuilds`.
- Containers: rootless Podman (macOS or Linux) for the local stack and Testcontainers;
  `scripts/podman/rootless-socket.sh start|stop|status|env` provides the socket
  ([docs/development.md](docs/development.md) §4.0).
- Git hooks are optional: `LEFTHOOK=0 pnpm install` skips them,
  `sh scripts/git-hooks/install.sh --uninstall` removes them.

## Commands

| Purpose        | Command                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| Install        | `pnpm install --frozen-lockfile`                                                                       |
| Build          | `pnpm build`                                                                                           |
| Typecheck      | `pnpm typecheck`                                                                                       |
| Lint / format  | `pnpm lint` · `pnpm format:check` (`pnpm format` to fix)                                               |
| Unit tests     | `pnpm test`                                                                                            |
| One package    | `pnpm --filter @starter/api test` (`--filter '@starter/api...'` adds its dependencies)                 |
| CI rules       | `pnpm ci:check` (generated rules up to date + supply-chain lint)                                       |
| CDK synth      | `pnpm --filter @starter/infra synth` (offline; needs `pnpm` on `PATH`)                                 |
| Policies       | `pnpm --filter @starter/policies test`                                                                 |
| Impact report  | `node tools/impact/src/cli.ts analyze --base "$(git merge-base origin/main HEAD)"`                     |
| Integration    | `pnpm test:integration` (PostgreSQL + DynamoDB Local via Testcontainers or CI services)                |
| Emulator layer | `bash tests/aws-integration/emulator/all.sh` (local MiniStack; [docs/ministack.md](docs/ministack.md)) |

The full gate, in this order (build first: workspace packages resolve each other's `dist/`):

```bash
pnpm format:check && pnpm lint && pnpm build && pnpm typecheck && pnpm test
```

GitLab CI re-runs every mandatory check; local Git hooks (Lefthook) are a convenience, not
enforcement. Deterministic CI checks are authoritative.

## Adding things

- **Lambda or service:** a workspace package under `functions/` or `apps/`, one entry in
  `components.yaml`, the CDK wiring in `infra/`, tests. CI picks it up from `components.yaml`; never
  copy CI YAML. See [docs/customization.md](docs/customization.md).
- **API endpoint:** contract in `@starter/contracts` → regenerate OpenAPI → route → tests.
- **Policy rule:** rule, passing fixture, failing fixture, expected diagnostic and a catalogue row in
  [docs/policy-as-code.md](docs/policy-as-code.md).
- **Database change:** a new numbered migration only (never edit an applied one), expand/contract
  ([docs/development.md](docs/development.md) §9).
