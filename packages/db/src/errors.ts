/**
 * PostgreSQL error helpers: SQLSTATE access, permission/authentication predicates, identifier and
 * literal quoting, and the transient/permanent classifier the workflow uses to decide retries.
 */
import { DatabaseCredentialError } from './credentials.js';
import { DatabaseTlsError } from './tls.js';

/** SQLSTATE codes this workload reacts to (https://www.postgresql.org/docs/17/errcodes-appendix.html). */
export const SQLSTATE = {
  insufficientPrivilege: '42501',
  invalidPassword: '28P01',
  invalidAuthorizationSpecification: '28000',
  uniqueViolation: '23505',
  checkViolation: '23514',
  undefinedTable: '42P01',
  undefinedFunction: '42883',
  undefinedObject: '42704',
  lockNotAvailable: '55P03',
  tooManyConnections: '53300',
  adminShutdown: '57P01',
  crashShutdown: '57P02',
  cannotConnectNow: '57P03',
  queryCanceled: '57014',
} as const;

/** SQLSTATE of a `pg` DatabaseError (undefined for network/TLS/client errors). */
export function sqlState(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

export function isPermissionDenied(error: unknown): boolean {
  return sqlState(error) === SQLSTATE.insufficientPrivilege;
}

export function isAuthenticationFailure(error: unknown): boolean {
  const code = sqlState(error);
  return code === SQLSTATE.invalidPassword || code === SQLSTATE.invalidAuthorizationSpecification;
}

export type DbErrorClass = 'transient' | 'permanent';

/**
 * SQLSTATEs worth a retry: connection exceptions (class 08), too many connections (53300, also
 * a role's CONNECTION LIMIT) and the server going away or not yet accepting connections during a
 * restart or Multi-AZ failover (57P01 admin_shutdown, 57P02 crash_shutdown, 57P03
 * cannot_connect_now).
 */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
  SQLSTATE.tooManyConnections,
  SQLSTATE.adminShutdown,
  SQLSTATE.crashShutdown,
  SQLSTATE.cannotConnectNow,
]);

/** Socket-level failures (Node error codes) that a later attempt can survive. */
const TRANSIENT_NODE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

/** `pg` / `pg-pool` messages for connect and read timeouts and dropped connections. */
const TRANSIENT_MESSAGES: readonly RegExp[] = [
  /^Connection terminated unexpectedly$/,
  /^Connection terminated due to connection timeout$/,
  /^timeout exceeded when trying to connect$/,
  /^Query read timeout$/,
  /^timeout expired$/,
  /^Client has encountered a connection error and is not queryable$/,
];

/**
 * Transient = retrying later can succeed: SQLSTATE class 08, 53300, 57P01/57P02/57P03, socket
 * errors, `pg` connect/read timeouts and credential-service hiccups (IAM signing, Secrets
 * Manager). Everything else is permanent: SQL, permission (42501), authentication (28xxx), TLS
 * verification and configuration errors.
 */
export function classifyDbError(error: unknown): DbErrorClass {
  if (error instanceof DatabaseTlsError) return 'permanent';
  if (error instanceof DatabaseCredentialError) return error.transient ? 'transient' : 'permanent';
  const code = sqlState(error);
  if (code !== undefined) {
    return code.startsWith('08') || TRANSIENT_SQLSTATES.has(code) ? 'transient' : 'permanent';
  }
  if (error && typeof error === 'object') {
    const nodeCode = (error as { code?: unknown }).code;
    if (typeof nodeCode === 'string' && TRANSIENT_NODE_CODES.has(nodeCode)) return 'transient';
    const message = (error as { message?: unknown }).message;
    if (
      typeof message === 'string' &&
      TRANSIENT_MESSAGES.some((pattern) => pattern.test(message))
    ) {
      return 'transient';
    }
  }
  return 'permanent';
}

export function isTransientDbError(error: unknown): boolean {
  return classifyDbError(error) === 'transient';
}

/** Quotes an SQL identifier (for names that cannot be bind parameters, e.g. roles, databases). */
export function quoteIdent(name: string): string {
  if (name.length === 0 || name.includes('\u0000')) throw new Error('invalid SQL identifier');
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quotes an SQL string literal like PostgreSQL's `quote_literal` (E'' form when backslashes occur). */
export function quoteLiteral(value: string): string {
  if (value.includes('\u0000')) throw new Error('invalid SQL literal');
  const quoted = value.replace(/'/g, "''");
  return value.includes('\\') ? `E'${quoted.replace(/\\/g, '\\\\')}'` : `'${quoted}'`;
}
