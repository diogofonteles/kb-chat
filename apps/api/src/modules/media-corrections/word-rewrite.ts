import { CORRECTION_MAX_CHARS, CORRECTION_MAX_WORDS } from '@kb-chat/contracts';

/** A stored word with its place in the transcript. */
export interface PlacedWord {
  readonly position: number;
  readonly segment: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/** The new text as it is kept (BR-3), or why it is refused. */
export type TidiedText =
  { readonly ok: true; readonly text: string } | { readonly ok: false };

/**
 * Spaces at the ends fall and repeated ones become one; a line break or more than 80
 * characters is refused (BR-3, AC-7, AC-8). Case, accents and punctuation are the person's.
 */
export function tidyText(raw: string): TidiedText {
  if (/[\r\n\u2028\u2029]/.test(raw)) return { ok: false };
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length > CORRECTION_MAX_CHARS
    ? { ok: false }
    : { ok: true, text };
}

/** Where a word sits in its segment's text. */
interface Placed {
  readonly start: number;
  readonly end: number;
}

/**
 * Places a segment's words in its text, in order, as the web's `alignWords` (KBC-045) does:
 * an empty word has no place. Null when a word is not found (ADR 0034 §1, `not-aligned`).
 */
export function alignSegment(
  text: string,
  words: readonly Pick<PlacedWord, 'position' | 'text'>[],
): ReadonlyMap<number, Placed> | null {
  const placed = new Map<number, Placed>();
  let cursor = 0;
  for (const word of words) {
    if (word.text === '') continue;
    const start = text.indexOf(word.text, cursor);
    if (start < 0) return null;
    cursor = start + word.text.length;
    placed.set(word.position, { start, end: cursor });
  }
  return placed;
}

const endsWithSpace = (text: string) => /\s$/.test(text);
const startsWithSpace = (text: string) => /^\s/.test(text);

/**
 * Text in place of a span: the spacing around it stays as it was (a word glued to the one
 * before stays glued), a removal takes one of the two spaces around it, and text put back
 * where there was none (`insert`) gets a space on each side it needs.
 */
function splice(
  parts: { readonly prefix: string; readonly suffix: string },
  replacement: string,
  insert: boolean,
): string {
  const { prefix, suffix } = parts;
  if (replacement === '') {
    const joined =
      endsWithSpace(prefix) && startsWithSpace(suffix)
        ? prefix.trimEnd() + ' ' + suffix.trimStart()
        : prefix + suffix;
    return joined.trim();
  }
  const before = insert && prefix !== '' && !endsWithSpace(prefix) ? ' ' : '';
  const after = insert && suffix !== '' && !startsWithSpace(suffix) ? ' ' : '';
  return `${prefix}${before}${replacement}${after}${suffix}`.trim();
}

/** The words' new texts: the first gets the replacement, the others are emptied (BR-1). */
export function replacedTexts(count: number, replacement: string): string[] {
  return Array.from({ length: count }, (_, index) =>
    index === 0 ? replacement : '',
  );
}

/**
 * A segment's text with `count` words from `position` replaced (ADR 0034 §1): the span from
 * the first to the last of them that has text. When all of them are empty (an undo of a
 * removal), the text goes back after the word before them. Null when the words do not align.
 */
export function rewriteSegment(input: {
  readonly text: string;
  readonly words: readonly Pick<PlacedWord, 'position' | 'text'>[];
  readonly position: number;
  readonly count: number;
  readonly replacement: string;
}): string | null {
  const { text, words, position, count, replacement } = input;
  const placed = alignSegment(text, words);
  if (!placed) return null;
  const placesOf = (keep: (at: number) => boolean) =>
    words
      .filter((word) => keep(word.position))
      .flatMap((word) => placed.get(word.position) ?? []);
  const inside = placesOf((at) => at >= position && at < position + count);
  const [first] = inside;
  const end = inside.at(-1);
  const anchor = placesOf((at) => at < position).at(-1)?.end ?? 0;
  const parts =
    first && end
      ? { prefix: text.slice(0, first.start), suffix: text.slice(end.end) }
      : { prefix: text.slice(0, anchor), suffix: text.slice(anchor) };
  return splice(parts, replacement, !first);
}

/** Whether the target is 1 to 5 words that exist, all in one segment (BR-1, AC-6). */
export function isContiguous(
  words: readonly PlacedWord[],
  count: number,
): boolean {
  const first = words[0];
  return (
    first !== undefined &&
    count <= CORRECTION_MAX_WORDS &&
    words.length === count &&
    words.every(
      (word, index) =>
        word.segment === first.segment &&
        word.position === first.position + index,
    )
  );
}

const PUNCTUATION = /[\p{P}\p{S}]/gu;

/**
 * Text as a carry-over compares it (BR-9): no case, no accents, no punctuation, single
 * spaces.
 */
export const carryKey = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('pt-BR')
    .replace(PUNCTUATION, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** A text's punctuation at its edges and what is between (BR-11). */
export function edgesOf(text: string): {
  readonly lead: string;
  readonly core: string;
  readonly trail: string;
} {
  const match = /^([\p{P}\p{S}]*)(.*?)([\p{P}\p{S}]*)$/su.exec(text);
  return {
    lead: match?.[1] ?? '',
    core: match?.[2] ?? text,
    trail: match?.[3] ?? '',
  };
}

/** Text as "Corrigir todas" compares it: no case, no edge punctuation (BR-11). */
export const occurrenceKey = (text: string): string =>
  edgesOf(text.replace(/\s+/g, ' ').trim())
    .core.toLocaleLowerCase('pt-BR')
    .trim();

/** An occurrence's new text: the typed one inside the occurrence's own edge punctuation. */
export function occurrenceReplacement(found: string, typed: string): string {
  const { lead, trail } = edgesOf(found);
  const { core } = edgesOf(typed);
  return `${lead}${core}${trail}`;
}

/** A run of words of one segment that says the chosen text (BR-11). */
export interface FoundRun {
  readonly words: readonly PlacedWord[];
  readonly said: string;
}

/**
 * Every run of 1 to 5 consecutive words of one segment that says `text` (case and edge
 * punctuation aside), in time order, never overlapping. Empty words are skipped inside a run
 * but count in its length; a run never crosses segments (AC-31).
 */
export function findRuns(
  words: readonly PlacedWord[],
  text: string,
): FoundRun[] {
  const wanted = occurrenceKey(text);
  const size = wanted.split(' ').length;
  if (wanted === '' || size > CORRECTION_MAX_WORDS) return [];
  const runs: FoundRun[] = [];
  const spoken = words.filter((word) => word.text !== '');
  for (let index = 0; index + size <= spoken.length; index++) {
    const run = spoken.slice(index, index + size);
    const first = run[0];
    const last = run.at(-1);
    if (!first || !last || last.segment !== first.segment) continue;
    if (last.position - first.position + 1 > CORRECTION_MAX_WORDS) continue;
    const said = run.map((word) => word.text).join(' ');
    if (occurrenceKey(said) !== wanted) continue;
    const all = words.filter(
      (word) =>
        word.position >= first.position && word.position <= last.position,
    );
    runs.push({ words: all, said });
    index += size - 1;
  }
  return runs;
}

/** A correction in force, as the carry-over reads it. */
export interface CarriedCorrection {
  readonly startMs: number;
  readonly endMs: number;
  readonly count: number;
  readonly before: readonly string[];
  readonly after: string;
}

/** Where a correction lands on a newer version, or what that version says there. */
export type CarryOutcome =
  | { readonly carried: true; readonly words: readonly PlacedWord[] }
  | { readonly carried: false; readonly found: string };

const midpoint = (word: PlacedWord) => (word.startMs + word.endMs) / 2;

/**
 * BR-9 (ADR 0034 §6): the newer version's words whose midpoints fall in the correction's
 * time, when they are as many as it changed, in one segment, and say its `before` (case,
 * accents and punctuation aside). Otherwise what they say there now.
 */
export function carryOver(
  correction: CarriedCorrection,
  words: readonly PlacedWord[],
): CarryOutcome {
  const there = words.filter(
    (word) =>
      midpoint(word) >= correction.startMs &&
      midpoint(word) <= correction.endMs,
  );
  const found = there
    .map((word) => word.text)
    .filter((text) => text !== '')
    .join(' ');
  const same =
    there.length === correction.count &&
    isContiguous(there, correction.count) &&
    carryKey(found) === carryKey(correction.before.join(' '));
  return same ? { carried: true, words: there } : { carried: false, found };
}
