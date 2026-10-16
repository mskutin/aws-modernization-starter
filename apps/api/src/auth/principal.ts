/**
 * The authenticated caller. Exactly one trusted issuer is configured, so the
 * job owner stored in PostgreSQL is the token's `sub`; logs only ever carry the pseudonymous
 * `id` (first 16 hex characters of sha256(iss + "|" + sub)), never claims or tokens.
 */
import { principalKey } from '@starter/domain';

export interface Principal {
  readonly issuer: string;
  /** `sub` claim: the owner key of jobs (`jobs.owner_id`). */
  readonly subject: string;
  readonly scopes: ReadonlySet<string>;
  /** sha256(iss|sub) hex: scope of the caller's idempotency keys. */
  readonly key: string;
  /** Pseudonymous log field `principal`. */
  readonly id: string;
}

export function createPrincipal(
  issuer: string,
  subject: string,
  scopes: Iterable<string>,
): Principal {
  const key = principalKey(issuer, subject);
  return { issuer, subject, scopes: new Set(scopes), key, id: key.slice(0, 16) };
}

/** Bounds the work done on hostile claims (a token is at most 8 KiB anyway). */
const MAX_SCOPES = 64;

/**
 * Granted scopes from `scope` (RFC 8693/9068: space-delimited string) and/or `scp` (string or
 * array, as issued by some IdPs). Anything else is ignored.
 */
export function scopesFromClaims(payload: Readonly<Record<string, unknown>>): Set<string> {
  const scopes = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string') {
      for (const scope of value.split(' ')) {
        if (scope && scopes.size < MAX_SCOPES) scopes.add(scope);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') add(item);
    }
  };
  add(payload.scope);
  add(payload.scp);
  return scopes;
}
