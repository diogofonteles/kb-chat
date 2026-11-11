import {
  CORRECTION_MAX_BATCH,
  type CorrectionGroupUndoResult,
  type CorrectionTarget,
  type Occurrence,
  type Occurrences,
  type OccurrencesQuery,
  type RewrittenSegment,
  type TranscriptCorrectionBatchRequest,
  type TranscriptCorrectionBatchResult,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  CorrectionRow,
  CurrentTranscript,
} from '../../ports/transcript-correction-store.js';
import type { StoredWord } from '../../ports/transcript-store.js';
import type { MediaActor } from '../media/index.js';
import {
  CorrectionService,
  authorOf,
  mayUndoAuthor,
  type Written,
} from './correction-service.js';
import {
  conflict,
  rowOf,
  sameTexts,
  segmentsOf,
  spoken,
  textsOf,
  writeChange,
  type CorrectionAuthor,
  type WordChange,
} from './correction-writer.js';
import {
  carryOver,
  findRuns,
  occurrenceReplacement,
  replacedTexts,
  type FoundRun,
  type PlacedWord,
} from './word-rewrite.js';

/** Words of context on each side of an occurrence in the preview (FR-11). */
const CONTEXT_WORDS = 5;

/** A batch item with the words it names now. */
interface Target {
  readonly item: CorrectionTarget;
  readonly words: readonly StoredWord[];
}

/** One carry-over (BR-9): the new version, its words as written so far, the new groups. */
interface CarryRun {
  readonly current: CurrentTranscript;
  readonly words: Map<number, PlacedWord>;
  readonly groups: Map<string, string>;
}

/** Changes written together: one revision, rows with one group (amendment 8). */
interface Together {
  readonly current: CurrentTranscript;
  readonly changes: readonly WordChange[];
  readonly kind: CorrectionRow['kind'];
  readonly author: CorrectionAuthor;
  readonly groupId: string | null;
  readonly reverts?: readonly string[];
}

/** An occurrence's words with the typed text, inside its own edge punctuation (BR-11). */
const changeOf = (
  item: CorrectionTarget,
  words: readonly StoredWord[],
  typed: string,
): WordChange => ({
  words,
  texts: replacedTexts(
    item.count,
    occurrenceReplacement(spoken(item.expected), typed),
  ),
});

const overlapping = (items: readonly CorrectionTarget[]): boolean => {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  return sorted.some((item, index) => {
    const next = sorted[index + 1];
    return next !== undefined && next.position < item.position + item.count;
  });
};

const inWindowOf =
  (query: OccurrencesQuery) =>
  (word: PlacedWord): boolean =>
    query.fromMs !== undefined &&
    query.toMs !== undefined &&
    word.startMs >= query.fromMs &&
    word.startMs < query.toMs;

/** The words of a segment on each side of a run, at most CONTEXT_WORDS. */
function contextOf(words: readonly StoredWord[], run: FoundRun) {
  const first = run.words[0];
  const last = run.words.at(-1);
  const sameSegment = (word: StoredWord | undefined): word is StoredWord =>
    word !== undefined && word.segment === first?.segment && word.text !== '';
  const before = words
    .slice(
      Math.max(0, (first?.position ?? 0) - CONTEXT_WORDS * 2),
      first?.position,
    )
    .filter(sameSegment)
    .slice(-CONTEXT_WORDS);
  const after = words
    .slice(
      (last?.position ?? 0) + 1,
      (last?.position ?? 0) + 1 + CONTEXT_WORDS * 2,
    )
    .filter(sameSegment)
    .slice(0, CONTEXT_WORDS);
  return {
    contextBefore: spoken(textsOf(before)),
    contextAfter: spoken(textsOf(after)),
  };
}

/**
 * The word corrections of KBC-093: one word (FR-5), its undo (BR-7), "Corrigir todas" and
 * its group undo (BR-11 to BR-15), the preview's occurrences (FR-12) and the carry-over to
 * a new version (BR-9).
 */
