#!/bin/sh
# Prepare a database for the API (CI jobs that start the API under test, host-side dev loops):
#   1. role bootstrap as the ADMIN      node dist/db-bootstrap.js   (roles, ownership, CONNECT)
#   2. migrations as starter_migrator       node dist/migrate.js up     (SET ROLE starter_owner inside)
# The API then runs as starter_app with the caller's DB_USER/DB_PASSWORD. ADR 0220.
#
# Environment (LOCAL/CI ONLY — on AWS the bootstrap and migration are separate ECS tasks with
# IAM authentication and no passwords):
#   DB_HOST, DB_PORT, DB_NAME, DB_SSL[, DB_SSL_ROOT_CERT], APP_RUNTIME (local|ci)
#   DB_ADMIN_USER, DB_ADMIN_PASSWORD                      admin (bootstrap superuser)
#   DB_BOOTSTRAP_{MIGRATOR,APP,PROCESSOR,RETENTION}_PASSWORD   login-role passwords
# Never use `set -x` here: the environment carries passwords.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
dist="${here}/../dist"
[ -f "${dist}/db-bootstrap.js" ] || {
  echo "prepare-database: ${dist}/db-bootstrap.js missing; build @starter/api first" >&2
  exit 1
}
: "${DB_ADMIN_USER:?DB_ADMIN_USER is required (admin role for the bootstrap)}"
: "${DB_ADMIN_PASSWORD:?DB_ADMIN_PASSWORD is required}"
: "${DB_BOOTSTRAP_MIGRATOR_PASSWORD:?DB_BOOTSTRAP_MIGRATOR_PASSWORD is required}"

echo "prepare-database: bootstrap roles on ${DB_HOST}:${DB_PORT:-5432}/${DB_NAME} as ${DB_ADMIN_USER}"
env -u DB_PASSWORD_FILE DB_USER="${DB_ADMIN_USER}" DB_PASSWORD="${DB_ADMIN_PASSWORD}" \
  DB_AUTH=password DB_BOOTSTRAP_LOGIN_AUTH=password \
  node "${dist}/db-bootstrap.js"

echo "prepare-database: migrate as starter_migrator"
env -u DB_PASSWORD_FILE DB_USER=starter_migrator DB_PASSWORD="${DB_BOOTSTRAP_MIGRATOR_PASSWORD}" \
  DB_AUTH=password \
  node "${dist}/migrate.js" up
