import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  EMPTY,
  Subject,
  catchError,
  finalize,
  map,
  switchMap,
  type Observable,
} from 'rxjs';
import {
  CORRECTION_MAX_CHARS,
  CORRECTION_MAX_WORDS,
  correctionConflictSchema,
  type CorrectionHistory,
  type LearnedSpan,
  type TranscriptCorrectionResult,
} from '@kb-chat/contracts';
import { formatClock, type TimedSpan } from '@kb-chat/player-core';
import { errorDetailsOf, toUiErrorCode } from '@core/api/api-error.js';
import { CorrectionsApi } from '@core/media/corrections-api.js';
import { TrackAudition } from '../tracks/track-audition.js';
import { TrackTextSource } from '../tracks/track-text-source.js';
import type { PlacedWord } from '../transcript/transcript-words.js';
import { spanAround, type WordSpan } from './word-span.js';

/** "Palavra corrigida." stays this long with its Desfazer (FR-3). */
export const NOTICE_MS = 10_000;
/** Words of context on each side of the chosen ones (FR-1). */
const CONTEXT_WORDS = 4;

/** A word of the text the person can correct: it has its place in the transcript. */
export type CorrectableWord = PlacedWord & { readonly position: number };

/** The chosen words: consecutive ones of one segment (BR-1). */
export interface Selection {
  readonly segment: number;
  /** The segment's words with text, in order. */
  readonly words: readonly CorrectableWord[];
  readonly first: number;
  readonly last: number;
}

/** How a choice was made: the word it stretches from, and whether it was cut (KBC-115). */
export interface ChoiceOptions {
  /** The last word chosen, by place; the first one alone by default. */
  readonly to?: number;
  /** The word a Shift+click or Shift+arrow stretches from; the first one by default. */
  readonly anchor?: number;
  /** The gesture went past the segment or the 5th word (BR-1): said with the words. */
  readonly clamped?: boolean;
}

/** A word's place, with its segment: where the keyboard starts again (KBC-115 FR-4). */
export interface WordPlace {
  readonly segment: number;
  readonly position: number;
}

/** Where the panel is (T20 "Corrigir palavra", its states). */
export type DeskPhase =
  | { readonly kind: 'editing' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'blocked' }
  | {
      readonly kind: 'conflict';
      readonly current: readonly string[];
      readonly author: string | null;
    }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed' }
  /** A track of the recording is above the person: correcting is its edit's (KBC-106). */
  | { readonly kind: 'above' }
  /** Refused for a reason a retry does not change (409 not-aligned, not-contiguous…). */
  | { readonly kind: 'refused' };

/** What a code that needs no detail leaves on the desk. */
const PLAIN_REFUSALS: Partial<Record<string, 'invalid' | 'above'>> = {
  CORRECTION_INVALID: 'invalid',
  EDIT_ABOVE_YOUR_LEVEL: 'above',
};

/** A message under the text, with an action for a while (FR-3, FR-11). */
export interface DeskNotice {
  readonly text: string;
  readonly undo: (() => void) | null;
}

const hasText = (word: PlacedWord): word is CorrectableWord =>
  word.position !== null;

/** Whether a word has its own time (BR-17: one without does not move the audio). */
export const isTimed = (word: TimedSpan): boolean => word.endMs > word.startMs;

/** The typed text as the API keeps it (BR-3); null when the rules refuse it. */
export function tidied(raw: string): string | null {
  if (/[\r\n]/.test(raw)) return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length > CORRECTION_MAX_CHARS ? null : text;
}

/** The last chosen word: up to `to`, within 5 positions of the first (BR-1, FR-2). */
function lastWithin(
  words: readonly CorrectableWord[],
  first: number,
  to: number,
): number {
  const start = words[first]?.position ?? 0;
  let last = first;
  for (let index = first + 1; index < words.length; index++) {
    const position = words[index]?.position ?? Number.POSITIVE_INFINITY;
    if (position > to || position - start >= CORRECTION_MAX_WORDS) break;
    last = index;
  }
  return last;
}

const spoken = (words: readonly CorrectableWord[]): string =>
  words.map((word) => word.text).join(' ');

/** Said when a gesture stops at the segment's edge or the 5th word (KBC-115 BR-1). */
export const insideSaid = (): string =>
  $localize`:@@correct.inside:A correção fica dentro de um trecho, com até 5 palavras.`;