export class TranscriptCorrectionService extends CorrectionService {
  batch(
    actor: MediaActor,
    mediaId: string,
    request: TranscriptCorrectionBatchRequest,
  ): Written<TranscriptCorrectionBatchResult> {
    this.recording(actor, mediaId);
    const text = this.batchText(request.text);
    this.checkItems(request.items);
    return this.deps.store.inTransaction(() => {
      const current = this.currentAt(mediaId, request.version);
      const sent = this.deps.store.groupRows(mediaId, request.key);
      if (sent.length > 0)
        return { status: 200, body: this.replayed(current, request.key, sent) };
      const written = this.writeTogether({
        current,
        changes: this.targetsOf(current, request.items).map(({ item, words }) =>
          changeOf(item, words, text),
        ),
        kind: 'correct',
        author: authorOf(actor),
        groupId: request.key,
      });
      this.notify(mediaId, 'batch', written.rows);
      return {
        status: 201,
        body: this.batchResult(written.current, request.key, written),
      };
    });
  }

  /** Deleting every occurrence is not "Corrigir todas": the screen refuses it too (BR-11). */
  private batchText(raw: string): string {
    const text = this.tidy(raw);
    if (text === '')
      throw new AppError('CORRECTION_INVALID', 'Type the right text');
    return text;
  }

  /** 1 to 200 items that do not overlap (422 otherwise, BR-12, AC-30, AC-32). */
  private checkItems(items: readonly CorrectionTarget[]): void {
    if (items.length === 0 || items.length > CORRECTION_MAX_BATCH)
      throw new AppError(
        'CORRECTION_INVALID',
        `Choose 1 to ${CORRECTION_MAX_BATCH} occurrences`,
      );
    if (overlapping(items))
      throw new AppError('CORRECTION_INVALID', 'Occurrences overlap');
  }

  /** Every item still says what the preview showed, or nothing is written (BR-13). */
  private targetsOf(
    current: CurrentTranscript,
    items: readonly CorrectionTarget[],
  ): Target[] {
    const targets = items.map((item) => ({
      item,
      words: this.targetOf(current, item),
    }));
    const changed = targets
      .filter(({ item, words }) => !sameTexts(textsOf(words), item.expected))
      .map(({ item, words }) => ({
        position: item.position,
        current: spoken(textsOf(words)),
      }));
    if (changed.length > 0)
      throw conflict(
        { reason: 'word-changed', changed },
        'Some occurrences changed since the preview',
      );
    return targets;
  }

  private batchResult(
    current: CurrentTranscript,
    groupId: string,
    written: {
      readonly rows: readonly CorrectionRow[];
      readonly segments: readonly RewrittenSegment[];
    },
  ): TranscriptCorrectionBatchResult {
    return {
      groupId,
      count: written.rows.length,
      version: current.version,
      revision: current.revision,
      segments: [...written.segments],
    };
  }

  /**
   * A key sent again (a lost answer, AC-34): what that group wrote on this version, with its
   * segments as they read now, and nothing written again.
   */
  private replayed(
    current: CurrentTranscript,
    groupId: string,
    sent: readonly CorrectionRow[],
  ): TranscriptCorrectionBatchResult {
    const rows = sent.filter(
      (row) => row.kind === 'correct' && row.transcriptId === current.id,
    );
    const { store } = this.deps;
    const segments = segmentsOf(
      rows.map((row) => ({
        index: row.segment,
        text: store.segmentText(current.id, row.segment) ?? '',
      })),
    );
    return this.batchResult(current, groupId, { rows, segments });
  }

