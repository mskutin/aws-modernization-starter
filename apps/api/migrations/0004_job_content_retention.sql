-- Retention support for document data (ADR 0223).
-- Expand-only: a nullable column without default (metadata-only change) and a NOT VALID check.
ALTER TABLE jobs ADD COLUMN content_purged_at timestamptz;

-- A purged row keeps no document data: title and content are replaced by fixed markers.
-- NOT VALID enforces the rule for new and updated rows at once without scanning the table under an
-- exclusive lock; every existing row is unpurged (NULL), so the rule already holds for them.
ALTER TABLE jobs ADD CONSTRAINT jobs_purged_document_redacted
  CHECK (content_purged_at IS NULL OR (title = '[purged]' AND content = '')) NOT VALID;

-- starter_retention (retention job, disabled by default): find candidates and redact them. It cannot
-- read titles or content, insert, delete or change anything else.
GRANT SELECT (id, created_at, content_purged_at) ON TABLE jobs TO starter_retention;
GRANT UPDATE (title, content, content_purged_at) ON TABLE jobs TO starter_retention;

-- load_job_document: same signature, now with the real column, and never a purged row.
CREATE OR REPLACE FUNCTION load_job_document(p_job_id uuid)
RETURNS TABLE (
  title text,
  content text,
  options jsonb,
  content_sha256 text,
  contract_version text,
  content_purged_at timestamptz
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT j.title, j.content, j.options, j.content_sha256::text, j.contract_version,
         j.content_purged_at
  FROM public.jobs AS j
  WHERE j.id = p_job_id
    AND j.created_at >= pg_catalog.now() - interval '1 hour'
    AND j.content_purged_at IS NULL
$$;
