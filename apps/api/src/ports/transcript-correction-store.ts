import type { CorrectionKind, CorrectionState } from '@kb-chat/contracts';
import type { StoredWord } from './transcript-store.js';

/** A media's current transcript, as a correction checks it (ADR 0034 §2, §4). */
export interface CurrentTranscript {
  readonly id: string;
  readonly mediaId: string;
  readonly version: number;
  readonly revision: number;
}

/** One row of the log (ADR 0034 §3, amendment 8). */
export interface CorrectionRow {
  readonly id: string;
  readonly mediaId: string;
  readonly transcriptId: string;
  readonly version: number;
  readonly revision: number;
  readonly kind: CorrectionKind;
  readonly position: number;
  readonly count: number;
  readonly segment: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly before: readonly string[];
  readonly after: string;
  readonly reverts: string | null;
  readonly state: CorrectionState;
  readonly carriedTo: string | null;
  /** The version a carry-over was tried on (FR-8). */
  readonly checkedVersion: number | null;
  readonly found: string | null;
  readonly groupId: string | null;
  readonly authorPrincipal: string;
  readonly authorName: string | null;
  readonly createdAt: string;
}

/** A word's new text. */
export interface WordText {
  readonly position: number;
  readonly text: string;
}

/** A page of the history: rows of each entry (a correction alone or a group), newest first. */
export interface CorrectionPage {
  readonly total: number;
  readonly entries: readonly (readonly CorrectionRow[])[];
}

/**
 * Word corrections in the media database (KBC-093, ADR 0034): words, segments and their
 * search index rows written in place, the transcript's revision and the append-only log.
 * The service runs each change in `inTransaction`, so a failure leaves nothing changed.
 */
export interface TranscriptCorrectionStorePort {
  inTransaction<T>(work: () => T): T;
  /** The newest transcript of a media; null before the first. */
  current(mediaId: string): CurrentTranscript | null;
  /** The newest version older than `version`; null when it is the first. */
  previousOf(mediaId: string, version: number): CurrentTranscript | null;
  /** The words from `position`, at most `count`, in order. */
  wordsAt(transcriptId: string, position: number, count: number): StoredWord[];
  segmentWords(transcriptId: string, segment: number): StoredWord[];
  allWords(transcriptId: string): StoredWord[];
  segmentText(transcriptId: string, segment: number): string | null;
  writeWords(transcriptId: string, words: readonly WordText[]): void;
  /** The segment's text and its row in the search index, which holds current versions. */
  writeSegment(transcriptId: string, segment: number, text: string): void;
  /** Sets the transcript's revision. */
  setRevision(transcriptId: string, revision: number): void;
  insert(row: CorrectionRow): void;
  markUndone(id: string): void;
  markCarried(
    id: string,
    to: { readonly carriedTo: string; readonly version: number },
  ): void;
  markNotCarried(
    id: string,
    at: { readonly found: string; readonly version: number },
  ): void;
  row(mediaId: string, id: string): CorrectionRow | null;
  groupRows(mediaId: string, groupId: string): CorrectionRow[];
  /** Corrections in force on a transcript, oldest first (what a carry-over replays). */
  activeOn(transcriptId: string): CorrectionRow[];
  /** The newest row that wrote one of these words of a transcript; null if none. */
  lastWriter(
    transcriptId: string,
    span: { readonly position: number; readonly count: number },
  ): CorrectionRow | null;
  history(
    mediaId: string,
    page: { readonly offset: number; readonly limit: number },
  ): CorrectionPage;
  /** What the carry-over did when `version` came (FR-8). */
  carryOf(
    mediaId: string,
    version: number,
  ): { readonly carried: number; readonly notCarried: number };
}
