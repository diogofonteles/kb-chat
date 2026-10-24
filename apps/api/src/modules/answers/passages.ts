import type { DocumentRef } from '@kb-chat/contracts';

/** Passages sent to the model (ADR 0004). */
export const MAX_PASSAGES = 8;
export const PASSAGE_CHARS = 2500;

const STOPWORDS = new Set([
  'que',
  'qual',
  'quais',
  'como',
  'para',
  'por',
  'com',
  'sem',
  'uma',
  'dos',
  'das',
  'nos',
  'nas',
  'sobre',
  'entre',
  'ser',
  'sao',
  'esta',
  'este',
  'essa',
  'esse',
  'isso',
  'onde',
  'quando',
  'porque',
  'mais',
  'muito',
]);

export interface Passage extends DocumentRef {
  readonly n: number;
  readonly text: string;
}

const fold = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function questionTerms(question: string): string[] {
  return [
    ...new Set(
      fold(question)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
    ),
  ];
}

const countTerms = (folded: string, terms: readonly string[]): number =>
  terms.reduce((sum, term) => sum + (folded.split(term).length - 1), 0);

/** Consecutive paragraphs starting at `start`, up to PASSAGE_CHARS. */
function windowFrom(paragraphs: readonly string[], start: number): string {
  let text = '';
  for (
    let i = start;
    i < paragraphs.length && text.length < PASSAGE_CHARS;
    i += 1
  ) {
    text += `${paragraphs[i]}\n\n`;
  }
  return text;
}

/**
 * The part of a body most likely to answer: the window of consecutive paragraphs
 * (≤ PASSAGE_CHARS) with the most occurrences of the question terms; the start of
 * the body when no term occurs (ADR 0004, revised 2026-10-24: the first occurrence is
 * often only the title, and the answer sits further down).
 */
export function extractPassage(body: string, terms: readonly string[]): string {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  let best = { start: 0, score: -1 };
  for (let start = 0; start < paragraphs.length; start += 1) {
    const score = countTerms(fold(windowFrom(paragraphs, start)), terms);
    if (score > best.score) best = { start, score };
  }
  return windowFrom(paragraphs, best.start)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PASSAGE_CHARS);
}
