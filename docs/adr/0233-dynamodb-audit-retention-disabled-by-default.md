# ADR 0233 — DynamoDB audit-record retention: implemented, disabled by default

- Status: Accepted

## Context

`STEP#<time>#<state>` items (the per-job step audit trail) have no expiry. Contracts §4: "Do not
enable destructive cleanup of real data without an approved retention policy… provide a
disabled-by-default implementation and clear configuration contract."

## Decision

- `JOB_AUDIT_TTL_DAYS` (1–3650) makes the job-state store write the table's TTL attribute
  (`expiresAt`, epoch seconds = step time + N days) on new STEP# items. **Unset = no expiry** —
  the default in code (`@starter/config` `loadJobAuditConfig`), in every environment config
  (`jobTable.auditRetentionDays: null`) and therefore in every synthesized function.
- The same attribute and TTL setting already serve the 24-hour idempotency records; no table change
  is needed. Existing items are not touched (TTL applies only to items written after enabling).
- The job-state item (`STATE`) keeps no TTL: its lifecycle follows the document retention
  (ADR 0223).

## Consequences

- Enabling retention is a configuration change per environment, after approval, and takes effect
  for new audit items only; DynamoDB deletes expired items lazily (typically within days) and they
  stay in point-in-time-recovery backups for the PITR window.
- Tested: disabled by default (config, store, synthesized functions) and the computed `expiresAt`
  on DynamoDB Local.
