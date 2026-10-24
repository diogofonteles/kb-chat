import type { SearchHit } from '@kb-chat/contracts';
import type { CatalogEntry } from '../catalog/index.js';
import type { BodyWindow } from './body-window.js';
import type { TextHit } from './text-finder.js';

const OPEN = '<<<DOCUMENTO';
const CLOSE = 'DOCUMENTO>>>';
const LINE_CHARS = 300;

/** One line, at most `max` characters: tool outputs stay compact. */
export function oneLine(text: string, max = LINE_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export const quote = (text: string): string => `“${oneLine(text, 80)}”`;

/** Accent- and case-insensitive key for matching names. */
export const foldName = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

export function hitLine(
  n: number,
  hit: SearchHit,
  summary: string | null,
): string {
  const parts = [`[${n}] ${oneLine(hit.title, 160)}`];
  if (summary) parts.push(`Resumo: ${oneLine(summary)}`);
  if (hit.snippet && hit.snippet !== summary)
    parts.push(`Trecho: ${oneLine(hit.snippet)}`);
  if (hit.concepts.length > 0)
    parts.push(`Assuntos: ${hit.concepts.slice(0, 6).join(', ')}`);
  return parts.join(' — ');
}

export function refLine(n: number, entry: CatalogEntry): string {
  const summary = entry.summary ? ` — ${oneLine(entry.summary, 200)}` : '';
  return `[${n}] ${oneLine(entry.title, 160)}${summary}`;
}

function facetsLine(entry: CatalogEntry): string {
  const facets = [
    entry.genre && `gênero: ${entry.genre}`,
    entry.depth !== null && `profundidade: ${entry.depth}`,
    entry.relevance && `relevância: ${entry.relevance}`,
  ].filter(Boolean);
  return facets.length > 0 ? `Facetas: ${facets.join('; ')}` : '';
}

/** The kb's description of a document: summary, criterion, subjects and facets. */
export function headerLines(n: number, entry: CatalogEntry): string[] {
  return [
    `[${n}] ${entry.title}`,
    `Id: ${entry.id}`,
    entry.summary ? `Resumo do kb: ${entry.summary}` : '',
    entry.criterion ? `Critério do kb: ${entry.criterion}` : '',
    entry.concepts.length > 0 ? `Assuntos: ${entry.concepts.join(', ')}` : '',
    facetsLine(entry),
  ].filter(Boolean);
}

function windowIntro(window: BodyWindow, around: string | undefined): string {
  const range = `Texto do documento, caracteres ${window.start} a ${window.end} de ${window.total}`;
  if (!around) return `${range}:`;
  if (window.matches)
    return `${range} (em volta de ${quote(around)}, ${window.matches} ocorrência(s) neste trecho):`;
  return `${range} (${quote(around)} não aparece no texto a partir daqui):`;
}

function nextHint(n: number, window: BodyWindow): string {
  if (window.end >= window.total) return 'Fim do documento.';
  return `Para continuar a leitura: read_document com document=${n} e offset=${window.end} (ou outro "around").`;
}

/** The body window, fenced as quoted data (prompt-injection safe). */
export function windowLines(
  n: number,
  window: BodyWindow,
  around: string | undefined,
): string[] {
  const text = window.text.split(OPEN).join('').split(CLOSE).join('');
  return [windowIntro(window, around), OPEN, text, CLOSE, nextHint(n, window)];
}

const SNIPPET_LINE_CHARS = 600;

/** One find_text hit: [n], title, occurrences per alternative, summary and the passage. */
export function textHitLine(n: number, hit: TextHit): string {
  const counts = hit.phrases
    .map(({ phrase, count }) => `${quote(phrase)} ${count}`)
    .join(', ');
  const parts = [
    `[${n}] ${oneLine(hit.entry.title, 160)}`,
    `${hit.occurrences} ocorrência(s): ${counts}`,
  ];
  if (hit.entry.summary)
    parts.push(`Resumo: ${oneLine(hit.entry.summary, 160)}`);
  if (hit.snippet)
    parts.push(`Trecho: ${oneLine(hit.snippet, SNIPPET_LINE_CHARS)}`);
  return parts.join(' — ');
}
