import type {
  CorrectionKind,
  CorrectionState,
  LearnedSpan,
} from '@kb-chat/contracts';
import type { StoredWord } from './transcript-store.js';

/** A person's correction in force (BR-1), with the words around it then. */
export interface LearningSource {
  readonly id: string;
  readonly mediaId: string;
  readonly mediaTitle: string;
  readonly startMs: number;
  /** The words' texts before the correction. */
  readonly before: readonly string[];
  readonly after: string;
  /** The nearest non-empty word before and after the span in its segment; '' at an edge. */
  readonly contextBefore: string;
  readonly contextAfter: string;
  readonly createdAt: string;
  readonly authorName: string | null;
}

/** How often a rule's replacements were written and undone (BR-8). */
export interface RuleTally {
  readonly applied: number;
  readonly undone: number;
}

/** A master's on/off (BR-11), keyed `rule:<id>` or `term:<id>`. */
export interface LearningSwitch {
  readonly enabled: boolean;
  readonly authorName: string | null;
  readonly at: string;
}

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
  /** The learned rule that wrote it (KBC-113, ADR 0037 §2); null for a person's. */
  readonly ruleId: string | null;
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
  /**
   * The people's corrections in force (KBC-113 BR-1): not undone, through their carried rows;
   * a word corrected twice counts once, from the first text to the last.
   */
  learningSources(): LearningSource[];
  /** Per rule: replacements written and undone (BR-8). */
  ruleTallies(): ReadonlyMap<string, RuleTally>;
  /** The learning's replacements in force on a transcript, in these segments (FR-5). */
  learnedOn(
    transcriptId: string,
    segments: { readonly from: number; readonly count: number },
  ): LearnedSpan[];
  /** Positions the carry-over wrote on a transcript (BR-6). */
  carriedPositions(transcriptId: string): ReadonlySet<number>;
  /** The masters' switches, keyed `rule:<id>` or `term:<id>` (BR-11). */
  switches(): ReadonlyMap<string, LearningSwitch>;
  setSwitch(input: {
    readonly kind: 'rule' | 'term';
    readonly key: string;
    readonly enabled: boolean | null;
    readonly author: {
      readonly principal: string;
      readonly name: string | null;
    };
    readonly now: Date;
  }): void;
  /** What the carry-over did when `version` came (FR-8). */
  carryOf(
    mediaId: string,
    version: number,
  ): { readonly carried: number; readonly notCarried: number };
}
