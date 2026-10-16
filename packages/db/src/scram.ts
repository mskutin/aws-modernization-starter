/**
 * SCRAM-SHA-256 password verifiers (RFC 5802 / RFC 7677), computed client-side exactly as libpq's
 * `PQencryptPasswordConn` and psql's `\password` do. `ALTER ROLE … PASSWORD '<verifier>'` stores
 * the verifier as is, so the cleartext password never reaches the server: not in the statement
 * text, `pg_stat_activity`, `log_statement`, pgaudit or `pg_stat_statements`.
 *
 * SASLprep is not implemented, so passwords are restricted to printable ASCII without spaces
 * (for those, SASLprep is the identity and client and server agree).
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

export const SCRAM_ITERATIONS = 4096;
const SALT_BYTES = 16;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

export class PasswordPolicyError extends Error {
  override readonly name = 'PasswordPolicyError';
}

/** Throws (without echoing the value) unless the password is usable for a SCRAM verifier. */
export function assertScramCompatiblePassword(password: string, label: string): void {
  if (password.length < 16) {
    throw new PasswordPolicyError(`${label} must be at least 16 characters`);
  }
  if (password.length > 1024) {
    throw new PasswordPolicyError(`${label} must be at most 1024 characters`);
  }
  if (!PRINTABLE_ASCII.test(password)) {
    throw new PasswordPolicyError(`${label} must be printable ASCII without spaces`);
  }
}

/** The RFC 5802 keys PostgreSQL stores for a password (no policy check; see below). */
export function scramSha256Keys(
  password: string,
  salt: Buffer,
  iterations: number,
): { storedKey: Buffer; serverKey: Buffer } {
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  return {
    storedKey: createHash('sha256').update(clientKey).digest(),
    serverKey: createHmac('sha256', salted).update('Server Key').digest(),
  };
}

/** `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>` for a policy-compliant password. */
export function scramSha256Verifier(
  password: string,
  options: { salt?: Buffer; iterations?: number } = {},
): string {
  assertScramCompatiblePassword(password, 'password');
  const salt = options.salt ?? randomBytes(SALT_BYTES);
  const iterations = options.iterations ?? SCRAM_ITERATIONS;
  const { storedKey, serverKey } = scramSha256Keys(password, salt, iterations);
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** A random password that satisfies {@link assertScramCompatiblePassword} (local/CI/test use). */
export function generatePassword(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}
