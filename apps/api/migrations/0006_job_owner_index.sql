-- migrate:no-transaction
-- identity: the index serving
-- owner-scoped keyset pagination (WHERE owner_issuer = $1 AND owner_subject = $2
-- ORDER BY created_at DESC, id DESC), built CONCURRENTLY so inserts are never blocked.
--
-- Exactly one statement: the runner sends a no-transaction file as one query, and a
-- multi-statement query would run in an implicit transaction, which CONCURRENTLY refuses.
-- No IF NOT EXISTS on purpose: a failed concurrent build leaves an INVALID index behind, and
-- IF NOT EXISTS would silently keep it. Recovery: DROP INDEX CONCURRENTLY
-- jobs_owner_created_at_id_idx; then re-run the migrations.
CREATE INDEX CONCURRENTLY jobs_owner_created_at_id_idx
  ON jobs (owner_issuer, owner_subject, created_at DESC, id DESC);