/**
 * The word corrections of one text block (KBC-093): which words are chosen, the typed text,
 * saving with its conflicts, the undo notice and the history. The audio follows the chosen
 * word (BR-17). Provided by the text block, which reads its transcript again after a change.
 */
@Injectable()
export class CorrectionDesk {
  private readonly api = inject(CorrectionsApi);
  private readonly source = inject(TrackTextSource);
  private readonly audition = inject(TrackAudition);
  private readonly destroyRef = inject(DestroyRef);

  private readonly chosen = signal<Selection | null>(null);
  private readonly typed = signal('');
  private readonly state = signal<DeskPhase>({ kind: 'editing' });
  private readonly shown = signal<DeskNotice | null>(null);
  private readonly said = signal('');
  private readonly log = signal<CorrectionHistory | null>(null);
  private readonly everywhere = signal<string | null>(null);
  private readonly undoPending = signal(false);
  /** Pages of the history asked: a newer ask drops the answer to an older one (PD-03). */
  private readonly historyAsked = new Subject<number>();
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The word a selection stretches from (KBC-115 BR-4). */
  private anchorAt: number | null = null;
  /** The anchor of the last choice, kept after the panel closes (KBC-115 FR-4). */
  private lastPlace: WordPlace | null = null;

  readonly selection = this.chosen.asReadonly();
  readonly draft = this.typed.asReadonly();
  readonly phase = this.state.asReadonly();
  readonly notice = this.shown.asReadonly();
  /** Said by the screen reader (a polite live region). */
  readonly announcement = this.said.asReadonly();
  readonly history = this.log.asReadonly();
  /** The text "Corrigir todas" is open for (FR-11); null when closed. */
  readonly correctingAll = this.everywhere.asReadonly();
  /** An undo on its way: Desfazer waits for its answer, one request per click (PD-02). */
  readonly undoing = this.undoPending.asReadonly();
  /** The audio plays up to here when a word is chosen while it plays. */
  private untilMs = Number.POSITIVE_INFINITY;

  readonly words = computed(() => {
    const selection = this.chosen();
    return selection
      ? selection.words.slice(selection.first, selection.last + 1)
      : [];
  });
  /** What the chosen words say now. */
  readonly original = computed(() => spoken(this.words()));
  readonly contextBefore = computed(() => {
    const selection = this.chosen();
    if (!selection) return '';
    const from = Math.max(0, selection.first - CONTEXT_WORDS);
    return spoken(selection.words.slice(from, selection.first));
  });
  readonly contextAfter = computed(() => {
    const selection = this.chosen();
    if (!selection) return '';
    const to = selection.last + 1 + CONTEXT_WORDS;
    return spoken(selection.words.slice(selection.last + 1, to));
  });
  readonly dirty = computed(() => this.typed() !== this.original());
  readonly valid = computed(() => tidied(this.typed()) !== null);
  /** Nothing to save: the same text once tidied (AC-7). */
  readonly unchanged = computed(
    () => tidied(this.typed()) === tidied(this.original()),
  );
  readonly canIncludeNext = computed(() => this.canGrow(1));
  readonly canIncludePrevious = computed(() => this.canGrow(-1));
  readonly hasPrevious = computed(() => (this.chosen()?.first ?? 0) > 0);
  readonly hasNext = computed(() => {
    const selection = this.chosen();
    return selection !== null && selection.last < selection.words.length - 1;
  });
  /** The learning replaced the chosen words (KBC-113 FR-6): what they said, and its row. */
  readonly learnedSpan = computed<LearnedSpan | null>(() => {
    const learned = this.source.words.learned();
    if (learned.size === 0) return null;
    for (const word of this.words()) {
      const span =
        word.position === null ? undefined : learned.get(word.position);
      if (span) return span;
    }
    return null;
  });
  readonly timed = computed(() => {
    const [first] = this.words();
    return first !== undefined && isTimed(first);
  });

  constructor() {
    this.destroyRef.onDestroy(() => this.clearNotice());
    this.followHistory();
  }

  /** The block's track ends here: a word chosen while playing plays at least that far. */
  playUntil(ms: number): void {
    this.untilMs = ms;
  }

