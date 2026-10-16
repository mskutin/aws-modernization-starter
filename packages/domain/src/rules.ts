/**
 * Business validation rules applied by the ValidateJob step. These go beyond
 * the API schema (which only checks shape and coarse limits): a request can be
 * accepted by the API (202) and still be rejected here, which fails the
 * workflow with `JobValidationError`.
 *
 * Messages never echo document content (it may contain personal data).
 */
import { countWords } from './text.js';

export const BUSINESS_RULES_VERSION = '1.0.0';

export const RULE_LIMITS = {
  minWords: 10,
  /** UTF-8 bytes; tighter than the schema's character limit. */
  maxContentBytes: 32 * 1024,
} as const;

export type RuleId =
  | 'min-word-count'
  | 'max-content-bytes'
  | 'forbidden-control-characters'
  | 'malformed-unicode'
  | 'title-needs-alphanumeric';

export interface RuleViolation {
  rule: RuleId;
  message: string;
}

export interface DocumentFacts {
  wordCount: number;
  byteLength: number;
}

export type RuleEvaluation =
  | { ok: true; facts: DocumentFacts; rulesVersion: string }
  | { ok: false; facts: DocumentFacts; rulesVersion: string; violations: RuleViolation[] };

// C0 controls except TAB, LF, CR; plus DEL and C1 controls. Matching control
// characters is the purpose of this rule.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

const codePoint = (ch: string) =>
  `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;

export function evaluateBusinessRules(doc: { title: string; content: string }): RuleEvaluation {
  const violations: RuleViolation[] = [];
  const byteLength = Buffer.byteLength(doc.content, 'utf8');
  const wordCount = countWords(doc.content);

  if (LONE_SURROGATE.test(doc.content) || LONE_SURROGATE.test(doc.title)) {
    violations.push({
      rule: 'malformed-unicode',
      message: 'text contains unpaired UTF-16 surrogates (malformed Unicode)',
    });
  }

  const controls = [...doc.content.matchAll(FORBIDDEN_CONTROL)];
  if (controls.length > 0) {
    const first = controls[0]!;
    violations.push({
      rule: 'forbidden-control-characters',
      message: `content contains ${controls.length} forbidden control character(s); first is ${codePoint(first[0])} at index ${first.index}`,
    });
  }

  if (wordCount < RULE_LIMITS.minWords) {
    violations.push({
      rule: 'min-word-count',
      message: `content has ${wordCount} word(s); at least ${RULE_LIMITS.minWords} are required`,
    });
  }

  if (byteLength > RULE_LIMITS.maxContentBytes) {
    violations.push({
      rule: 'max-content-bytes',
      message: `content is ${byteLength} bytes (UTF-8); the limit is ${RULE_LIMITS.maxContentBytes}`,
    });
  }

  if (!ALPHANUMERIC.test(doc.title)) {
    violations.push({
      rule: 'title-needs-alphanumeric',
      message: 'title must contain at least one letter or digit',
    });
  }

  const facts = { wordCount, byteLength };
  return violations.length === 0
    ? { ok: true, facts, rulesVersion: BUSINESS_RULES_VERSION }
    : { ok: false, facts, rulesVersion: BUSINESS_RULES_VERSION, violations };
}

export function summarizeViolations(violations: readonly RuleViolation[]): string {
  return `Document rejected: ${violations.map((v) => v.message).join('; ')}`;
}
