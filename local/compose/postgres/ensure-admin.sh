#!/bin/sh
# One-shot (compose service postgres-admin): make sure the admin superuser of the volume exists.
#
# - Current volumes: initdb created it (POSTGRES_ADMIN_USER) -> nothing to do.
# - Legacy volumes (POSTGRES_USER=starter_app made the API role the bootstrap superuser):
#   create the admin ONCE with the legacy superuser's credentials (LEGACY_* from local/compose/.env).
#   The database bootstrap (db-bootstrap service) then renames and locks the old superuser,
#   creates a least-privilege starter_app and moves every object to starter_owner, keeping the data.
# Connects over TLS with full verification, like every other client. Never prints a password.
set -eu
export PGHOST=postgres PGPORT=5432 PGDATABASE="${POSTGRES_DB}" PGSSLMODE=verify-full \
  PGSSLROOTCERT=/starter/tls/ca.pem PGCONNECT_TIMEOUT=10

if PGUSER="${POSTGRES_ADMIN_USER}" PGPASSWORD="${POSTGRES_ADMIN_PASSWORD}" \
  psql -XqAt -c 'SELECT 1' >/dev/null 2>&1; then
  echo "postgres-admin: admin role ${POSTGRES_ADMIN_USER} ok"
  exit 0
fi
if [ -z "${LEGACY_SUPERUSER:-}" ] || [ -z "${LEGACY_PASSWORD:-}" ]; then
  echo "postgres-admin: cannot log in as ${POSTGRES_ADMIN_USER}, and no legacy superuser is configured" >&2
  echo "postgres-admin: restore the local/compose/.env this volume was created with, or delete the volume (bin/dev-down.sh --volumes)" >&2
  exit 1
fi
echo "postgres-admin: legacy volume: creating ${POSTGRES_ADMIN_USER} with the legacy superuser ${LEGACY_SUPERUSER}"
PGUSER="${LEGACY_SUPERUSER}" PGPASSWORD="${LEGACY_PASSWORD}" psql -Xq -v ON_ERROR_STOP=1 \
  -v admin="${POSTGRES_ADMIN_USER}" -v pw="${POSTGRES_ADMIN_PASSWORD}" <<'SQL'
DO $$ BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'the legacy user is not a superuser; nothing to upgrade';
  END IF;
END $$;
CREATE ROLE :"admin" LOGIN SUPERUSER PASSWORD :'pw';
SQL
echo "postgres-admin: created ${POSTGRES_ADMIN_USER}"
