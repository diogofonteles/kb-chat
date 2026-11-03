import type { CatalogEntry } from '../catalog/index.js';
import { originFolder } from './doc-filter.js';
import type { DocMatch, Occurrence } from './text-finder.js';
import {
  authorshipPart,
  oneLine,
  quote,
  type AuthorshipLabels,
} from './tool-output.js';

/**
 * Characters a page may take (NFR-3: every output stays under 60,000, below Claude Code's
 * MCP output limit): lines past it move to the next page, with an exact offset.
 */
export const PAGE_CHARS = 50_000;
/** How many of the lines fit in the page's character budget (at least one). */
export function fitting(lines: readonly string[], budget = PAGE_CHARS): number {
  let used = 0;
  let count = 0;
  for (const line of lines) {
    used += line.length + 1;
    if (used > budget && count > 0) break;
    count += 1;
  }
  return count;
}

/** Lines of a files page that also show a passage (the rest stay one compact line). */
export const PASSAGES_PER_PAGE = 10;
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
  // The three most frequent alternatives: a line stays short with eight of them.
  const counts =
    match.phrases.length > 1
      ? ` (${match.phrases
          .slice(0, 3)
          .map(({ phrase, count }) => `${quote(phrase)} ${count}`)
          .join(', ')}${match.phrases.length > 3 ? ', …' : ''})`
      : '';
  return `${match.occurrences} ocorrência(s)${counts}`;
};

const titlePart = (n: number, entry: CatalogEntry): string =>
  `[${n}] ${oneLine(entry.title, TITLE_CHARS)}`;

/** One files-mode line: [n], title, occurrences, origin; a passage when one is given. */
export function fileLine(
  n: number,
  match: DocMatch,
  {
    passage,
    labels,
  }: { readonly passage: string | null; readonly labels?: AuthorshipLabels },
): string {
  const parts = [titlePart(n, match.entry)];
  if (match.occurrences > 0) parts.push(occurrencesPart(match));
  parts.push(`origem: ${oneLine(originFolder(match.entry), 120)}`);
  const line = `${parts.join(' · ')}${authorshipPart(match.entry.authorship, labels)}`;
  return passage
    ? `${line} — Trecho: ${oneLine(passage, PASSAGE_CHARS)}`
    : line;
}

/** One files-mode line of a phrase-less listing: the kb summary instead of a passage. */
export function listedLine(
  n: number,
  match: DocMatch,
  {
    withSummary,
    labels,
  }: { readonly withSummary: boolean; readonly labels?: AuthorshipLabels },
): string {
  const line = fileLine(n, match, { passage: null, labels });
  const summary = match.entry.summary;
  return withSummary && summary
    ? `${line} — Resumo: ${oneLine(summary, PASSAGE_CHARS)}`
    : line;
}

export const countLine = (
  n: number,
  match: DocMatch,
  labels?: AuthorshipLabels,
): string =>
  `${titlePart(n, match.entry)} · ${match.occurrences}${authorshipPart(match.entry.authorship, labels)}`;

/** "[3] Título: ocorrências 21–25 de 25", the head of a document's occurrences on a page. */
export function groupLine(
  n: number,
  entry: CatalogEntry,
  span: {
    readonly from: number;
    readonly to: number;
    readonly of: number;
    readonly labels?: AuthorshipLabels;
  },
): string {
  const range =
    span.from === span.to
      ? `ocorrência ${span.from}`
      : `ocorrências ${span.from}–${span.to}`;
  return `${titlePart(n, entry)}: ${range} de ${span.of}${authorshipPart(entry.authorship, span.labels)}`;
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
