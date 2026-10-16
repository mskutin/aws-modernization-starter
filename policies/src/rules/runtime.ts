/**
 * Deployed-runtime settings shared by BASE-ECS-008/009 (task definitions) and BASE-LMB-007/008
 * (Lambda functions); see ADR 0511.
 *
 * Every local/CI relaxation keys on `APP_RUNTIME` (`aws` default | `ci` | `local`), which CDK never
 * sets. A synthesized task definition or function must therefore carry none of them:
 *
 * - "relaxations" (ECS-008, LMB-007): `APP_RUNTIME` ≠ `aws`, `AUTH_ALLOW_INSECURE_ISSUER`, an
 *   `http:` `AUTH_ISSUER`/`AUTH_JWKS_URI`, `DB_SSL` ≠ `verify-full` (or a `DB_HOST` without an
 *   explicit `DB_SSL`), `DB_PASSWORD` anywhere (environment or ECS secrets). No exemptions.
 *   ECS-008 also requires the client allow-list of token-verifying containers (`clientAllowList…`).
 * - "IAM database authentication" (ECS-009, LMB-008): `DB_AUTH` ≠ `iam` (or a `DB_HOST` without an
 *   explicit `DB_AUTH`), a `DB_*SECRET*` variable (e.g. `DB_SECRET_ARN`), or a `DB_*` value
 *   injected from Secrets Manager. The one-off database bootstrap task (break-glass, master
 *   secret) is the only workload exempted, by a governed exception on exactly its task definition.
 *
 * Keep in sync with `guard/rules/ecs.guard` and `guard/rules/lambda.guard` (parity tests).
 */
import type { Finding } from '../types.js';
import { asArray, finding, isRecord } from './util.js';

/** One environment entry: ECS `Environment[]`/`Secrets[]` item or a Lambda `Variables` key. */
export interface EnvEntry {
  name: string;
  value: unknown;
  /** Template path of the entry, relative to the resource. */
  path: string;
  /** `secret` = ECS `Secrets[]` (value is `ValueFrom`). */
  source: 'environment' | 'secret';
}

const HTTP_URL = /^http:/i;
export const AUTH_URL_VARIABLES = ['AUTH_ISSUER', 'AUTH_JWKS_URI'] as const;
export const DB_SECRET_VARIABLE = /^DB_.*SECRET/;

/** ECS container entries (`Environment[]` and `Secrets[]`). */
export function containerEntries(container: Record<string, unknown>, base: string): EnvEntry[] {
  const out: EnvEntry[] = [];
  asArray(container['Environment']).forEach((e, j) => {
    if (isRecord(e) && typeof e['Name'] === 'string') {
      out.push({
        name: e['Name'],
        value: e['Value'],
        path: `${base}/Environment/${j}`,
        source: 'environment',
      });
    }
  });
  asArray(container['Secrets']).forEach((e, j) => {
    if (isRecord(e) && typeof e['Name'] === 'string') {
      out.push({
        name: e['Name'],
        value: e['ValueFrom'],
        path: `${base}/Secrets/${j}`,
        source: 'secret',
      });
    }
  });
  return out;
}

/** Lambda `Environment.Variables` entries. */
export function functionEntries(variables: unknown): EnvEntry[] {
  if (!isRecord(variables)) return [];
  return Object.entries(variables).map(([name, value]) => ({
    name,
    value,
    path: `Properties/Environment/Variables/${name}`,
    source: 'environment' as const,
  }));
}

const has = (entries: readonly EnvEntry[], name: string) =>
  entries.some((e) => e.source === 'environment' && e.name === name);

