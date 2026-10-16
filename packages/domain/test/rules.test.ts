import { describe, expect, it } from 'vitest';
import {
  JobValidationError,
  RULE_LIMITS,
  evaluateBusinessRules,
  summarizeViolations,
} from '../src/index.js';
import { WorkflowError } from '@starter/workflow-processing';

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('evaluateBusinessRules', () => {
  it('accepts a normal document and reports facts', () => {
    const result = evaluateBusinessRules({ title: 'Quarterly report', content: words(12) });
    expect(result).toMatchObject({ ok: true, facts: { wordCount: 12 } });
  });

  it('allows tabs, newlines and carriage returns', () => {
    const content = `${words(6)}\r\n\t${words(6)}\n`;
    expect(evaluateBusinessRules({ title: 'T', content }).ok).toBe(true);
  });

  it('rejects documents below the minimum word count', () => {
    const result = evaluateBusinessRules({ title: 'Too short', content: 'only three words' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((v) => v.rule)).toEqual(['min-word-count']);
      expect(result.violations[0]?.message).toBe('content has 3 word(s); at least 10 are required');
    }
  });

  it('accepts exactly the minimum word count (boundary)', () => {
    expect(evaluateBusinessRules({ title: 'T', content: words(RULE_LIMITS.minWords) }).ok).toBe(
      true,
    );
    expect(evaluateBusinessRules({ title: 'T', content: words(RULE_LIMITS.minWords - 1) }).ok).toBe(
      false,
    );
  });

  it('rejects forbidden control characters without echoing content', () => {
    const content = `${words(12)} secret\u0007value\u0000`;
    const result = evaluateBusinessRules({ title: 'T', content });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const violation = result.violations.find((v) => v.rule === 'forbidden-control-characters');
      expect(violation?.message).toMatch(/2 forbidden control character\(s\); first is U\+0007/);
      expect(violation?.message).not.toContain('secret');
    }
  });

  it.each(['\u007F', '\u0085', '\u000B', '\u001B'])('rejects control character %j', (ch) => {
    expect(evaluateBusinessRules({ title: 'T', content: `${words(12)}${ch}` }).ok).toBe(false);
  });

  it('rejects content above the UTF-8 byte limit even when the character count is small', () => {
    // 4-byte emoji: 8,193 characters (well under the schema's 40,000) = 32,772+ bytes.
    const content = `${words(12)} ${'😀'.repeat(8_193)}`;
    const result = evaluateBusinessRules({ title: 'Emoji', content });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.map((v) => v.rule)).toContain('max-content-bytes');
  });

  it('accepts content exactly at the byte limit', () => {
    const prefix = `${words(12)} `;
    const content = prefix + 'a'.repeat(RULE_LIMITS.maxContentBytes - prefix.length);
    expect(Buffer.byteLength(content)).toBe(RULE_LIMITS.maxContentBytes);
    expect(evaluateBusinessRules({ title: 'T', content }).ok).toBe(true);
  });

  it('rejects malformed Unicode (lone surrogates)', () => {
    const result = evaluateBusinessRules({ title: 'T', content: `${words(12)} \uD800 end` });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.map((v) => v.rule)).toContain('malformed-unicode');
  });

  it('rejects titles without any letter or digit', () => {
    const result = evaluateBusinessRules({ title: '***', content: words(12) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.rule).toBe('title-needs-alphanumeric');
  });

  it('reports every violated rule at once', () => {
    const result = evaluateBusinessRules({ title: '--', content: 'a\u0001b' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((v) => v.rule).sort()).toEqual([
        'forbidden-control-characters',
        'min-word-count',
        'title-needs-alphanumeric',
      ]);
      const error = new JobValidationError(
        summarizeViolations(result.violations),
        result.violations,
      );
      expect(error.name).toBe(WorkflowError.Validation);
      expect(error.message).toMatch(/^Document rejected: /);
      expect(error.violations).toHaveLength(3);
    }
  });
});
