import { TRACK_ANCHOR, anchorAt, anchorsIn } from '@kb-chat/contracts';
import type { CatalogEntry } from '../../catalog/index.js';
import type { SourceBook } from '../source-book.js';
import { foldName } from '../tool-output.js';
import type { ShownWindow } from './sweep-planner.js';

/** What a finding's quote must have to be looked for: a few words, not a stray mark. */
const MIN_QUOTE_CHARS = 8;
const QUOTES = /[“"«]([^”"»]+)[”"»]/gu;

/** kb's wikilinks read as their text: "[[Ritmo|o ritmo]]" is "o ritmo" (ADR 0035 §6 c). */
const withoutLinks = (text: string): string =>
  text.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1');

const fold = (text: string): string =>
  foldName(withoutLinks(text).replace(new RegExp(TRACK_ANCHOR.source, 'g'), ''))
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The quotes a finding carries, longest first. */
function quotesOf(text: string): string[] {
  return [...text.matchAll(QUOTES)]
    .map((match) => fold(match[1] ?? ''))
    .filter((quote) => quote.length >= MIN_QUOTE_CHARS)
    .sort((a, b) => b.length - a.length);
}

/** The anchor of the shown paragraph that holds a quote; null when none does. */
function quotedAnchor(
  quotes: readonly string[],
  windows: readonly ShownWindow[],
): number | null {
  for (const window of windows) {
    const found = quotedIn(quotes, window);
    if (found !== null) return found;
  }
  return null;
}

/** The anchor of the window's first line that holds a quote; null when none does. */
function quotedIn(
  quotes: readonly string[],
  { body, start, end }: ShownWindow,
): number | null {
  let at = start;
  for (const line of body.slice(start, end).split('\n')) {
    if (quotes.some((quote) => fold(line).includes(quote)))
      return anchorAt(body, at + line.length);
    at += line.length + 1;
  }
  return null;
}

/** Every anchor a batch showed of a track: they may be cited (ADR 0035 §6). */
function shownAnchors(windows: readonly ShownWindow[]): number[] {
  const anchors = windows.flatMap(({ body, start, end }) => {
    const opening = anchorAt(body, start);
    return [
      ...(opening === null ? [] : [opening]),
      ...anchorsIn(body.slice(start, end)),
    ];
  });
  return [...new Set(anchors)];
}

/**
 * Where a sweep finding in a track is (KBC-101 BR-4, ADR 0035 §6 c): the paragraph its
 * literal quote is in, wikilink markup stripped; without one, the start of the window read.
 */
export function trackFindingFocus(
  text: string,
  windows: readonly ShownWindow[],
): { readonly anchors: number[]; readonly focus: number | null } {
  const anchors = shownAnchors(windows);
  const quoted = quotedAnchor(quotesOf(text), windows);
  return { anchors, focus: quoted ?? anchors[0] ?? null };
}

/** The track findings of one batch, placed on their passages in the turn's book. */
export function placeTrackFindings(
  found: readonly { readonly entry: CatalogEntry; readonly text: string }[],
  {
    book,
    labels,
    shown,
  }: {
    book: SourceBook;
    labels: ReadonlyMap<number, CatalogEntry>;
    shown: ReadonlyMap<number, readonly ShownWindow[]>;
  },
): void {
  const labelOf = new Map(
    [...labels].map(([label, entry]) => [entry.id, label]),
  );
  for (const { entry, text } of found) {
    const windows = shown.get(labelOf.get(entry.id) ?? 0);
    if (!entry.media || !windows) continue;
    book.showTrack(book.number(entry), trackFindingFocus(text, windows));
  }
}
