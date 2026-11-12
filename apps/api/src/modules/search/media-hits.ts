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
    // NFC first: a pasted "hóasca" with a combining accent is one word, not "ho" + "asca".
    ...new Set(
      question
        .normalize('NFC')
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [],
    ),
  ];
  const content = words.filter((word) => !STOPWORDS.has(word));
  return (content.length > 0 ? content : words).slice(0, MAX_TERMS);
}

/**
 * Facets that media never have (BR-2): any of them active hides the spoken passages. Concepts
 * are apart: for who sees subjects they reach the tracks (KBC-070).
 */
export const hasDocumentOnlyFilters = (filters: SearchFilters): boolean =>
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

/** The longest passage a result shows (KBC-096): a segment can run for minutes. */
export const EXCERPT_MAX = 240;
/** How much comes before the first word found. */
const EXCERPT_LEAD = 60;

/** The whole words in [start, end) that keep `first`, so a cut never splits one. */
function wordBounds(
  text: string,
  { start, end, first }: { start: number; end: number; first: number },
): readonly [number, number] {
  const space = start === 0 ? -1 : text.slice(start, first).indexOf(' ');
  const from = space < 0 ? start : start + space + 1;
  const to = end >= text.length ? text.length : text.lastIndexOf(' ', end);
  return [from, to > first ? to : end];
}

/** The passage around its first highlight, with "…" where it was cut. */
export function excerptOf(passage: {
  readonly text: string;
  readonly highlights: readonly TextRange[];
}): { readonly text: string; readonly highlights: TextRange[] } {
  const { text, highlights } = passage;
  if (text.length <= EXCERPT_MAX) return { text, highlights: [...highlights] };
  const first = highlights[0]?.start ?? 0;
  const latest = text.length - EXCERPT_MAX;
  const start = Math.min(Math.max(0, first - EXCERPT_LEAD), latest);
  const [from, to] = wordBounds(text, {
    start,
    end: start + EXCERPT_MAX,
    first,
  });
  const head = from > 0 ? '…' : '';
  const shift = head.length - from;
  return {
    text: `${head}${text.slice(from, to)}${to < text.length ? '…' : ''}`,
    highlights: highlights
      .filter((one) => one.start >= from && one.end <= to)
      .map((one) => ({ start: one.start + shift, end: one.end + shift })),
  };
}

/**
 * A passage's relevance, 0–1, from its own words: how many times the question's terms are
 * marked in it (h / (h + 1)). Not FTS5's bm25, whose statistics span the whole table and so
 * move with transcripts above the person's level (KBC-111): the order still comes from bm25,
 * the number shown and mixed with the documents tells nothing of what is hidden.
 */
export const passageScore = (marked: string): number => {
  const hits = unmark(marked).highlights.length;
  return hits / (hits + 1);
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
    score: passageScore(match.marked),
    match: 'speech',
    subjects: [],
  };
}