  /**
   * A word clicked, or chosen in "Procurar palavra" (BR-17): the audio goes to it and the
   * panel opens on it, once. With a changed text not saved, nothing moves (AC-44).
   */
  choose(
    segment: number,
    position: number,
    options: ChoiceOptions = {},
  ): boolean {
    const to = options.to ?? position;
    const current = this.chosen();
    if (current && this.dirty()) {
      if (!this.sameChoice(position, options.to))
        this.state.set({ kind: 'blocked' });
      return false;
    }
    const words = (this.source.words.of(segment) ?? []).filter(hasText);
    const first = words.findIndex((word) => word.position === position);
    if (first < 0) return false;
    const last = lastWithin(words, first, to);
    if (
      current?.segment === segment &&
      current.first === first &&
      current.last === last
    )
      return true;
    const anchor = words.some((word) => word.position === options.anchor)
      ? options.anchor
      : undefined;
    this.select({ segment, words, first, last }, anchor, options.clamped);
    return true;
  }

  /**
   * With a changed text, what may be asked again without a word (AC-44): a click on one of
   * the open words, or a drag over exactly them; a drag over others is told (KBC-115 BR-3).
   */
  private sameChoice(position: number, to = position): boolean {
    const words = this.words();
    if (to === position)
      return words.some((word) => word.position === position);
    return words[0]?.position === position && words.at(-1)?.position === to;
  }

  private select(
    selection: Selection,
    anchor = selection.words[selection.first]?.position,
    clamped = false,
  ): void {
    this.chosen.set(selection);
    this.anchorAt = anchor ?? null;
    if (anchor !== undefined)
      this.lastPlace = { segment: selection.segment, position: anchor };
    this.typed.set(this.original());
    this.state.set({ kind: 'editing' });
    const [first] = this.words();
    const audio =
      first && isTimed(first)
        ? $localize`:@@correct.audioAt:Áudio em ${formatClock(first.startMs)}:clock:`
        : '';
    if (first && isTimed(first))
      this.audition.seek(first.startMs, this.untilMs);
    const said = [this.chosenSaid(clamped), audio].filter(Boolean).join(' ');
    if (said !== '') this.say(said);
  }

  /** "3 palavras escolhidas: o mestre Tiuako" (KBC-115 FR-6); a single word says nothing. */
  private chosenSaid(clamped: boolean): string {
    const words = this.words();
    const chosen =
      words.length > 1
        ? $localize`:@@correct.chosenMany:${words.length}:count: palavras escolhidas: ${this.original()}:words:.`
        : '';
    // Each part is a sentence with its own full stop (QA-1).
    return [chosen, clamped ? insideSaid() : ''].filter(Boolean).join(' ');
  }

  /** The word a Shift+click or Shift+arrow stretches from (KBC-115 BR-4). */
  anchor(): number | null {
    return this.anchorAt;
  }

  /** Where the last choice started, even after the panel closed (KBC-115 FR-4). */
  lastChosen(): WordPlace | null {
    return this.lastPlace;
  }

  /**
   * Shift+click or Shift+arrows (KBC-115 BR-4): from the anchor to `to`, within the segment and
   * 5 places; the typed text stays and the audio does not move, as "Incluir a próxima". Null
   * when there is nothing open in that segment to stretch.
   */
  extend(
    segment: number,
    to: number,
    options: Omit<ChoiceOptions, 'to'> = {},
  ): WordSpan | null {
    const selection = this.chosen();
    if (selection?.segment !== segment) return null;
    const from = options.anchor ?? this.anchorAt;
    const anchor = selection.words.findIndex((word) => word.position === from);
    const focus = selection.words.findIndex((word) => word.position === to);
    if (anchor < 0 || focus < 0) return null;
    const span = spanAround(selection.words, anchor, focus);
    const cut = options.clamped === true || span.clamped;
    this.anchorAt = from;
    if (span.first !== selection.first || span.last !== selection.last) {
      const keepTyped = this.dirty();
      const typed = this.typed();
      this.chosen.set({ ...selection, first: span.first, last: span.last });
      this.typed.set(keepTyped ? typed : this.original());
    }
    const said = this.chosenSaid(cut);
    if (said !== '') this.say(said);
    return { ...span, clamped: cut };
  }

  /** ◀ Anterior / Próxima ▶: the word beside, alone; the audio goes there too (BR-17). */
  move(direction: 1 | -1): void {
    const selection = this.chosen();
    if (!selection) return;
    const at = direction === 1 ? selection.last + 1 : selection.first - 1;
    if (at < 0 || at >= selection.words.length) return;
    this.select({ ...selection, first: at, last: at });
  }

