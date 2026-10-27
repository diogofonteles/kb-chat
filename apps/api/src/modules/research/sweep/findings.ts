import type { SweepFinding } from '@kb-chat/contracts';
import type { CatalogEntry } from '../../catalog/index.js';
import type { SourceBook } from '../source-book.js';
import { foldName } from '../tool-output.js';

/** One thing a batch found in one document (KBC-030). */
export interface FoundItem {
  readonly entry: CatalogEntry;
  readonly text: string;
}

/** A finding already in the turn's numbering. */
export interface NumberedItem {
  readonly n: number;
  readonly text: string;
}

/** "- [D1][D2] text", "3. [D1] text", "[D1]: text": labels, then the finding. */
const LABELLED =
  /^\s*(?:[-*•]\s*|\d+[.)]\s*)?((?:\[D\d+\]\s*,?\s*)+)[\s:—–-]*(.*\S)\s*$/u;
const NUMBERED =
  /^\s*(?:[-*•]\s*|\d+[.)]\s*)?((?:\[\d+\]\s*,?\s*)+)[\s:—–-]*(.*\S)\s*$/u;
/** Long enough to tell two findings apart, short enough to ignore a changed ending. */
const KEY_CHARS = 160;

const numbersIn = (labels: string): number[] =>
  [...labels.matchAll(/\d+/g)].map((m) => Number(m[0]));

/**
 * A batch's findings (ADR 0021): one per line, each starting with the [Dk] labels of the
 * documents it comes from. A label the batch did not have is dropped (never invented).
 */
export function parseFindings(
  output: string,
  labels: ReadonlyMap<number, CatalogEntry>,
): FoundItem[] {
  return output.split('\n').flatMap((line) => {
    const match = LABELLED.exec(line);
    if (!match?.[1] || !match[2]) return [];
    const text = match[2];
    return numbersIn(match[1]).flatMap((label) => {
      const entry = labels.get(label);
      return entry ? [{ entry, text }] : [];
    });
  });
}

/** Condensed findings by [n]; numbers the turn never gave out are dropped. */
export function parseNumbered(
  output: string,
  book: SourceBook,
): NumberedItem[] {
  return output.split('\n').flatMap((line) => {
    const match = NUMBERED.exec(line);
    if (!match?.[1] || !match[2]) return [];
    const text = match[2];
    return numbersIn(match[1])
      .filter((n) => book.find(n) !== undefined)
      .map((n) => ({ n, text }));
  });
}

/** Characters of a finding a cursor carries (the contract's cap). */
const CARRIED_CHARS = 300;

/** A finding as a cursor carries it: by document id, so another turn can number it. */
export const carriedOf = (entry: CatalogEntry, text: string): SweepFinding => ({
  id: entry.id,
  text: text.slice(0, CARRIED_CHARS),
});

const keyOf = ({ n, text }: NumberedItem): string =>
  `${n}|${foldName(text)
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim()
    .slice(0, KEY_CHARS)}`;

/**
 * Every finding of a sweep, numbered in the turn's SourceBook (the [n] shared with the
 * answer and the sources) and without repeats; listed grouped by document.
 */
export class FindingSet {
  private readonly items = new Map<string, NumberedItem>();

  constructor(private readonly book: SourceBook) {}

  get size(): number {
    return this.items.size;
  }

  /** Documents with at least one finding. */
  get documents(): number {
    return new Set([...this.items.values()].map((item) => item.n)).size;
  }

  addFound(found: readonly FoundItem[]): void {
    this.addNumbered(
      found.map(({ entry, text }) => ({ n: this.book.number(entry), text })),
    );
  }

  addNumbered(found: readonly NumberedItem[]): void {
    for (const item of found) {
      const key = keyOf(item);
      if (!this.items.has(key)) this.items.set(key, item);
    }
  }

  /** The findings by document id, at most `max` (for the cursor). */
  carried(max: number): SweepFinding[] {
    return [...this.items.values()].slice(0, max).flatMap(({ n, text }) => {
      const id = this.book.find(n)?.id;
      return id ? [{ id, text: text.slice(0, CARRIED_CHARS) }] : [];
    });
  }

  lines(): string[] {
    const byDoc = new Map<number, string[]>();
    for (const { n, text } of this.items.values())
      byDoc.set(n, [...(byDoc.get(n) ?? []), `- [${n}] ${text}`]);
    return [...byDoc.values()].flat();
  }
}
