-- identity (EXPAND phase, ADR 0211).
--
-- Every job belongs to the principal that submitted it. The owner is ISSUER-BOUND
-- (owner_issuer = `iss`, owner_subject = `sub` of the caller's access token), so an issuer
-- change cannot hand one tenant's jobs to another tenant with an equal `sub`; every read,
-- list and insert-conflict lookup of the API filters on both columns.
--
-- Nullable on purpose (expand): legacy rows (created before this migration) have no owner and are visible to
-- NOBODY. The NOT VALID check enforces the invariant for every NEW row without scanning (or
-- rewriting) existing ones; a later CONTRACT migration may VALIDATE it once legacy rows are
-- purged or assigned. Both statements are catalogue-only (no table rewrite).
--
-- The owner index is created CONCURRENTLY in 0006 (the runner executes a no-transaction file
-- as one statement batch, so the concurrent build needs a file of its own).
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS owner_issuer text,
  ADD COLUMN IF NOT EXISTS owner_subject text;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_owner_present
  CHECK (owner_issuer IS NOT NULL AND owner_subject IS NOT NULL) NOT VALID;

-- Least privilege for the API role: INSERT is table-level and already covers
-- the new columns; SELECT is column-level, so the new columns are granted here.
GRANT SELECT (owner_issuer, owner_subject) ON jobs TO starter_app;

-- The API never reads document content any more: end the TRANSITIONAL grant of 0003.
REVOKE SELECT (content) ON jobs FROM starter_app;
