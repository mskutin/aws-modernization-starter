-- Least-privilege grants for the runtime identities (ADR 0220).
-- Runs as starter_owner: the runner connects as starter_migrator and runs SET ROLE starter_owner. The roles
-- come from the database bootstrap (dist/db-bootstrap.js), which must have run first.
-- Expand-only: grants and one new function; no table rewrite and no long lock.

-- Nothing for PUBLIC on the application objects, including future functions and types.
REVOKE ALL ON TABLE jobs, schema_migrations FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE starter_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE starter_owner REVOKE USAGE ON TYPES FROM PUBLIC;

-- starter_app (API): INSERT, and SELECT on every column except `content`.
-- No UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER. A migration that adds a column grants it.
GRANT INSERT ON TABLE jobs TO starter_app;
GRANT SELECT (id, title, content_sha256, content_length, options, idempotency_key,
              request_fingerprint, contract_version, created_at) ON TABLE jobs TO starter_app;

-- TRANSITIONAL: the API on main still reads `content`
-- (INSERT ... RETURNING and the Step Functions payload). Migration 0005 revokes
-- this grant in the change that removes the last read. The permission tests already prove the
-- target state: after `REVOKE SELECT (content) ON jobs FROM starter_app`, reading it fails (42501).
GRANT SELECT (content) ON TABLE jobs TO starter_app;

-- starter_processor (validator/processor Lambdas, local simulator) gets no table privilege at all.
-- It reads ONE document, of a job inside the processing window, through this
-- function. Window: 1 hour, i.e. the workflow execution timeout (600 s) plus margin for the
-- start, Step Functions/Lambda retries and clock skew between the API task and the database.
-- No row = missing, out of window or (from 0004) purged: a permanent, non-sensitive failure
-- for the workflow. `content_purged_at` is part of the signature from the start (NULL until
-- 0004 adds the column), so 0004 replaces only the body.
CREATE FUNCTION load_job_document(p_job_id uuid)
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
         NULL::timestamptz
  FROM public.jobs AS j
  WHERE j.id = p_job_id
    AND j.created_at >= pg_catalog.now() - interval '1 hour'
$$;
REVOKE ALL ON FUNCTION load_job_document(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION load_job_document(uuid) TO starter_processor;
COMMENT ON FUNCTION load_job_document(uuid) IS
  'One job document inside the 1-hour processing window, for starter_processor only.';