/** Local/CI relaxations (BASE-ECS-008 / BASE-LMB-007). `what` names the resource in messages. */
export function relaxationFindings(entries: readonly EnvEntry[], what: string): Finding[] {
  const out: Finding[] = [];
  for (const e of entries) {
    if (e.name === 'DB_PASSWORD') {
      out.push(
        finding(
          `${e.path}/Name`,
          `${what} carries DB_PASSWORD (${e.source === 'secret' ? 'injected from a secret' : 'environment'}); deployed workloads use IAM database authentication.`,
        ),
      );
      continue;
    }
    if (e.source !== 'environment') continue;
    const valuePath = e.path.includes('/Variables/') ? e.path : `${e.path}/Value`;
    if (e.name === 'APP_RUNTIME' && e.value !== 'aws') {
      out.push(finding(valuePath, `${what} sets APP_RUNTIME to a value other than aws.`));
    } else if (e.name === 'AUTH_ALLOW_INSECURE_ISSUER') {
      out.push(
        finding(
          e.path.includes('/Variables/') ? e.path : `${e.path}/Name`,
          `${what} sets AUTH_ALLOW_INSECURE_ISSUER (local/CI only).`,
        ),
      );
    } else if (
      (AUTH_URL_VARIABLES as readonly string[]).includes(e.name) &&
      typeof e.value === 'string' &&
      HTTP_URL.test(e.value)
    ) {
      out.push(finding(valuePath, `${what} sets ${e.name} to an http: URL; https is required.`));
    } else if (e.name === 'DB_SSL' && e.value !== 'verify-full') {
      out.push(finding(valuePath, `${what} sets DB_SSL to a mode other than verify-full.`));
    }
  }
  const dbHost = entries.find((e) => e.source === 'environment' && e.name === 'DB_HOST');
  if (dbHost && !has(entries, 'DB_SSL')) {
    out.push(
      finding(
        dbHost.path.includes('/Variables/') ? dbHost.path : `${dbHost.path}/Name`,
        `${what} connects to PostgreSQL without an explicit DB_SSL=verify-full.`,
      ),
    );
  }
  return out;
}

/** Database credentials other than IAM authentication (BASE-ECS-009 / BASE-LMB-008). */
export function databaseAuthFindings(entries: readonly EnvEntry[], what: string): Finding[] {
  const out: Finding[] = [];
  for (const e of entries) {
    const namePath = e.path.includes('/Variables/') ? e.path : `${e.path}/Name`;
    if (e.source === 'secret') {
      if (e.name.startsWith('DB_')) {
        out.push(
          finding(namePath, `${what} injects ${e.name} from a secret; use DB_AUTH=iam instead.`),
        );
      }
      continue;
    }
    if (e.name === 'DB_AUTH' && e.value !== 'iam') {
      out.push(
        finding(
          e.path.includes('/Variables/') ? e.path : `${e.path}/Value`,
          `${what} sets DB_AUTH to a mode other than iam.`,
        ),
      );
    } else if (DB_SECRET_VARIABLE.test(e.name)) {
      out.push(finding(namePath, `${what} references a database secret (${e.name}).`));
    }
  }
  const dbHost = entries.find((e) => e.source === 'environment' && e.name === 'DB_HOST');
  if (dbHost && !has(entries, 'DB_AUTH')) {
    out.push(
      finding(
        dbHost.path.includes('/Variables/') ? dbHost.path : `${dbHost.path}/Name`,
        `${what} connects to PostgreSQL without an explicit DB_AUTH=iam.`,
      ),
    );
  }
  return out;
}

/** Variables that make a container a token-verifying API configuration (`@starter/config` auth). */
export const API_AUTH_VARIABLES = ['AUTH_ISSUER', 'AUTH_AUDIENCE'] as const;
export const CLIENT_ALLOW_LIST = 'AUTH_ALLOWED_CLIENT_IDS';

/**
 * Client allow-list of a token-verifying container (BASE-ECS-008). An empty
 * `AUTH_ALLOWED_CLIENT_IDS` accepts the tokens of every OAuth client of the issuer and is a
 * local/CI relaxation: with APP_RUNTIME=aws the API refuses to start without it. A container that
 * sets `AUTH_ISSUER` or `AUTH_AUDIENCE` needs the variable with at least one non-blank
 * comma-separated entry. A value CloudFormation resolves at deploy time (an intrinsic such as
 * `Ref`/`Fn::Join`, or ECS `Secrets[]` from SSM) cannot be evaluated here and is accepted.
 */
export function clientAllowListFindings(entries: readonly EnvEntry[], what: string): Finding[] {
  const auth = entries.find(
    (e) => e.source === 'environment' && (API_AUTH_VARIABLES as readonly string[]).includes(e.name),
  );
  if (!auth) return [];
  const list = entries.find((e) => e.name === CLIENT_ALLOW_LIST);
  if (!list) {
    return [
      finding(
        `${auth.path}/Name`,
        `${what} verifies tokens (${auth.name}) without ${CLIENT_ALLOW_LIST}; the API accepts every client of the issuer and refuses to start with APP_RUNTIME=aws.`,
      ),
    ];
  }
  if (list.source === 'secret') return [];
  const empty =
    list.value === undefined ||
    list.value === null ||
    (typeof list.value === 'string' && !list.value.split(',').some((id) => id.trim() !== ''));
  return empty
    ? [
        finding(
          `${list.path}/Value`,
          `${what} sets an empty ${CLIENT_ALLOW_LIST}; list the OAuth clients (the SPA client id) whose tokens the API accepts.`,
        ),
      ]
    : [];
}
