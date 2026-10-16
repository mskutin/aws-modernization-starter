# ADR 0200 — API contracts in zod v4 with natively generated OpenAPI 3.1

- Status: Accepted

## Context

The SPA, the API, the Lambda steps and the tests must agree on request and
response shapes, and reviewers need a machine-readable API description. Options:
hand-written OpenAPI plus generated types; a schema library plus an OpenAPI
generator dependency (e.g. `@asteasolutions/zod-to-openapi`); or zod v4's
built-in JSON Schema output.

## Decision

- `@starter/contracts` holds zod v4 schemas per major version (`src/v1`), exported
  as `v1` and at the top level for the current major.
- The OpenAPI 3.1 document is assembled from `z.toJSONSchema` (draft 2020-12,
  the OpenAPI 3.1 dialect) using explicit component registries: requests are
  generated with `io: "input"` (defaults optional, `additionalProperties: false`),
  responses with `io: "output"` and open objects for additive evolution.
- `openapi/v1.json` is committed; a unit test fails when it drifts from the
  generator; `pnpm --filter @starter/contracts run openapi:generate` rewrites it.
- The API serves the same document at `GET /openapi.json`.

## Consequences

- One dependency (`zod`) for runtime validation, types and documentation.
- Spec reviewers see contract changes as diffs of `openapi/v1.json`.
- zod upgrades can change the generated JSON; the drift test surfaces that.
- Query-parameter docs are hand-built from the same `LIMITS` constants because
  coercing schemas have no meaningful JSON Schema input type.
