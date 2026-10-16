#!/usr/bin/env bash
# Shared helpers for local/compose/bin/*.sh (sourced, not executed).
# shellcheck disable=SC2034  # variables are used by the sourcing scripts

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${COMPOSE_DIR}/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_DIR}/compose.yaml"
ENV_EXAMPLE="${COMPOSE_DIR}/.env.example"
# Generated local secrets (env file with passwords, PostgreSQL TLS material) live OUTSIDE the
# repository, per user, shared by every worktree (the data volumes are per user too):
#   ${STARTER_LOCAL_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/starter-app/compose}
# On macOS the directory must stay below $HOME (podman machine only shares $HOME with the VM).
STATE_DIR="${STARTER_LOCAL_STATE_DIR:-${XDG_STATE_HOME:-${HOME}/.local/state}/starter-app/compose}"
ENV_FILE="${STATE_DIR}/.env"
TLS_DIR="${STATE_DIR}/postgres-tls"
# Read by compose.yaml (bind mounts of the TLS material).
export STARTER_TLS_DIR="$TLS_DIR"
# Before the state directory existed these were kept in the worktree (gitignored).
LEGACY_ENV_FILE="${COMPOSE_DIR}/.env"
API_IMAGE="localhost/starter-app/api:local"
TEST_IDP_IMAGE="localhost/starter-app/test-idp:local"

