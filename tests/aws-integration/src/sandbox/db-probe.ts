/**
 * In-VPC database probes (test.sh): a one-off ECS task of the API task definition (task role,
 * DB_* environment, image and network of the API) with a COMMAND OVERRIDE only — no image change.
 * The image's entrypoint is node, so the override is `--input-type=module -e <PROBE_SCRIPT>`; the
 * script imports `@starter/db` and `pg` from the image's own /app/node_modules.
 *
 * The probe prints one JSON line per case to stdout (→ the API log group via awslogs) and never a
 * credential: IAM tokens are generated in-process by @starter/db's password provider and pg errors do
 * not echo them. The script reports raw outcomes; `evaluateProbe` decides pass/fail from the
 * expectations below, so a probe that claims success cannot pass itself.
 *
 * Cases (DB_AUTH=iam, DB_USER=starter_app, DB_SSL=verify-full with the image's RDS CA bundle):
 *   tls-verify-full    connect as configured; must succeed with TLS as starter_app
 *   tls-wrong-ca       Node's default trust store instead of the RDS bundle; must fail TLS verification
 *   tls-wrong-hostname the RDS CA, but the server's IP as host; must fail the host-name check
 *   tls-disabled       no TLS; must be refused by the server (rds.force_ssl / IAM needs TLS)
 *   iam-other-role     an IAM token for starter_migrator from the API task role; must fail authentication
 *   allow:*            positive controls of starter_app's grants (SELECT on jobs)
 *   deny:*             privileged statements; each must fail with SQLSTATE 42501, inside BEGIN/ROLLBACK
 */

export const PROBE_MARKER = 'starter-sbx-db-probe';

/** Privileged statements starter_app must not be able to run (cf. apps/api/test/integration/permissions.test.ts). */
export const DENY_STATEMENTS: readonly [string, string][] = [
  ['UPDATE jobs', `UPDATE jobs SET title = title WHERE false`],
  ['DELETE FROM jobs', 'DELETE FROM jobs WHERE false'],
  ['TRUNCATE jobs', 'TRUNCATE jobs'],
  ['read jobs.content', 'SELECT content FROM jobs LIMIT 1'],
  ['CREATE TABLE', 'CREATE TABLE sbx_probe_stolen (body text)'],
  ['ALTER TABLE jobs', 'ALTER TABLE jobs ADD COLUMN sbx_backdoor text'],
  ['DROP TABLE jobs', 'DROP TABLE jobs'],
  ['CREATE INDEX', 'CREATE INDEX sbx_probe_idx ON jobs (title)'],
  ['CREATE FUNCTION', 'CREATE FUNCTION sbx_probe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$'],
  ['CREATE SCHEMA', 'CREATE SCHEMA sbx_probe'],
  ['CREATE TEMP TABLE', 'CREATE TEMP TABLE sbx_probe_scratch (i int)'],
  ['CREATE ROLE', 'CREATE ROLE sbx_probe_role LOGIN'],
  ['ALTER ROLE SUPERUSER', 'ALTER ROLE starter_app SUPERUSER'],
  ['ALTER ROLE CREATEROLE', 'ALTER ROLE starter_app CREATEROLE'],
  ['GRANT starter_owner', 'GRANT starter_owner TO starter_app'],
  ['SET ROLE starter_owner', 'SET ROLE starter_owner'],
  ['SET ROLE starter_migrator', 'SET ROLE starter_migrator'],
  ['read pg_authid', 'SELECT rolname FROM pg_authid LIMIT 1'],
  ['pg_read_file', `SELECT pg_read_file('/etc/hostname')`],
  ['COPY TO PROGRAM', `COPY (SELECT 1) TO PROGRAM 'true'`],
  ['CREATE EXTENSION', 'CREATE EXTENSION IF NOT EXISTS dblink'],
];

/** Statements that cannot run inside a transaction block: run alone, must still be denied. */
export const DENY_OUTSIDE_TRANSACTION: readonly [string, string][] = [
  ['CREATE DATABASE', 'CREATE DATABASE sbx_probe_db'],
  ['ALTER SYSTEM', `ALTER SYSTEM SET log_statement = 'all'`],
];

export const ALLOW_STATEMENTS: readonly [string, string][] = [
  ['count jobs', 'SELECT count(*)::int AS n FROM jobs'],
  ['read job ids', 'SELECT id FROM jobs LIMIT 1'],
];

