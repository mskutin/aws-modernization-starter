/**
 * Deterministic document analysis performed by the ProcessJob step. Same input
 * and options always yield the same result (no clocks, randomness or locale).
 */
import { createHash } from 'node:crypto';
import type { JobOptions, JobResult, TermFrequency } from '@starter/contracts';
import { ENGLISH_STOP_WORDS } from './stopwords.js';
import {
  codePointLength,
  normalizeText,
  splitParagraphs,
  splitSentences,
  tokenizeWords,
} from './text.js';

export const ANALYSIS_ALGORITHM_VERSION = '1.0.0';
export const WORDS_PER_MINUTE = 200;
const MIN_TERM_LENGTH = 3;

const round = (value: number, digits: number) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function toTerm(word: string): string | null {
  const term = word.toLowerCase().replace(/’/g, "'").replace(/'s$/, '');
  if (ENGLISH_STOP_WORDS.has(term)) return null;
  if (codePointLength(term) < MIN_TERM_LENGTH) return null;
  if (/^[\p{N}'-]+$/u.test(term)) return null;
  return term;
}

export function topTerms(words: readonly string[], limit: number): TermFrequency[] {
  const counts = new Map<string, number>();
  for (const word of words) {
    const term = toTerm(word);
    if (term) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([termA, countA], [termB, countB]) =>
      countB !== countA ? countB - countA : termA < termB ? -1 : termA > termB ? 1 : 0,
    )
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

export function analyzeDocument(content: string, options: JobOptions): JobResult {
  const normalized = normalizeText(content);
  const words = tokenizeWords(normalized);
  const wordCount = words.length;
  const uniqueWordCount = new Set(words.map((w) => w.toLowerCase())).size;
  const sentenceCount = splitSentences(normalized).length;
  const letters = words.reduce((sum, word) => sum + codePointLength(word), 0);

  return {
    algorithmVersion: ANALYSIS_ALGORITHM_VERSION,
    wordCount,
    uniqueWordCount,
    sentenceCount,
    paragraphCount: splitParagraphs(normalized).length,
    characterCount: codePointLength(normalized),
    averageWordLength: wordCount === 0 ? 0 : round(letters / wordCount, 2),
    averageSentenceLength: sentenceCount === 0 ? 0 : round(wordCount / sentenceCount, 2),
    lexicalDiversity: wordCount === 0 ? 0 : round(uniqueWordCount / wordCount, 4),
    readingTimeSeconds: Math.ceil((wordCount / WORDS_PER_MINUTE) * 60),
    topTerms: topTerms(words, options.topTerms),
    checksumSha256: sha256Hex(content),
  };
}
