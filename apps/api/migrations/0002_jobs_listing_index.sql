-- Keyset pagination for GET /v1/jobs (ORDER BY created_at DESC, id DESC).
-- Expand-only change: safe to apply while the previous release is running.
CREATE INDEX IF NOT EXISTS jobs_created_at_id_idx ON jobs (created_at DESC, id DESC);