/**
 * The probe (ESM, runs as `node --input-type=module -e` inside the API image). Kept small: the
 * ECS overrides document is limited to 8 KiB.
 */
export function probeScript(): string {
  const deny = JSON.stringify(DENY_STATEMENTS);
  const denyOut = JSON.stringify(DENY_OUTSIDE_TRANSACTION);
  const allow = JSON.stringify(ALLOW_STATEMENTS);
  return `
import { loadDbConfig, pgClientConfig } from '@starter/db';
import pg from 'pg';
import { lookup } from 'node:dns/promises';
const M = ${JSON.stringify(PROBE_MARKER)};
const R = process.env.PROBE_RUN_ID ?? '';
const out = (o) => console.log(JSON.stringify({ probe: M, runId: R, ...o }));
const errOf = (e) => ({ code: typeof e?.code === 'string' ? e.code : null, msg: String(e?.message ?? e).slice(0, 160) });
const cfg = loadDbConfig(process.env);
const base = pgClientConfig(cfg, { applicationName: 'starter-sbx-probe', connectionTimeoutMillis: 8000 });
async function tryConnect(name, conf, fn) {
  const c = new pg.Client(conf);
  try {
    await c.connect();
    const extra = fn ? await fn(c) : {};
    out({ name, ok: true, ...extra });
  } catch (e) {
    out({ name, ok: false, ...errOf(e) });
  } finally {
    await c.end().catch(() => {});
  }
}
await tryConnect('tls-verify-full', base, async (c) => {
  const r = await c.query("SELECT current_user AS u, s.ssl, s.version FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid()");
  const row = r.rows[0] ?? {};
  return { user: row.u ?? null, ssl: row.ssl === true, tls: row.version ?? null };
});
await tryConnect('tls-wrong-ca', { ...base, ssl: { rejectUnauthorized: true, minVersion: 'TLSv1.2' } });
let ip = null;
try { ip = (await lookup(cfg.host)).address; } catch (e) { out({ name: 'tls-wrong-hostname', ok: false, code: 'DNS', msg: 'lookup failed' }); }
if (ip) await tryConnect('tls-wrong-hostname', { ...base, host: ip });
await tryConnect('tls-disabled', { ...base, ssl: false });
await tryConnect('iam-other-role', pgClientConfig({ ...cfg, user: 'starter_migrator' }, { applicationName: 'starter-sbx-probe', connectionTimeoutMillis: 8000 }));
const c = new pg.Client(base);
try {
  await c.connect();
  for (const [name, sql] of ${allow}) {
    try { await c.query(sql); out({ name: 'allow:' + name, ok: true }); } catch (e) { out({ name: 'allow:' + name, ok: false, ...errOf(e) }); }
  }
  for (const [name, sql] of ${deny}) {
    await c.query('BEGIN');
    try { await c.query(sql); out({ name: 'deny:' + name, ok: true }); } catch (e) { out({ name: 'deny:' + name, ok: false, ...errOf(e) }); }
    await c.query('ROLLBACK').catch(() => {});
  }
  for (const [name, sql] of ${denyOut}) {
    try { await c.query(sql); out({ name: 'deny:' + name, ok: true }); } catch (e) { out({ name: 'deny:' + name, ok: false, ...errOf(e) }); }
  }
} catch (e) {
  out({ name: 'privileges', ok: false, ...errOf(e) });
} finally {
  await c.end().catch(() => {});
}
out({ name: 'done', ok: true });
`;
}

