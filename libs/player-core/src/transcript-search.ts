/**
 * "Buscar na transcrição" (KBC-038 FR-8): occurrences found without regard to accents or
 * case ("salomao" finds "Salomão"), with their places in the original text to highlight.
 */

/** The text as search compares it, and where each of its characters came from. */
export interface FoldedText {
  readonly folded: string;
  /** `offsets[i]`: index in the original text of folded character `i`; one more at the end. */
  readonly offsets: readonly number[];
}

/** ASCII needs no decomposition: the common case stays cheap on 20 000 words. */
const foldChar = (char: string): string =>
  char < '\u0080'
    ? char.toLowerCase()
    : char
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .toLocaleLowerCase('pt-BR');

export function foldForSearch(text: string): FoldedText {
  let folded = '';
  const offsets: number[] = [];
  let index = 0;
  for (const char of text) {
    const part = foldChar(char);
    offsets.push(...Array.from({ length: part.length }, () => index));
    folded += part;
    index += char.length;
  }
  offsets.push(text.length);
  return { folded, offsets };
}

/** One occurrence: the segment and the characters `start..end` of its text. */
export interface SearchHit {
  readonly segment: number;
  readonly start: number;
  readonly end: number;
}

/** Every segment's text folded once, so each keystroke only scans (KBC-038 NFR-2). */
export function prepareSearch(texts: readonly string[]): FoldedText[] {
  return texts.map(foldForSearch);
}

function hitsIn(
  prepared: FoldedText,
  query: string,
  segment: number,
): SearchHit[] {
  const { folded, offsets } = prepared;
  const hits: SearchHit[] = [];
  for (
    let at = folded.indexOf(query);
    at !== -1;
    at = folded.indexOf(query, at + query.length)
  )
    hits.push({
      segment,
      start: offsets[at] ?? 0,
      end: offsets[at + query.length] ?? offsets[offsets.length - 1] ?? 0,
    });
  return hits;
}

/** Every occurrence of `query` in texts prepared by `prepareSearch`, in reading order. */
export function searchPrepared(
  prepared: readonly FoldedText[],
  query: string,
): SearchHit[] {
  const wanted = foldForSearch(query.trim().replace(/\s+/g, ' ')).folded;
  if (!wanted) return [];
  return prepared.flatMap((one, segment) => hitsIn(one, wanted, segment));
}

/** Every occurrence of `query` in the segments' texts, in reading order. */
export const searchSegments = (
  texts: readonly string[],
  query: string,
): SearchHit[] => searchPrepared(prepareSearch(texts), query);