  /** Incluir a próxima / anterior: up to 5 words of the segment; the audio stays (BR-17). */
  include(direction: 1 | -1): void {
    const selection = this.chosen();
    if (!selection || !this.canGrow(direction)) return;
    const keepTyped = this.dirty();
    const typed = this.typed();
    this.chosen.set({
      ...selection,
      first: direction === -1 ? selection.first - 1 : selection.first,
      last: direction === 1 ? selection.last + 1 : selection.last,
    });
    this.typed.set(keepTyped ? typed : this.original());
  }

  private canGrow(direction: 1 | -1): boolean {
    const selection = this.chosen();
    if (!selection) return false;
    const first =
      selection.words[direction === -1 ? selection.first - 1 : selection.first];
    const last =
      selection.words[direction === 1 ? selection.last + 1 : selection.last];
    return (
      first !== undefined &&
      last !== undefined &&
      last.position - first.position < CORRECTION_MAX_WORDS
    );
  }

  /** "Corrigir todas" for what the chosen words say (FR-11). */
  openAll(text: string): void {
    this.everywhere.set(text);
  }

  closeAll(): void {
    this.everywhere.set(null);
  }

  type(text: string): void {
    this.typed.set(text);
    const phase = this.state().kind;
    if (phase === 'invalid' || phase === 'blocked')
      this.state.set({ kind: 'editing' });
  }

  close(): void {
    this.chosen.set(null);
    this.state.set({ kind: 'editing' });
  }

