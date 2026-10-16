/**
 * LOCAL ONLY: a real PostgreSQL 17 with `ssl=on`, started by Testcontainers with a certificate
 * from {@link createTestPki}. TCP connections must use TLS (`hostssl` only, `hostnossl … reject`)
 * and SCRAM. Used by the `tls-server` suites, which prove the same client-side verification as the
 * proxy-based CI suites against PostgreSQL's own TLS stack. CI jobs have no container socket.
 */
import type { TestPki } from './pki.js';
import { DEFAULT_POSTGRES_IMAGE, type PostgresEndpoint, type StartedEndpoint } from './infra.js';
import { randomBytes } from 'node:crypto';

const HBA = `# starter test: TLS-only TCP access
local   all all                trust
hostssl all all 0.0.0.0/0      scram-sha-256
hostssl all all ::/0           scram-sha-256
hostnossl all all 0.0.0.0/0    reject
hostnossl all all ::/0         reject
`;

/** Installs key/cert for the postgres user (the key must be 0600 and owned by it). */
const ENTRYPOINT = [
  'set -eu',
  'install -d -o postgres -g postgres -m 700 /var/lib/postgresql/tls',
  'install -o postgres -g postgres -m 600 /tls-src/server.key /var/lib/postgresql/tls/server.key',
  'install -o postgres -g postgres -m 644 /tls-src/server.pem /var/lib/postgresql/tls/server.pem',
  'install -o postgres -g postgres -m 644 /tls-src/pg_hba.conf /var/lib/postgresql/tls/pg_hba.conf',
  'exec docker-entrypoint.sh postgres -c ssl=on' +
    ' -c ssl_cert_file=/var/lib/postgresql/tls/server.pem' +
    ' -c ssl_key_file=/var/lib/postgresql/tls/server.key' +
    ' -c ssl_min_protocol_version=TLSv1.2' +
    ' -c hba_file=/var/lib/postgresql/tls/pg_hba.conf',
].join('\n');

export async function startTlsPostgres(
  pki: TestPki,
  options: { image?: string } = {},
): Promise<StartedEndpoint<PostgresEndpoint>> {
  const { GenericContainer, Wait } = await import('testcontainers');
  const password = `pw_${randomBytes(8).toString('hex')}`;
  const container = await new GenericContainer(options.image ?? DEFAULT_POSTGRES_IMAGE)
    .withName(`starter-test-postgres-tls-${randomBytes(4).toString('hex')}`)
    .withLabels({
      'starter.project': 'aws-modernization-starter',
      'starter.purpose': 'integration-test',
    })
    .withEnvironment({
      POSTGRES_PASSWORD: password,
      POSTGRES_USER: 'postgres',
      POSTGRES_DB: 'postgres',
      POSTGRES_INITDB_ARGS: '--auth-host=scram-sha-256',
    })
    .withCopyContentToContainer([
      { content: pki.server.key.pem, target: '/tls-src/server.key', mode: 0o600 },
      { content: pki.server.cert.pem, target: '/tls-src/server.pem', mode: 0o644 },
      { content: HBA, target: '/tls-src/pg_hba.conf', mode: 0o644 },
    ])
    .withEntrypoint(['/bin/sh', '-c', ENTRYPOINT])
    .withExposedPorts(5432)
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(120_000)
    .start();
  return {
    endpoint: {
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: 'postgres',
      password,
      database: 'postgres',
    },
    source: 'container',
    stop: async () => {
      await container.stop();
    },
  };
}
