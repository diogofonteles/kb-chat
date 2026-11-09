import type {
  CorrectionConflict,
  CorrectionKind,
  RewrittenSegment,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  CorrectionRow,
  CurrentTranscript,
  TranscriptCorrectionStorePort,
} from '../../ports/transcript-correction-store.js';
import { rewriteSegment, type PlacedWord } from './word-rewrite.js';

/** The words a change targets and what each will say. */
export interface WordChange {
  readonly words: readonly PlacedWord[];
  readonly texts: readonly string[];
}

/** Who a row names: the effective person (a master acting as them, ADR 0027). */
export interface CorrectionAuthor {
  readonly principal: string;
  readonly name: string | null;
}

/** What a log row says beyond the words it changed. */
export interface RowMeta {
  readonly id: string;
  readonly kind: CorrectionKind;
  readonly revision: number;
  readonly author: CorrectionAuthor;
  readonly at: string;
  readonly groupId?: string | null;
  readonly reverts?: string | null;
}

/** A new row: in force, not tried on another version yet. */
const NOT_CARRIED_YET = {
  state: 'active',
  carriedTo: null,
  checkedVersion: null,
  found: null,
} as const;

export const conflict = (details: CorrectionConflict, message: string) =>
  new AppError('CORRECTION_CONFLICT', message, { details });

export const textsOf = (words: readonly PlacedWord[]): string[] =>
  words.map((word) => word.text);

export const sameTexts = (
  a: readonly string[],
  b: readonly string[],
): boolean =>
  a.length === b.length && a.every((text, index) => text === b[index]);

/** The text a span says, its empty words left out. */
export const spoken = (texts: readonly string[]): string =>
  texts.filter((text) => text !== '').join(' ');

/**
 * Writes a change in place (ADR 0034 §1): the words, then their segment's text rewritten over
 * the span and its search index row. Refuses (409 `not-aligned`) a segment whose words do not
 * sit in its text, before writing anything.
 */
export function writeChange(
  store: TranscriptCorrectionStorePort,
  transcriptId: string,
  change: WordChange,
): RewrittenSegment {
  const first = change.words[0];
  if (!first) throw new Error('a change names at least one word');
  const text = store.segmentText(transcriptId, first.segment) ?? '';
  const rewritten = rewriteSegment({
    text,
    words: store.segmentWords(transcriptId, first.segment),
    position: first.position,
    count: change.words.length,
    replacement: spoken(change.texts),
  });
  if (rewritten === null)
    throw conflict(
      { reason: 'not-aligned' },
      'This segment cannot be corrected',
    );
  store.writeWords(
    transcriptId,
    change.words.map((word, index) => ({
      position: word.position,
      text: change.texts[index] ?? '',
    })),
  );
  store.writeSegment(transcriptId, first.segment, rewritten);
  return { index: first.segment, text: rewritten };
}

function endsOf(change: WordChange) {
  const first = change.words[0];
  const last = change.words.at(-1);
  if (!first || !last) throw new Error('a change names at least one word');
  return { first, last };
}

/** The log row of a change (ADR 0034 §3): its words' times, texts before and after. */
export function rowOf(
  current: CurrentTranscript,
  change: WordChange,
  meta: RowMeta,
): CorrectionRow {
  const { first, last } = endsOf(change);
  return {
    id: meta.id,
    mediaId: current.mediaId,
    transcriptId: current.id,
    version: current.version,
    revision: meta.revision,
    kind: meta.kind,
    position: first.position,
    count: change.words.length,
    segment: first.segment,
    startMs: first.startMs,
    endMs: last.endMs,
    before: textsOf(change.words),
    after: spoken(change.texts),
    reverts: meta.reverts ?? null,
    ...NOT_CARRIED_YET,
    groupId: meta.groupId ?? null,
    authorPrincipal: meta.author.principal,
    authorName: meta.author.name,
    createdAt: meta.at,
  };
}

/** Segments rewritten by several changes: the last text of each, in order. */
export function segmentsOf(
  rewritten: readonly RewrittenSegment[],
): RewrittenSegment[] {
  const byIndex = new Map(rewritten.map((one) => [one.index, one.text]));
  return [...byIndex]
    .sort(([a], [b]) => a - b)
    .map(([index, text]) => ({ index, text }));
}