  /** Salvar (or Enter); `text` '' is Apagar palavra (BR-2). */
  save(text: string = this.typed(), expected?: readonly string[]): void {
    const clean = tidied(text);
    if (clean === null) {
      this.state.set({ kind: 'invalid' });
      return;
    }
    const request = this.requestOf(clean, expected);
    const phase = this.state().kind;
    if (!request || phase === 'saving' || phase === 'refused') return;
    this.state.set({ kind: 'saving' });
    this.api
      .correct(request.mediaId, request.body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => this.saved(result),
        error: (err: unknown) => this.refused(err),
      });
  }

  /** Salvar a minha: over the other person's text, with it as the expected one (AC-12). */
  saveMine(): void {
    const phase = this.state();
    if (phase.kind !== 'conflict') return;
    this.state.set({ kind: 'editing' });
    this.save(this.typed(), phase.current);
  }

  /** Usar a de Maria: the text as it is now, read again (AC-12). */
  useTheirs(): void {
    this.close();
    this.source.reload();
  }

  private requestOf(text: string, expected?: readonly string[]) {
    const transcript = this.source.transcript();
    const words = this.words();
    const [first] = words;
    const last = words.at(-1);
    const selection = this.chosen();
    if (!transcript || !first || !last || !selection) return null;
    const count = last.position - first.position + 1;
    const byPosition = new Map(words.map((word) => [word.position, word.text]));
    return {
      mediaId: transcript.mediaId,
      body: {
        version: transcript.version,
        position: first.position,
        count,
        expected: [
          ...(expected ??
            Array.from(
              { length: count },
              (_, index) => byPosition.get(first.position + index) ?? '',
            )),
        ],
        text,
      },
    };
  }

  private saved(result: TranscriptCorrectionResult): void {
    this.close();
    this.source.reload();
    this.loadHistory();
    const id = result.correction?.id;
    const text =
      (result.correction?.count ?? 1) > 1
        ? $localize`:@@correct.savedMany:Palavras corrigidas.`
        : $localize`:@@correct.saved:Palavra corrigida.`;
    this.say(text);
    this.tell({ text, undo: id ? () => this.undo(id) : null });
  }

  private refused(err: unknown): void {
    const code = toUiErrorCode(err);
    if (code === 'TRANSCRIPT_CHANGED') {
      this.state.set({ kind: 'stale' });
      this.source.reload();
      return;
    }
    // Refusals a retry does not change: said as they are (KBC-106: above the person).
    const plain = PLAIN_REFUSALS[code];
    if (plain) {
      this.state.set({ kind: plain });
      return;
    }
    const details = correctionConflictSchema.safeParse(errorDetailsOf(err));
    const reason = code === 'CORRECTION_CONFLICT' ? details.data?.reason : null;
    if (reason && reason !== 'word-changed' && reason !== 'changed-since') {
      this.state.set({ kind: 'refused' });
      return;
    }
    if (reason === 'word-changed' && details.data) {
      this.state.set({
        kind: 'conflict',
        current: details.data.current ?? [],
        author: details.data.authorName ?? null,
      });
      return;
    }
    this.state.set({ kind: 'failed' });
  }

  /** Desfazer, in the notice or the history (BR-7). */
  undo(correctionId: string, done?: string): void {
    const transcript = this.source.transcript();
    if (!transcript || this.undoPending()) return;
    this.clearNotice();
    this.undoOnce(this.api.undo(transcript.mediaId, correctionId)).subscribe({
      next: () => {
        this.source.reload();
        this.loadHistory();
        const text = done ?? $localize`:@@correct.undone:Correção desfeita.`;
        this.say(text);
        this.tell({ text, undo: null });
      },
      error: (err: unknown) => this.undoRefused(err),
    });
  }

  /** "Desfazer" on a word the learning replaced (KBC-113 BR-7): the panel closes. */
  undoLearned(): void {
    const span = this.learnedSpan();
    if (!span || this.undoPending()) return;
    this.close();
    this.undo(
      span.correctionId,
      $localize`:@@correct.learnedUndone:Palavra voltou a «${span.before}:before:».`,
    );
  }

  /** Desfazer o grupo (BR-14): what still says the new text goes back, the rest is told. */
  undoGroup(groupId: string): void {
    const transcript = this.source.transcript();
    if (!transcript || this.undoPending()) return;
    this.clearNotice();
    this.undoOnce(this.api.undoGroup(transcript.mediaId, groupId)).subscribe({
      next: ({ undone, changed }) => {
        this.source.reload();
        this.loadHistory();
        const text =
          changed === 0
            ? $localize`:@@correct.groupUndone:${undone}:undone: desfeitas.`
            : $localize`:@@correct.groupPartly:${undone}:undone: desfeitas; ${changed}:changed: mudaram depois e ficaram como estão.`;
        this.say(text);
        this.tell({ text, undo: null });
      },
      error: (err: unknown) => this.undoRefused(err),
    });
  }

  private undoOnce<T>(request: Observable<T>): Observable<T> {
    this.undoPending.set(true);
    return request.pipe(
      finalize(() => this.undoPending.set(false)),
      takeUntilDestroyed(this.destroyRef),
    );
  }

  private undoRefused(err: unknown): void {
    const details = correctionConflictSchema.safeParse(errorDetailsOf(err));
    const now = details.data?.current?.filter((text) => text !== '').join(' ');
    const text =
      details.data?.reason === 'changed-since'
        ? $localize`:@@correct.changedSince:Esta palavra mudou depois: agora diz «${now ?? ''}:now:». Corrija à mão se precisar.`
        : $localize`:@@correct.undoFailed:Não consegui desfazer. Tente de novo.`;
    this.say(text);
    this.tell({ text, undo: null });
  }

  /** A message under the text; one with Desfazer goes after 10 s (FR-3). */
  tell(notice: DeskNotice): void {
    this.clearNotice();
    this.shown.set(notice);
    if (notice.undo)
      this.noticeTimer = setTimeout(() => this.shown.set(null), NOTICE_MS);
  }

  dismissNotice(): void {
    this.clearNotice();
  }

  private clearNotice(): void {
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    this.shown.set(null);
  }

  say(text: string): void {
    // The same words twice must be said twice: the region changes first.
    this.said.set('');
    queueMicrotask(() => this.said.set(text));
  }

  /** The recording's history, for "Correções (N)" and the carry-over notice (FR-8, FR-9). */
  loadHistory(cursor = 0): void {
    this.historyAsked.next(cursor);
  }

  private followHistory(): void {
    this.historyAsked
      .pipe(
        switchMap((cursor) => {
          const transcript = this.source.transcript();
          if (!transcript) return EMPTY;
          return this.api.history(transcript.mediaId, cursor).pipe(
            map((page) => ({ cursor, page })),
            // The count and the notice wait for the next change; the text works without them.
            catchError(() => EMPTY),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(({ cursor, page }) =>
        this.log.update((known) =>
          cursor === 0 || !known
            ? page
            : { ...page, entries: [...known.entries, ...page.entries] },
        ),
      );
  }
}
