import type {
  Authorship,
  MediaAuthor,
  MediaHit,
  SearchFilters,
  TextRange,
} from '@kb-chat/contracts';
import {
  MATCH_CLOSE,
  MATCH_OPEN,
  type AuthorRule,
  type MediaSegmentMatch,
} from '../../ports/media-search.js';

/** The most words a question sends to the media index. */
export const MAX_TERMS = 12;

/**
 * Short function words of Portuguese: a question in plain language ("o que é a hoasca?")
 * would otherwise require all of them in one spoken segment.
 */
const STOPWORDS = new Set([
  'a',
  'ao',
  'aos',
  'as',
  'com',
  'como',
  'da',
  'das',
  'de',
  'do',
  'dos',
  'e',
  'é',
  'em',
  'na',
  'nas',
  'no',
  'nos',
  'o',
  'os',
  'ou',
  'para',
  'pelo',
  'pela',
  'por',
  'que',
  'se',
  'um',
  'uma',
  'sobre',
  'qual',
  'quais',
  'quem',
  'onde',
  'quando',
]);

/**
 * The words of a question, as the media index reads them: letters and digits only (no
 * FTS5 syntax gets through), lowercase, without repeats or function words — unless the
 * question is only function words.
 */
export function termsOf(question: string): string[] {
  const words = [
    ...new Set(question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
  ];
  const content = words.filter((word) => !STOPWORDS.has(word));
  return (content.length > 0 ? content : words).slice(0, MAX_TERMS);
}

/** Facets that media do not have (BR-2): any of them active hides the spoken passages. */
export const hasDocumentOnlyFilters = (filters: SearchFilters): boolean =>
  filters.concepts.length > 0 ||
  filters.genres.length > 0 ||
  filters.depths.length > 0 ||
  filters.relevances.length > 0;

/**
 * Who the passages must be by under the "Autoria" choice: none or both media groups mean
 * anyone; the main author's group or the others' narrow it; only the groups media never
 * have ("Síntese", "Não classificado") leave nothing (null).
 */
export function authorRuleOf(
  authorships: readonly Authorship[],
  mainOf: ReadonlyMap<string, string | null>,
): AuthorRule | null {
  if (authorships.length === 0) return { kind: 'any' };
  const main = authorships.includes('mestre-laercio');
  const others = authorships.includes('outros-autores');
  if (main && others) return { kind: 'any' };
  if (main) return { kind: 'main', mainOf };
  if (others) return { kind: 'others', mainOf };
  return null;
}

/** The text without markers, and where each marked match is in it. */
export function unmark(marked: string): {
  readonly text: string;
  readonly highlights: TextRange[];
} {
  const highlights: TextRange[] = [];
  let text = '';
  let start: number | null = null;
  for (const char of marked) {
    if (char === MATCH_OPEN) {
      start = text.length;
      continue;
    }
    if (char !== MATCH_CLOSE) {
      text += char;
      continue;
    }
    if (start !== null && text.length > start)
      highlights.push({ start, end: text.length });
    start = null;
  }
  return { text, highlights };
}

/** bm25 (negative, lower is better) to 0–1, as QMD scores the documents' lexical match. */
export const scoreOf = (bm25: number): number => {
  const magnitude = Math.abs(bm25);
  return magnitude / (1 + magnitude);
};

/** How a match names its author, and its group in the "Autoria" filter. */
export interface AuthorView {
  readonly mainOf: (topic: string) => string | null;
  readonly authorOf: (topic: string, slug: string) => MediaAuthor;
}

export function toMediaHit(
  match: MediaSegmentMatch,
  authors: AuthorView,
): MediaHit {
  const { text, highlights } = unmark(match.marked);
  const main = authors.mainOf(match.topic);
  return {
    mediaId: match.mediaId,
    topic: match.topic,
    title: match.title,
    authorship:
      match.author !== null && match.author === main
        ? 'mestre-laercio'
        : 'outros-autores',
    author:
      match.author === null
        ? null
        : authors.authorOf(match.topic, match.author),
    text,
    highlights,
    startMs: match.startMs,
    endMs: match.endMs,
    confidence: match.confidence,
    score: scoreOf(match.bm25),
  };
}