/** Collapses indentation and blank lines (the overrides limit); keeps statements intact. */
export function compactScript(script: string): string {
  return script
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

export interface ProbeOverrides {
  containerOverrides: {
    name: string;
    command: string[];
    environment: { name: string; value: string }[];
  }[];
}

export const ECS_OVERRIDES_LIMIT = 8192;

export function probeOverrides(container: string, runId: string): ProbeOverrides {
  const overrides: ProbeOverrides = {
    containerOverrides: [
      {
        name: container,
        command: ['--input-type=module', '-e', compactScript(probeScript())],
        environment: [{ name: 'PROBE_RUN_ID', value: runId }],
      },
    ],
  };
  const size = JSON.stringify(overrides).length;
  if (size > ECS_OVERRIDES_LIMIT) {
    throw new Error(
      `probe overrides are ${size} bytes; ECS accepts at most ${ECS_OVERRIDES_LIMIT}`,
    );
  }
  return overrides;
}

export interface ProbeLine {
  name: string;
  ok: boolean;
  code?: string | null;
  msg?: string;
  user?: string | null;
  ssl?: boolean;
  tls?: string | null;
}

/** JSON probe lines of `runId` from log event messages (other lines ignored). */
export function probeLines(messages: readonly string[], runId: string): ProbeLine[] {
  const out: ProbeLine[] = [];
  for (const m of messages) {
    const start = m.indexOf('{');
    if (start < 0) continue;
    try {
      const o = JSON.parse(m.slice(start)) as Record<string, unknown>;
      if (
        o.probe === PROBE_MARKER &&
        o.runId === runId &&
        typeof o.name === 'string' &&
        typeof o.ok === 'boolean'
      ) {
        out.push(o as unknown as ProbeLine);
      }
    } catch {
      // not a probe line
    }
  }
  return out;
}

const TLS_VERIFY_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
]);

export interface ProbeVerdict {
  name: string;
  ok: boolean;
  detail: string;
}

/** Decides every expected case; a missing case is a failure (the probe did not prove it). */
export function evaluateProbe(lines: readonly ProbeLine[]): ProbeVerdict[] {
  const by = new Map(lines.map((l) => [l.name, l]));
  const v: ProbeVerdict[] = [];
  const need = (name: string, title: string, decide: (l: ProbeLine) => [boolean, string]) => {
    const l = by.get(name);
    if (!l) {
      v.push({ name: title, ok: false, detail: 'no probe result (did not run)' });
      return;
    }
    const [ok, detail] = decide(l);
    v.push({ name: title, ok, detail });
  };
  need('tls-verify-full', 'db: starter_app connects with IAM auth and sslmode=verify-full', (l) => [
    l.ok && l.user === 'starter_app' && l.ssl === true,
    l.ok
      ? `user=${l.user ?? '?'} ssl=${String(l.ssl)} ${l.tls ?? ''}`
      : `failed: ${l.code ?? ''} ${l.msg ?? ''}`,
  ]);
  need(
    'tls-wrong-ca',
    'db: a trust store without the RDS CA is rejected (TLS verification)',
    (l) => [
      !l.ok && TLS_VERIFY_CODES.has(l.code ?? ''),
      l.ok ? 'CONNECTED without the RDS CA' : `refused: ${l.code ?? '?'}`,
    ],
  );
  need('tls-wrong-hostname', 'db: a host name that is not in the certificate is rejected', (l) => [
    !l.ok && l.code === 'ERR_TLS_CERT_ALTNAME_INVALID',
    l.ok ? 'CONNECTED to the IP address' : `refused: ${l.code ?? '?'}`,
  ]);
  need('tls-disabled', 'db: a connection without TLS is refused', (l) => [
    !l.ok && l.code !== null && l.code !== 'ECONNREFUSED' && l.code !== 'ETIMEDOUT',
    l.ok ? 'CONNECTED without TLS' : `refused: ${l.code ?? '?'}`,
  ]);
  need('iam-other-role', 'db: the API task role cannot log in as starter_migrator', (l) => [
    !l.ok && (l.code === '28000' || l.code === '28P01'),
    l.ok ? 'LOGGED IN as starter_migrator' : `refused: ${l.code ?? '?'}`,
  ]);
  for (const [name] of ALLOW_STATEMENTS) {
    need(`allow:${name}`, `db: starter_app may ${name} (positive control)`, (l) => [
      l.ok,
      l.ok ? 'allowed' : `failed: ${l.code ?? '?'}`,
    ]);
  }
  for (const [name] of [...DENY_STATEMENTS, ...DENY_OUTSIDE_TRANSACTION]) {
    // RDS for PostgreSQL disables COPY ... PROGRAM for every role: feature_not_supported (0A000)
    // is a denial too (observed on RDS).
    const codes = name === 'COPY TO PROGRAM' ? ['42501', '0A000'] : ['42501'];
    need(`deny:${name}`, `db: starter_app cannot ${name} (${codes.join(' or ')})`, (l) => [
      !l.ok && typeof l.code === 'string' && codes.includes(l.code),
      l.ok ? 'SUCCEEDED (privilege not denied)' : `denied: ${l.code ?? '?'}`,
    ]);
  }
  need('done', 'db: the probe ran to completion', (l) => [l.ok, 'completed']);
  return v;
}
