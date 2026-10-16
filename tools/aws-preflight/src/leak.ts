/**
 * Final leak scanner: the last check before sanitized output is written or printed. It does not
 * sanitize anything; it refuses (evidence) or suppresses (console lines). The rules are
 * deliberately blunt (any 12-digit number is treated as an AWS account ID), so the sanitizer must
 * mask such values first.
 */

export interface LeakRule {
  readonly id: string;
  readonly re: RegExp;
}

export const LEAK_RULES: readonly LeakRule[] = [
  { id: 'twelve-digit-number', re: /(?<!\d)\d{12}(?!\d)/ },
  { id: 'separated-account-id', re: /(?<!\d)\d{4}[- ]\d{4}[- ]\d{4}(?!\d)/ },
  { id: 'email-address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { id: 'url-encoded-email-address', re: /[A-Za-z0-9._%+-]+%40[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}\b/ },
  { id: 'secret-key-material-name', re: /secret[_-]?access[_-]?key|session[_-]?token/i },
  { id: 'pem-header', re: /-----BEGIN [A-Z0-9 ]*-----/ },
];

export interface LeakSecrets {
  /** The raw sandbox account ID (also covered by the 12-digit rule; checked explicitly). */
  readonly account?: string | undefined;
  /** The caller's SSO/role session name (usually the user's e-mail or user name). */
  readonly sessionName?: string | undefined;
}

export interface LeakFinding {
  readonly rule: string;
  /** JSON path (`$.probes[3].data.Vpcs[0]`) or `text`. Never contains the matched value. */
  readonly path: string;
}

/** Session names shorter than this are matched as whole identifiers only (not as substrings). */
export const MIN_SUBSTRING_SESSION = 6;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** IAM name characters: a session name is a whole identifier when not surrounded by these. */
const IDENT = 'A-Za-z0-9_+=,.@-';

/**
 * The matcher for a session name, shared by the sanitizer and the scanner: a case-insensitive
 * substring for names of 6+ characters; a whole identifier for shorter ones (so `dev` does not
 * hit `devops` or `Environment=dev`).
 */
export function sessionNameRegExp(session: string, flags = 'i'): RegExp {
  return session.length >= MIN_SUBSTRING_SESSION
    ? new RegExp(escapeRe(session), flags)
    : new RegExp(`(?<![${IDENT}])${escapeRe(session)}(?![${IDENT}])`, flags);
}

/**
 * Digests computed by the tool itself (git commit: 40 hex, SHA-256: 64 hex) are random hex, so about
 * one in ten contains a run of exactly 12 decimal digits. A whole-string digest is therefore exempt
 * from the two digit rules (and only from those).
 */
export const HEX_DIGEST_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGIT_RULES: ReadonlySet<string> = new Set(['twelve-digit-number', 'separated-account-id']);
/** Quoted whole-string digests in serialized JSON (text-level scan). */
const QUOTED_DIGEST_RE = /"(?:[0-9a-f]{40}|[0-9a-f]{64})"/g;

/** Rule ids that match `text` (empty when clean). */
export function leakRulesIn(text: string, secrets: LeakSecrets = {}): string[] {
  const hits: string[] = [];
  const digest = HEX_DIGEST_RE.test(text);
  for (const rule of LEAK_RULES) {
    if (digest && DIGIT_RULES.has(rule.id)) continue;
    if (rule.re.test(text)) hits.push(rule.id);
  }
  if (secrets.account && text.includes(secrets.account)) hits.push('sandbox-account-id');
  if (secrets.sessionName && sessionNameRegExp(secrets.sessionName).test(text)) {
    hits.push('session-name');
  }
  return hits;
}

/** Walks every key and value of a JSON-like value; reports rule + path, never the value. */
export function scanValue(value: unknown, secrets: LeakSecrets = {}): LeakFinding[] {
  const findings: LeakFinding[] = [];
  const visit = (v: unknown, path: string): void => {
    if (typeof v === 'string' || typeof v === 'number') {
      for (const rule of leakRulesIn(String(v), secrets)) findings.push({ rule, path });
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, `${path}[${i}]`));
    } else if (typeof v === 'object' && v !== null) {
      for (const [k, child] of Object.entries(v)) {
        for (const rule of leakRulesIn(k, secrets)) findings.push({ rule, path: `${path}{key}` });
        visit(child, `${path}.${k}`);
      }
    }
  };
  visit(value, '$');
  return findings;
}

/** Text-level backstop over the final serialized output (quoted whole digests neutralized). */
export function scanText(text: string, secrets: LeakSecrets = {}): LeakFinding[] {
  const scanned = text.replace(QUOTED_DIGEST_RE, '"<digest>"');
  return leakRulesIn(scanned, secrets).map((rule) => ({ rule, path: 'text' }));
}

/**
 * Phone numbers are refused in operator text only (not a global rule: quota values and limits are
 * legitimately 8+ digit numbers): 8-digit subscriber numbers (`9123 4567`, `61234567`) and any
 * `+<country code>` number.
 */
export const PHONE_NUMBER_RE =
  /(?<![\d.])(?:[2-9]\d{3}[- ]?\d{4}|\+\d{1,3}[- ]?\d[\d -]{6,}\d)(?![\d.])/;
