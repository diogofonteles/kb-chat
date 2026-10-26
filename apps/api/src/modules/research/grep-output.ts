import type { CatalogEntry } from '../catalog/index.js';
import { originFolder } from './doc-filter.js';
import type { DocMatch, Occurrence } from './text-finder.js';
import { oneLine, quote } from './tool-output.js';

/** Lines of a files page that also show a passage (the rest stay one compact line). */
export const PASSAGES_PER_PAGE = 3;
const PASSAGE_CHARS = 300;
const TITLE_CHARS = 140;

/** A page of a list: its first item (0-based), how many it holds and the total. */
export interface Page {
  readonly offset: number;
  readonly size: number;
  readonly total: number;
}

export const phraseList = (phrases: readonly string[]): string =>
  phrases.map(quote).join(' ou ');

/** "Mostrando 21–30 de 45." (1-based, inclusive). */
export function pageRange({ offset, size, total }: Page): string {
  if (size === 0)
    return `Nada a mostrar: offset=${offset} passa do total (${total}).`;
  return `Mostrando ${offset + 1}–${offset + size} de ${total}.`;
}

/** The last line of a page: how to get the next one, or that the list ended. */
export function pageFooter({ offset, size, total }: Page): string {
  const next = offset + size;
  return next < total && size > 0
    ? `Próxima página: offset=${next}.`
    : 'Fim da lista.';
}

const occurrencesPart = (match: DocMatch): string => {
  const counts =
    match.phrases.length > 1
      ? ` (${match.phrases.map(({ phrase, count }) => `${quote(phrase)} ${count}`).join(', ')})`
      : '';
  return `${match.occurrences} ocorrência(s)${counts}`;
};

const titlePart = (n: number, entry: CatalogEntry): string =>
  `[${n}] ${oneLine(entry.title, TITLE_CHARS)}`;

/** One files-mode line: [n], title, occurrences, origin; a passage when one is given. */
export function fileLine(
  n: number,
  match: DocMatch,
  passage: string | null,
): string {
  const parts = [titlePart(n, match.entry)];
  if (match.occurrences > 0) parts.push(occurrencesPart(match));
  parts.push(`origem: ${oneLine(originFolder(match.entry), 120)}`);
  const line = parts.join(' · ');
  return passage
    ? `${line} — Trecho: ${oneLine(passage, PASSAGE_CHARS)}`
    : line;
}

/** One files-mode line of a phrase-less listing: the kb summary instead of a passage. */
export function listedLine(
  n: number,
  match: DocMatch,
  withSummary: boolean,
): string {
  const line = fileLine(n, match, null);
  const summary = match.entry.summary;
  return withSummary && summary
    ? `${line} — Resumo: ${oneLine(summary, PASSAGE_CHARS)}`
    : line;
}

export const countLine = (n: number, match: DocMatch): string =>
  `${titlePart(n, match.entry)} · ${match.occurrences}`;

/** "[3] Título: ocorrências 21–25 de 25", the head of a document's occurrences on a page. */
export function groupLine(
  n: number,
  entry: CatalogEntry,
  span: { readonly from: number; readonly to: number; readonly of: number },
): string {
  const range =
    span.from === span.to
      ? `ocorrência ${span.from}`
      : `ocorrências ${span.from}–${span.to}`;
  return `${titlePart(n, entry)}: ${range} de ${span.of}`;
}

/** One occurrence: its body offset (for read_document) and the text around it. */
export function occurrenceLine(
  occurrence: Occurrence,
  severalPhrases: boolean,
): string {
  const where =
    occurrence.offset === null ? '(resumo)' : `@${occurrence.offset}`;
  const which = severalPhrases ? ` ${quote(occurrence.phrase)}` : '';
  return `- ${where}${which}: ${occurrence.context}`;
}
