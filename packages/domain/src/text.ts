/**
 * Deterministic, locale-independent text primitives. Regex based (not
 * `Intl.Segmenter`) so results do not depend on the runtime's ICU data.
 */

/** A word starts with a letter/digit and may contain marks, apostrophes and inner hyphens. */
const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu;
const HAS_WORD = /[\p{L}\p{N}]/u;
/** Sentence boundary: terminator run (+ closing quotes/brackets) followed by whitespace. */
const SENTENCE_BOUNDARY = /(?<=[.!?…。！？]['"’”)\]]*)\s+|\n[ \t]*\n/u;
const PARAGRAPH_BOUNDARY = /\n[ \t]*\n/;

export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').normalize('NFC');
}

export function tokenizeWords(text: string): string[] {
  return normalizeText(text).match(WORD) ?? [];
}

export function countWords(text: string): number {
  return tokenizeWords(text).length;
}

export function splitSentences(text: string): string[] {
  return normalizeText(text)
    .split(SENTENCE_BOUNDARY)
    .filter((segment) => HAS_WORD.test(segment));
}

export function splitParagraphs(text: string): string[] {
  return normalizeText(text)
    .split(PARAGRAPH_BOUNDARY)
    .filter((segment) => HAS_WORD.test(segment));
}

export function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}
