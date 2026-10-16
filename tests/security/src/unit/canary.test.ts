import { analyzeDocument, evaluateBusinessRules } from '@starter/domain';
import { describe, expect, it } from 'vitest';
import { canaryDocument, canaryValues } from '../canary.js';

describe('canary documents', () => {
  const doc = canaryDocument('run1234', 'unit');

  it('pass the business rules, so they are processed end to end', () => {
    expect(evaluateBusinessRules(doc).ok).toBe(true);
    expect(doc.title.length).toBeLessThanOrEqual(200);
  });

  it('can never be produced as derived data: no top term equals or contains a canary', () => {
    const result = analyzeDocument(doc.content, { topTerms: 50 });
    const terms = result.topTerms.map((t) => t.term);
    expect(terms.length).toBeGreaterThan(0);
    for (const canary of canaryValues(doc)) {
      expect(terms.some((term) => term.includes(canary) || canary === term)).toBe(false);
      expect(canary).toMatch(/[ ~]/); // tokenizer separators: never a single term
      expect(canary).toBe(canary.toLowerCase()); // case folding cannot hide a leak
    }
  });

  it('are embedded in the content (sentence, token) and unique per document', () => {
    expect(doc.content).toContain(doc.canaries.sentence);
    expect(doc.content).toContain(doc.canaries.token);
    const other = canaryDocument('run1234', 'unit');
    expect(canaryValues(other).some((c) => canaryValues(doc).includes(c))).toBe(false);
  });
});
