import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_ALGORITHM_VERSION,
  analyzeDocument,
  countWords,
  splitParagraphs,
  splitSentences,
  tokenizeWords,
  topTerms,
} from '../src/index.js';

const SAMPLE = [
  'Cloud migration is a journey. Every migration starts with discovery!',
  '',
  'Teams assess workloads, plan the migration waves, and modernize applications. Is the cloud cheaper? Often, cloud costs drop after optimisation.',
].join('\n');

describe('tokenisation', () => {
  it('keeps contractions, possessives and hyphenated words as single words', () => {
    expect(tokenizeWords("Don't stop state-of-the-art O’Neil's work")).toEqual([
      "Don't",
      'stop',
      'state-of-the-art',
      "O’Neil's",
      'work',
    ]);
  });

  it('handles non-Latin scripts and digits', () => {
    expect(countWords('Привет мир 2026 ελληνικά')).toBe(4);
  });

  it('returns zero for punctuation-only text', () => {
    expect(countWords('... --- !!!')).toBe(0);
  });

  it('splits sentences on terminators followed by whitespace and on blank lines', () => {
    expect(splitSentences(SAMPLE)).toHaveLength(5);
    expect(splitSentences('He said "Stop." Then left.')).toHaveLength(2);
    expect(splitSentences('Version 1.5 is out')).toHaveLength(1);
  });

  it('counts paragraphs separated by blank lines (CRLF tolerant)', () => {
    expect(splitParagraphs('one\r\n\r\ntwo\n  \nthree')).toHaveLength(3);
  });
});

describe('analyzeDocument', () => {
  const result = analyzeDocument(SAMPLE, { topTerms: 3 });

  it('computes deterministic statistics', () => {
    expect(result).toMatchObject({
      algorithmVersion: ANALYSIS_ALGORITHM_VERSION,
      wordCount: 30,
      sentenceCount: 5,
      paragraphCount: 2,
      readingTimeSeconds: 9,
    });
    expect(result.uniqueWordCount).toBeLessThan(result.wordCount);
    expect(result.lexicalDiversity).toBeCloseTo(result.uniqueWordCount / result.wordCount, 4);
    expect(result.averageSentenceLength).toBe(6);
  });

  it('ranks top terms by frequency then alphabetically, excluding stop words', () => {
    expect(result.topTerms).toEqual([
      { term: 'cloud', count: 3 },
      { term: 'migration', count: 3 },
      { term: 'applications', count: 1 },
    ]);
    expect(result.topTerms.map((t) => t.term)).not.toContain('the');
  });

  it('respects the topTerms limit', () => {
    expect(analyzeDocument(SAMPLE, { topTerms: 1 }).topTerms).toHaveLength(1);
  });

  it('checksums the content exactly as submitted', () => {
    expect(result.checksumSha256).toBe(createHash('sha256').update(SAMPLE, 'utf8').digest('hex'));
  });

  it('is deterministic across runs', () => {
    expect(analyzeDocument(SAMPLE, { topTerms: 3 })).toEqual(result);
  });

  it('copes with empty-of-words content without dividing by zero', () => {
    expect(analyzeDocument('!!!', { topTerms: 5 })).toMatchObject({
      wordCount: 0,
      averageWordLength: 0,
      averageSentenceLength: 0,
      lexicalDiversity: 0,
      readingTimeSeconds: 0,
      topTerms: [],
    });
  });

  it('ignores numbers, short tokens and possessive suffixes in top terms', () => {
    expect(topTerms(['AWS', "AWS's", '2026', 'is', 'go', 'Lambda', 'lambda'], 10)).toEqual([
      { term: 'aws', count: 2 },
      { term: 'lambda', count: 2 },
    ]);
  });
});
