import { randomUUID } from 'node:crypto';
import type {
  CorrectionHistory,
  CorrectionTarget,
  TranscriptCorrection,
  TranscriptCorrectionRequest,
  TranscriptCorrectionResult,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  CorrectionRow,
  CurrentTranscript,
  TranscriptCorrectionStorePort,
} from '../../ports/transcript-correction-store.js';
import type { MediaRecord } from '../../ports/media-store.js';
import type { StoredWord } from '../../ports/transcript-store.js';
import type { MediaActor } from '../media/index.js';
import {
  conflict,
  rowOf,
  sameTexts,
  textsOf,
  writeChange,
  type CorrectionAuthor,
  type WordChange,
} from './correction-writer.js';
import { LEARNING_PRINCIPAL } from './learning-rules.js';
import { isContiguous, replacedTexts, tidyText } from './word-rewrite.js';

/** Entries of the history per page (FR-6). */
export const HISTORY_PAGE = 20;

/** A word's time, what the tracks and documents that hold it follow (BR-10). */
export interface WordTime {
  readonly startMs: number;
  readonly endMs: number;
}

export interface CorrectionServiceDeps {
  readonly store: TranscriptCorrectionStorePort;
  /** Who sees which media: throws the 404 (KBC-038 FR-1). */
  readonly media: { get(actor: MediaActor, mediaId: string): unknown };
  readonly recordOf: (mediaId: string) => Pick<MediaRecord, 'track'> | null;
  /**
   * Inside the correction's transaction (BR-10, BR-15): the published tracks that hold a
   * changed word are cut again and their documents follow (KBC-100 FR-2).
   */
  readonly afterChange?: (
    recordingId: string,
    words: readonly WordTime[],
  ) => void;
  /** Usage, read by the owner after 30 days (spec metric 4). */
  readonly onCorrected?: (event: {
    readonly mediaId: string;
    readonly kind: 'correct' | 'batch' | 'undo' | 'undo-group' | 'carry';
    readonly words: number;
  }) => void;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** 200 when nothing changed (a retry, the same text), 201 when a row was written. */
export interface Written<T> {
  readonly status: 200 | 201;
  readonly body: T;
}

export const authorOf = (actor: MediaActor): CorrectionAuthor => ({
  principal: actor.principal,
  name: actor.displayName ?? null,
});

/**
 * Who undoes a row (BR-5): its author or a master; the learning's, anyone who corrects
 * (KBC-113 BR-7: it is no person's).
 */
export const mayUndoAuthor = (
  row: Pick<CorrectionRow, 'authorPrincipal'>,
  actor: MediaActor,
): boolean =>
  row.authorPrincipal === actor.principal ||
  row.authorPrincipal === LEARNING_PRINCIPAL ||
  actor.isMaster;

/** A correction in force that this person may undo (BR-5). */
const mayUndo = (row: CorrectionRow, actor: MediaActor): boolean =>
  row.state === 'active' && row.kind !== 'undo' && mayUndoAuthor(row, actor);

const NONE: ReadonlySet<string> = new Set();

const invalid = (message: string) =>
  new AppError('CORRECTION_INVALID', message);

/**
 * Fixes words of a recording's current transcript in place (KBC-093, ADR 0034): the words,
 * the segment, its search row, the revision, the log and the tracks, in one transaction.
 */
export class CorrectionService {
  protected readonly now: () => Date;
  protected readonly newId: () => string;

