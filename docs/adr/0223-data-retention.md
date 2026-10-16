# ADR 0223 — Data retention: redaction job disabled until an approved policy exists

- Status: Accepted
- Related: ADR 0220 (`starter_retention`), ADR 0221 (IAM)

## Context

Documents, derived results and job metadata were kept forever. Retention
periods are an organization decision, and no period is approved. The brief forbids destructive cleanup of
real data without an approved policy, but asks for an implementation that is ready to switch on.

## Decision

1. **Policy document with an inventory of every store** (`data-retention.md`). It lists proposed
   periods and their approval status, the effective deletion time including RDS backups and DynamoDB
   PITR (up to 35 days), and the owner of each mechanism.
2. **Redaction, not deletion, for PostgreSQL documents.** After `RETENTION_CONTENT_DAYS`, `title` and
   `content` are replaced by `[purged]` and `''`, and `content_purged_at` is set (migration 0004 with
   a `NOT VALID` check constraint). Metadata and hashes stay for audit and idempotency. Row deletion
   needs a cross-store design and is not implemented.
3. **Disabled by default, explicit to enable.**
   - `RETENTION_MODE=disabled` is the default; in that mode the CLI reads nothing.
   - `dry-run` only counts.
   - `apply` requires `RETENTION_APPROVAL_REF`, which the CLI and the CDK schema both enforce and
     every batch log line carries.
   - The CDK task definition exists but has no schedule.
4. **Least privilege and bounded work.**
   - `starter_retention` can select only `id, created_at, content_purged_at` and update only the three
     redacted columns.
   - Batches use `FOR UPDATE SKIP LOCKED` and the database clock, with a per-run batch limit.
5. **Logs never carry document data.** The retention job logs counts. The RDS parameter group stops PostgreSQL
   from logging bind parameters of slow statements (`log_parameter_max_length=0`), which would
   otherwise copy titles and content into the CloudWatch export.

## Consequences

- Nothing is purged in any environment until the organization approves a period. This is the intended
  state; this ADR says so prominently.
- Purged data remains in backups and PITR until those windows pass. Restores must re-run the job
  before serving traffic (runbook item).
- DynamoDB TTLs for STATE/STEP items belong to the workflow (`JOB_AUDIT_TTL_DAYS`, unset = no
  expiry), so the retention policy for derived results also depends on that setting (ADR 0233).
