# ADR 0211 — Ownership-scoped authorization, principal-scoped idempotency, pagination and audit

- Status: Accepted (implemented and tested locally against PostgreSQL 17 and DynamoDB Local)

## Context

Any caller could read every job and its analysis by id, list every title, and learn whether
someone else had already submitted an identical document (global idempotency keys). ADR 0005
item 4 also requires the authenticated subject on every state change.

## Decision

1. **Owner = issuer-bound principal.** Each job stores `owner_issuer` (`iss`) and `owner_subject`
   (`sub`) — migration `0005_job_owner.sql`. Both are part of every authorization predicate, so a
   second issuer or an issuer change can never hand one tenant's jobs to another with an equal
   `sub`.
2. **Authorization in the data path.** `PgJobRepository` exposes only owner-scoped reads:
   `findOwned(id, owner)` → `WHERE id = $1 AND owner_issuer = $2 AND owner_subject = $3`,
   `listOwned(owner, …)` (keyset pagination), and the insert-conflict lookup is filtered the same
   way — a conflict with another owner's row raises `OwnershipConflictError` (500) instead of
   returning that row. The DynamoDB state item is read only after the owner check succeeded.
3. **No existence oracle.** A foreign id and an unknown id run the same single query and produce
   the same 404 body (`Job <id> does not exist.`, same type/title/status).
4. **Least privilege.** The API never reads `content` back: it is written by the INSERT and
   never selected or returned. `starter_app` needs INSERT plus column-level SELECT on every column
   except `content`; `0005` grants SELECT on the owner columns and **revokes the transitional
   `SELECT (content)`** granted by `0003`. No UPDATE/DELETE is needed.
5. **Legacy rows.** `owner_*` stay nullable with
   `CHECK (owner_issuer IS NOT NULL AND owner_subject IS NOT NULL) NOT VALID`: legacy rows are kept
   but visible to nobody; no new row can be ownerless. A later contract migration may validate the
   constraint after a purge or an assignment.
   - **`0005` is a CUT-OVER migration, not a pure expand step.** The NOT VALID check
     applies to every new INSERT at once, so a legacy API task — which inserts ownerless rows —
     gets `23514` on every `POST /v1/jobs` from the moment `0005` ran until it is replaced. (The
     content revoke has the same shape: a legacy task that still selects `content` gets `42501`.)
   - **Rollout rule for the release that adds `0005`:** do not run the migration while legacy tasks serve
     traffic. Either (a) scale the legacy service to zero / drain it, run the migration task, then
     start the new version — a short, announced submission outage; or (b) deploy it with
     **rollback-on-alarm disabled for this one deployment** (`ApiService` sets the deployment
     alarm with `ROLLBACK_ON_ALARM`) and roll forward on failure.
   - **Rollback consequence:** an automatic or manual rollback to legacy after `0005` leaves job
     submission DOWN (every insert fails the check) until a roll-forward; reads of legacy data are
     unaffected. Undoing `0005` would mean dropping the check (and re-granting `SELECT (content)`),
     i.e. re-opening the content read and the issuer-blind owner check — a security decision, not an operational rollback.
   - Alternative not taken: add the check (and, with Database, the content revoke) in a
     contract migration of the NEXT release, after every task inserts owners. Rejected because the
     ownerless window would ship the cross-tenant exposure this decision closes.
6. **Index without blocking writes.** `0006_job_owner_index.sql` builds
   `(owner_issuer, owner_subject, created_at DESC, id DESC)` `CONCURRENTLY` under
   `-- migrate:no-transaction`. It is a separate one-statement file because the runner sends a
   no-transaction file as one query and a multi-statement query runs in an implicit transaction,
   which `CONCURRENTLY` refuses. No `IF NOT EXISTS`, so a failed concurrent build (an INVALID
   index) fails loudly on the next run instead of being kept. Numbers follow merge order
   (Database's 0003/0004 first).
7. **Principal-scoped idempotency.** Before any key reaches DynamoDB or PostgreSQL:
   `p:<sha256(iss|sub)>:h:<Idempotency-Key>` and `p:<sha256(iss|sub)>:derived:v1:<fingerprint>`
   (`@starter/domain` `resolveIdempotencyKey`, the scope argument is mandatory). The same key or the
   same body from two principals names two jobs; `Idempotent-Replayed` is only ever returned for
   the caller's own job; key reuse with another body stays 422 within one principal. Scoped keys
   contain `:`, so they can never equal a raw header key or a legacy key.
8. **Pagination.** Unchanged contract: `limit` 1–100 (default 20), opaque keyset cursor. A cursor
   is only a position; replayed by another principal it yields that principal's (empty) page.
9. **Audit trail (ADR 0005 item 4).** Exactly one structured event per `/v1` request, written
   in `onResponse` so every outcome is covered — or, when the client disconnects before the response
   finished, with outcome `aborted` as soon as the handler settles (Fastify then runs
   neither `onResponse` nor, once the body was read, `onRequestAbort`; `audit.ts` watches the
   response's `close`-without-`finish`). `status` is then what the API decided (e.g. 202 for a job
   that WAS created) and `jobIds` is recorded right after the job row exists, so a create that later
   fails or is abandoned still names its job: `{"msg":"audit","audit":{"event","outcome","status",
"principal","jobIds","count","reason","requestId"}}` with `event` ∈ `job.create`, `job.read`,
   `job.list`, `auth.denied` (401, 403, 429 and the 503 of an IdP outage, with the verifier/limiter
   reason code) and `request.unrouted` (authenticated request to an unknown `/v1` route).
   `job.read` records the requested id also for 404s ("who asked for job X"). Never logged: titles,
   content, tokens, raw claims or the subject.
   - `principal` = first 16 hex of `sha256(iss|sub)`: a **linkable pseudonym, not anonymous** —
     anyone with a candidate subject can recompute it, and low-entropy subjects (e-mail, national-ID-like
     ids) are dictionary-reversible. Keyed hashing (HMAC with a Secrets Manager key) is the
     upgrade path if an organization requires unlinkability in logs.
   - Retention: the API log group's CloudWatch retention (`observability.logRetentionDays`: dev 30,
     staging/prod per config, prod ≥ 365 days enforced by the schema).
   - Workflow transitions are correlated to the user through `jobId` → owner in PostgreSQL (the
     execution input carries no principal; the reconciler logs `actor: "system:reconciler"`).

## Consequences

- A user sees only their own jobs; operators answer "who submitted/read job X" from the audit log
  plus the PostgreSQL owner columns.
- Organizations that need group/tenant sharing must extend the predicate deliberately (e.g. an
  `owner_group` claim); the single-owner model is the safe default.
- Changing `AUTH_ISSUER` makes existing jobs invisible (by design); a migration must re-own them.
- Proof: unit and integration tests (cross-user get/list/cursor/result, identical 404 bodies,
  cross-user idempotency in both stores, conflict lookup, upgrade from a database at 0002 with
  legacy rows, `SELECT content` as `starter_app` → 42501); mutation runs remove each SQL owner
  predicate in turn and the suite fails each time.