  constructor(protected readonly deps: CorrectionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  correct(
    actor: MediaActor,
    mediaId: string,
    request: TranscriptCorrectionRequest,
  ): Written<TranscriptCorrectionResult> {
    this.recording(actor, mediaId);
    const text = this.tidy(request.text);
    return this.deps.store.inTransaction(() => {
      const current = this.currentAt(mediaId, request.version);
      const words = this.targetOf(current, request);
      const texts = replacedTexts(request.count, text);
      if (sameTexts(textsOf(words), texts))
        return { status: 200, body: this.unchanged(current) };
      this.expect(current, { words, expected: request.expected });
      const row = this.write(current, { words, texts }, { actor });
      this.notify(mediaId, 'correct', [row]);
      return {
        status: 201,
        body: {
          ...this.resultOf(current, row),
          correction: this.toContract(row, actor),
        },
      };
    });
  }

  undo(
    actor: MediaActor,
    mediaId: string,
    correctionId: string,
  ): Written<TranscriptCorrectionResult> {
    this.recording(actor, mediaId);
    return this.deps.store.inTransaction(() => {
      const row = this.rowToUndo(actor, mediaId, correctionId);
      const current = this.currentOf(mediaId);
      if (row.state === 'undone')
        return { status: 200, body: this.unchanged(current) };
      const words = this.stillSaying(current, row);
      const undo = this.write(
        current,
        { words, texts: row.before },
        { actor, reverts: row.id },
      );
      this.deps.store.markUndone(row.id);
      this.notify(mediaId, 'undo', [undo]);
      return {
        status: 201,
        body: {
          ...this.resultOf(current, undo),
          correction: this.toContract(undo, actor),
        },
      };
    });
  }

  history(actor: MediaActor, mediaId: string, cursor = 0): CorrectionHistory {
    this.deps.media.get(actor, mediaId);
    const { store } = this.deps;
    const page = store.history(mediaId, {
      offset: cursor,
      limit: HISTORY_PAGE,
    });
    const next = cursor + page.entries.length;
    const stale = this.staleLearned(page.entries.flat());
    return {
      mediaId,
      total: page.total,
      entries: page.entries.map((rows) => this.entryOf(rows, actor, stale)),
      next: next < page.total ? next : null,
      carry: this.carryNow(mediaId),
    };
  }

  /** The newest version's carry-over, once there was one (FR-8). */
  private carryNow(mediaId: string): CorrectionHistory['carry'] {
    const current = this.deps.store.current(mediaId);
    if (!current || current.version === 1) return null;
    const counts = this.deps.store.carryOf(mediaId, current.version);
    return counts.carried + counts.notCarried === 0
      ? null
      : { version: current.version, ...counts };
  }

  private entryOf(
    rows: readonly CorrectionRow[],
    actor: MediaActor,
    stale: ReadonlySet<string>,
  ) {
    const items = rows.map((row) => this.toContract(row, actor, stale));
    const groupId = rows[0]?.groupId ?? null;
    const own = rows.every((row) => mayUndoAuthor(row, actor));
    return {
      groupId,
      items,
      canUndoGroup:
        groupId !== null && own && items.some((item) => item.canUndo),
    };
  }

  /**
   * The learned replacements of a page a person corrected over: they no longer hold their
   * text, so no Desfazer there (KBC-113, review round 1). One read of words per transcript
   * of the page, however many rows a group holds (ND-19, review round 2).
   */
  private staleLearned(rows: readonly CorrectionRow[]): ReadonlySet<string> {
    const learned = rows.filter(
      (row) => row.ruleId !== null && row.state === 'active',
    );
    const stale = new Set<string>();
    const byTranscript = new Map<string, CorrectionRow[]>();
    for (const row of learned)
      byTranscript.set(row.transcriptId, [
        ...(byTranscript.get(row.transcriptId) ?? []),
        row,
      ]);
    for (const [transcriptId, group] of byTranscript)
      for (const id of this.notHolding(transcriptId, group)) stale.add(id);
    return stale;
  }

  /** The rows of one transcript whose words no longer say their text: one read. */
  private notHolding(
    transcriptId: string,
    rows: readonly CorrectionRow[],
  ): string[] {
    const from = Math.min(...rows.map((row) => row.position));
    const to = Math.max(...rows.map((row) => row.position + row.count));
    const texts = new Map(
      this.deps.store
        .wordsAt(transcriptId, from, to - from)
        .map((word) => [word.position, word.text]),
    );
    return rows
      .filter((row) => {
        const now = Array.from(
          { length: row.count },
          (_, index) => texts.get(row.position + index) ?? '',
        );
        return !sameTexts(now, replacedTexts(row.count, row.after));
      })
      .map((row) => row.id);
  }

  protected toContract(
    row: CorrectionRow,
    actor: MediaActor,
    stale: ReadonlySet<string> = NONE,
  ): TranscriptCorrection {
    const mine = row.authorPrincipal === actor.principal;
    return {
      id: row.id,
      kind: row.kind,
      state: row.state,
      version: row.version,
      revision: row.revision,
      position: row.position,
      count: row.count,
      segment: row.segment,
      startMs: row.startMs,
      endMs: row.endMs,
      before: [...row.before],
      after: row.after,
      reverts: row.reverts,
      carriedTo: row.carriedTo,
      found: row.found,
      groupId: row.groupId,
      authorName: row.authorName,
      mine,
      canUndo: mayUndo(row, actor) && !stale.has(row.id),
      learned: row.ruleId !== null,
      createdAt: row.createdAt,
    };
  }

  /** A recording the person sees (404 otherwise); a track is corrected through it (409). */
  protected recording(actor: MediaActor, mediaId: string): void {
    this.deps.media.get(actor, mediaId);
    if (this.deps.recordOf(mediaId)?.track)
      throw conflict(
        { reason: 'track-derived' },
        'A track is corrected through its recording',
      );
  }

  protected tidy(raw: string): string {
    const tidied = tidyText(raw);
    if (!tidied.ok) throw invalid('Use up to 80 characters, on one line');
    return tidied.text;
  }

  protected currentOf(mediaId: string): CurrentTranscript {
    const current = this.deps.store.current(mediaId);
    if (!current)
      throw new AppError('MEDIA_NOT_READY', 'This media has no transcript yet');
    return current;
  }

  /** The version the person saw, still the newest (412 otherwise, BR-6). */
  protected currentAt(mediaId: string, version: number): CurrentTranscript {
    const current = this.currentOf(mediaId);
    if (current.version !== version)
      throw new AppError(
        'TRANSCRIPT_CHANGED',
        'The recording was transcribed again',
        { details: { version: current.version } },
      );
    return current;
  }

  /** 1 to 5 consecutive words of one segment (409 `not-contiguous`, AC-6). */
  protected targetOf(
    current: CurrentTranscript,
    target: Pick<CorrectionTarget, 'position' | 'count'>,
  ): StoredWord[] {
    const words = this.deps.store.wordsAt(
      current.id,
      target.position,
      target.count,
    );
    if (!isContiguous(words, target.count))
      throw conflict(
        { reason: 'not-contiguous' },
        'A correction is 1 to 5 words of one segment',
      );
    return words;
  }

  /** The words still say what the person saw (409 `word-changed` otherwise, BR-6). */
  protected expect(
    current: CurrentTranscript,
    target: {
      readonly words: readonly StoredWord[];
      readonly expected: readonly string[];
    },
  ): void {
    const now = textsOf(target.words);
    if (sameTexts(now, target.expected)) return;
    const first = target.words[0];
    const writer = this.deps.store.lastWriter(current.id, {
      position: first?.position ?? 0,
      count: target.words.length,
    });
    throw conflict(
      {
        reason: 'word-changed',
        current: now,
        authorName: writer?.authorName ?? null,
      },
      'These words changed since they were read',
    );
  }

  /** Writes one change with its log row and the next revision. */
  protected write(
    current: CurrentTranscript,
    change: WordChange,
    by: { readonly actor: MediaActor; readonly reverts?: string },
  ): CorrectionRow {
    const { actor, ...extra } = by;
    const { store } = this.deps;
    const revision = current.revision + 1;
    writeChange(store, current.id, change);
    const row = rowOf(current, change, {
      id: this.newId(),
      kind: extra.reverts ? 'undo' : 'correct',
      revision,
      author: authorOf(actor),
      at: this.now().toISOString(),
      reverts: extra.reverts ?? null,
    });
    store.insert(row);
    store.setRevision(current.id, revision);
    this.deps.afterChange?.(current.mediaId, change.words);
    return row;
  }

  private rowToUndo(
    actor: MediaActor,
    mediaId: string,
    correctionId: string,
  ): CorrectionRow {
    const row = this.deps.store.row(mediaId, correctionId);
    if (!row) throw new AppError('NOT_FOUND', 'Unknown correction');
    if (!mayUndoAuthor(row, actor))
      throw new AppError('FORBIDDEN', 'Only a master undoes another person');
    return row;
  }

  /** The words a correction wrote, as it left them (409 `changed-since` otherwise, BR-7). */
  protected stillSaying(
    current: CurrentTranscript,
    row: CorrectionRow,
  ): StoredWord[] {
    const words = this.deps.store.wordsAt(current.id, row.position, row.count);
    const fits =
      row.kind !== 'undo' &&
      row.state === 'active' &&
      row.transcriptId === current.id &&
      sameTexts(textsOf(words), replacedTexts(row.count, row.after));
    if (fits) return words;
    const writer = this.deps.store.lastWriter(current.id, row);
    throw conflict(
      {
        reason: 'changed-since',
        current: row.transcriptId === current.id ? textsOf(words) : [],
        authorName: writer?.authorName ?? null,
      },
      'These words changed after the correction',
    );
  }

  protected unchanged(current: CurrentTranscript): TranscriptCorrectionResult {
    return {
      correction: null,
      version: current.version,
      revision: current.revision,
      segments: [],
    };
  }

  private resultOf(current: CurrentTranscript, row: CorrectionRow) {
    const text = this.deps.store.segmentText(current.id, row.segment) ?? '';
    return {
      version: current.version,
      revision: row.revision,
      segments: [{ index: row.segment, text }],
    };
  }

  protected notify(
    mediaId: string,
    kind: Parameters<
      NonNullable<CorrectionServiceDeps['onCorrected']>
    >[0]['kind'],
    rows: readonly CorrectionRow[],
  ): void {
    const words = rows.reduce((sum, row) => sum + row.count, 0);
    this.deps.onCorrected?.({ mediaId, kind, words });
  }
}
