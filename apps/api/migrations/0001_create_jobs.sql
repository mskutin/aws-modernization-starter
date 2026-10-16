-- Business record of submitted document-analysis jobs.
-- Workflow status lives in DynamoDB (see workflows/processing/src/spec.ts).
CREATE TABLE jobs (
  id                  uuid        PRIMARY KEY,
  title               text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  content             text        NOT NULL,
  content_sha256      char(64)    NOT NULL,
  content_length      integer     NOT NULL CHECK (content_length >= 0),
  options             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key     text        NOT NULL,
  request_fingerprint char(64)    NOT NULL,
  contract_version    text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Durable idempotency guarantee (DynamoDB idempotency records expire via TTL).
CREATE UNIQUE INDEX jobs_idempotency_key_uq ON jobs (idempotency_key);
