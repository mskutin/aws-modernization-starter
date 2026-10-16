/**
 * Leak detection shared by the security suites and the artifact scanner (scanner/cli.ts):
 * well-known secret formats, explicit secret values and per-run canaries. Findings never carry
 * the matched value itself, only a redacted preview, so a report can be published safely.
 */

export interface SecretPattern {
  id: string;
  description: string;
  regex: RegExp;
}

/**
 * Formats that must never appear in logs, reports or responses. Deliberately narrow (low false
 * positive rate); gitleaks remains the broad scanner for the repository itself.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: 'jwt',
    description: 'JSON Web Token (bearer token)',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/g,
  },
  {
    id: 'bearer-header',
    description: 'Authorization header with a bearer credential',
    regex: /authorization["']?\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+/-]{16,}/gi,
  },
  {
    id: 'private-key',
    description: 'PEM private key',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |ENCRYPTED SIGSTORE )?PRIVATE KEY-----/g,
  },
  {
    id: 'aws-access-key-id',
    description: 'AWS access key id',
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    id: 'aws-secret-access-key',
    description: 'AWS secret access key assignment',
    regex: /aws_secret_access_key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}\b/gi,
  },
  {
    id: 'gitlab-token',
    description: 'GitLab personal/project/runner/deploy token',
    regex: /\b(?:glpat|glrt|gldt|glptt|glcbt|glimt)-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'postgres-url-credentials',
    description: 'PostgreSQL connection URL with a password',
    regex: /\bpostgres(?:ql)?:\/\/[^:\s/@]+:[^@\s]+@/gi,
  },
];

export interface LeakFinding {
  /** Pattern id, `secret:<label>` for an explicit value, or `canary:<label>`. */
  kind: string;
  /** 1-based line number within the scanned text. */
  line: number;
  /** Redacted preview: first characters of the match only. */
  preview: string;
}

export interface NamedValue {
  label: string;
  value: string;
}

const redact = (match: string): string =>
  match.length <= 8 ? '***' : `${match.slice(0, 6)}…(${match.length} chars)`;

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/** Every occurrence of `needle` (case-insensitive) in `text`. */
function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  const hay = text.toLowerCase();
  const n = needle.toLowerCase();
  for (let i = hay.indexOf(n); i !== -1; i = hay.indexOf(n, i + 1)) out.push(i);
  return out;
}

/**
 * Scans `text` for the secret formats, explicit secret values (e.g. the DB password the API was
 * given) and canaries. Explicit values shorter than 6 characters are ignored (too ambiguous).
 */
export function findLeaks(
  text: string,
  options: {
    secrets?: readonly NamedValue[];
    canaries?: readonly NamedValue[];
    patterns?: boolean;
  } = {},
): LeakFinding[] {
  const findings: LeakFinding[] = [];
  if (options.patterns ?? true) {
    for (const pattern of SECRET_PATTERNS) {
      for (const m of text.matchAll(pattern.regex)) {
        findings.push({ kind: pattern.id, line: lineOf(text, m.index), preview: redact(m[0]) });
      }
    }
  }
  for (const [prefix, values] of [
    ['secret', options.secrets ?? []],
    ['canary', options.canaries ?? []],
  ] as const) {
    for (const { label, value } of values) {
      if (value.length < 6) continue;
      for (const index of occurrences(text, value)) {
        findings.push({
          kind: `${prefix}:${label}`,
          line: lineOf(text, index),
          preview: redact(value),
        });
      }
    }
  }
  return findings;
}

/** `findLeaks` over a JSON-serializable value (e.g. a DynamoDB item or a captured input). */
export const findLeaksInValue = (
  value: unknown,
  options: Parameters<typeof findLeaks>[1] = {},
): LeakFinding[] => findLeaks(JSON.stringify(value) ?? '', options);
