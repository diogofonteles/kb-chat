import type { Authorship, SearchHit } from '@kb-chat/contracts';
import type { CatalogEntry } from '../catalog/index.js';
import type { BodyWindow } from './body-window.js';

const OPEN = '<<<DOCUMENTO';
const CLOSE = 'DOCUMENTO>>>';
const LINE_CHARS = 300;
/** Summary and snippet per hit (KBC-011): long enough that many answers need no read. */
const HIT_TEXT_CHARS = 400;

/** One line, at most `max` characters: tool outputs stay compact. */
export function oneLine(text: string, max = LINE_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export const quote = (text: string): string => `“${oneLine(text, 80)}”`;

/** Accent- and case-insensitive key for matching names. */
export const foldName = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** KBC-020: what every document line says about whose text it is (ADR 0015). */
export const AUTHORSHIP_LABELS: Readonly<Record<Authorship, string>> = {
  'mestre-laercio': 'Mestre Laércio',
  'outros-autores': 'Outros autores',
  sintese: 'Síntese do acervo',
  'nao-classificado': 'Não classificado',
};

/** " · autoria: Mestre Laércio", appended to a document's title on every line. */
export const authorshipPart = (authorship: Authorship): string =>
  ` · autoria: ${AUTHORSHIP_LABELS[authorship]}`;

/** What the agent must keep in mind when citing each group (read headers). */
const AUTHORSHIP_NOTES: Readonly<Record<Authorship, string>> = {
  'mestre-laercio': '',
  'outros-autores': 'não é do Mestre Laércio; diga o autor ou o livro ao citar',
  sintese:
    'artigo do wiki que resume vários documentos; não é fala do Mestre Laércio',
  'nao-classificado':
    'a autoria ainda não foi marcada; não atribua ao Mestre Laércio sem confirmar',
};

function authorshipLine(entry: CatalogEntry): string {
  const notes = [
    entry.author && `autor: ${oneLine(entry.author, 120)}`,
    AUTHORSHIP_NOTES[entry.authorship],
  ].filter(Boolean);
  const detail = notes.length > 0 ? ` (${notes.join('; ')})` : '';
  return `Autoria: ${AUTHORSHIP_LABELS[entry.authorship]}${detail}`;
}

export function hitLine(
  n: number,
  hit: SearchHit,
  summary: string | null,
): string {
  const parts = [
    `[${n}] ${oneLine(hit.title, 160)}${authorshipPart(hit.authorship)}`,
  ];
  if (summary) parts.push(`Resumo: ${oneLine(summary, HIT_TEXT_CHARS)}`);
  if (hit.snippet && hit.snippet !== summary)
    parts.push(`Trecho: ${oneLine(hit.snippet, HIT_TEXT_CHARS)}`);
  if (hit.concepts.length > 0)
    parts.push(`Assuntos: ${hit.concepts.slice(0, 6).join(', ')}`);
  return parts.join(' — ');
}

export function refLine(n: number, entry: CatalogEntry): string {
  const summary = entry.summary ? ` — ${oneLine(entry.summary, 200)}` : '';
  return `[${n}] ${oneLine(entry.title, 160)}${authorshipPart(entry.authorship)}${summary}`;
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
    authorshipLine(entry),
    entry.summary ? `Resumo do kb: ${entry.summary}` : '',
    entry.criterion ? `Critério do kb: ${entry.criterion}` : '',
    entry.concepts.length > 0 ? `Assuntos: ${entry.concepts.join(', ')}` : '',
    entry.entities.length > 0
      ? `Entidades do kb: ${oneLine(entry.entities.slice(0, 12).join(', '))}`
      : '',
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