log() { printf '[starter-compose] %s\n' "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

# Tools the helpers need on the host; fails with one clear message instead of a stack of errors.
require_host_tools() {
  local tool missing=()
  for tool in podman curl node; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  [[ ${#missing[@]} -eq 0 ]] || die "missing on PATH: ${missing[*]} (prerequisites: docs/development.md section 1)"
}

# `podman compose` delegates to an external provider (docker-compose v2 is the tested one).
ensure_compose_provider() {
  local cmd="${COMPOSE_CMD:-podman compose}"
  # shellcheck disable=SC2086  # COMPOSE_CMD is a command line
  $cmd version >/dev/null 2>&1 ||
    die "'${cmd} version' failed: install a compose provider (docker-compose v2, found by 'podman compose') or set COMPOSE_CMD"
}

# Point DOCKER_HOST at the ROOTLESS Podman API (scripts/podman/rootless-socket.sh: an SSH forward
# from the podman machine on macOS, the user's $XDG_RUNTIME_DIR socket on Linux). Without it,
# `podman compose` (docker-compose provider) may talk to a ROOTFUL default socket.
ensure_rootless_docker_host() {
  require_host_tools
  if [[ -z "${DOCKER_HOST:-}" ]]; then
    local helper="${REPO_ROOT}/scripts/podman/rootless-socket.sh" exports
    # The helper starts the socket if needed and prints `export DOCKER_HOST=...` lines.
    exports="$(bash "$helper" env)" || die "no rootless Podman API socket (see the rootless-socket messages above)"
    eval "$exports"
  fi
  [[ "$DOCKER_HOST" == unix://* ]] || die "DOCKER_HOST must be a unix socket, got: ${DOCKER_HOST}"
  local sock="${DOCKER_HOST#unix://}"
  [[ -S "$sock" ]] || die "socket ${sock} does not exist. Run: scripts/podman/rootless-socket.sh start"
  # Safety: refuse to operate on a rootful engine.
  local rootless
  rootless="$(curl -sS --max-time 10 --unix-socket "$sock" http://d/v4.0.0/libpod/info 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).host.security.rootless))}catch{process.stdout.write("unknown")}})')"
  [[ "$rootless" == "true" ]] || die "DOCKER_HOST (${DOCKER_HOST}) is not a rootless Podman API (rootless=${rootless}); refusing."
  export DOCKER_HOST
}

random_secret() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("hex"))'
}

ensure_state_dir() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
}

# Create the env file (ENV_FILE) from .env.example with generated passwords (first run only), then
# upgrade an existing .env to the least-privilege role model (ADR 0220).
ensure_env_file() {
  ensure_state_dir
  if [[ ! -f "$ENV_FILE" && -f "$LEGACY_ENV_FILE" ]]; then
    # One-time move of a worktree-local .env (same passwords, so existing volumes keep working).
    (umask 077 && cp "$LEGACY_ENV_FILE" "$ENV_FILE")
    chmod 600 "$ENV_FILE"
    rm -f "$LEGACY_ENV_FILE"
    log "moved ${LEGACY_ENV_FILE} to ${ENV_FILE} (generated secrets now live outside the repository)"
  elif [[ -f "$LEGACY_ENV_FILE" ]]; then
    log "WARNING: ignoring ${LEGACY_ENV_FILE}; the stack uses ${ENV_FILE}"
  fi
  if [[ ! -f "$ENV_FILE" ]]; then
    [[ -f "$ENV_EXAMPLE" ]] || die "missing ${ENV_EXAMPLE}"
    # PostgreSQL applies its init variables only when it initialises an empty volume: fresh random
    # passwords for an existing volume fail later with "password authentication failed".
    if podman_remote volume exists starter-app-pgdata 2>/dev/null; then
      die "volume starter-app-pgdata exists but ${ENV_FILE} does not: restore the env file it was created with (or set STARTER_LOCAL_STATE_DIR to its directory), or delete the local data with local/compose/bin/dev-down.sh --volumes"
    fi
    local line out=""
    while IFS= read -r line || [[ -n "$line" ]]; do
      # One distinct random value per __GENERATE__ placeholder.
      while [[ "$line" == *__GENERATE__* ]]; do line="${line/__GENERATE__/$(random_secret)}"; done
      out+="${line}"$'\n'
    done <"$ENV_EXAMPLE"
    (umask 077 && printf '%s' "$out" >"$ENV_FILE")
    log "created ${ENV_FILE} (outside the repository) with generated local passwords"
  fi
  upgrade_env_file
}

# A separate admin superuser and one password per least-privilege login role. Existing
# values are never changed; a legacy .env keeps its superuser as LEGACY_* for the one-time
# volume upgrade (local/compose/postgres/ensure-admin.sh).
upgrade_env_file() {
  local appended=""
  if ! grep -q '^POSTGRES_ADMIN_USER=' "$ENV_FILE"; then
    if grep -q '^POSTGRES_USER=' "$ENV_FILE"; then
      appended+=$'\n# Legacy volume superuser (was POSTGRES_USER): used once to create POSTGRES_ADMIN_USER.\n'
      appended+="LEGACY_SUPERUSER=$(sed -n 's/^POSTGRES_USER=//p' "$ENV_FILE" | tail -n1)"$'\n'
      appended+="LEGACY_PASSWORD=$(sed -n 's/^POSTGRES_PASSWORD=//p' "$ENV_FILE" | tail -n1)"$'\n'
    fi
    appended+=$'\n# database identities (added by bin/dev-up.sh)\nPOSTGRES_ADMIN_USER=starter_admin\n'
  fi
  local key
  for key in POSTGRES_ADMIN_PASSWORD STARTER_MIGRATOR_PASSWORD STARTER_APP_PASSWORD STARTER_PROCESSOR_PASSWORD \
    STARTER_RETENTION_PASSWORD; do
    if ! grep -q "^${key}=" "$ENV_FILE" && [[ "$appended" != *"${key}="* ]]; then
      appended+="${key}=$(random_secret)"$'\n'
    fi
  done
  if [[ -n "$appended" ]]; then
    printf '%s' "$appended" >>"$ENV_FILE"
    log "upgraded ${ENV_FILE}: admin superuser and least-privilege role passwords added (existing values kept)"
  fi
}

# Locally generated TLS material for the PostgreSQL container (in the state directory): a throw-away
# CA, whose private key is discarded after signing, and a server certificate for
# postgres/localhost/127.0.0.1.
ensure_local_tls() {
  command -v openssl >/dev/null || die "openssl is required to generate the local PostgreSQL TLS material"
  if [[ -s "${TLS_DIR}/ca.pem" && -s "${TLS_DIR}/server.pem" && -s "${TLS_DIR}/server.key" ]] &&
    openssl x509 -checkend 2592000 -noout -in "${TLS_DIR}/server.pem" >/dev/null 2>&1; then
    return
  fi
  ensure_state_dir
  log "generating local PostgreSQL TLS material in ${TLS_DIR}"
  local work
  work="$(mktemp -d)"
  cat >"${work}/openssl.cnf" <<'CNF'
[req]
distinguished_name = dn
[dn]
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[v3_server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:postgres,DNS:localhost,IP:127.0.0.1
authorityKeyIdentifier = keyid,issuer
CNF
  (
    umask 077
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "${work}/ca.key" -out "${work}/ca.pem" -days 825 \
      -subj "/CN=starter-app local PostgreSQL CA $(date +%Y%m%d)" -config "${work}/openssl.cnf" \
      -extensions v3_ca >/dev/null 2>&1
    openssl req -new -newkey rsa:2048 -nodes -keyout "${work}/server.key" -out "${work}/server.csr" \
      -subj "/CN=postgres" -config "${work}/openssl.cnf" >/dev/null 2>&1
    openssl x509 -req -in "${work}/server.csr" -CA "${work}/ca.pem" -CAkey "${work}/ca.key" \
      -set_serial "0x$(openssl rand -hex 8)" -days 825 -out "${work}/server.pem" \
      -extfile "${work}/openssl.cnf" -extensions v3_server >/dev/null 2>&1
  ) || {
    rm -rf "$work"
    die "openssl could not generate the local TLS material"
  }
  mkdir -p "$TLS_DIR"
  install -m 644 "${work}/ca.pem" "${TLS_DIR}/ca.pem"
  install -m 644 "${work}/server.pem" "${TLS_DIR}/server.pem"
  install -m 600 "${work}/server.key" "${TLS_DIR}/server.key"
  rm -rf "$work" # the CA key is gone: nothing else can ever be signed with this CA
}

# Value of KEY from the environment, else from the env file (ENV_FILE), else the default.
setting() {
  local key="$1" default="$2" value="${!1:-}"
  if [[ -z "$value" && -f "$ENV_FILE" ]]; then
    value="$(sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n1)"
  fi
  printf '%s' "${value:-$default}"
}

podman_remote() { podman --url "$DOCKER_HOST" "$@"; }

# Build the API image exactly as apps/api/Dockerfile documents: repository root as context and
# apps/api/.dockerignore as ignore file (only `podman/buildah build --ignorefile` honours it).
build_api_image() {
  [[ -f "${REPO_ROOT}/apps/api/Dockerfile" ]] ||
    die "apps/api/Dockerfile not found - cannot build ${API_IMAGE}"
  log "building ${API_IMAGE} (context: repository root, ignore file: apps/api/.dockerignore)"
  podman_remote build \
    --ignorefile "${REPO_ROOT}/apps/api/.dockerignore" \
    -f "${REPO_ROOT}/apps/api/Dockerfile" \
    -t "$API_IMAGE" \
    "$REPO_ROOT"
}

# Identity: the TEST ONLY IdP image, built like the API image (repository root as context,
# tools/test-idp/.dockerignore as ignore file).
build_test_idp_image() {
  log "building ${TEST_IDP_IMAGE} (TEST ONLY identity provider)"
  podman_remote build \
    --ignorefile "${REPO_ROOT}/tools/test-idp/.dockerignore" \
    -f "${REPO_ROOT}/tools/test-idp/Dockerfile" \
    -t "$TEST_IDP_IMAGE" \
    "$REPO_ROOT"
}

compose() {
  ${COMPOSE_CMD:-podman compose} -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}
