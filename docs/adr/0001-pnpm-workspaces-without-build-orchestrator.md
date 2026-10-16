# 0001 — pnpm workspaces without a build orchestration framework

- Status: Accepted

## Context

The reference must show dependency-aware CI for a TypeScript monorepo (SPA, API,
Lambdas, CDK, policies) while staying easy for another team to
understand and extend. Nx and Turborepo add caching and task graphs but also a
proprietary configuration surface, plugins, remote-cache temptations and upgrade churn.

## Decision

- Use **pnpm workspaces** (`pnpm-workspace.yaml`) with explicit package boundaries
  (`@starter/*`), `workspace:*` internal dependencies and TypeScript project references
  where they help.
- Task ordering comes from `pnpm -r` (topological by declared dependencies).
- Affected-component detection is a small, tested in-repo tool (`tools/impact`) that
  reads the same package graph plus `components.yaml`, and **fails safe** (run more
  checks) whenever impact is uncertain.
- No Nx, Turborepo, Lerna, Rush or custom monorepo framework.

## Consequences

- - Plain, debuggable scripts; the dependency graph is the package manifests.
- - CI selection logic is reviewable code with fixtures and unit tests.
- − No local/remote computation cache; CI relies on GitLab caches for the pnpm store.
- − Topological builds are slower than a cached orchestrator in very large repos; revisit
  if the repo grows beyond a few dozen packages.
