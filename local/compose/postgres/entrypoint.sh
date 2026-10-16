#!/bin/sh
# starter-app PostgreSQL with TLS (local only). Runs as root inside the container: installs the
# locally generated server key/cert for the postgres user (the key must be 0600 and owned by it),
# then hands over to the image's entrypoint with ssl=on and the TLS-only pg_hba.conf.
set -eu
tls_dir=/var/lib/postgresql/tls
install -d -o postgres -g postgres -m 700 "$tls_dir"
install -o postgres -g postgres -m 600 /starter/tls/server.key "$tls_dir/server.key"
install -o postgres -g postgres -m 644 /starter/tls/server.pem "$tls_dir/server.pem"
exec docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_cert_file="$tls_dir/server.pem" \
  -c ssl_key_file="$tls_dir/server.key" \
  -c ssl_min_protocol_version=TLSv1.2 \
  -c password_encryption=scram-sha-256 \
  -c hba_file=/starter/pg_hba.conf