  /** Several changes in one revision, each with its row; the tracks follow once (BR-15). */
  private writeTogether(input: Together) {
    const { store } = this.deps;
    const { current, changes } = input;
    const meta = {
      kind: input.kind,
      revision: current.revision + 1,
      author: input.author,
      at: this.now().toISOString(),
      groupId: input.groupId,
    };
    const rewritten: RewrittenSegment[] = [];
    const rows = changes.map((change, index) => {
      rewritten.push(writeChange(store, current.id, change));
      const reverts = input.reverts?.[index] ?? null;
      const row = rowOf(current, change, {
        ...meta,
        id: this.newId(),
        reverts,
      });
      store.insert(row);
      return row;
    });
    store.setRevision(current.id, meta.revision);
    const words = changes.flatMap((one) => one.words);
    this.deps.afterChange?.(current.mediaId, words);
    const segments = segmentsOf(rewritten);
    return { rows, segments, current: { ...current, revision: meta.revision } };
  }

  undoGroup(
    actor: MediaActor,
    mediaId: string,
    groupId: string,
  ): CorrectionGroupUndoResult {
    this.recording(actor, mediaId);
    return this.deps.store.inTransaction(() => {
      const rows = this.groupToUndo(actor, mediaId, groupId);
      const current = this.currentOf(mediaId);
      const restorable: { row: CorrectionRow; words: StoredWord[] }[] = [];
      let changed = 0;
      for (const row of rows.filter((one) => one.state === 'active')) {
        const words = this.wordsIfStill(current, row);
        if (words) restorable.push({ row, words });
        else changed++;
      }
      return this.restore({ actor, current, restorable, changed });
    });
  }

  private groupToUndo(
    actor: MediaActor,
    mediaId: string,
    groupId: string,
  ): CorrectionRow[] {
    const rows = this.deps.store
      .groupRows(mediaId, groupId)
      .filter((row) => row.kind !== 'undo');
    if (rows.length === 0)
      throw new AppError('NOT_FOUND', 'Unknown group of corrections');
    if (!rows.every((row) => mayUndoAuthor(row, actor)))
      throw new AppError('FORBIDDEN', 'Only a master undoes another person');
    return rows;
  }

  private wordsIfStill(
    current: CurrentTranscript,
    row: CorrectionRow,
  ): StoredWord[] | null {
    try {
      return this.stillSaying(current, row);
    } catch (err) {
      if (err instanceof AppError && err.code === 'CORRECTION_CONFLICT')
        return null;
      throw err;
    }
  }

  private restore(input: {
    readonly actor: MediaActor;
    readonly current: CurrentTranscript;
    readonly restorable: readonly { row: CorrectionRow; words: StoredWord[] }[];
    readonly changed: number;
  }): CorrectionGroupUndoResult {
    const { current, restorable, changed } = input;
    const base = { undone: 0, changed, version: current.version };
    if (restorable.length === 0)
      return { ...base, revision: current.revision, segments: [] };
    const written = this.writeTogether({
      current,
      changes: restorable.map(({ row, words }) => ({
        words,
        texts: row.before,
      })),
      kind: 'undo',
      author: authorOf(input.actor),
      groupId: this.newId(),
      reverts: restorable.map(({ row }) => row.id),
    });
    for (const { row } of restorable) this.deps.store.markUndone(row.id);
    this.notify(current.mediaId, 'undo-group', written.rows);
    return {
      ...base,
      undone: written.rows.length,
      revision: written.current.revision,
      segments: written.segments,
    };
  }

  /** The preview of "Corrigir todas" (FR-12): the first 200 by time of the scope. */
  occurrences(
    actor: MediaActor,
    mediaId: string,
    query: OccurrencesQuery,
  ): Occurrences {
    this.recording(actor, mediaId);
    const current = this.currentOf(mediaId);
    const words = this.deps.store.allWords(current.id);
    const inWindow = inWindowOf(query);
    const all = findRuns(words, query.text).map((run): Occurrence =>
      this.occurrenceOf(words, run, inWindow),
    );
    const windowed = all.filter((one) => one.inWindow);
    const listed = query.scope === 'window' ? windowed : all;
    return {
      mediaId,
      version: current.version,
      revision: current.revision,
      total: all.length,
      inWindow: windowed.length,
      occurrences: listed.slice(0, CORRECTION_MAX_BATCH),
    };
  }

