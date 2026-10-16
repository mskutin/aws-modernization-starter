/**
 * Sanitizing for committed evidence: every 12-digit AWS account id (in ARNs, bucket names or
 * anywhere else in a string) becomes `********NNNN`; caller session / user names, e-mail
 * addresses and IPv4 addresses are redacted; output that looks like a credential, a private key or
 * a token is refused before it is written.
 */

/**
 * A 12-digit run, except the last group of a UUID (8-4-4-4-12 hex): KMS key ids and stack ids
 * are UUIDs whose last group can be all digits and must stay usable as identifiers.
 */
const NOT_UUID_TAIL = '(?<![0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-)';
const ACCOUNT_RE = new RegExp(`${NOT_UUID_TAIL}(?<!\\d)\\d{12}(?!\\d)`, 'g');
const ACCOUNT_TEST_RE = new RegExp(`${NOT_UUID_TAIL}(?<!\\d)\\d{12}(?!\\d)`);

export const maskAccountId = (id: string): string => `********${id.slice(-4)}`;

const IPV4_RE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;

/**
 * Caller principals in AWS error messages ("User: arn:aws:sts::…:assumed-role/<role>/<session>
 * is not authorized …"): the session name is usually the person's user name or e-mail address.
 * Same rule as the guard's maskPrincipalArn: keep the role, mask the session / user name.
 */
const ASSUMED_ROLE_RE =
  /(arn:aws[a-z-]*:sts::(?:\d{12}|\*{8}\d{4}):assumed-role\/[A-Za-z0-9+=,.@_-]{1,64})\/[^\s"',;)]+/g;
const IAM_USER_RE =
  /(arn:aws[a-z-]*:(?:iam|sts)::(?:\d{12}|\*{8}\d{4}):(?:user|federated-user))\/[^\s"',;)]+/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * Masks every 12-digit run, the session / user name of caller principals, e-mail addresses and
 * IPv4 addresses (e.g. an EIP's physical id).
 */
export const maskString = (s: string): string =>
  s
    .replace(ASSUMED_ROLE_RE, '$1/<session>')
    .replace(IAM_USER_RE, '$1/<user>')
    .replace(EMAIL_RE, '<email>')
    .replace(ACCOUNT_RE, (m) => maskAccountId(m))
    .replace(IPV4_RE, '<ipv4-redacted>');

/** Deep copy with every string masked (numbers, booleans and keys are left alone). */
export function maskDeep<T>(value: T): T {
  if (typeof value === 'string') return maskString(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => maskDeep(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskDeep(v)]),
    ) as T;
  }
  return value;
}

/** Patterns that must never reach a report: access keys, private keys, JWTs, JWK private parts. */
const LEAK_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['AWS access key id', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['JWK private component', /"(?:d|p|q|dp|dq|qi)"\s*:\s*"[A-Za-z0-9_-]{16,}"/],
  ['AWS secret access key assignment', /aws_secret_access_key|SecretAccessKey"\s*:\s*"[^"]{20,}"/i],
  ['session token assignment', /SessionToken"\s*:\s*"[^"]{20,}"/],
  ['e-mail address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ['caller session name', /:assumed-role\/[A-Za-z0-9+=,.@_-]{1,64}\/(?!<session>)[^\s"',;)]+/],
];

export class LeakError extends Error {
  override name = 'LeakError';
}

/**
 * Throws when the text contains something shaped like a secret, an unmasked account id, or one of
 * the given literals (the run's origin-verify value, the issuer private key component, the
 * operator's home directory). The text and the literals are never echoed.
 */
export function assertNoSecrets(
  text: string,
  what: string,
  literals: readonly { readonly label: string; readonly value: string }[] = [],
): void {
  for (const { label, value } of literals) {
    if (value.length >= 5 && text.includes(value)) {
      throw new LeakError(`refusing to write ${what}: it contains ${label}`);
    }
  }
  for (const [label, re] of LEAK_PATTERNS) {
    if (re.test(text)) {
      throw new LeakError(
        `refusing to write ${what}: it contains something shaped like a ${label}`,
      );
    }
  }
  if (ACCOUNT_TEST_RE.test(text)) {
    throw new LeakError(`refusing to write ${what}: it contains an unmasked 12-digit account id`);
  }
}