  private occurrenceOf(
    words: readonly StoredWord[],
    run: FoundRun,
    inWindow: (word: PlacedWord) => boolean,
  ): Occurrence {
    const [first] = run.words;
    const last = run.words.at(-1);
    if (!first || !last) throw new Error('a run has words');
    return {
      position: first.position,
      count: run.words.length,
      expected: textsOf(run.words),
      segment: first.segment,
      startMs: first.startMs,
      endMs: last.endMs,
      ...contextOf(words, run),
      text: run.said,
      inWindow: inWindow(first),
    };
  }

  /**
   * Inside the new version's transaction, before its tracks are cut (FR-8, BR-9): each
   * correction in force on the version before lands on the new one, by time and text, or is
   * kept as not carried with what the new version says there (NFR-3: none is lost).
   */
  carry(mediaId: string): void {
    const { store } = this.deps;
    const current = store.current(mediaId);
    const previous = current
      ? store.previousOf(mediaId, current.version)
      : null;
    if (!current || !previous) return;
    const rows = store.activeOn(previous.id);
    const run: CarryRun = {
      current,
      // Read once (thousands of words, inside the worker's transaction) and kept as written.
      words: new Map(
        store.allWords(current.id).map((word) => [word.position, word]),
      ),
      // A group carried is a group of its own on the new version (BR-14): its history line
      // counts what landed there, apart from the version before.
      groups: new Map(),
    };
    const carried = rows.flatMap((row) => this.carryOne(run, row));
    if (carried.length === 0) return;
    store.setRevision(current.id, current.revision + 1);
    this.notify(mediaId, 'carry', carried);
  }

  private carryOne(run: CarryRun, row: CorrectionRow): CorrectionRow[] {
    const { store } = this.deps;
    const { current } = run;
    const change = this.landing(run, row);
    if (typeof change === 'string') {
      store.markNotCarried(row.id, { found: change, version: current.version });
      return [];
    }
    const carried = rowOf(current, change, {
      id: this.newId(),
      kind: 'carried',
      revision: current.revision + 1,
      author: { principal: row.authorPrincipal, name: row.authorName },
      at: this.now().toISOString(),
      groupId: this.carriedGroup(run, row.groupId),
      ruleId: row.ruleId,
    });
    store.insert(carried);
    const to = { carriedTo: carried.id, version: current.version };
    store.markCarried(row.id, to);
    return [carried];
  }

  /**
   * The change written on the new version, or what that version says there when it does not
   * land: other words, or words whose segment cannot be rewritten (409 `not-aligned`), which
   * stay not carried and never fail the new version (NFR-3, ADR 0034 §6).
   */
  private landing(run: CarryRun, row: CorrectionRow): WordChange | string {
    const outcome = carryOver(row, [...run.words.values()]);
    if (!outcome.carried) return outcome.found;
    const change = {
      words: outcome.words,
      texts: replacedTexts(row.count, row.after),
    };
    return this.landed(run, change) ? change : spoken(textsOf(outcome.words));
  }

  /** Writes a carried change and keeps the words read in step; false when it cannot land. */
  private landed(run: CarryRun, change: WordChange): boolean {
    try {
      writeChange(this.deps.store, run.current.id, change);
    } catch (err) {
      if (err instanceof AppError && err.code === 'CORRECTION_CONFLICT')
        return false;
      throw err;
    }
    change.words.forEach((word, index) =>
      run.words.set(word.position, {
        ...word,
        text: change.texts[index] ?? '',
      }),
    );
    return true;
  }

  private carriedGroup(run: CarryRun, groupId: string | null): string | null {
    if (groupId === null) return null;
    const known = run.groups.get(groupId);
    if (known) return known;
    const fresh = this.newId();
    run.groups.set(groupId, fresh);
    return fresh;
  }
}
